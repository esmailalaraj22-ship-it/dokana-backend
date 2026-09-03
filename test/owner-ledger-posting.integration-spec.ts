import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { Pool } from 'pg';

import { deriveAccountingPeriodId } from '../src/accounting-periods/accounting-period-identity';
import { resolveAccountingPeriodBoundaries } from '../src/accounting-periods/accounting-period-month';
import type { AuthenticatedPrincipal } from '../src/auth/auth.types';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import { DatabaseService } from '../src/database/database.service';
import type { TenantTransactionContext } from '../src/database/database.types';
import {
  deriveMoneyFactId,
  deriveMoneyFactOperationId,
} from '../src/money-movements/money-movement-identity';
import { postgresqlErrorCode } from '../src/money-movements/money-movement-database-error';
import { OwnerLedgerWriteService } from '../src/owner-ledger/owner-ledger-write.service';
import { OwnerPositionReadService } from '../src/owner-ledger/owner-position-read.service';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();

jest.setTimeout(120_000);

const fixture = {
  stores: {
    active: 'a1000000-0000-4000-8000-000000000001',
    tenantB: 'a1000000-0000-4000-8000-000000000002',
    readOnly: 'a1000000-0000-4000-8000-000000000003',
    openingRace: 'a1000000-0000-4000-8000-000000000004',
    reimbursementRace: 'a1000000-0000-4000-8000-000000000005',
    rollback: 'a1000000-0000-4000-8000-000000000006',
  },
  users: {
    active: 'a1100000-0000-4000-8000-000000000001',
    tenantB: 'a1100000-0000-4000-8000-000000000002',
    readOnly: 'a1100000-0000-4000-8000-000000000003',
    openingRace: 'a1100000-0000-4000-8000-000000000004',
    reimbursementRace: 'a1100000-0000-4000-8000-000000000005',
    rollback: 'a1100000-0000-4000-8000-000000000006',
  },
  devices: {
    active: 'a1200000-0000-4000-8000-000000000001',
    tenantB: 'a1200000-0000-4000-8000-000000000002',
    readOnly: 'a1200000-0000-4000-8000-000000000003',
    openingRace: 'a1200000-0000-4000-8000-000000000004',
    reimbursementRace: 'a1200000-0000-4000-8000-000000000005',
    rollback: 'a1200000-0000-4000-8000-000000000006',
  },
  accounts: {
    activeCash: 'a1300000-0000-4000-8000-000000000001',
    activeBank: 'a1300000-0000-4000-8000-000000000002',
    activeArchived: 'a1300000-0000-4000-8000-000000000003',
    positiveOpening: 'a1300000-0000-4000-8000-000000000004',
    negativeOpening: 'a1300000-0000-4000-8000-000000000005',
    tenantB: 'a1300000-0000-4000-8000-000000000006',
    readOnly: 'a1300000-0000-4000-8000-000000000007',
    openingRace: 'a1300000-0000-4000-8000-000000000008',
    reimbursementOne: 'a1300000-0000-4000-8000-000000000009',
    reimbursementTwo: 'a1300000-0000-4000-8000-000000000010',
    rollback: 'a1300000-0000-4000-8000-000000000011',
  },
};

type StoreKey = keyof typeof fixture.stores;

const storeIds = Object.values(fixture.stores);
const januaryPeriods = Object.fromEntries(
  Object.entries(fixture.stores).map(([key, storeId]) => [
    key,
    deriveAccountingPeriodId(storeId, 2026, 1),
  ]),
) as Record<StoreKey, string>;
const closedFebruaryPeriod = deriveAccountingPeriodId(fixture.stores.active, 2026, 2);

class NullLogDestination implements DestinationStream {
  write(): void {
    return;
  }
}

describe('Opening Balance and Owner Ledger with real PostgreSQL', () => {
  let app: INestApplication | undefined;
  let adminPool: Pool;
  let database: DatabaseService;
  let writes: OwnerLedgerWriteService;
  let positionReads: OwnerPositionReadService;
  let poolInitialized = false;

  function context(key: StoreKey): TenantTransactionContext {
    return {
      storeId: fixture.stores[key],
      userId: fixture.users[key],
      deviceId: fixture.devices[key],
      requestId: randomUUID(),
    };
  }

  function principal(
    key: StoreKey,
    membershipRole: AuthenticatedPrincipal['membershipRole'] = 'owner',
  ): Pick<AuthenticatedPrincipal, 'membershipRole' | 'storeId' | 'userId' | 'deviceId'> {
    return {
      membershipRole,
      storeId: fixture.stores[key],
      userId: fixture.users[key],
      deviceId: fixture.devices[key],
    };
  }

  function ownerRequest(
    accountId: string,
    amountMinor: string,
    overrides: Partial<{ operationId: string; occurredAt: string }> = {},
  ) {
    return {
      operationId: overrides.operationId ?? randomUUID(),
      moneyAccountId: accountId,
      amountMinor,
      occurredAt: overrides.occurredAt ?? '2026-01-15T10:00:00.000Z',
    };
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
         id, store_id, period_year, period_month, starts_at, ends_at, status, closed_at,
         operation_id, version
       ) values ($1,$2,$3,$4,$5,$6,$7,
         case when $7 = 'closed' then '2026-08-01T08:00:00Z'::timestamptz else null end,
         $8,1)`,
      [id, storeId, year, month, boundaries.startsAt, boundaries.endsAt, status, randomUUID()],
    );
  }

  async function insertAccount(
    storeId: string,
    id: string,
    name: string,
    accountType: 'cash' | 'transfer' = 'transfer',
    status: 'active' | 'archived' = 'active',
  ): Promise<void> {
    await adminPool.query(
      `insert into ledger.money_accounts (
         id, store_id, name, normalized_name, account_type, availability, is_default,
         status, archived_at, operation_id, version
       ) values ($1,$2,$3,$4,$5,'available',$6,$7,
         case when $7 = 'archived' then now() else null end,$8,1)`,
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

  async function movementCount(storeId: string, transactionGroupId?: string): Promise<number> {
    const result = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count
       from ledger.money_movements
       where store_id = $1 and ($2::uuid is null or transaction_group_id = $2::uuid)`,
      [storeId, transactionGroupId ?? null],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function ownerEntryCount(storeId: string, transactionGroupId?: string): Promise<number> {
    const result = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count
       from ledger.owner_ledger_entries
       where store_id = $1 and ($2::uuid is null or transaction_group_id = $2::uuid)`,
      [storeId, transactionGroupId ?? null],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function processedOperationCount(storeId: string, operationId: string): Promise<number> {
    const result = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count
       from sync.processed_operations
       where store_id = $1 and operation_id = $2`,
      [storeId, operationId],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function balance(storeId: string, accountId: string): Promise<bigint> {
    const result = await adminPool.query<{ balance: string }>(
      `select balance_minor::text as balance
       from ledger.v_money_account_balances
       where store_id = $1 and account_id = $2`,
      [storeId, accountId],
    );
    const value = result.rows[0]?.balance;
    if (value === undefined) {
      throw new Error('Fixture Money Account balance is missing.');
    }
    return BigInt(value);
  }

  async function ownerPosition(storeId: string): Promise<{
    liability: bigint;
    equity: bigint;
  }> {
    const result = await adminPool.query<{ liability: string; equity: string }>(
      `select store_owes_owner_minor::text as liability,
              owner_equity_movement_minor::text as equity
       from ledger.v_owner_position
       where store_id = $1`,
      [storeId],
    );
    return {
      liability: BigInt(result.rows[0]?.liability ?? '0'),
      equity: BigInt(result.rows[0]?.equity ?? '0'),
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
    await adminPool.query('delete from sync.conflicts where store_id = any($1::uuid[])', [
      storeIds,
    ]);
    await adminPool.query('delete from audit.central_audit_logs where store_id = any($1::uuid[])', [
      storeIds,
    ]);
    await adminPool.query(
      'delete from ledger.owner_ledger_entries where store_id = any($1::uuid[])',
      [storeIds],
    );
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
    await adminPool.query('delete from ledger.stores where id = any($1::uuid[])', [storeIds]);
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
      'dokana-s103-admin',
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
          + (select count(*) from ledger.owner_ledger_entries)
          + (select count(*) from ledger.accounting_periods)
          + (select count(*) from ledger.money_accounts))::integer as "accountingRows"
      from pg_roles as role_state
      where role_state.rolname = current_user
    `);
    const approved = approval.rows[0];
    if (
      approved?.databaseName !== environment.databaseName ||
      !approved.isSuperuser ||
      approved.users !== 0 ||
      approved.stores !== 0 ||
      approved.accountingRows !== 0
    ) {
      throw new Error('The local S10.3 mutation fixture database is not approved.');
    }

    await removeFixtures();
    const storeKeys = Object.keys(fixture.stores) as StoreKey[];
    for (const [index, key] of storeKeys.entries()) {
      await adminPool.query('insert into ledger.stores (id, name, status) values ($1,$2,$3)', [
        fixture.stores[key],
        `S10.3 ${key} store`,
        key === 'readOnly' ? 'read_only' : 'active',
      ]);
      await adminPool.query(
        `insert into ledger.devices (
           id, store_id, device_name, platform, installation_id, device_prefix, status
         ) values ($1,$2,$3,'android',$4,$5,'active')`,
        [
          fixture.devices[key],
          fixture.stores[key],
          `S10.3 ${key} device`,
          randomUUID(),
          `o${index.toString()}`,
        ],
      );
      await insertPeriod(fixture.stores[key], januaryPeriods[key], 2026, 1, 'open');
    }
    await insertPeriod(fixture.stores.active, closedFebruaryPeriod, 2026, 2, 'closed');

    await insertAccount(fixture.stores.active, fixture.accounts.activeCash, 'active cash', 'cash');
    await insertAccount(fixture.stores.active, fixture.accounts.activeBank, 'active bank');
    await insertAccount(
      fixture.stores.active,
      fixture.accounts.activeArchived,
      'active archived',
      'transfer',
      'archived',
    );
    await insertAccount(
      fixture.stores.active,
      fixture.accounts.positiveOpening,
      'positive opening',
    );
    await insertAccount(
      fixture.stores.active,
      fixture.accounts.negativeOpening,
      'negative opening',
    );
    await insertAccount(fixture.stores.tenantB, fixture.accounts.tenantB, 'tenant b', 'cash');
    await insertAccount(fixture.stores.readOnly, fixture.accounts.readOnly, 'read only', 'cash');
    await insertAccount(
      fixture.stores.openingRace,
      fixture.accounts.openingRace,
      'opening race',
      'cash',
    );
    await insertAccount(
      fixture.stores.reimbursementRace,
      fixture.accounts.reimbursementOne,
      'reimbursement one',
      'cash',
    );
    await insertAccount(
      fixture.stores.reimbursementRace,
      fixture.accounts.reimbursementTwo,
      'reimbursement two',
    );
    await insertAccount(fixture.stores.rollback, fixture.accounts.rollback, 'rollback', 'cash');

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
    writes = nestApp.get(OwnerLedgerWriteService);
    positionReads = nestApp.get(OwnerPositionReadService);
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
        ((select count(*) from ledger.owner_ledger_entries where store_id = any($1::uuid[]))
          + (select count(*) from ledger.money_movements where store_id = any($1::uuid[]))
          + (select count(*) from ledger.money_accounts where store_id = any($1::uuid[]))
          + (select count(*) from ledger.accounting_periods where store_id = any($1::uuid[]))
          + (select count(*) from sync.processed_operations where store_id = any($1::uuid[]))
          + (select count(*) from sync.conflicts where store_id = any($1::uuid[]))
          + (select count(*) from ledger.devices where store_id = any($1::uuid[]))
          + (select count(*) from ledger.stores where id = any($1::uuid[])))::integer
          as "fixtureRows",
        (select count(*)::integer from platform.users) as users,
        (select count(*)::integer from ledger.stores) as stores,
        ((select count(*) from ledger.owner_ledger_entries)
          + (select count(*) from ledger.money_movements)
          + (select count(*) from ledger.money_accounts)
          + (select count(*) from ledger.accounting_periods))::integer as "accountingRows",
        (select count(*)::integer from pg_stat_activity
          where datname = current_database() and state = 'idle in transaction')
          as "idleTransactions"`,
      [storeIds],
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

  it('preserves forced RLS, append-only triggers, and least-privilege runtime access', async () => {
    const relations = await adminPool.query<{
      tableName: string;
      owner: string;
      rlsEnabled: boolean;
      rlsForced: boolean;
    }>(`
      select relation.relname as "tableName", pg_get_userbyid(relation.relowner) as owner,
        relation.relrowsecurity as "rlsEnabled", relation.relforcerowsecurity as "rlsForced"
      from pg_class as relation
      where relation.oid in (
        'ledger.money_movements'::regclass,
        'ledger.owner_ledger_entries'::regclass
      )
      order by relation.relname
    `);
    expect(relations.rows).toEqual([
      {
        tableName: 'money_movements',
        owner: 'shop_app_migrator',
        rlsEnabled: true,
        rlsForced: true,
      },
      {
        tableName: 'owner_ledger_entries',
        owner: 'shop_app_migrator',
        rlsEnabled: true,
        rlsForced: true,
      },
    ]);

    const policies = await adminPool.query<{ tableName: string; name: string }>(`
      select tablename as "tableName", policyname as name
      from pg_policies
      where schemaname = 'ledger'
        and tablename in ('money_movements', 'owner_ledger_entries')
      order by tablename, policyname
    `);
    expect(policies.rows).toEqual([
      {
        tableName: 'money_movements',
        name: 'tenant_isolation_money_movements',
      },
      {
        tableName: 'owner_ledger_entries',
        name: 'tenant_isolation_owner_ledger_entries',
      },
    ]);

    const triggers = await adminPool.query<{ tableName: string; name: string }>(`
      select relation.relname as "tableName", trigger_state.tgname as name
      from pg_trigger as trigger_state
      inner join pg_class as relation on relation.oid = trigger_state.tgrelid
      where trigger_state.tgrelid in (
        'ledger.money_movements'::regclass,
        'ledger.owner_ledger_entries'::regclass
      ) and not trigger_state.tgisinternal
      order by relation.relname, trigger_state.tgname
    `);
    expect(triggers.rows).toEqual([
      { tableName: 'money_movements', name: 'trg_money_movements_no_mutation' },
      { tableName: 'money_movements', name: 'trg_money_movements_period' },
      { tableName: 'owner_ledger_entries', name: 'trg_owner_ledger_no_mutation' },
      { tableName: 'owner_ledger_entries', name: 'trg_owner_ledger_period' },
    ]);

    const runtime = await adminPool.query<{
      superuser: boolean;
      bypassRls: boolean;
      ownsFacts: boolean;
      canSelectOwner: boolean;
      canInsertOwner: boolean;
      canExecutePeriodGuard: boolean;
    }>(`
      select role_state.rolsuper as superuser, role_state.rolbypassrls as "bypassRls",
        exists (
          select 1 from pg_class
          where oid in ('ledger.money_movements'::regclass, 'ledger.owner_ledger_entries'::regclass)
            and relowner = role_state.oid
        ) as "ownsFacts",
        has_table_privilege('dokana_runtime_login', 'ledger.owner_ledger_entries', 'select')
          as "canSelectOwner",
        has_table_privilege('dokana_runtime_login', 'ledger.owner_ledger_entries', 'insert')
          as "canInsertOwner",
        has_function_privilege(
          'dokana_runtime_login',
          'ledger.assert_period_open(uuid, uuid, timestamp with time zone)',
          'execute'
        ) as "canExecutePeriodGuard"
      from pg_roles as role_state
      where role_state.rolname = 'dokana_runtime_login'
    `);
    expect(runtime.rows).toEqual([
      {
        superuser: false,
        bypassRls: false,
        ownsFacts: false,
        canSelectOwner: true,
        canInsertOwner: true,
        canExecutePeriodGuard: true,
      },
    ]);

    const missingContext = await database.transaction((transaction) =>
      transaction.execute<{ count: number }>(sql`
        select count(*)::integer as count from ledger.owner_ledger_entries
      `),
    );
    expect(missingContext.rows).toEqual([{ count: 0 }]);
  });

  it('posts signed and zero opening balances without creating any Owner Ledger effect', async () => {
    const activeContext = context('active');
    const activePrincipal = principal('active');

    const zeroRequest = ownerRequest(fixture.accounts.positiveOpening, '0');
    const zero = await writes.postOpeningBalance(activePrincipal, activeContext, zeroRequest);
    expect(zero).toMatchObject({
      operationId: zeroRequest.operationId,
      postingDate: '2026-01-15',
      accountingPeriodId: januaryPeriods.active,
      movements: [],
      ownerEntries: [],
    });
    expect(await processedOperationCount(fixture.stores.active, zeroRequest.operationId)).toBe(1);
    await expect(
      writes.postOpeningBalance(activePrincipal, context('active'), zeroRequest),
    ).resolves.toEqual(zero);

    const positiveRequest = ownerRequest(fixture.accounts.positiveOpening, '125000');
    const positive = await writes.postOpeningBalance(
      activePrincipal,
      context('active'),
      positiveRequest,
    );
    expect(positive.movements).toEqual([
      expect.objectContaining({
        id: deriveMoneyFactId(positiveRequest.operationId, 'opening'),
        operationId: deriveMoneyFactOperationId(positiveRequest.operationId, 'opening'),
        movementType: 'opening_balance',
        amountDeltaMinor: '125000',
        transactionGroupId: positiveRequest.operationId,
      }),
    ]);
    const movementCountAfterPositive = await movementCount(
      fixture.stores.active,
      positiveRequest.operationId,
    );
    await expect(
      writes.postOpeningBalance(activePrincipal, context('active'), positiveRequest),
    ).resolves.toEqual(positive);
    expect(await movementCount(fixture.stores.active, positiveRequest.operationId)).toBe(
      movementCountAfterPositive,
    );
    await expect(
      writes.postOpeningBalance(activePrincipal, context('active'), {
        ...positiveRequest,
        amountMinor: '125001',
      }),
    ).rejects.toMatchObject({ response: { code: 'OPERATION_ID_CONFLICT' } });
    expect(await movementCount(fixture.stores.active, positiveRequest.operationId)).toBe(1);

    const negativeRequest = ownerRequest(fixture.accounts.negativeOpening, '-40000');
    const negative = await writes.postOpeningBalance(
      activePrincipal,
      context('active'),
      negativeRequest,
    );
    expect(negative.movements[0]).toMatchObject({
      movementType: 'opening_balance',
      amountDeltaMinor: '-40000',
    });
    expect(await balance(fixture.stores.active, fixture.accounts.positiveOpening)).toBe(125_000n);
    expect(await balance(fixture.stores.active, fixture.accounts.negativeOpening)).toBe(-40_000n);
    expect(await ownerEntryCount(fixture.stores.active)).toBe(0);

    const duplicateRequest = ownerRequest(fixture.accounts.positiveOpening, '1');
    await expect(
      writes.postOpeningBalance(activePrincipal, context('active'), duplicateRequest),
    ).rejects.toMatchObject({ response: { code: 'OPENING_BALANCE_ALREADY_EXISTS' } });
    await expect(
      writes.postOpeningBalance(activePrincipal, context('active'), duplicateRequest),
    ).rejects.toMatchObject({ response: { code: 'OPENING_BALANCE_ALREADY_EXISTS' } });
    expect(await movementCount(fixture.stores.active, duplicateRequest.operationId)).toBe(0);
    expect(await processedOperationCount(fixture.stores.active, duplicateRequest.operationId)).toBe(
      1,
    );
  });

  it('serializes two distinct first-opening commands so at most one succeeds', async () => {
    const first = ownerRequest(fixture.accounts.openingRace, '10');
    const second = ownerRequest(fixture.accounts.openingRace, '20');
    const results = await Promise.allSettled([
      writes.postOpeningBalance(principal('openingRace'), context('openingRace'), first),
      writes.postOpeningBalance(principal('openingRace'), context('openingRace'), second),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejection = results.find((result) => result.status === 'rejected');
    expect(rejection).toMatchObject({
      status: 'rejected',
      reason: { response: { code: 'OPENING_BALANCE_ALREADY_EXISTS' } },
    });
    expect(await movementCount(fixture.stores.openingRace)).toBe(1);
    expect(await ownerEntryCount(fixture.stores.openingRace)).toBe(0);
  });

  it('rejects unavailable accounts and closed periods with no accounting facts', async () => {
    const archivedRequest = ownerRequest(fixture.accounts.activeArchived, '1');
    await expect(
      writes.postOpeningBalance(principal('active'), context('active'), archivedRequest),
    ).rejects.toMatchObject({ response: { code: 'MONEY_ACCOUNT_UNAVAILABLE' } });
    expect(await movementCount(fixture.stores.active, archivedRequest.operationId)).toBe(0);

    const closedRequest = ownerRequest(fixture.accounts.activeBank, '1', {
      occurredAt: '2026-02-15T10:00:00.000Z',
    });
    await expect(
      writes.postOpeningBalance(principal('active'), context('active'), closedRequest),
    ).rejects.toMatchObject({
      response: { code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE' },
    });
    expect(await movementCount(fixture.stores.active, closedRequest.operationId)).toBe(0);
  });

  it('posts contribution, loan, reimbursement, and both withdrawal classes exactly', async () => {
    const activePrincipal = principal('active');

    const contributionRequest = ownerRequest(fixture.accounts.activeCash, '300');
    const contribution = await writes.postContribution(
      activePrincipal,
      context('active'),
      contributionRequest,
    );
    expect(contribution.movements[0]).toMatchObject({
      movementType: 'owner_contribution',
      amountDeltaMinor: '300',
    });
    expect(contribution.ownerEntries[0]).toMatchObject({
      id: deriveMoneyFactId(contributionRequest.operationId, 'owner-entry'),
      operationId: deriveMoneyFactOperationId(contributionRequest.operationId, 'owner-entry'),
      entryType: 'capital_contribution',
      ownerLiabilityDeltaMinor: '0',
      equityDeltaMinor: '300',
      transactionGroupId: contributionRequest.operationId,
    });
    const linkedContribution = await adminPool.query<{
      moneyId: string;
      ownerId: string;
      moneyReferenceId: string;
      ownerReferenceId: string;
    }>(
      `select movement.id as "moneyId", owner_entry.id as "ownerId",
              movement.reference_id as "moneyReferenceId",
              owner_entry.reference_id as "ownerReferenceId"
       from ledger.money_movements as movement
       inner join ledger.owner_ledger_entries as owner_entry
         on owner_entry.store_id = movement.store_id
        and owner_entry.transaction_group_id = movement.transaction_group_id
       where movement.store_id = $1 and movement.transaction_group_id = $2`,
      [fixture.stores.active, contributionRequest.operationId],
    );
    expect(linkedContribution.rows).toEqual([
      {
        moneyId: deriveMoneyFactId(contributionRequest.operationId, 'owner-money'),
        ownerId: deriveMoneyFactId(contributionRequest.operationId, 'owner-entry'),
        moneyReferenceId: deriveMoneyFactId(contributionRequest.operationId, 'owner-entry'),
        ownerReferenceId: deriveMoneyFactId(contributionRequest.operationId, 'owner-money'),
      },
    ]);
    const commandClaims = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count
       from sync.processed_operations
       where store_id = $1
         and operation_id = any($2::uuid[])`,
      [
        fixture.stores.active,
        [
          contributionRequest.operationId,
          deriveMoneyFactOperationId(contributionRequest.operationId, 'owner-money'),
          deriveMoneyFactOperationId(contributionRequest.operationId, 'owner-entry'),
        ],
      ],
    );
    expect(commandClaims.rows).toEqual([{ count: 1 }]);

    const loanRequest = ownerRequest(fixture.accounts.activeCash, '100');
    const loan = await writes.postLoan(activePrincipal, context('active'), loanRequest);
    expect(loan.movements[0]).toMatchObject({
      movementType: 'owner_loan',
      amountDeltaMinor: '100',
    });
    expect(loan.ownerEntries[0]).toMatchObject({
      entryType: 'owner_loan_to_store',
      ownerLiabilityDeltaMinor: '100',
      equityDeltaMinor: '0',
    });

    const partialRequest = ownerRequest(fixture.accounts.activeCash, '40');
    const partial = await writes.postReimbursement(
      activePrincipal,
      context('active'),
      partialRequest,
    );
    expect(partial.movements[0]).toMatchObject({
      movementType: 'owner_reimbursement',
      amountDeltaMinor: '-40',
    });
    expect(partial.ownerEntries[0]).toMatchObject({
      entryType: 'owner_reimbursement',
      ownerLiabilityDeltaMinor: '-40',
      equityDeltaMinor: '0',
    });
    expect(await ownerPosition(fixture.stores.active)).toEqual({ liability: 60n, equity: 300n });

    const exactRequest = ownerRequest(fixture.accounts.activeCash, '60');
    await writes.postReimbursement(activePrincipal, context('active'), exactRequest);
    expect(await ownerPosition(fixture.stores.active)).toEqual({ liability: 0n, equity: 300n });

    const withdrawalRequest = ownerRequest(fixture.accounts.activeCash, '500');
    const withdrawal = await writes.postPersonalWithdrawal(
      activePrincipal,
      context('active'),
      withdrawalRequest,
    );
    expect(withdrawal.movements[0]).toMatchObject({
      movementType: 'owner_withdrawal',
      amountDeltaMinor: '-500',
    });
    expect(withdrawal.ownerEntries[0]).toMatchObject({
      entryType: 'personal_withdrawal',
      ownerLiabilityDeltaMinor: '0',
      equityDeltaMinor: '-500',
    });
    const capitalWithdrawalRequest = ownerRequest(fixture.accounts.activeCash, '50');
    const capitalWithdrawal = await writes.postCapitalWithdrawal(
      activePrincipal,
      context('active'),
      capitalWithdrawalRequest,
    );
    expect(capitalWithdrawal.movements[0]).toMatchObject({
      movementType: 'owner_withdrawal',
      amountDeltaMinor: '-50',
    });
    expect(capitalWithdrawal.ownerEntries[0]).toMatchObject({
      entryType: 'capital_withdrawal',
      ownerLiabilityDeltaMinor: '0',
      equityDeltaMinor: '-50',
    });
    expect(await ownerPosition(fixture.stores.active)).toEqual({ liability: 0n, equity: -250n });
    expect(await balance(fixture.stores.active, fixture.accounts.activeCash)).toBe(-250n);

    const paired = [contribution, loan, partial, withdrawal, capitalWithdrawal];
    for (const response of paired) {
      expect(response.movements).toHaveLength(1);
      expect(response.ownerEntries).toHaveLength(1);
      expect(response.movements[0]?.transactionGroupId).toBe(response.operationId);
      expect(response.ownerEntries[0]?.transactionGroupId).toBe(response.operationId);
      expect(response.movements[0]?.id).not.toBe(response.ownerEntries[0]?.id);
    }
  });

  it('rejects over-reimbursement and serializes 80 + 80 against liability 100', async () => {
    const racePrincipal = principal('reimbursementRace');
    await writes.postLoan(
      racePrincipal,
      context('reimbursementRace'),
      ownerRequest(fixture.accounts.reimbursementOne, '100'),
    );

    const overRequest = ownerRequest(fixture.accounts.reimbursementOne, '101');
    await expect(
      writes.postReimbursement(racePrincipal, context('reimbursementRace'), overRequest),
    ).rejects.toMatchObject({ response: { code: 'OWNER_LIABILITY_EXCEEDED' } });
    await expect(
      writes.postReimbursement(racePrincipal, context('reimbursementRace'), overRequest),
    ).rejects.toMatchObject({ response: { code: 'OWNER_LIABILITY_EXCEEDED' } });
    expect(await movementCount(fixture.stores.reimbursementRace, overRequest.operationId)).toBe(0);
    expect(await ownerEntryCount(fixture.stores.reimbursementRace, overRequest.operationId)).toBe(
      0,
    );

    const first = ownerRequest(fixture.accounts.reimbursementOne, '80');
    const second = ownerRequest(fixture.accounts.reimbursementTwo, '80');
    const results = await Promise.allSettled([
      writes.postReimbursement(racePrincipal, context('reimbursementRace'), first),
      writes.postReimbursement(racePrincipal, context('reimbursementRace'), second),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejection = results.find((result) => result.status === 'rejected');
    expect(rejection).toMatchObject({
      status: 'rejected',
      reason: { response: { code: 'OWNER_LIABILITY_EXCEEDED' } },
    });
    expect(await ownerPosition(fixture.stores.reimbursementRace)).toEqual({
      liability: 20n,
      equity: 0n,
    });
    expect(
      (await balance(fixture.stores.reimbursementRace, fixture.accounts.reimbursementOne)) +
        (await balance(fixture.stores.reimbursementRace, fixture.accounts.reimbursementTwo)),
    ).toBe(20n);
  });

  it('returns the original stored snapshot on exact replay after later state changes', async () => {
    const rollbackPrincipal = principal('rollback');
    const operation = ownerRequest(fixture.accounts.rollback, '25');
    const original = await writes.postContribution(
      rollbackPrincipal,
      context('rollback'),
      operation,
    );
    await writes.postLoan(
      rollbackPrincipal,
      context('rollback'),
      ownerRequest(fixture.accounts.rollback, '10'),
    );
    const movementsBefore = await movementCount(fixture.stores.rollback);
    const ownerEntriesBefore = await ownerEntryCount(fixture.stores.rollback);

    const replay = await writes.postContribution(rollbackPrincipal, context('rollback'), operation);
    expect(replay).toEqual(original);
    expect(await movementCount(fixture.stores.rollback)).toBe(movementsBefore);
    expect(await ownerEntryCount(fixture.stores.rollback)).toBe(ownerEntriesBefore);

    await expect(
      writes.postContribution(rollbackPrincipal, context('rollback'), {
        ...operation,
        amountMinor: '26',
      }),
    ).rejects.toMatchObject({ response: { code: 'OPERATION_ID_CONFLICT' } });
    const conflicts = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count from sync.conflicts
       where store_id = $1 and operation_id = $2`,
      [fixture.stores.rollback, operation.operationId],
    );
    expect(conflicts.rows).toEqual([{ count: 1 }]);
  });

  it('allows exact replay in read_only while rejecting every genuinely new posting', async () => {
    const replayOperation = ownerRequest(fixture.accounts.rollback, '5');
    const original = await writes.postContribution(
      principal('rollback'),
      context('rollback'),
      replayOperation,
    );
    await adminPool.query("update ledger.stores set status = 'read_only' where id = $1", [
      fixture.stores.rollback,
    ]);
    await expect(
      writes.postContribution(principal('rollback'), context('rollback'), replayOperation),
    ).resolves.toEqual(original);
    const newOperation = ownerRequest(fixture.accounts.rollback, '1');
    await expect(
      writes.postContribution(principal('rollback'), context('rollback'), newOperation),
    ).rejects.toMatchObject({ response: { code: 'BUSINESS_WRITE_NOT_ALLOWED' } });
    expect(await processedOperationCount(fixture.stores.rollback, newOperation.operationId)).toBe(
      0,
    );
    await adminPool.query("update ledger.stores set status = 'active' where id = $1", [
      fixture.stores.rollback,
    ]);
  });

  it('rolls back the Money Movement, command claim, and response if Owner fact insertion fails', async () => {
    const operationId = randomUUID();
    const collidingOwnerOperationId = deriveMoneyFactOperationId(operationId, 'owner-entry');
    const seededId = randomUUID();
    await adminPool.query(
      `insert into ledger.owner_ledger_entries (
         id, store_id, accounting_period_id, entry_type, owner_liability_delta_minor,
         equity_delta_minor, money_account_id, transaction_group_id, occurred_at,
         device_id, operation_id
       ) values ($1,$2,$3,'capital_contribution',0,1,$4,$5,$6,$7,$8)`,
      [
        seededId,
        fixture.stores.rollback,
        januaryPeriods.rollback,
        fixture.accounts.rollback,
        randomUUID(),
        new Date('2026-01-01T10:00:00.000Z'),
        fixture.devices.rollback,
        collidingOwnerOperationId,
      ],
    );

    await expect(
      writes.postContribution(
        principal('rollback'),
        context('rollback'),
        ownerRequest(fixture.accounts.rollback, '7', { operationId }),
      ),
    ).rejects.toBeDefined();
    const movementId = deriveMoneyFactId(operationId, 'owner-money');
    const movement = await adminPool.query<{ count: number }>(
      'select count(*)::integer as count from ledger.money_movements where id = $1',
      [movementId],
    );
    expect(movement.rows).toEqual([{ count: 0 }]);
    expect(await processedOperationCount(fixture.stores.rollback, operationId)).toBe(0);
    await adminPool.query('delete from ledger.owner_ledger_entries where id = $1', [seededId]);
  });

  it('fails closed for cross-Store accounts and owner facts under runtime RLS', async () => {
    const operation = ownerRequest(fixture.accounts.tenantB, '1');
    await expect(
      writes.postContribution(principal('active'), context('active'), operation),
    ).rejects.toMatchObject({ response: { code: 'MONEY_ACCOUNT_NOT_FOUND' } });
    expect(await movementCount(fixture.stores.active, operation.operationId)).toBe(0);
    expect(await ownerEntryCount(fixture.stores.active, operation.operationId)).toBe(0);

    const crossTenantRead = await database.withTenantTransaction(context('active'), (transaction) =>
      transaction.execute<{ count: number }>(sql`
          select count(*)::integer as count
          from ledger.owner_ledger_entries
          where store_id = ${fixture.stores.tenantB}::uuid
        `),
    );
    expect(crossTenantRead.rows).toEqual([{ count: 0 }]);

    const crossTenantEntryId = randomUUID();
    let rlsErrorCode: string | undefined;
    try {
      await database.withTenantTransaction(context('active'), (transaction) =>
        transaction.execute(sql`
          insert into ledger.owner_ledger_entries (
            id, store_id, accounting_period_id, entry_type, owner_liability_delta_minor,
            equity_delta_minor, money_account_id, transaction_group_id, occurred_at,
            device_id, operation_id
          ) values (
            ${crossTenantEntryId}::uuid,
            ${fixture.stores.tenantB}::uuid,
            ${januaryPeriods.tenantB}::uuid,
            'capital_contribution', 0, 1,
            ${fixture.accounts.tenantB}::uuid,
            ${randomUUID()}::uuid,
            ${new Date('2026-01-15T10:00:00.000Z')},
            ${fixture.devices.tenantB}::uuid,
            ${randomUUID()}::uuid
          )
        `),
      );
    } catch (error) {
      rlsErrorCode = postgresqlErrorCode(error);
    }
    expect(rlsErrorCode).toBe('23503');
    const blockedInsert = await adminPool.query<{ count: number }>(
      'select count(*)::integer as count from ledger.owner_ledger_entries where id = $1',
      [crossTenantEntryId],
    );
    expect(blockedInsert.rows).toEqual([{ count: 0 }]);
  });

  it('returns only minimum lossless Owner Position data and enforces owner authorization', async () => {
    await expect(positionReads.read(principal('active'), context('active'))).resolves.toEqual({
      storeOwesOwnerMinor: '0',
      ownerEquityMovementMinor: '-250',
    });
    await expect(positionReads.read(principal('tenantB'), context('tenantB'))).resolves.toEqual({
      storeOwesOwnerMinor: '0',
      ownerEquityMovementMinor: '0',
    });
    expect(() => positionReads.read(principal('active', 'support'), context('active'))).toThrow(
      'Owner Ledger reads are not allowed.',
    );
  });
});
