import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Pool, QueryConfig } from 'pg';

import type { DatabaseReadiness } from '../database/database.types';
import { AUTH_DATABASE_POOL } from './auth.constants';
import type {
  AuthenticatedPrincipal,
  AuthorizedStore,
  CredentialRecord,
  RefreshRotationInput,
  RefreshRotationResult,
  SessionIssueInput,
} from './auth.types';

interface AuthenticationRoleInspection {
  sessionUser: string;
  currentUser: string;
  isSuperuser: boolean;
  bypassesRls: boolean;
  canCreateDatabases: boolean;
  canCreateRoles: boolean;
  canReplicate: boolean;
  rowSecurityEnabled: boolean;
  isAuthMember: boolean;
  canSetAuth: boolean;
  canSetAuthOwner: boolean;
  canSetMigrator: boolean;
  canSetRuntime: boolean;
  hasAuthSchemaUsage: boolean;
  hasAuthSchemaCreate: boolean;
  hasRestrictedSchemaUsage: boolean;
  hasProtectedTableAccess: boolean;
  ownsApplicationObjects: boolean;
}

class UnsafeAuthenticationDatabaseRoleError extends Error {
  constructor() {
    super('The authentication database connection violates least-privilege requirements.');
    this.name = 'UnsafeAuthenticationDatabaseRoleError';
  }
}

@Injectable()
export class AuthenticationDatabaseService implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(
    @Inject(AUTH_DATABASE_POOL)
    private readonly pool: Pool,
    private readonly logger: PinoLogger,
  ) {
    this.pool.on('error', () => {
      this.logger.error({
        event: 'authentication_database_pool_error',
        message: 'An idle authentication PostgreSQL client emitted an error.',
      });
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    let inspection: AuthenticationRoleInspection;
    try {
      inspection = await this.inspectRole();
    } catch {
      this.logger.warn({
        event: 'authentication_database_startup_check',
        status: 'unavailable',
      });
      return;
    }

    if (!this.isSafeRole(inspection)) {
      this.logger.error({
        event: 'authentication_database_startup_check',
        status: 'unsafe_role',
      });
      throw new UnsafeAuthenticationDatabaseRoleError();
    }

    this.logger.info({
      event: 'authentication_database_startup_check',
      status: 'ready',
      authenticationRoleVerified: true,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
    this.logger.info({
      event: 'authentication_database_pool_closed',
    });
  }

  async checkReadiness(timeoutMs: number): Promise<DatabaseReadiness> {
    const startedAt = performance.now();

    try {
      const inspection = await this.inspectRole(timeoutMs);
      return {
        ready: this.isSafeRole(inspection),
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      };
    } catch {
      return {
        ready: false,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      };
    }
  }

  async lookupCredentials(normalizedEmail: string): Promise<CredentialRecord | undefined> {
    const result = await this.pool.query<CredentialRecord>(
      `
        select
          user_id as "userId",
          password_hash as "passwordHash",
          user_status as "userStatus"
        from auth_api.lookup_credentials($1::text)
      `,
      [normalizedEmail],
    );
    return result.rows[0];
  }

  async listAuthorizedStores(userId: string): Promise<AuthorizedStore[]> {
    const result = await this.pool.query<AuthorizedStore>(
      `
        select
          store_id as "storeId",
          store_name as "storeName",
          currency_code as "currencyCode",
          store_status as "storeStatus",
          membership_role as "membershipRole",
          membership_version as "membershipVersion"
        from auth_api.list_authorized_stores($1::uuid)
      `,
      [userId],
    );
    return result.rows;
  }

  async issueSession(input: SessionIssueInput): Promise<AuthenticatedPrincipal | undefined> {
    const result = await this.pool.query<AuthenticatedPrincipal>(
      `
        select
          user_id as "userId",
          email,
          full_name as "fullName",
          store_id as "storeId",
          store_name as "storeName",
          store_status as "storeStatus",
          membership_role as "membershipRole",
          membership_version as "membershipVersion",
          device_id as "deviceId",
          session_id as "sessionId",
          session_expires_at as "sessionExpiresAt"
        from auth_api.issue_session(
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4::text,
          $5::text,
          $6::uuid,
          $7::uuid,
          $8::uuid,
          $9::text,
          $10::uuid,
          $11::timestamptz,
          $12::timestamptz,
          $13::text,
          $14::text
        )
      `,
      [
        input.userId,
        input.storeId,
        input.deviceId,
        input.deviceName,
        input.devicePlatform,
        input.sessionId,
        input.accessTokenJti,
        input.refreshTokenId,
        input.refreshTokenHash,
        input.refreshFamilyId,
        input.sessionExpiresAt,
        input.refreshExpiresAt,
        input.ipHash ?? null,
        input.userAgentHash ?? null,
      ],
    );
    return result.rows[0];
  }

  async validateSession(
    userId: string,
    sessionId: string,
    storeId: string,
    deviceId: string,
    accessTokenJti: string,
  ): Promise<AuthenticatedPrincipal | undefined> {
    const result = await this.pool.query<AuthenticatedPrincipal>(
      `
        select
          user_id as "userId",
          email,
          full_name as "fullName",
          store_id as "storeId",
          store_name as "storeName",
          store_status as "storeStatus",
          membership_role as "membershipRole",
          membership_version as "membershipVersion",
          device_id as "deviceId",
          session_id as "sessionId",
          session_expires_at as "sessionExpiresAt"
        from auth_api.validate_session($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)
      `,
      [userId, sessionId, storeId, deviceId, accessTokenJti],
    );
    return result.rows[0];
  }

  async rotateRefreshToken(input: RefreshRotationInput): Promise<RefreshRotationResult> {
    const result = await this.pool.query<RefreshRotationResult>(
      `
        select
          outcome,
          user_id as "userId",
          email,
          full_name as "fullName",
          store_id as "storeId",
          store_name as "storeName",
          store_status as "storeStatus",
          membership_role as "membershipRole",
          membership_version as "membershipVersion",
          device_id as "deviceId",
          session_id as "sessionId",
          session_expires_at as "sessionExpiresAt"
        from auth_api.rotate_refresh_token($1::text, $2::uuid, $3::text, $4::uuid, $5::integer)
      `,
      [
        input.currentTokenHash,
        input.newTokenId,
        input.newTokenHash,
        input.newAccessTokenJti,
        input.refreshTtlSeconds,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Authentication refresh function returned no outcome.');
    }
    return row;
  }

  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    const result = await this.pool.query<{ revoked: boolean }>(
      `select auth_api.revoke_session($1::uuid, $2::uuid, 'logout'::text) as revoked`,
      [userId, sessionId],
    );
    return result.rows[0]?.revoked === true;
  }

  private async inspectRole(timeoutMs?: number): Promise<AuthenticationRoleInspection> {
    const query = {
      text: `
      select
        session_user as "sessionUser",
        current_user as "currentUser",
        role_state.rolsuper as "isSuperuser",
        role_state.rolbypassrls as "bypassesRls",
        role_state.rolcreatedb as "canCreateDatabases",
        role_state.rolcreaterole as "canCreateRoles",
        role_state.rolreplication as "canReplicate",
        current_setting('row_security') = 'on' as "rowSecurityEnabled",
        pg_has_role(current_user, 'shop_app_auth', 'MEMBER') as "isAuthMember",
        pg_has_role(current_user, 'shop_app_auth', 'SET') as "canSetAuth",
        pg_has_role(current_user, 'shop_app_auth_owner', 'SET') as "canSetAuthOwner",
        pg_has_role(current_user, 'shop_app_migrator', 'SET') as "canSetMigrator",
        pg_has_role(current_user, 'shop_app_runtime', 'SET') as "canSetRuntime",
        has_schema_privilege(current_user, 'auth_api', 'USAGE') as "hasAuthSchemaUsage",
        has_schema_privilege(current_user, 'auth_api', 'CREATE') as "hasAuthSchemaCreate",
        (
          has_schema_privilege(current_user, 'platform', 'USAGE')
          or has_schema_privilege(current_user, 'ledger', 'USAGE')
        ) as "hasRestrictedSchemaUsage",
        exists (
          select 1
          from pg_class as protected_auth
          inner join pg_namespace as protected_namespace
            on protected_namespace.oid = protected_auth.relnamespace
          where
            (
              (
                protected_namespace.nspname = 'platform'
                and protected_auth.relname in (
                  'users',
                  'store_memberships',
                  'auth_sessions',
                  'refresh_tokens'
                )
              )
              or (
                protected_namespace.nspname = 'ledger'
                and protected_auth.relname in ('stores', 'devices')
              )
            )
            and (
              has_table_privilege(current_user, protected_auth.oid, 'SELECT')
              or has_table_privilege(current_user, protected_auth.oid, 'INSERT')
              or has_table_privilege(current_user, protected_auth.oid, 'UPDATE')
              or has_table_privilege(current_user, protected_auth.oid, 'DELETE')
              or has_table_privilege(current_user, protected_auth.oid, 'TRUNCATE')
              or has_table_privilege(current_user, protected_auth.oid, 'REFERENCES')
              or has_table_privilege(current_user, protected_auth.oid, 'TRIGGER')
              or has_any_column_privilege(current_user, protected_auth.oid, 'SELECT')
              or has_any_column_privilege(current_user, protected_auth.oid, 'INSERT')
              or has_any_column_privilege(current_user, protected_auth.oid, 'UPDATE')
              or has_any_column_privilege(current_user, protected_auth.oid, 'REFERENCES')
            )
        ) as "hasProtectedTableAccess",
        (
          exists (
            select 1
            from pg_class as relation
            inner join pg_namespace as namespace on namespace.oid = relation.relnamespace
            where namespace.nspname in ('platform', 'ledger', 'sync', 'audit', 'auth_api')
              and relation.relowner = role_state.oid
          )
          or exists (
            select 1
            from pg_namespace as namespace
            where namespace.nspname in ('platform', 'ledger', 'sync', 'audit', 'auth_api')
              and namespace.nspowner = role_state.oid
          )
          or exists (
            select 1
            from pg_proc as function_state
            inner join pg_namespace as namespace on namespace.oid = function_state.pronamespace
            where namespace.nspname in ('platform', 'ledger', 'sync', 'audit', 'auth_api')
              and function_state.proowner = role_state.oid
          )
        ) as "ownsApplicationObjects"
      from pg_roles as role_state
      where role_state.rolname = current_user
    `,
      ...(timeoutMs === undefined ? {} : { query_timeout: timeoutMs }),
    } as QueryConfig;
    const result = await this.pool.query<AuthenticationRoleInspection>(query);
    const inspection = result.rows[0];
    if (!inspection) {
      throw new Error('Unable to inspect the authentication database role.');
    }
    return inspection;
  }

  private isSafeRole(inspection: AuthenticationRoleInspection): boolean {
    return (
      inspection.sessionUser === 'dokana_auth_login' &&
      inspection.currentUser === 'dokana_auth_login' &&
      !inspection.isSuperuser &&
      !inspection.bypassesRls &&
      !inspection.canCreateDatabases &&
      !inspection.canCreateRoles &&
      !inspection.canReplicate &&
      inspection.rowSecurityEnabled &&
      inspection.isAuthMember &&
      !inspection.canSetAuth &&
      !inspection.canSetAuthOwner &&
      !inspection.canSetMigrator &&
      !inspection.canSetRuntime &&
      inspection.hasAuthSchemaUsage &&
      !inspection.hasAuthSchemaCreate &&
      !inspection.hasRestrictedSchemaUsage &&
      !inspection.hasProtectedTableAccess &&
      !inspection.ownsApplicationObjects
    );
  }
}
