import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { Pool } from 'pg';

import { deriveAccountingPeriodId } from '../src/accounting-periods/accounting-period-identity';
import { resolveAccountingPeriodBoundaries } from '../src/accounting-periods/accounting-period-month';
import {
  AccountingPeriodNotPostingEligibleError,
  AccountingPeriodPostingContextService,
} from '../src/accounting-periods/accounting-period-posting-context.service';
import type { AccountingPeriodPostingContext } from '../src/accounting-periods/accounting-period-posting-context.types';
import { AccountingPeriodIntegrityError } from '../src/accounting-periods/accounting-period-provisioning.service';
import type { AccountingPeriodStatus } from '../src/accounting-periods/accounting-period.types';
import { AccountingPeriodWriteService } from '../src/accounting-periods/accounting-period-write.service';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import { DatabaseService } from '../src/database/database.service';
import type { TenantTransactionContext } from '../src/database/database.types';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const fixture = {
  stores: {
    active: '97000000-0000-4000-8000-000000000001',
    readOnly: '97000000-0000-4000-8000-000000000002',
    concurrent: '97000000-0000-4000-8000-000000000003',
    rollback: '97000000-0000-4000-8000-000000000004',
    corrupt: '97000000-0000-4000-8000-000000000005',
    tenantB: '97000000-0000-4000-8000-000000000006',
  },
  users: {
    active: '97100000-0000-4000-8000-000000000001',
    readOnly: '97100000-0000-4000-8000-000000000002',
    concurrent: '97100000-0000-4000-8000-000000000003',
    rollback: '97100000-0000-4000-8000-000000000004',
    corrupt: '97100000-0000-4000-8000-000000000005',
    tenantB: '97100000-0000-4000-8000-000000000006',
  },
  memberships: {
    active: '97200000-0000-4000-8000-000000000001',
    readOnly: '97200000-0000-4000-8000-000000000002',
    concurrent: '97200000-0000-4000-8000-000000000003',
    rollback: '97200000-0000-4000-8000-000000000004',
    corrupt: '97200000-0000-4000-8000-000000000005',
    tenantB: '97200000-0000-4000-8000-000000000006',
  },
  devices: {
    active: '97300000-0000-4000-8000-000000000001',
    readOnly: '97300000-0000-4000-8000-000000000002',
    concurrent: '97300000-0000-4000-8000-000000000003',
    rollback: '97300000-0000-4000-8000-000000000004',
    corrupt: '97300000-0000-4000-8000-000000000005',
    tenantB: '97300000-0000-4000-8000-000000000006',
  },
};

type FixtureKey = keyof typeof fixture.stores;

interface PeriodFixture {
  id: string;
  storeId: string;
  periodYear: number;
  periodMonth: number;
  status: AccountingPeriodStatus;
  operationId: string;
}

interface PersistedPeriod {
  id: string;
  status: AccountingPeriodStatus;
  operationId: string;
}

const periodIds = {
  activeExisting: deriveAccountingPeriodId(fixture.stores.active, 2026, 1),
  activeClosed: deriveAccountingPeriodId(fixture.stores.active, 2026, 2),
  activeClosing: deriveAccountingPeriodId(fixture.stores.active, 2026, 3),
  postingFirst: deriveAccountingPeriodId(fixture.stores.active, 2026, 4),
  closeFirst: deriveAccountingPeriodId(fixture.stores.active, 2026, 5),
  tenantB: deriveAccountingPeriodId(fixture.stores.tenantB, 2026, 6),
  readOnlyExisting: deriveAccountingPeriodId(fixture.stores.readOnly, 2026, 7),
  activeMissing: deriveAccountingPeriodId(fixture.stores.active, 2026, 8),
  concurrent: deriveAccountingPeriodId(fixture.stores.concurrent, 2026, 9),
  rollback: deriveAccountingPeriodId(fixture.stores.rollback, 2026, 10),
  corrupt: '97400000-0000-4000-8000-000000000099',
};

const periodFixtures: PeriodFixture[] = [
  {
    id: periodIds.activeExisting,
    storeId: fixture.stores.active,
    periodYear: 2026,
    periodMonth: 1,
    status: 'open',
    operationId: '97400000-0000-4000-8000-000000000001',
  },
  {
    id: periodIds.activeClosed,
    storeId: fixture.stores.active,
    periodYear: 2026,
    periodMonth: 2,
    status: 'closed',
    operationId: '97400000-0000-4000-8000-000000000002',
  },
  {
    id: periodIds.activeClosing,
    storeId: fixture.stores.active,
    periodYear: 2026,
    periodMonth: 3,
    status: 'closing',
    operationId: '97400000-0000-4000-8000-000000000003',
  },
  {
    id: periodIds.postingFirst,
    storeId: fixture.stores.active,
    periodYear: 2026,
    periodMonth: 4,
    status: 'open',
    operationId: '97400000-0000-4000-8000-000000000004',
  },
  {
    id: periodIds.closeFirst,
    storeId: fixture.stores.active,
    periodYear: 2026,
    periodMonth: 5,
    status: 'open',
    operationId: '97400000-0000-4000-8000-000000000005',
  },
  {
    id: periodIds.tenantB,
    storeId: fixture.stores.tenantB,
    periodYear: 2026,
    periodMonth: 6,
    status: 'open',
    operationId: '97400000-0000-4000-8000-000000000006',
  },
  {
    id: periodIds.readOnlyExisting,
    storeId: fixture.stores.readOnly,
    periodYear: 2026,
    periodMonth: 7,
    status: 'open',
    operationId: '97400000-0000-4000-8000-000000000007',
  },
  {
    id: periodIds.corrupt,
    storeId: fixture.stores.corrupt,
    periodYear: 2026,
    periodMonth: 11,
    status: 'open',
    operationId: '97400000-0000-4000-8000-000000000008',
  },
];

class NullLogDestination implements DestinationStream {
  write(): void {
    return;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe('Accounting Period posting context with real PostgreSQL', () => {
  jest.setTimeout(120_000);

  const fixtureKeys = Object.keys(fixture.stores) as FixtureKey[];
  const storeIds = Object.values(fixture.stores);
  const userIds = Object.values(fixture.users);
  const membershipIds = Object.values(fixture.memberships);
  let app: INestApplication | undefined;
  let adminPool: Pool;
  let database: DatabaseService;
  let resolver: AccountingPeriodPostingContextService;
  let periodWrites: AccountingPeriodWriteService;
  let poolInitialized = false;

  function context(key: FixtureKey): TenantTransactionContext {
    return {
      storeId: fixture.stores[key],
      userId: fixture.users[key],
      deviceId: fixture.devices[key],
      requestId: randomUUID(),
    };
  }

  function ownerPrincipal(key: FixtureKey) {
    return {
      membershipRole: 'owner' as const,
      storeId: fixture.stores[key],
      userId: fixture.users[key],
      deviceId: fixture.devices[key],
    };
  }

  async function removeFixtures(): Promise<void> {
    await adminPool.query(
      'delete from sync.processed_operations where store_id = any($1::uuid[])',
      [storeIds],
    );
    await adminPool.query('delete from sync.change_events where store_id = any($1::uuid[])', [
      storeIds,
    ]);
    await adminPool.query('delete from audit.central_audit_logs where store_id = any($1::uuid[])', [
      storeIds,
    ]);
    await adminPool.query(
      'delete from ledger.accounting_periods where store_id = any($1::uuid[])',
      [storeIds],
    );
    await adminPool.query('delete from ledger.devices where store_id = any($1::uuid[])', [
      storeIds,
    ]);
    await adminPool.query('delete from platform.store_memberships where id = any($1::uuid[])', [
      membershipIds,
    ]);
    await adminPool.query('delete from platform.users where id = any($1::uuid[])', [userIds]);
    await adminPool.query('delete from ledger.stores where id = any($1::uuid[])', [storeIds]);
  }

  async function insertPeriod(period: PeriodFixture): Promise<void> {
    const boundaries = resolveAccountingPeriodBoundaries(period.periodYear, period.periodMonth);
    await adminPool.query(
      `insert into ledger.accounting_periods (
         id, store_id, period_year, period_month, starts_at, ends_at, status,
         closed_at, operation_id, version
       ) values (
         $1, $2, $3, $4, $5, $6, $7,
         case when $7 = 'closed' then '2026-08-01T08:00:00Z'::timestamptz else null end,
         $8, 1
       )`,
      [
        period.id,
        period.storeId,
        period.periodYear,
        period.periodMonth,
        boundaries.startsAt,
        boundaries.endsAt,
        period.status,
        period.operationId,
      ],
    );
  }

  async function readPeriod(storeId: string, periodId: string): Promise<PersistedPeriod | null> {
    const result = await adminPool.query<PersistedPeriod>(
      `select id::text, status, operation_id::text as "operationId"
       from ledger.accounting_periods where store_id = $1 and id = $2`,
      [storeId, periodId],
    );
    return result.rows[0] ?? null;
  }

  async function readPeriodCount(storeId: string, periodYear: number, periodMonth: number) {
    const result = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.accounting_periods
       where store_id = $1 and period_year = $2 and period_month = $3`,
      [storeId, periodYear, periodMonth],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function readEffects(storeId: string, periodId: string) {
    const result = await adminPool.query<{ changeEvents: number; auditLogs: number }>(
      `select
         (select count(*)::integer from sync.change_events
          where store_id = $1 and entity_type = 'accounting_periods' and entity_id = $2)
           as "changeEvents",
         (select count(*)::integer from audit.central_audit_logs
          where store_id = $1 and entity_type = 'ledger.accounting_periods' and entity_id = $2)
           as "auditLogs"`,
      [storeId, periodId],
    );
    return result.rows[0];
  }

  beforeAll(async () => {
    if (!environment) {
      throw new Error('The approved local PostgreSQL test environment is unavailable.');
    }
    process.env.APP_ENV = 'test';
    process.env.LOG_LEVEL = 'info';
    process.env.DATABASE_URL = environment.runtimeUrl;
    process.env.AUTH_DATABASE_URL = environment.authUrl;
    process.env.DB_POOL_MAX = '12';

    adminPool = createTestPool(
      environment.adminUrl,
      'dokana-task95-admin',
      2,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    poolInitialized = true;

    const approval = await adminPool.query<{
      databaseName: string;
      isSuperuser: boolean;
      users: number;
      stores: number;
      accountingRows: number;
    }>(`
      select current_database() as "databaseName", role_state.rolsuper as "isSuperuser",
        (select count(*)::integer from platform.users) as users,
        (select count(*)::integer from ledger.stores) as stores,
        ((select count(*) from ledger.accounting_periods)
          + (select count(*) from ledger.sales)
          + (select count(*) from ledger.purchase_invoices)
          + (select count(*) from ledger.customer_payments)
          + (select count(*) from ledger.supplier_payments)
          + (select count(*) from ledger.expenses)
          + (select count(*) from ledger.money_movements)
          + (select count(*) from ledger.inventory_movements)
          + (select count(*) from ledger.stock_balances)
          + (select count(*) from ledger.stock_counts))::integer as "accountingRows"
      from pg_roles as role_state where role_state.rolname = current_user
    `);
    const approved = approval.rows[0];
    if (
      approved?.databaseName !== environment.databaseName ||
      !approved.isSuperuser ||
      approved.users !== 0 ||
      approved.stores !== 0 ||
      approved.accountingRows !== 0
    ) {
      throw new Error('The local S9.5 mutation fixture database is not approved.');
    }

    await removeFixtures();
    for (const [index, key] of fixtureKeys.entries()) {
      const storeStatus = key === 'readOnly' ? 'read_only' : 'active';
      const email = `task95-${key.toLowerCase()}@example.test`;
      await adminPool.query('insert into ledger.stores (id, name, status) values ($1, $2, $3)', [
        fixture.stores[key],
        `Task 9.5 ${key} store`,
        storeStatus,
      ]);
      await adminPool.query(
        `insert into platform.users (
           id, email, normalized_email, password_hash, full_name, status
         ) values ($1, $2, $2, 'test-only-hash', $3, 'active')`,
        [fixture.users[key], email, `Task 9.5 ${key}`],
      );
      await adminPool.query(
        `insert into platform.store_memberships (id, store_id, user_id, role, status)
         values ($1, $2, $3, 'owner', 'active')`,
        [fixture.memberships[key], fixture.stores[key], fixture.users[key]],
      );
      await adminPool.query(
        `insert into ledger.devices (
           id, store_id, device_name, platform, installation_id, device_prefix, status
         ) values ($1, $2, $3, 'android', $4, $5, 'active')`,
        [
          fixture.devices[key],
          fixture.stores[key],
          `Task 9.5 ${key} device`,
          randomUUID(),
          `t95${index.toString()}`,
        ],
      );
    }
    for (const period of periodFixtures) {
      await insertPeriod(period);
    }

    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PARAMS_PROVIDER_TOKEN)
      .useFactory({
        factory: (config: AppConfigService) =>
          createLoggingParams(config, new NullLogDestination()),
        inject: [AppConfigService],
      })
      .compile();
    const nestApp = module.createNestApplication();
    nestApp.useLogger(nestApp.get(Logger));
    await nestApp.init();
    app = nestApp;
    database = nestApp.get(DatabaseService);
    resolver = nestApp.get(AccountingPeriodPostingContextService);
    periodWrites = nestApp.get(AccountingPeriodWriteService);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    if (!poolInitialized) {
      return;
    }
    await removeFixtures();
    const residue = await adminPool.query<{
      fixtureRows: number;
      users: number;
      stores: number;
      accountingRows: number;
      idleTransactions: number;
    }>(
      `select
        ((select count(*) from sync.processed_operations where store_id = any($1::uuid[]))
          + (select count(*) from sync.change_events where store_id = any($1::uuid[]))
          + (select count(*) from audit.central_audit_logs where store_id = any($1::uuid[]))
          + (select count(*) from ledger.accounting_periods where store_id = any($1::uuid[]))
          + (select count(*) from ledger.devices where store_id = any($1::uuid[]))
          + (select count(*) from platform.store_memberships where id = any($2::uuid[]))
          + (select count(*) from platform.users where id = any($3::uuid[]))
          + (select count(*) from ledger.stores where id = any($1::uuid[])))::integer
            as "fixtureRows",
        (select count(*)::integer from platform.users) as users,
        (select count(*)::integer from ledger.stores) as stores,
        ((select count(*) from ledger.accounting_periods)
          + (select count(*) from ledger.sales)
          + (select count(*) from ledger.purchase_invoices)
          + (select count(*) from ledger.customer_payments)
          + (select count(*) from ledger.supplier_payments)
          + (select count(*) from ledger.expenses)
          + (select count(*) from ledger.money_movements)
          + (select count(*) from ledger.inventory_movements))::integer as "accountingRows",
        (select count(*)::integer from pg_stat_activity
          where datname = current_database() and state = 'idle in transaction')
            as "idleTransactions"`,
      [storeIds, membershipIds, userIds],
    );
    expect(residue.rows[0]).toEqual({
      fixtureRows: 0,
      users: 0,
      stores: 0,
      accountingRows: 0,
      idleTransactions: 0,
    });
    await adminPool.end();
  }, 30_000);

  it('resolves existing and newly ensured open periods for an active Store', async () => {
    const activeContext = context('active');
    const existing = await database.withTenantTransaction(activeContext, (transaction) =>
      resolver.resolveForWrite(transaction, activeContext, {
        postingDate: '2026-01-18',
        operationId: randomUUID(),
      }),
    );
    expect(existing).toEqual({
      storeId: fixture.stores.active,
      postingDate: '2026-01-18',
      accountingPeriodId: periodIds.activeExisting,
      periodYear: 2026,
      periodMonth: 1,
    });

    const ensureOperationId = randomUUID();
    const ensureContext = context('active');
    const created = await database.withTenantTransaction(ensureContext, (transaction) =>
      resolver.resolveForWrite(transaction, ensureContext, {
        postingDate: '2026-08-31',
        operationId: ensureOperationId,
      }),
    );
    expect(created.accountingPeriodId).toBe(periodIds.activeMissing);
    expect(await readPeriod(fixture.stores.active, periodIds.activeMissing)).toEqual({
      id: periodIds.activeMissing,
      status: 'open',
      operationId: ensureOperationId,
    });
    expect(await readEffects(fixture.stores.active, periodIds.activeMissing)).toEqual({
      changeEvents: 1,
      auditLogs: 1,
    });
  });

  it('rejects read-only Stores before reuse or provisioning', async () => {
    const readOnlyContext = context('readOnly');
    await expect(
      database.withTenantTransaction(readOnlyContext, (transaction) =>
        resolver.resolveForWrite(transaction, readOnlyContext, {
          postingDate: '2026-07-10',
          operationId: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ response: { code: 'BUSINESS_WRITE_NOT_ALLOWED' } });

    const missingId = deriveAccountingPeriodId(fixture.stores.readOnly, 2026, 8);
    const missingContext = context('readOnly');
    await expect(
      database.withTenantTransaction(missingContext, (transaction) =>
        resolver.resolveForWrite(transaction, missingContext, {
          postingDate: '2026-08-10',
          operationId: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ response: { code: 'BUSINESS_WRITE_NOT_ALLOWED' } });
    expect(await readPeriod(fixture.stores.readOnly, missingId)).toBeNull();
  });

  it.each([
    ['closed', '2026-02-10'],
    ['closing', '2026-03-10'],
  ] as const)(
    'rejects a committed %s period after acquiring its posting lock',
    async (status, date) => {
      const activeContext = context('active');
      await expect(
        database.withTenantTransaction(activeContext, (transaction) =>
          resolver.resolveForWrite(transaction, activeContext, {
            postingDate: date,
            operationId: randomUUID(),
          }),
        ),
      ).rejects.toMatchObject({
        code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE',
        periodStatus: status,
      });
    },
  );

  it('fails closed for missing context, cross-tenant substitution, and corrupt identity', async () => {
    const activeContext = context('active');
    await expect(
      database.transaction((transaction) =>
        resolver.resolveForWrite(transaction, activeContext, {
          postingDate: '2026-01-10',
          operationId: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ response: { code: 'BUSINESS_WRITE_NOT_ALLOWED' } });

    const tenantBContext = context('tenantB');
    await expect(
      database.withTenantTransaction(activeContext, (transaction) =>
        resolver.resolveForWrite(transaction, tenantBContext, {
          postingDate: '2026-06-10',
          operationId: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ response: { code: 'BUSINESS_WRITE_NOT_ALLOWED' } });

    const corruptContext = context('corrupt');
    await expect(
      database.withTenantTransaction(corruptContext, (transaction) =>
        resolver.resolveForWrite(transaction, corruptContext, {
          postingDate: '2026-11-10',
          operationId: randomUUID(),
        }),
      ),
    ).rejects.toBeInstanceOf(AccountingPeriodIntegrityError);
  });

  it('rolls back a newly ensured period with the owning transaction', async () => {
    const rollbackContext = context('rollback');
    const rollbackMarker = new Error('intentional owning transaction rollback');
    await expect(
      database.withTenantTransaction(rollbackContext, async (transaction) => {
        const resolved = await resolver.resolveForWrite(transaction, rollbackContext, {
          postingDate: '2026-10-10',
          operationId: randomUUID(),
        });
        expect(resolved.accountingPeriodId).toBe(periodIds.rollback);
        throw rollbackMarker;
      }),
    ).rejects.toBe(rollbackMarker);
    expect(await readPeriod(fixture.stores.rollback, periodIds.rollback)).toBeNull();
    expect(await readEffects(fixture.stores.rollback, periodIds.rollback)).toEqual({
      changeEvents: 0,
      auditLogs: 0,
    });
  });

  it('converges concurrent first use through S9.5 to one canonical period', async () => {
    const firstContext = context('concurrent');
    const secondContext = context('concurrent');
    const [first, second] = await Promise.all([
      database.withTenantTransaction(firstContext, (transaction) =>
        resolver.resolveForWrite(transaction, firstContext, {
          postingDate: '2026-09-01',
          operationId: randomUUID(),
        }),
      ),
      database.withTenantTransaction(secondContext, (transaction) =>
        resolver.resolveForWrite(transaction, secondContext, {
          postingDate: '2026-09-30',
          operationId: randomUUID(),
        }),
      ),
    ]);

    expect(first.accountingPeriodId).toBe(periodIds.concurrent);
    expect(second.accountingPeriodId).toBe(periodIds.concurrent);
    expect(await readPeriodCount(fixture.stores.concurrent, 2026, 9)).toBe(1);
    expect(await readEffects(fixture.stores.concurrent, periodIds.concurrent)).toEqual({
      changeEvents: 1,
      auditLogs: 1,
    });
  });

  it('holds the posting lock after resolver return until the caller commits', async () => {
    const postingContext = context('active');
    const ready = deferred<AccountingPeriodPostingContext>();
    const release = deferred<undefined>();
    const postingTransaction = database.withTenantTransaction(
      postingContext,
      async (transaction) => {
        try {
          const resolved = await resolver.resolveForWrite(transaction, postingContext, {
            postingDate: '2026-04-10',
            operationId: randomUUID(),
          });
          ready.resolve(resolved);
          await release.promise;
        } catch (error) {
          ready.reject(error);
          throw error;
        }
      },
    );

    const resolved = await ready.promise;
    expect(resolved.accountingPeriodId).toBe(periodIds.postingFirst);

    let closeSettled = false;
    const closeContext = context('active');
    const closePromise = periodWrites.close(
      ownerPrincipal('active'),
      closeContext,
      periodIds.postingFirst,
      { operationId: randomUUID(), expectedVersion: '1' },
    );
    closePromise.then(
      () => {
        closeSettled = true;
      },
      () => {
        closeSettled = true;
      },
    );

    try {
      await wait(250);
      expect(closeSettled).toBe(false);
      expect((await readPeriod(fixture.stores.active, periodIds.postingFirst))?.status).toBe(
        'open',
      );
    } finally {
      release.resolve(undefined);
    }

    await postingTransaction;
    await expect(closePromise).resolves.toMatchObject({
      id: periodIds.postingFirst,
      status: 'closed',
    });
    expect((await readPeriod(fixture.stores.active, periodIds.postingFirst))?.status).toBe(
      'closed',
    );
  });

  it('rejects posting context after close commits first', async () => {
    const closeContext = context('active');
    await expect(
      periodWrites.close(ownerPrincipal('active'), closeContext, periodIds.closeFirst, {
        operationId: randomUUID(),
        expectedVersion: '1',
      }),
    ).resolves.toMatchObject({ id: periodIds.closeFirst, status: 'closed' });

    const postingContext = context('active');
    await expect(
      database.withTenantTransaction(postingContext, (transaction) =>
        resolver.resolveForWrite(transaction, postingContext, {
          postingDate: '2026-05-10',
          operationId: randomUUID(),
        }),
      ),
    ).rejects.toBeInstanceOf(AccountingPeriodNotPostingEligibleError);
  });
});
