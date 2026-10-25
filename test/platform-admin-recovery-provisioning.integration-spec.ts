import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { drizzle } from 'drizzle-orm/node-postgres';
import type { PinoLogger } from 'nestjs-pino';
import type { Pool } from 'pg';

import {
  activateRecoveryControl,
  fenceRecoveryControl,
  withDatabase,
} from '../scripts/recovery/recovery-target';
import { AuthenticationDatabaseService } from '../src/auth/auth-database.service';
import type { AppConfigService } from '../src/config/app-config.service';
import { DatabaseService } from '../src/database/database.service';
import type { TenantTransactionContext } from '../src/database/database.types';
import * as schema from '../src/database/schema';
import { SystemCashProvisioningService } from '../src/money-accounts/system-cash-provisioning.service';
import type { PlatformAdminProvisionStoreDto } from '../src/platform-authority/dto/platform-admin-provision-store.dto';
import { PlatformAdminRepository } from '../src/platform-authority/platform-admin.repository';
import { PlatformAdminService } from '../src/platform-authority/platform-admin.service';
import { StoreProvisioningService } from '../src/platform-authority/store-provisioning.service';
import { SubscriptionLifecycleRepository } from '../src/platform-authority/subscription-lifecycle.repository';
import { SubscriptionLifecycleService } from '../src/platform-authority/subscription-lifecycle.service';
import { AppSettingsInitializationService } from '../src/settings/app-settings-initialization.service';
import {
  createInventoryTestDatabase,
  type InventoryTestDatabase,
  upgradeInventoryTestDatabaseToCurrent,
} from './inventory-postgresql-fixture';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const describeWithPostgres = environment ? describe : describe.skip;
jest.setTimeout(120_000);

describeWithPostgres('S22-R1 Platform Admin provisioning recovery context', () => {
  let fixture: InventoryTestDatabase;
  let authPool: Pool | undefined;
  let closeFixture: (() => Promise<void>) | undefined;
  let service: PlatformAdminService;
  let context: TenantTransactionContext;
  let oldGeneration: string;
  let migrationUrl: string;
  const ownerId = randomUUID();

  function command(): PlatformAdminProvisionStoreDto {
    return {
      operationId: randomUUID(),
      ownerUserId: ownerId,
      name: 'Recovery provisioning',
      reason: 'Approved recovery provisioning',
      activateSubscription: true,
      settings: {
        dailyReportTimeMinutes: 1200,
        defaultCreditPolicy: 'warn',
        defaultCreditLimitMinor: null,
        allowNegativeStock: false,
        lowStockAlertEnabled: true,
        debtAgeAlertDays: 30,
        backupEnabled: true,
        backupIntervalHours: 24,
      },
    };
  }

  // Compare persisted contents, including audit/sync effects, after rejected attempts.
  async function state(): Promise<unknown[]> {
    const tables = [
      'ledger.stores',
      'platform.store_memberships',
      'ledger.app_settings',
      'ledger.money_accounts',
      'platform.subscriptions',
      'platform.admin_actions',
      'audit.central_audit_logs',
      'sync.store_change_events_v1',
      'sync.store_change_watermarks_v1',
    ];
    return Promise.all(
      tables.map(async (table) => {
        const result = await fixture.admin.query<{ count: number; digest: string }>(`
          select count(*)::integer as count,
            md5(coalesce(string_agg(row_to_json(t)::text, '' order by row_to_json(t)::text), ''))
              as digest
          from ${table} as t
        `);
        return result.rows[0];
      }),
    );
  }

  async function expectOneFoundation(storeId: unknown, operationId: string): Promise<void> {
    expect(typeof storeId).toBe('string');
    const result = await fixture.admin.query(
      `select
         (select count(*)::integer from ledger.stores where id=$1) as stores,
         (select count(*)::integer from platform.store_memberships
          where store_id=$1 and user_id=$2 and role='owner') as owners,
         (select count(*)::integer from ledger.app_settings where store_id=$1) as settings,
         (select count(*)::integer from ledger.money_accounts
          where store_id=$1 and account_type='cash') as cash,
         (select count(*)::integer from platform.subscriptions where store_id=$1) as subscriptions,
         (select count(*)::integer from platform.admin_actions
          where store_id=$1 and request_id=$3 and action='store_provisioned') as actions`,
      [storeId, ownerId, operationId],
    );
    expect(result.rows[0]).toEqual({
      stores: 1,
      owners: 1,
      settings: 1,
      cash: 1,
      subscriptions: 1,
      actions: 1,
    });
  }

  beforeAll(async () => {
    if (!environment) throw new Error('Approved local PostgreSQL environment is required.');
    fixture = await createInventoryTestDatabase('0033_platform_recovery_generation_fencing.sql');
    closeFixture = () => fixture.close();
    await upgradeInventoryTestDatabaseToCurrent(fixture, []);
    migrationUrl = withDatabase(environment.migrationUrl, fixture.databaseName);
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as PinoLogger;
    const database = new DatabaseService(
      drizzle(fixture.runtime, { schema }),
      fixture.runtime,
      {} as AppConfigService,
      logger,
    );
    const repository = new SubscriptionLifecycleRepository();
    const provisioning = new StoreProvisioningService(
      database,
      repository,
      new AppSettingsInitializationService(database),
      new SystemCashProvisioningService(database),
    );
    service = new PlatformAdminService(
      database,
      new PlatformAdminRepository(),
      new SubscriptionLifecycleService(database, repository),
      provisioning,
    );

    const adminId = randomUUID();
    const authStoreId = randomUUID();
    for (const id of [adminId, ownerId]) {
      await fixture.admin.query(
        `insert into platform.users(id,email,normalized_email,password_hash,full_name,status)
         values($1,$2,$2,'not-used','Recovery provisioning fixture','active')`,
        [id, `${id}@example.test`],
      );
    }
    await fixture.admin.query(
      `insert into platform.platform_admin_assignments(user_id,status) values($1,'active')`,
      [adminId],
    );
    await fixture.admin.query(
      `insert into ledger.stores(id,name,status) values($1,'Recovery auth Store','active')`,
      [authStoreId],
    );
    await fixture.admin.query(
      `insert into platform.store_memberships(id,store_id,user_id,role,status)
       values($1,$2,$3,'owner','active')`,
      [randomUUID(), authStoreId, adminId],
    );
    authPool = createTestPool(
      withDatabase(environment.authUrl, fixture.databaseName),
      'dokana-r1-auth',
    );
    const auth = new AuthenticationDatabaseService(authPool, logger);
    async function authenticate() {
      const principal = await auth.issueSession({
        userId: adminId,
        storeId: authStoreId,
        deviceId: randomUUID(),
        deviceName: 'Recovery provisioning',
        devicePlatform: 'android',
        sessionId: randomUUID(),
        accessTokenJti: randomUUID(),
        refreshTokenId: randomUUID(),
        refreshTokenHash: randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
        refreshFamilyId: randomUUID(),
        sessionExpiresAt: new Date(Date.now() + 3_600_000),
        refreshExpiresAt: new Date(Date.now() + 3_600_000),
      });
      if (!principal) throw new Error('Recovery provisioning authentication failed.');
      return principal;
    }
    oldGeneration = (await authenticate()).recoveryGenerationId;
    await fenceRecoveryControl(migrationUrl, oldGeneration);
    const activated = await activateRecoveryControl(migrationUrl, oldGeneration);
    const principal = await authenticate();
    expect(principal.recoveryGenerationId).toBe(activated.recoveryGenerationId);
    expect(principal.recoveryGenerationId).not.toBe(oldGeneration);
    context = {
      storeId: principal.storeId,
      userId: principal.userId,
      deviceId: principal.deviceId,
      requestId: randomUUID(),
      recoveryGenerationId: principal.recoveryGenerationId,
    };
  });

  afterAll(async () => {
    await authPool?.end();
    await closeFixture?.();
  });

  it('provisions exactly once through Platform Admin with newly authenticated recovery authority', async () => {
    const input = command();
    const result = await service.provisionStore(context, input);
    expect(result).toMatchObject({ operationId: input.operationId, replayed: false });
    const beforeReplay = await state();
    const replay = await service.provisionStore({ ...context, requestId: randomUUID() }, input);
    expect(replay).toEqual({ ...result, replayed: true });
    expect(await state()).toEqual(beforeReplay);
    await expectOneFoundation(result.storeId, input.operationId);
  });

  it.each(['stale', 'missing'] as const)(
    'rejects %s authority without any provisioning, audit, or sync residue',
    async (kind) => {
      const before = await state();
      await expect(
        service.provisionStore(
          { ...context, recoveryGenerationId: kind === 'stale' ? oldGeneration : undefined },
          command(),
        ),
      ).rejects.toMatchObject({ response: { code: 'PLATFORM_LIFECYCLE_CONFLICT' } });
      expect(await state()).toEqual(before);
    },
  );

  it('holds admitted provisioning authority through commit and blocks new provisioning after fencing', async () => {
    const blocker = await fixture.admin.connect();
    let provision: Promise<Record<string, unknown>> | undefined;
    let fence: ReturnType<typeof fenceRecoveryControl> | undefined;
    try {
      await blocker.query('begin');
      await blocker.query('select id from platform.users where id=$1 for update', [ownerId]);
      const blockerPid = (await blocker.query<{ pid: number }>('select pg_backend_pid() as pid'))
        .rows[0]?.pid;
      const input = command();
      provision = service.provisionStore(context, input);
      void provision.catch(() => undefined);
      // The real provisioning SQL waits for the Owner row after acquiring recovery authority.
      const admittedPid = await waitForBlockedBackend(fixture.admin, blockerPid, 'ShareLock', true);
      const generation = context.recoveryGenerationId;
      if (!generation) throw new Error('Authenticated generation is missing.');
      fence = fenceRecoveryControl(migrationUrl, generation);
      void fence.catch(() => undefined);
      await waitForBlockedBackend(fixture.admin, admittedPid, 'ExclusiveLock', false);
      // Observe committed state without joining the recovery lock queue ourselves.
      const control = await fixture.admin.query<{ state: string }>(
        'select service_state as state from platform.recovery_control',
      );
      expect(control.rows[0]?.state).toBe('ACTIVE');

      await blocker.query('commit');
      const result = await provision;
      expect((await fence).serviceState).toBe('FENCED');
      await expectOneFoundation(result.storeId, input.operationId);
      const before = await state();
      await expect(service.provisionStore(context, command())).rejects.toMatchObject({
        response: { code: 'PLATFORM_LIFECYCLE_CONFLICT' },
      });
      expect(await state()).toEqual(before);
    } finally {
      await blocker.query('rollback');
      blocker.release();
      await Promise.allSettled([provision, fence]);
    }
  });
});

async function waitForBlockedBackend(
  admin: Pool,
  blockerPid: number | undefined,
  advisoryMode: 'ShareLock' | 'ExclusiveLock',
  granted: boolean,
): Promise<number> {
  if (blockerPid === undefined) throw new Error('Expected database blocker PID.');
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await admin.query<{ pid: number }>(
      `select activity.pid from pg_stat_activity as activity
       join pg_locks as lock on lock.pid=activity.pid
       where activity.datname=current_database()
         and $1::integer=any(pg_blocking_pids(activity.pid))
         and lock.locktype='advisory' and lock.mode=$2 and lock.granted=$3`,
      [blockerPid, advisoryMode, granted],
    );
    const pid = result.rows[0]?.pid;
    if (pid !== undefined) return pid;
    await delay(20);
  }
  throw new Error('Expected PostgreSQL lock dependency was not observed.');
}
