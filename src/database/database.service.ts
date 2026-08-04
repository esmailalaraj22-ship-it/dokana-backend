import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import type { Pool, QueryConfig } from 'pg';

import { AppConfigService } from '../config/app-config.service';
import { isUuid } from '../common/logging/request-id';
import { DATABASE_POOL, DRIZZLE_DATABASE } from './database.constants';
import type {
  DatabaseClient,
  DatabaseReadiness,
  DatabaseTransaction,
  TenantTransactionContext,
} from './database.types';

interface RuntimeRoleInspection {
  isSuperuser: boolean;
  bypassesRls: boolean;
  canCreateDatabases: boolean;
  canCreateRoles: boolean;
  canReplicate: boolean;
  rowSecurityEnabled: boolean;
  isRuntimeRoleMember: boolean;
  isMigrationRoleMember: boolean;
  hasRuntimeSchemaAccess: boolean;
  hasRestrictedSchemaAccess: boolean;
  ownsProtectedTables: boolean;
}

class UnsafeRuntimeDatabaseRoleError extends Error {
  constructor() {
    super('The runtime database connection violates least-privilege requirements.');
    this.name = 'UnsafeRuntimeDatabaseRoleError';
  }
}

@Injectable()
export class DatabaseService implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(
    @Inject(DRIZZLE_DATABASE)
    private readonly database: DatabaseClient,
    @Inject(DATABASE_POOL)
    private readonly pool: Pool,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.pool.on('error', () => {
      this.logger.error({
        event: 'database_pool_error',
        message: 'An idle PostgreSQL client emitted an error.',
      });
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    let inspection: RuntimeRoleInspection;

    try {
      inspection = await this.inspectRuntimeRole(this.config.healthCheckTimeoutMs);
    } catch {
      this.logger.warn({
        event: 'database_startup_check',
        status: 'unavailable',
      });
      return;
    }

    if (!this.isSafeRuntimeRole(inspection)) {
      this.logger.error({
        event: 'database_startup_check',
        status: 'unsafe_role',
        isSuperuser: inspection.isSuperuser,
        bypassesRls: inspection.bypassesRls,
        canCreateDatabases: inspection.canCreateDatabases,
        canCreateRoles: inspection.canCreateRoles,
        canReplicate: inspection.canReplicate,
        rowSecurityEnabled: inspection.rowSecurityEnabled,
        isRuntimeRoleMember: inspection.isRuntimeRoleMember,
        isMigrationRoleMember: inspection.isMigrationRoleMember,
        hasRuntimeSchemaAccess: inspection.hasRuntimeSchemaAccess,
        hasRestrictedSchemaAccess: inspection.hasRestrictedSchemaAccess,
        ownsProtectedTables: inspection.ownsProtectedTables,
      });
      throw new UnsafeRuntimeDatabaseRoleError();
    }

    this.logger.info({
      event: 'database_startup_check',
      status: 'ready',
      runtimeRoleVerified: true,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
    this.logger.info({
      event: 'database_pool_closed',
    });
  }

  async transaction<T>(work: (transaction: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.database.transaction(work);
  }

  async withTenantTransaction<T>(
    context: TenantTransactionContext,
    work: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    this.assertTenantContext(context);

    return this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select set_config('app.store_id', ${context.storeId}, true)`);
      await transaction.execute(sql`select set_config('app.user_id', ${context.userId}, true)`);
      await transaction.execute(sql`select set_config('app.device_id', ${context.deviceId}, true)`);
      await transaction.execute(
        sql`select set_config('app.request_id', ${context.requestId}, true)`,
      );

      return work(transaction);
    });
  }

  async checkReadiness(timeoutMs: number): Promise<DatabaseReadiness> {
    const startedAt = performance.now();

    try {
      const inspection = await this.inspectRuntimeRole(timeoutMs);
      return {
        ready: this.isSafeRuntimeRole(inspection),
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      };
    } catch {
      return {
        ready: false,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      };
    }
  }

  private async inspectRuntimeRole(timeoutMs: number): Promise<RuntimeRoleInspection> {
    const query = {
      text: `
        select
          r.rolsuper as "isSuperuser",
          r.rolbypassrls as "bypassesRls",
          r.rolcreatedb as "canCreateDatabases",
          r.rolcreaterole as "canCreateRoles",
          r.rolreplication as "canReplicate",
          current_setting('row_security') = 'on' as "rowSecurityEnabled",
          pg_has_role(current_user, 'shop_app_runtime', 'MEMBER') as "isRuntimeRoleMember",
          pg_has_role(current_user, 'shop_app_migrator', 'MEMBER') as "isMigrationRoleMember",
          (
            has_schema_privilege(current_user, 'ledger', 'USAGE')
            and has_schema_privilege(current_user, 'sync', 'USAGE')
          ) as "hasRuntimeSchemaAccess",
          (
            has_schema_privilege(current_user, 'platform', 'USAGE')
            or has_schema_privilege(current_user, 'audit', 'USAGE')
          ) as "hasRestrictedSchemaAccess",
          exists (
            select 1
            from pg_class as protected_table
            inner join pg_namespace as protected_schema
              on protected_schema.oid = protected_table.relnamespace
            where protected_schema.nspname in ('platform', 'ledger', 'sync', 'audit')
              and protected_table.relkind in ('r', 'p')
              and protected_table.relowner = r.oid
          ) as "ownsProtectedTables"
        from pg_roles as r
        where r.rolname = current_user
      `,
      query_timeout: timeoutMs,
    } as QueryConfig;
    const result = await this.pool.query(query);
    const inspection = result.rows[0] as RuntimeRoleInspection | undefined;

    if (!inspection) {
      throw new Error('Unable to inspect the runtime database role.');
    }

    return inspection;
  }

  private isSafeRuntimeRole(inspection: RuntimeRoleInspection): boolean {
    return (
      !inspection.isSuperuser &&
      !inspection.bypassesRls &&
      !inspection.canCreateDatabases &&
      !inspection.canCreateRoles &&
      !inspection.canReplicate &&
      inspection.rowSecurityEnabled &&
      inspection.isRuntimeRoleMember &&
      !inspection.isMigrationRoleMember &&
      inspection.hasRuntimeSchemaAccess &&
      !inspection.hasRestrictedSchemaAccess &&
      !inspection.ownsProtectedTables
    );
  }

  private assertTenantContext(context: TenantTransactionContext): void {
    const values = [context.storeId, context.userId, context.deviceId, context.requestId];

    if (!values.every(isUuid)) {
      throw new TypeError('Tenant transaction context values must be UUIDs.');
    }
  }
}
