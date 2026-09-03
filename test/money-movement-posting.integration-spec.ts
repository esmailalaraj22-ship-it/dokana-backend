import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { Pool } from 'pg';

import { deriveAccountingPeriodId } from '../src/accounting-periods/accounting-period-identity';
import { resolveAccountingPeriodBoundaries } from '../src/accounting-periods/accounting-period-month';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import type { TenantTransactionContext } from '../src/database/database.types';
import { MoneyAccountBalanceReadRepository } from '../src/money-movements/money-account-balance-read.repository';
import { MoneyMovementPostingService } from '../src/money-movements/money-movement-posting.service';
import type { MoneyMovementEffectInput } from '../src/money-movements/money-movement.types';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();

const fixture = {
  stores: {
    active: '9a000000-0000-4000-8000-000000000001',
    readOnly: '9a000000-0000-4000-8000-000000000002',
    concurrent: '9a000000-0000-4000-8000-000000000003',
  },
  users: {
    active: '9a100000-0000-4000-8000-000000000001',
    readOnly: '9a100000-0000-4000-8000-000000000002',
    concurrent: '9a100000-0000-4000-8000-000000000003',
  },
  memberships: {
    active: '9a200000-0000-4000-8000-000000000001',
    readOnly: '9a200000-0000-4000-8000-000000000002',
    concurrent: '9a200000-0000-4000-8000-000000000003',
  },
  devices: {
    active: '9a300000-0000-4000-8000-000000000001',
    readOnly: '9a300000-0000-4000-8000-000000000002',
    concurrent: '9a300000-0000-4000-8000-000000000003',
  },
  accounts: {
    cash: '9a400000-0000-4000-8000-000000000001',
    transfer: '9a400000-0000-4000-8000-000000000002',
    archived: '9a400000-0000-4000-8000-000000000003',
    concurrentOne: '9a400000-0000-4000-8000-000000000004',
    concurrentTwo: '9a400000-0000-4000-8000-000000000005',
    readOnly: '9a400000-0000-4000-8000-000000000006',
  },
};

type FixtureKey = keyof typeof fixture.stores;

const storeIds = Object.values(fixture.stores);
const userIds = Object.values(fixture.users);
const membershipIds = Object.values(fixture.memberships);
const januaryPeriod = deriveAccountingPeriodId(fixture.stores.active, 2026, 1);
const concurrentJanuaryPeriod = deriveAccountingPeriodId(fixture.stores.concurrent, 2026, 1);
const closedFebruaryPeriod = deriveAccountingPeriodId(fixture.stores.active, 2026, 2);

class NullLogDestination implements DestinationStream {
  write(): void {
    return;
  }
}

describe('Money Movement Authority with real PostgreSQL', () => {
  jest.setTimeout(120_000);

  let app: INestApplication | undefined;
  let adminPool: Pool;
  let posting: MoneyMovementPostingService;
  let balances: MoneyAccountBalanceReadRepository;
  let poolInitialized = false;

  function context(key: FixtureKey): TenantTransactionContext {
    return {
      storeId: fixture.stores[key],
      userId: fixture.users[key],
      deviceId: fixture.devices[key],
      requestId: randomUUID(),
    };
  }

  function singleEffect(
    overrides: Partial<MoneyMovementEffectInput> = {},
  ): MoneyMovementEffectInput {
    return {
      discriminator: 'primary',
      accountId: fixture.accounts.cash,
      amountDeltaMinor: 150_000n,
      movementType: 'other',
      referenceType: 'test',
      referenceId: randomUUID(),
      ...overrides,
    };
  }

  function command(
    effects: MoneyMovementEffectInput[],
    overrides: {
      operationId?: string;
      action?: string;
      requestHash?: string;
      occurredAt?: Date;
    } = {},
  ) {
    const operationId = overrides.operationId ?? randomUUID();
    return {
      operationId,
      action: overrides.action ?? 'money.test.post',
      requestHash: overrides.requestHash ?? `hash-${operationId}`,
      occurredAt: overrides.occurredAt ?? new Date('2026-01-15T10:00:00Z'),
      effects,
    };
  }

  async function movementCount(storeId: string): Promise<number> {
    const result = await adminPool.query<{ count: number }>(
      'select count(*)::integer as count from ledger.money_movements where store_id = $1',
      [storeId],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function appliedOperations(storeId: string): Promise<number> {
    const result = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count from sync.processed_operations
       where store_id = $1 and status = 'applied'`,
      [storeId],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function removeFixtures(): Promise<void> {
    await adminPool.query(
      'delete from sync.processed_operations where store_id = any($1::uuid[])',
      [storeIds],
    );
    await adminPool.query('delete from sync.change_events where store_id = any($1::uuid[])', [
      storeIds,
    ]);
    await adminPool.query('delete from sync.conflicts where store_id = any($1::uuid[])', [
      storeIds,
    ]);
    await adminPool.query('delete from audit.central_audit_logs where store_id = any($1::uuid[])', [
      storeIds,
    ]);
    await adminPool.query('delete from ledger.money_movements where store_id = any($1::uuid[])', [
      storeIds,
    ]);
    await adminPool.query('delete from ledger.money_accounts where store_id = any($1::uuid[])', [
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

  async function insertPeriod(
    storeId: string,
    id: string,
    year: number,
    month: number,
    status: 'open' | 'closed',
  ): Promise<void> {
    const boundaries = resolveAccountingPeriodBoundaries(year, month);
    await adminPool.query(
      `insert into ledger.accounting_periods (
         id, store_id, period_year, period_month, starts_at, ends_at, status, closed_at, operation_id, version
       ) values ($1,$2,$3,$4,$5,$6,$7,
         case when $7 = 'closed' then '2026-08-01T08:00:00Z'::timestamptz else null end, $8, 1)`,
      [id, storeId, year, month, boundaries.startsAt, boundaries.endsAt, status, randomUUID()],
    );
  }

  async function insertAccount(
    storeId: string,
    id: string,
    name: string,
    accountType: 'cash' | 'transfer',
    status: 'active' | 'archived',
  ): Promise<void> {
    await adminPool.query(
      `insert into ledger.money_accounts (
         id, store_id, name, normalized_name, account_type, availability, is_default, status, archived_at, operation_id, version
       ) values ($1,$2,$3,$4,$5,'available',$6,$7,
         case when $7 = 'archived' then now() else null end, $8, 1)`,
      [
        id,
        storeId,
        name,
        name.toLowerCase(),
        accountType,
        accountType === 'cash',
        status,
        randomUUID(),
      ],
    );
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
      'dokana-s102-admin',
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
        ((select count(*) from ledger.money_movements)
          + (select count(*) from ledger.accounting_periods)
          + (select count(*) from ledger.money_accounts))::integer as "accountingRows"
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
      throw new Error('The local S10.2 mutation fixture database is not approved.');
    }

    await removeFixtures();
    const keys = Object.keys(fixture.stores) as FixtureKey[];
    for (const [index, key] of keys.entries()) {
      const storeStatus = key === 'readOnly' ? 'read_only' : 'active';
      await adminPool.query('insert into ledger.stores (id, name, status) values ($1, $2, $3)', [
        fixture.stores[key],
        `S10.2 ${key} store`,
        storeStatus,
      ]);
      await adminPool.query(
        `insert into platform.users (id, email, normalized_email, password_hash, full_name, status)
         values ($1, $2, $2, 'test-only-hash', $3, 'active')`,
        [fixture.users[key], `s102-${key.toLowerCase()}@example.test`, `S10.2 ${key}`],
      );
      await adminPool.query(
        `insert into platform.store_memberships (id, store_id, user_id, role, status)
         values ($1, $2, $3, 'owner', 'active')`,
        [fixture.memberships[key], fixture.stores[key], fixture.users[key]],
      );
      await adminPool.query(
        `insert into ledger.devices (id, store_id, device_name, platform, installation_id, device_prefix, status)
         values ($1, $2, $3, 'android', $4, $5, 'active')`,
        [
          fixture.devices[key],
          fixture.stores[key],
          `S10.2 ${key} device`,
          randomUUID(),
          `s2${index.toString()}`,
        ],
      );
    }

    await insertPeriod(fixture.stores.active, januaryPeriod, 2026, 1, 'open');
    await insertPeriod(fixture.stores.active, closedFebruaryPeriod, 2026, 2, 'closed');
    await insertPeriod(fixture.stores.concurrent, concurrentJanuaryPeriod, 2026, 1, 'open');
    await insertAccount(fixture.stores.active, fixture.accounts.cash, 'cash', 'cash', 'active');
    await insertAccount(
      fixture.stores.active,
      fixture.accounts.transfer,
      'bank',
      'transfer',
      'active',
    );
    await insertAccount(
      fixture.stores.active,
      fixture.accounts.archived,
      'old',
      'transfer',
      'archived',
    );
    await insertAccount(
      fixture.stores.concurrent,
      fixture.accounts.concurrentOne,
      'one',
      'transfer',
      'active',
    );
    await insertAccount(
      fixture.stores.concurrent,
      fixture.accounts.concurrentTwo,
      'two',
      'transfer',
      'active',
    );
    await insertAccount(
      fixture.stores.readOnly,
      fixture.accounts.readOnly,
      'cash',
      'cash',
      'active',
    );

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
    posting = nestApp.get(MoneyMovementPostingService);
    balances = nestApp.get(MoneyAccountBalanceReadRepository);
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
        ((select count(*) from ledger.money_movements where store_id = any($1::uuid[]))
          + (select count(*) from ledger.money_accounts where store_id = any($1::uuid[]))
          + (select count(*) from ledger.accounting_periods where store_id = any($1::uuid[]))
          + (select count(*) from sync.processed_operations where store_id = any($1::uuid[]))
          + (select count(*) from sync.conflicts where store_id = any($1::uuid[]))
          + (select count(*) from ledger.devices where store_id = any($1::uuid[]))
          + (select count(*) from platform.store_memberships where id = any($2::uuid[]))
          + (select count(*) from platform.users where id = any($3::uuid[]))
          + (select count(*) from ledger.stores where id = any($1::uuid[])))::integer as "fixtureRows",
        (select count(*)::integer from platform.users) as users,
        (select count(*)::integer from ledger.stores) as stores,
        ((select count(*) from ledger.money_movements)
          + (select count(*) from ledger.money_accounts)
          + (select count(*) from ledger.accounting_periods))::integer as "accountingRows",
        (select count(*)::integer from pg_stat_activity
          where datname = current_database() and state = 'idle in transaction') as "idleTransactions"`,
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

  it('posts an immutable movement resolved through S9 and reflects it in the derived balance', async () => {
    const activeContext = context('active');
    const response = await posting.post(
      activeContext,
      command([singleEffect({ amountDeltaMinor: 150_000n })]),
    );

    expect(response.postingDate).toBe('2026-01-15');
    expect(response.accountingPeriodId).toBe(januaryPeriod);
    expect(response.movements).toHaveLength(1);
    expect(response.movements[0]?.amountDeltaMinor).toBe('150000');

    const balance = await balances.readBalanceMinor(activeContext, fixture.accounts.cash);
    expect(balance).toBe(150_000n);
  });

  it('returns the stored snapshot on exact replay without creating a duplicate movement', async () => {
    const activeContext = context('active');
    const operationId = randomUUID();
    const posted = await posting.post(
      activeContext,
      command([singleEffect({ amountDeltaMinor: 40_000n })], { operationId }),
    );
    const before = await movementCount(fixture.stores.active);

    const replay = await posting.post(
      activeContext,
      command([singleEffect({ amountDeltaMinor: 40_000n })], { operationId }),
    );

    expect(replay).toEqual(posted);
    expect(await movementCount(fixture.stores.active)).toBe(before);
  });

  it('rejects a reused operationId carrying a different canonical request', async () => {
    const activeContext = context('active');
    const operationId = randomUUID();
    await posting.post(
      activeContext,
      command([singleEffect({ amountDeltaMinor: 10_000n })], { operationId, requestHash: 'first' }),
    );

    await expect(
      posting.post(
        activeContext,
        command([singleEffect({ amountDeltaMinor: 10_000n })], {
          operationId,
          requestHash: 'second',
        }),
      ),
    ).rejects.toMatchObject({ response: { code: 'OPERATION_ID_CONFLICT' } });
  });

  it('rejects a new posting to an archived account and writes no movement', async () => {
    const activeContext = context('active');
    const before = await movementCount(fixture.stores.active);
    await expect(
      posting.post(
        activeContext,
        command([singleEffect({ accountId: fixture.accounts.archived })]),
      ),
    ).rejects.toMatchObject({ response: { code: 'MONEY_ACCOUNT_UNAVAILABLE' } });
    expect(await movementCount(fixture.stores.active)).toBe(before);
  });

  it('rejects new posting from a read_only Store', async () => {
    const readOnlyContext = context('readOnly');
    await expect(
      posting.post(
        readOnlyContext,
        command([singleEffect({ accountId: fixture.accounts.readOnly })]),
      ),
    ).rejects.toMatchObject({ response: { code: 'BUSINESS_WRITE_NOT_ALLOWED' } });
    expect(await movementCount(fixture.stores.readOnly)).toBe(0);
  });

  it('rejects posting into a closed accounting period', async () => {
    const activeContext = context('active');
    await expect(
      posting.post(
        activeContext,
        command([singleEffect({ amountDeltaMinor: 5_000n })], {
          occurredAt: new Date('2026-02-15T12:00:00Z'),
        }),
      ),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE' } });
  });

  it('posts a multi-effect net-zero pair atomically under one transaction group', async () => {
    const activeContext = context('active');
    const response = await posting.post(
      activeContext,
      command([
        singleEffect({
          discriminator: 'transfer-source',
          accountId: fixture.accounts.cash,
          amountDeltaMinor: -25_000n,
          movementType: 'internal_transfer',
        }),
        singleEffect({
          discriminator: 'transfer-destination',
          accountId: fixture.accounts.transfer,
          amountDeltaMinor: 25_000n,
          movementType: 'internal_transfer',
        }),
      ]),
    );

    expect(response.movements).toHaveLength(2);
    const groups = new Set(response.movements.map((movement) => movement.transactionGroupId));
    expect(groups.size).toBe(1);
    const sum = response.movements.reduce(
      (total, movement) => total + BigInt(movement.amountDeltaMinor),
      0n,
    );
    expect(sum).toBe(0n);
  });

  it('rolls back every effect when one effect references a missing account', async () => {
    const activeContext = context('active');
    const before = await movementCount(fixture.stores.active);
    const appliedBefore = await appliedOperations(fixture.stores.active);

    await expect(
      posting.post(
        activeContext,
        command([
          singleEffect({ discriminator: 'a', accountId: fixture.accounts.cash }),
          singleEffect({ discriminator: 'b', accountId: randomUUID() }),
        ]),
      ),
    ).rejects.toMatchObject({ response: { code: 'MONEY_ACCOUNT_NOT_FOUND' } });

    expect(await movementCount(fixture.stores.active)).toBe(before);
    expect(await appliedOperations(fixture.stores.active)).toBe(appliedBefore);
  });

  it('allows a derived balance to go negative', async () => {
    const activeContext = context('active');
    const before =
      (await balances.readBalanceMinor(activeContext, fixture.accounts.transfer)) ?? 0n;
    await posting.post(
      activeContext,
      command([
        singleEffect({
          accountId: fixture.accounts.transfer,
          amountDeltaMinor: -1_000_000n,
          movementType: 'owner_withdrawal',
        }),
      ]),
    );
    const after = await balances.readBalanceMinor(activeContext, fixture.accounts.transfer);
    expect(after).toBe(before - 1_000_000n);
    expect(after).toBeLessThan(0n);
  });

  it('serializes concurrent opposite-direction transfers without deadlock (canonical lock order)', async () => {
    const concurrentContext = context('concurrent');
    const forward = posting.post(
      concurrentContext,
      command(
        [
          singleEffect({
            discriminator: 'transfer-source',
            accountId: fixture.accounts.concurrentOne,
            amountDeltaMinor: -3_000n,
            movementType: 'internal_transfer',
          }),
          singleEffect({
            discriminator: 'transfer-destination',
            accountId: fixture.accounts.concurrentTwo,
            amountDeltaMinor: 3_000n,
            movementType: 'internal_transfer',
          }),
        ],
        { action: 'money.test.transfer' },
      ),
    );
    const backward = posting.post(
      concurrentContext,
      command(
        [
          singleEffect({
            discriminator: 'transfer-source',
            accountId: fixture.accounts.concurrentTwo,
            amountDeltaMinor: -1_000n,
            movementType: 'internal_transfer',
          }),
          singleEffect({
            discriminator: 'transfer-destination',
            accountId: fixture.accounts.concurrentOne,
            amountDeltaMinor: 1_000n,
            movementType: 'internal_transfer',
          }),
        ],
        { action: 'money.test.transfer' },
      ),
    );

    await expect(Promise.all([forward, backward])).resolves.toHaveLength(2);

    const one = await balances.readBalanceMinor(concurrentContext, fixture.accounts.concurrentOne);
    const two = await balances.readBalanceMinor(concurrentContext, fixture.accounts.concurrentTwo);
    expect(one).toBe(-2_000n);
    expect(two).toBe(2_000n);
  });
});
