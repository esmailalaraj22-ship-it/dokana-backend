import { randomUUID } from 'node:crypto';

import { captureReplayEvidence } from './stage3b-replay-evidence';

import { HttpException, type INestApplication } from '@nestjs/common';
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
import {
  postgresqlConstraint,
  postgresqlErrorCode,
} from '../src/money-movements/money-movement-database-error';
import { MoneyMovementPostingRepository } from '../src/money-movements/money-movement-posting.repository';
import { MoneyTransferPostingRepository } from '../src/money-transfers/money-transfer-posting.repository';
import { MoneyTransferWriteService } from '../src/money-transfers/money-transfer-write.service';
import { OwnerLedgerWriteService } from '../src/owner-ledger/owner-ledger-write.service';
import type { MoneyTransferMutationResponse } from '../src/money-transfers/money-transfer.types';
import {
  createTestPool,
  provisionActiveTestEntitlements,
  readLocalPostgresTestEnvironment,
  removeActiveTestEntitlements,
  type ActiveTestEntitlementFixture,
} from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();

jest.setTimeout(120_000);

const fixture = {
  stores: {
    active: 'b1000000-0000-4000-8000-000000000001',
    tenantB: 'b1000000-0000-4000-8000-000000000002',
    concurrent: 'b1000000-0000-4000-8000-000000000003',
    readOnly: 'b1000000-0000-4000-8000-000000000004',
    rollback: 'b1000000-0000-4000-8000-000000000005',
  },
  users: {
    active: 'b1100000-0000-4000-8000-000000000001',
    tenantB: 'b1100000-0000-4000-8000-000000000002',
    concurrent: 'b1100000-0000-4000-8000-000000000003',
    readOnly: 'b1100000-0000-4000-8000-000000000004',
    rollback: 'b1100000-0000-4000-8000-000000000005',
  },
  devices: {
    active: 'b1200000-0000-4000-8000-000000000001',
    tenantB: 'b1200000-0000-4000-8000-000000000002',
    concurrent: 'b1200000-0000-4000-8000-000000000003',
    readOnly: 'b1200000-0000-4000-8000-000000000004',
    rollback: 'b1200000-0000-4000-8000-000000000005',
  },
  accounts: {
    activeSource: 'b1300000-0000-4000-8000-000000000001',
    activeDestination: 'b1300000-0000-4000-8000-000000000002',
    activeAlternate: 'b1300000-0000-4000-8000-000000000003',
    archived: 'b1300000-0000-4000-8000-000000000004',
    held: 'b1300000-0000-4000-8000-000000000005',
    tenantBSource: 'b1300000-0000-4000-8000-000000000006',
    tenantBDestination: 'b1300000-0000-4000-8000-000000000007',
    concurrentLow: 'b1300000-0000-4000-8000-000000000008',
    concurrentHigh: 'b1300000-0000-4000-8000-000000000009',
    readOnlySource: 'b1300000-0000-4000-8000-000000000010',
    readOnlyDestination: 'b1300000-0000-4000-8000-000000000011',
    rollbackSource: 'b1300000-0000-4000-8000-000000000012',
    rollbackDestination: 'b1300000-0000-4000-8000-000000000013',
  },
};

type StoreKey = keyof typeof fixture.stores;

const storeIds = Object.values(fixture.stores);
const userIds = Object.values(fixture.users);
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

interface MovementRow {
  id: string;
  accountId: string;
  accountingPeriodId: string;
  movementType: string;
  amountDeltaMinor: string;
  referenceType: string;
  referenceId: string;
  transactionGroupId: string;
  transferGroupId: string | null;
  counterAccountId: string | null;
  occurredAt: Date;
  operationId: string;
}

describe('Internal Money Account Transfers with real PostgreSQL', () => {
  let app: INestApplication | undefined;
  let adminPool: Pool;
  let database: DatabaseService;
  let writes: MoneyTransferWriteService;
  let repository: MoneyTransferPostingRepository;
  let poolInitialized = false;
  let entitlementFixture: ActiveTestEntitlementFixture | undefined;
  let basicTransfer: MoneyTransferMutationResponse;

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

  function transferRequest(
    sourceAccountId: string,
    destinationAccountId: string,
    amountMinor = '100',
    overrides: Partial<{ operationId: string; occurredAt: string }> = {},
  ) {
    return {
      operationId: overrides.operationId ?? randomUUID(),
      sourceAccountId,
      destinationAccountId,
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
    options: Partial<{
      accountType: 'cash' | 'transfer' | 'external_party';
      availability: 'available' | 'held_by_external_party';
      status: 'active' | 'archived';
    }> = {},
  ): Promise<void> {
    const accountType = options.accountType ?? 'transfer';
    const availability = options.availability ?? 'available';
    const status = options.status ?? 'active';
    await adminPool.query(
      `insert into ledger.money_accounts (
         id, store_id, name, normalized_name, account_type, availability, is_default,
         status, archived_at, operation_id, version
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,
         case when $8 = 'archived' then now() else null end,$9,1)`,
      [
        id,
        storeId,
        name,
        name.toLowerCase(),
        accountType,
        availability,
        accountType === 'cash',
        status,
        randomUUID(),
      ],
    );
  }

  async function movements(storeId: string, operationId: string): Promise<MovementRow[]> {
    const result = await adminPool.query<MovementRow>(
      `select id, account_id as "accountId", accounting_period_id as "accountingPeriodId",
              movement_type as "movementType", amount_delta_minor::text as "amountDeltaMinor",
              reference_type as "referenceType", reference_id as "referenceId",
              transaction_group_id as "transactionGroupId",
              transfer_group_id as "transferGroupId", counter_account_id as "counterAccountId",
              occurred_at as "occurredAt", operation_id as "operationId"
       from ledger.money_movements
       where store_id = $1 and transaction_group_id = $2
       order by amount_delta_minor`,
      [storeId, operationId],
    );
    return result.rows;
  }

  async function transferCount(storeId: string, operationId?: string): Promise<number> {
    const result = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.money_transfers
       where store_id = $1 and ($2::uuid is null or id = $2::uuid)`,
      [storeId, operationId ? deriveMoneyFactId(storeId, operationId, 'transfer-header') : null],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function movementCount(storeId: string, operationId?: string): Promise<number> {
    const result = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.money_movements
       where store_id = $1 and ($2::uuid is null or transaction_group_id = $2::uuid)`,
      [storeId, operationId ?? null],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function processedOperation(
    storeId: string,
    operationId: string,
  ): Promise<{ status: string; errorCode: string | null } | undefined> {
    const result = await adminPool.query<{ status: string; errorCode: string | null }>(
      `select status, error_code as "errorCode" from sync.processed_operations
       where store_id = $1 and operation_id = $2`,
      [storeId, operationId],
    );
    return result.rows[0];
  }

  async function balance(storeId: string, accountId: string): Promise<bigint> {
    const result = await adminPool.query<{ balance: string }>(
      `select balance_minor::text as balance from ledger.v_money_account_balances
       where store_id = $1 and account_id = $2`,
      [storeId, accountId],
    );
    return BigInt(result.rows[0]?.balance ?? '0');
  }

  async function removeFixtures(): Promise<void> {
    await removeActiveTestEntitlements(adminPool, entitlementFixture);
    entitlementFixture = undefined;
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
    await adminPool.query('delete from ledger.money_transfers where store_id = any($1::uuid[])', [
      storeIds,
    ]);
    await adminPool.query(
      'delete from ledger.owner_ledger_entries where store_id = any($1::uuid[])',
      [storeIds],
    );
    await adminPool.query('delete from ledger.money_movements where store_id = any($1::uuid[])', [
      storeIds,
    ]);
    await adminPool.query(
      'delete from ledger.document_sequences where store_id = any($1::uuid[])',
      [storeIds],
    );
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
    await adminPool.query(
      'delete from platform.store_memberships where store_id = any($1::uuid[])',
      [storeIds],
    );
    await adminPool.query(
      'delete from sync.store_change_events_v1 where store_id = any($1::uuid[])',
      [storeIds],
    );
    await adminPool.query(
      'delete from sync.store_change_watermarks_v1 where store_id = any($1::uuid[])',
      [storeIds],
    );
    await adminPool.query('delete from ledger.stores where id = any($1::uuid[])', [storeIds]);
    await adminPool.query('delete from platform.users where id = any($1::uuid[])', [userIds]);
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
      'dokana-s104-admin',
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
        ((select count(*) from ledger.money_transfers)
          + (select count(*) from ledger.money_movements)
          + (select count(*) from ledger.owner_ledger_entries)
          + (select count(*) from ledger.document_sequences)
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
      throw new Error('The local S10.4 mutation fixture database is not approved.');
    }

    await removeFixtures();
    const keys = Object.keys(fixture.stores) as StoreKey[];
    for (const [index, key] of keys.entries()) {
      await adminPool.query(
        `insert into platform.users (
           id, email, normalized_email, password_hash, full_name, status
         ) values ($1,$2,$2,'test-only-hash',$3,'active')`,
        [fixture.users[key], `s104-${key.toLowerCase()}@example.test`, `S10.4 ${key}`],
      );
      await adminPool.query('insert into ledger.stores (id, name, status) values ($1,$2,$3)', [
        fixture.stores[key],
        `S10.4 ${key} store`,
        key === 'readOnly' ? 'read_only' : 'active',
      ]);
      // Migration 0039 requires a real active membership for service-level writes.
      await adminPool.query(
        `insert into platform.store_memberships(id,store_id,user_id,role,status)
        values($1,$2,$3,'owner','active')`,
        [randomUUID(), fixture.stores[key], fixture.users[key]],
      );
      await adminPool.query(
        `insert into ledger.devices (
           id, store_id, device_name, platform, installation_id, device_prefix, status
         ) values ($1,$2,$3,'android',$4,$5,'active')`,
        [
          fixture.devices[key],
          fixture.stores[key],
          `S10.4 ${key} device`,
          randomUUID(),
          `t${index.toString()}`,
        ],
      );
      await insertPeriod(fixture.stores[key], januaryPeriods[key], 2026, 1, 'open');
    }
    await insertPeriod(fixture.stores.active, closedFebruaryPeriod, 2026, 2, 'closed');

    await insertAccount(fixture.stores.active, fixture.accounts.activeSource, 'active source', {
      accountType: 'cash',
    });
    await insertAccount(
      fixture.stores.active,
      fixture.accounts.activeDestination,
      'active destination',
    );
    await insertAccount(fixture.stores.active, fixture.accounts.activeAlternate, 'alternate');
    await insertAccount(fixture.stores.active, fixture.accounts.archived, 'archived', {
      status: 'archived',
    });
    await insertAccount(fixture.stores.active, fixture.accounts.held, 'held', {
      accountType: 'external_party',
      availability: 'held_by_external_party',
    });
    await insertAccount(fixture.stores.tenantB, fixture.accounts.tenantBSource, 'tenant b source', {
      accountType: 'cash',
    });
    await insertAccount(
      fixture.stores.tenantB,
      fixture.accounts.tenantBDestination,
      'tenant b destination',
    );
    await insertAccount(
      fixture.stores.concurrent,
      fixture.accounts.concurrentLow,
      'concurrent low',
      { accountType: 'cash' },
    );
    await insertAccount(
      fixture.stores.concurrent,
      fixture.accounts.concurrentHigh,
      'concurrent high',
    );
    await insertAccount(
      fixture.stores.readOnly,
      fixture.accounts.readOnlySource,
      'read only source',
      { accountType: 'cash' },
    );
    await insertAccount(
      fixture.stores.readOnly,
      fixture.accounts.readOnlyDestination,
      'read only destination',
    );
    await insertAccount(
      fixture.stores.rollback,
      fixture.accounts.rollbackSource,
      'rollback source',
      { accountType: 'cash' },
    );
    await insertAccount(
      fixture.stores.rollback,
      fixture.accounts.rollbackDestination,
      'rollback destination',
    );

    entitlementFixture = await provisionActiveTestEntitlements(adminPool, storeIds);
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
    writes = nestApp.get(MoneyTransferWriteService);
    repository = nestApp.get(MoneyTransferPostingRepository);
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
        ((select count(*) from platform.store_memberships where store_id = any($1::uuid[]))
          + (select count(*) from sync.store_change_events_v1 where store_id = any($1::uuid[]))
          + (select count(*) from sync.store_change_watermarks_v1 where store_id = any($1::uuid[]))
          + (select count(*) from ledger.money_transfers where store_id = any($1::uuid[]))
          + (select count(*) from ledger.money_movements where store_id = any($1::uuid[]))
          + (select count(*) from ledger.owner_ledger_entries where store_id = any($1::uuid[]))
          + (select count(*) from ledger.document_sequences where store_id = any($1::uuid[]))
          + (select count(*) from ledger.money_accounts where store_id = any($1::uuid[]))
          + (select count(*) from ledger.accounting_periods where store_id = any($1::uuid[]))
          + (select count(*) from sync.processed_operations where store_id = any($1::uuid[]))
          + (select count(*) from sync.change_events where store_id = any($1::uuid[]))
          + (select count(*) from sync.conflicts where store_id = any($1::uuid[]))
          + (select count(*) from audit.central_audit_logs where store_id = any($1::uuid[]))
          + (select count(*) from ledger.devices where store_id = any($1::uuid[]))
          + (select count(*) from ledger.stores where id = any($1::uuid[])))::integer
          as "fixtureRows",
        (select count(*)::integer from platform.users) as users,
        (select count(*)::integer from ledger.stores) as stores,
        ((select count(*) from ledger.money_transfers)
          + (select count(*) from ledger.money_movements)
          + (select count(*) from ledger.owner_ledger_entries)
          + (select count(*) from ledger.document_sequences)
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

  it('preserves the existing transfer table security, validation, and period-guard contract', async () => {
    const relation = await adminPool.query<{
      rowSecurity: boolean;
      forceRowSecurity: boolean;
      owner: string;
      runtimeSelect: boolean;
      runtimeInsert: boolean;
      periodExecute: boolean;
    }>(`
      select c.relrowsecurity as "rowSecurity", c.relforcerowsecurity as "forceRowSecurity",
        owner.rolname as owner,
        has_table_privilege('dokana_runtime_login', c.oid, 'SELECT') as "runtimeSelect",
        has_table_privilege('dokana_runtime_login', c.oid, 'INSERT') as "runtimeInsert",
        has_function_privilege(
          'shop_app_runtime',
          'ledger.assert_period_open(uuid, uuid, timestamptz)',
          'EXECUTE'
        ) as "periodExecute"
      from pg_class as c
      join pg_roles as owner on owner.oid = c.relowner
      where c.oid = 'ledger.money_transfers'::regclass
    `);
    expect(relation.rows).toEqual([
      {
        rowSecurity: true,
        forceRowSecurity: true,
        owner: 'shop_app_migrator',
        runtimeSelect: true,
        runtimeInsert: true,
        periodExecute: true,
      },
    ]);
    const policies = await adminPool.query<{ name: string }>(`
      select policyname as name from pg_policies
      where schemaname = 'ledger' and tablename = 'money_transfers'
    `);
    expect(policies.rows).toEqual([{ name: 'tenant_isolation_money_transfers' }]);
    const triggers = await adminPool.query<{ name: string }>(`
      select tgname as name from pg_trigger
      where tgrelid = 'ledger.money_transfers'::regclass and not tgisinternal
      order by tgname
    `);
    expect(triggers.rows.map((row) => row.name)).toEqual([
      'trg_money_transfer_post_validate',
      'trg_money_transfers_central_audit',
      'trg_money_transfers_change_event',
      'trg_money_transfers_finalized_guard',
      'trg_money_transfers_no_delete',
      'trg_money_transfers_store_change_v1',
      'trg_money_transfers_touch',
    ]);
  });

  it('Stage 3B B01 Money Transfer posts one immutable header and an exact equal/opposite pair with no owner effect', async () => {
    const request = transferRequest(
      fixture.accounts.activeSource,
      fixture.accounts.activeDestination,
      '100',
    );
    basicTransfer = await writes.create(principal('active'), context('active'), request);
    const tables = [
      'ledger.money_transfers',
      'ledger.money_movements',
      'ledger.owner_ledger_entries',
    ];
    const beforeReplay = await captureReplayEvidence(adminPool, fixture.stores.active, tables);
    expect(await writes.create(principal('active'), context('active'), request)).toEqual(
      basicTransfer,
    );
    expect(await captureReplayEvidence(adminPool, fixture.stores.active, tables)).toEqual(
      beforeReplay,
    );

    expect(basicTransfer).toMatchObject({
      operationId: request.operationId,
      postingDate: '2026-01-15',
      accountingPeriodId: januaryPeriods.active,
      transfer: {
        id: deriveMoneyFactId(fixture.stores.active, request.operationId, 'transfer-header'),
        sourceAccountId: fixture.accounts.activeSource,
        destinationAccountId: fixture.accounts.activeDestination,
        amountMinor: '100',
        status: 'posted',
        operationId: deriveMoneyFactOperationId(
          fixture.stores.active,
          request.operationId,
          'transfer-header',
        ),
        version: '1',
      },
    });
    expect(basicTransfer.transfer.displayNumber).toMatch(/^t0-2026-\d{6}$/);
    expect(basicTransfer.movements.map((movement) => movement.amountDeltaMinor)).toEqual([
      '-100',
      '100',
    ]);

    const rows = await movements(fixture.stores.active, request.operationId);
    expect(rows).toEqual([
      expect.objectContaining({
        id: deriveMoneyFactId(fixture.stores.active, request.operationId, 'transfer-source'),
        accountId: fixture.accounts.activeSource,
        accountingPeriodId: januaryPeriods.active,
        movementType: 'internal_transfer',
        amountDeltaMinor: '-100',
        referenceType: 'money_transfer',
        referenceId: basicTransfer.transfer.id,
        transactionGroupId: request.operationId,
        transferGroupId: basicTransfer.transfer.id,
        counterAccountId: fixture.accounts.activeDestination,
        operationId: deriveMoneyFactOperationId(
          fixture.stores.active,
          request.operationId,
          'transfer-source',
        ),
      }),
      expect.objectContaining({
        id: deriveMoneyFactId(fixture.stores.active, request.operationId, 'transfer-destination'),
        accountId: fixture.accounts.activeDestination,
        accountingPeriodId: januaryPeriods.active,
        movementType: 'internal_transfer',
        amountDeltaMinor: '100',
        referenceType: 'money_transfer',
        referenceId: basicTransfer.transfer.id,
        transactionGroupId: request.operationId,
        transferGroupId: basicTransfer.transfer.id,
        counterAccountId: fixture.accounts.activeSource,
        operationId: deriveMoneyFactOperationId(
          fixture.stores.active,
          request.operationId,
          'transfer-destination',
        ),
      }),
    ]);
    expect(rows[0]?.occurredAt.toISOString()).toBe('2026-01-15T10:00:00.000Z');
    expect(rows[1]?.occurredAt.toISOString()).toBe('2026-01-15T10:00:00.000Z');
    expect(rows.reduce((sum, row) => sum + BigInt(row.amountDeltaMinor), 0n)).toBe(0n);
    expect(await balance(fixture.stores.active, fixture.accounts.activeSource)).toBe(-100n);
    expect(await balance(fixture.stores.active, fixture.accounts.activeDestination)).toBe(100n);
    const ownerEffects = await adminPool.query<{ count: number }>(
      'select count(*)::integer as count from ledger.owner_ledger_entries where store_id = $1',
      [fixture.stores.active],
    );
    expect(ownerEffects.rows).toEqual([{ count: 0 }]);
    const claims = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count from sync.processed_operations
       where store_id = $1 and operation_id = any($2::uuid[])`,
      [
        fixture.stores.active,
        [
          request.operationId,
          deriveMoneyFactOperationId(fixture.stores.active, request.operationId, 'transfer-header'),
          deriveMoneyFactOperationId(fixture.stores.active, request.operationId, 'transfer-source'),
          deriveMoneyFactOperationId(
            fixture.stores.active,
            request.operationId,
            'transfer-destination',
          ),
        ],
      ],
    );
    expect(claims.rows).toEqual([{ count: 1 }]);
  });

  it.each(['active', 'tenantB'] as const)(
    'Stage 3B B02 allows independent Stores to reuse a command UUID when %s commits first',
    async (firstStore) => {
      if (!app) throw new Error('Transfer application is unavailable');
      const secondStore = firstStore === 'active' ? 'tenantB' : 'active';
      const operationId = randomUUID();
      const command = (key: 'active' | 'tenantB', id = operationId) =>
        transferRequest(
          key === 'active' ? fixture.accounts.activeSource : fixture.accounts.tenantBSource,
          key === 'active'
            ? fixture.accounts.activeDestination
            : fixture.accounts.tenantBDestination,
          key === 'active' ? '17' : '29',
          { operationId: id },
        );
      const tables = [
        'ledger.money_transfers',
        'ledger.money_movements',
        'ledger.owner_ledger_entries',
      ];
      const first = await writes.create(
        principal(firstStore),
        context(firstStore),
        command(firstStore),
      );
      const firstEvidence = await captureReplayEvidence(
        adminPool,
        fixture.stores[firstStore],
        tables,
      );
      const secondBefore = await captureReplayEvidence(
        adminPool,
        fixture.stores[secondStore],
        tables,
      );
      const movementRepository = app.get(MoneyMovementPostingRepository);
      const insert = movementRepository.insertMovementWithinTransaction.bind(movementRepository);
      const databaseFailures: { code?: string; constraint?: string }[] = [];
      const observation = jest
        .spyOn(movementRepository, 'insertMovementWithinTransaction')
        .mockImplementation(async (...args) => {
          try {
            return await insert(...args);
          } catch (error) {
            databaseFailures.push({
              code: postgresqlErrorCode(error),
              constraint: postgresqlConstraint(error),
            });
            throw error;
          }
        });
      let failure: HttpException | undefined;
      let second: MoneyTransferMutationResponse | undefined;
      try {
        second = await writes.create(
          principal(secondStore),
          context(secondStore),
          command(secondStore),
        );
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        failure = error;
      } finally {
        observation.mockRestore();
      }
      expect(await captureReplayEvidence(adminPool, fixture.stores[firstStore], tables)).toEqual(
        firstEvidence,
      );
      expect(
        await writes.create(principal(firstStore), context(firstStore), command(firstStore)),
      ).toEqual(first);
      if (failure) {
        const secondAfter = await captureReplayEvidence(
          adminPool,
          fixture.stores[secondStore],
          tables,
        );
        for (const table of tables) expect(secondAfter[table]).toEqual(secondBefore[table]);
        expect(await transferCount(fixture.stores[secondStore], operationId)).toBe(0);
        expect(await movementCount(fixture.stores[secondStore], operationId)).toBe(0);
        await expect(
          writes.create(principal(secondStore), context(secondStore), command(secondStore)),
        ).rejects.toMatchObject({ response: failure.getResponse() });
        expect(await captureReplayEvidence(adminPool, fixture.stores[secondStore], tables)).toEqual(
          secondAfter,
        );
      }
      // The same second Store/accounts/actor work with a fresh UUID; the refusal
      // is caused by shared identity, not tenant admission or resource eligibility.
      const independentId = randomUUID();
      await writes.create(
        principal(secondStore),
        context(secondStore),
        command(secondStore, independentId),
      );
      expect(await transferCount(fixture.stores[secondStore], independentId)).toBe(1);
      expect(await movementCount(fixture.stores[secondStore], independentId)).toBe(2);
      expect({
        secondStatus: failure?.getStatus() ?? 201,
        secondResponse: failure?.getResponse() ?? null,
        databaseFailures,
        firstOperation: await processedOperation(fixture.stores[firstStore], operationId),
        secondOperation: await processedOperation(fixture.stores[secondStore], operationId),
      }).toEqual({
        secondStatus: 201,
        secondResponse: null,
        databaseFailures: [],
        firstOperation: { status: 'applied', errorCode: null },
        secondOperation: { status: 'applied', errorCode: null },
      });
      if (!second) throw new Error('Second Store transfer did not apply.');
      expect(second.transfer.id).not.toBe(first.transfer.id);
      expect(new Set([...first.movements, ...second.movements].map((row) => row.id)).size).toBe(4);
      for (const key of [firstStore, secondStore] as const) {
        expect(await transferCount(fixture.stores[key], operationId)).toBe(1);
        const facts = await movements(fixture.stores[key], operationId);
        expect(facts).toHaveLength(2);
        expect(facts.map((row) => row.amountDeltaMinor).sort()).toEqual(
          key === 'active' ? ['-17', '17'] : ['-29', '29'],
        );
      }
      const secondEvidence = await captureReplayEvidence(
        adminPool,
        fixture.stores[secondStore],
        tables,
      );
      expect(
        await writes.create(principal(secondStore), context(secondStore), command(secondStore)),
      ).toEqual(second);
      expect(await captureReplayEvidence(adminPool, fixture.stores[secondStore], tables)).toEqual(
        secondEvidence,
      );
    },
  );

  it('Stage 3B B02 binds replay to the original device and permits an authorized same-Store actor', async () => {
    const request = transferRequest(
      fixture.accounts.activeSource,
      fixture.accounts.activeDestination,
      '13',
    );
    const secondDevice = randomUUID();
    await adminPool.query(
      `insert into ledger.devices(id,store_id,device_name,platform,installation_id,device_prefix,status)
       values($1,$2,'Stage 3B second device','android',$3,'b3','active')`,
      [secondDevice, fixture.stores.active, randomUUID()],
    );
    await adminPool.query(
      `insert into platform.store_memberships(id,store_id,user_id,role,status)
       values($1,$2,$3,'owner','active')`,
      [randomUUID(), fixture.stores.active, fixture.users.tenantB],
    );
    const first = await writes.create(principal('active'), context('active'), request);
    const tables = [
      'ledger.money_transfers',
      'ledger.money_movements',
      'ledger.owner_ledger_entries',
    ];
    const before = await captureReplayEvidence(adminPool, fixture.stores.active, tables);
    await expect(
      writes.create(
        { ...principal('active'), deviceId: secondDevice },
        { ...context('active'), deviceId: secondDevice },
        request,
      ),
    ).rejects.toMatchObject({ response: { code: 'OPERATION_ID_CONFLICT' } });
    // The contract binds Store/device/intent, not user identity. Both users have active membership.
    expect(
      await writes.create(
        { ...principal('active'), userId: fixture.users.tenantB },
        { ...context('active'), userId: fixture.users.tenantB },
        request,
      ),
    ).toEqual(first);
    const after = await captureReplayEvidence(adminPool, fixture.stores.active, tables);
    for (const table of [...tables, 'sync.processed_operations'])
      expect(after[table]).toEqual(before[table]);
    expect(await movementCount(fixture.stores.active, request.operationId)).toBe(2);
    expect(await transferCount(fixture.stores.active, request.operationId)).toBe(1);
  });

  it.each(['transfer', 'contribution'] as const)(
    'Stage 3B B02 rejects cross-family reuse when %s claims the UUID first',
    async (firstFamily) => {
      if (!app) throw new Error('Transfer application is unavailable');
      const ownerWrites = app.get(OwnerLedgerWriteService);
      const request = transferRequest(
        fixture.accounts.activeSource,
        fixture.accounts.activeDestination,
        '11',
      );
      const contribution = {
        operationId: request.operationId,
        moneyAccountId: fixture.accounts.activeSource,
        amountMinor: '11',
        occurredAt: request.occurredAt,
      };
      const transfer = () => writes.create(principal('active'), context('active'), request);
      const owner = () =>
        ownerWrites.postContribution(principal('active'), context('active'), contribution);
      const accepted = firstFamily === 'transfer' ? transfer : owner;
      const rejected = firstFamily === 'transfer' ? owner : transfer;
      const first = await accepted();
      const tables = [
        'ledger.money_transfers',
        'ledger.money_movements',
        'ledger.owner_ledger_entries',
      ];
      const before = await captureReplayEvidence(adminPool, fixture.stores.active, tables);
      await expect(rejected()).rejects.toMatchObject({
        response: { code: 'OPERATION_ID_CONFLICT' },
      });
      expect(await accepted()).toEqual(first);
      const after = await captureReplayEvidence(adminPool, fixture.stores.active, tables);
      for (const table of [...tables, 'sync.processed_operations'])
        expect(after[table]).toEqual(before[table]);
      expect(await movementCount(fixture.stores.active, request.operationId)).toBe(
        firstFamily === 'transfer' ? 2 : 1,
      );
      expect(await transferCount(fixture.stores.active, request.operationId)).toBe(
        firstFamily === 'transfer' ? 1 : 0,
      );
    },
  );

  it('stores and exactly replays same-account rejection without financial facts', async () => {
    const request = transferRequest(
      fixture.accounts.activeSource,
      fixture.accounts.activeSource,
      '1',
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        writes.create(principal('active'), context('active'), request),
      ).rejects.toMatchObject({ response: { code: 'MONEY_TRANSFER_SAME_ACCOUNT' } });
    }
    expect(await transferCount(fixture.stores.active, request.operationId)).toBe(0);
    expect(await movementCount(fixture.stores.active, request.operationId)).toBe(0);
    expect(await processedOperation(fixture.stores.active, request.operationId)).toEqual({
      status: 'rejected',
      errorCode: 'MONEY_TRANSFER_SAME_ACCOUNT',
    });
  });

  it.each([
    ['archived source', fixture.accounts.archived, fixture.accounts.activeDestination],
    ['archived destination', fixture.accounts.activeSource, fixture.accounts.archived],
    ['unavailable source', fixture.accounts.held, fixture.accounts.activeDestination],
    ['unavailable destination', fixture.accounts.activeSource, fixture.accounts.held],
  ])(
    'rejects %s after account locking with no transfer facts',
    async (_name, source, destination) => {
      const request = transferRequest(source, destination, '1');
      await expect(
        writes.create(principal('active'), context('active'), request),
      ).rejects.toMatchObject({ response: { code: 'MONEY_ACCOUNT_UNAVAILABLE' } });
      expect(await transferCount(fixture.stores.active, request.operationId)).toBe(0);
      expect(await movementCount(fixture.stores.active, request.operationId)).toBe(0);
    },
  );

  it('rejects a closed-period transfer and persists its deterministic rejection', async () => {
    const request = transferRequest(
      fixture.accounts.activeSource,
      fixture.accounts.activeDestination,
      '1',
      { occurredAt: '2026-02-15T10:00:00.000Z' },
    );
    await expect(
      writes.create(principal('active'), context('active'), request),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE' } });
    expect(await processedOperation(fixture.stores.active, request.operationId)).toEqual({
      status: 'rejected',
      errorCode: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE',
    });
    expect(await movementCount(fixture.stores.active, request.operationId)).toBe(0);
  });

  it('Stage 3B B03 replays the stored historical response and conflicts on changed transfer direction or intent', async () => {
    const request = transferRequest(
      fixture.accounts.activeSource,
      fixture.accounts.activeDestination,
      '25',
    );
    const original = await writes.create(principal('active'), context('active'), request);
    const tables = ['ledger.money_transfers', 'ledger.money_movements'];
    const originalFacts = await captureReplayEvidence(adminPool, fixture.stores.active, tables);
    const before = {
      transfers: await transferCount(fixture.stores.active),
      movements: await movementCount(fixture.stores.active),
    };
    await expect(writes.create(principal('active'), context('active'), request)).resolves.toEqual(
      original,
    );
    expect(await transferCount(fixture.stores.active)).toBe(before.transfers);
    expect(await movementCount(fixture.stores.active)).toBe(before.movements);

    for (const changed of [
      { ...request, amountMinor: '26' },
      { ...request, destinationAccountId: fixture.accounts.activeAlternate },
      {
        ...request,
        sourceAccountId: request.destinationAccountId,
        destinationAccountId: request.sourceAccountId,
      },
    ]) {
      await expect(
        writes.create(principal('active'), context('active'), changed),
      ).rejects.toMatchObject({ response: { code: 'OPERATION_ID_CONFLICT' } });
      const after = await captureReplayEvidence(adminPool, fixture.stores.active, tables);
      for (const table of [...tables, 'sync.processed_operations'])
        expect(after[table]).toEqual(originalFacts[table]);
    }

    await writes.create(
      principal('active'),
      context('active'),
      transferRequest(fixture.accounts.activeDestination, fixture.accounts.activeAlternate, '7'),
    );
    await expect(writes.create(principal('active'), context('active'), request)).resolves.toEqual(
      original,
    );
    const conflicts = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count from sync.conflicts
       where store_id = $1 and operation_id = $2`,
      [fixture.stores.active, request.operationId],
    );
    expect(conflicts.rows).toEqual([{ count: 3 }]);
  });

  it('allows completed replay in read_only but rejects a genuinely new transfer before claim', async () => {
    await adminPool.query("update ledger.stores set status = 'active' where id = $1", [
      fixture.stores.readOnly,
    ]);
    const request = transferRequest(
      fixture.accounts.readOnlySource,
      fixture.accounts.readOnlyDestination,
      '5',
    );
    const original = await writes.create(principal('readOnly'), context('readOnly'), request);
    await adminPool.query("update ledger.stores set status = 'read_only' where id = $1", [
      fixture.stores.readOnly,
    ]);
    try {
      await expect(
        writes.create(principal('readOnly'), context('readOnly'), request),
      ).resolves.toEqual(original);
      const newRequest = transferRequest(
        fixture.accounts.readOnlySource,
        fixture.accounts.readOnlyDestination,
        '1',
      );
      await expect(
        writes.create(principal('readOnly'), context('readOnly'), newRequest),
      ).rejects.toMatchObject({ response: { code: 'BUSINESS_WRITE_NOT_ALLOWED' } });
      expect(
        await processedOperation(fixture.stores.readOnly, newRequest.operationId),
      ).toBeUndefined();
    } finally {
      await adminPool.query("update ledger.stores set status = 'active' where id = $1", [
        fixture.stores.readOnly,
      ]);
    }
  });

  it('fails closed for either cross-Store account position and hides foreign transfer rows', async () => {
    const foreignDestination = transferRequest(
      fixture.accounts.activeSource,
      fixture.accounts.tenantBDestination,
      '1',
    );
    const foreignSource = transferRequest(
      fixture.accounts.tenantBSource,
      fixture.accounts.activeDestination,
      '1',
    );
    for (const request of [foreignDestination, foreignSource]) {
      await expect(
        writes.create(principal('active'), context('active'), request),
      ).rejects.toMatchObject({ response: { code: 'MONEY_ACCOUNT_NOT_FOUND' } });
      expect(await transferCount(fixture.stores.active, request.operationId)).toBe(0);
      expect(await movementCount(fixture.stores.active, request.operationId)).toBe(0);
    }

    const tenantB = await writes.create(
      principal('tenantB'),
      context('tenantB'),
      transferRequest(fixture.accounts.tenantBSource, fixture.accounts.tenantBDestination, '3'),
    );
    const hidden = await database.withTenantTransaction(context('active'), (transaction) =>
      transaction.execute<{ count: number }>(sql`
        select count(*)::integer as count from ledger.money_transfers
        where id = ${tenantB.transfer.id}::uuid
      `),
    );
    expect(hidden.rows).toEqual([{ count: 0 }]);
    const missingContext = await database.transaction((transaction) =>
      transaction.execute<{ count: number }>(sql`
        select count(*)::integer as count from ledger.money_transfers
      `),
    );
    expect(missingContext.rows).toEqual([{ count: 0 }]);
  });

  it('serializes opposite and same-direction pairs without deadlock or accidental deduplication', async () => {
    const firstOperation = randomUUID();
    const secondOperation = randomUUID();
    const [forward, backward] = await Promise.all([
      writes.create(
        principal('concurrent'),
        context('concurrent'),
        transferRequest(fixture.accounts.concurrentHigh, fixture.accounts.concurrentLow, '30', {
          operationId: firstOperation,
        }),
      ),
      writes.create(
        principal('concurrent'),
        context('concurrent'),
        transferRequest(fixture.accounts.concurrentLow, fixture.accounts.concurrentHigh, '10', {
          operationId: secondOperation,
        }),
      ),
    ]);
    expect([forward, backward]).toHaveLength(2);
    for (const operationId of [firstOperation, secondOperation]) {
      const rows = await movements(fixture.stores.concurrent, operationId);
      expect(rows).toHaveLength(2);
      expect(rows.reduce((sum, row) => sum + BigInt(row.amountDeltaMinor), 0n)).toBe(0n);
    }
    expect(await balance(fixture.stores.concurrent, fixture.accounts.concurrentLow)).toBe(20n);
    expect(await balance(fixture.stores.concurrent, fixture.accounts.concurrentHigh)).toBe(-20n);

    const sameDirectionRequests = [randomUUID(), randomUUID()].map((operationId) =>
      transferRequest(fixture.accounts.concurrentLow, fixture.accounts.concurrentHigh, '5', {
        operationId,
      }),
    );
    await expect(
      Promise.all(
        sameDirectionRequests.map((request) =>
          writes.create(principal('concurrent'), context('concurrent'), request),
        ),
      ),
    ).resolves.toHaveLength(2);
    expect(await transferCount(fixture.stores.concurrent)).toBe(4);
    expect(await movementCount(fixture.stores.concurrent)).toBe(8);
  });

  it('rolls back a source fact when destination identity collides with immutable history', async () => {
    const request = transferRequest(
      fixture.accounts.rollbackSource,
      fixture.accounts.rollbackDestination,
      '11',
    );
    const seededId = randomUUID();
    await adminPool.query(
      `insert into ledger.money_movements (
         id, store_id, account_id, accounting_period_id, movement_type, amount_delta_minor,
         reference_type, reference_id, transaction_group_id, occurred_at, device_id, operation_id
       ) values ($1,$2,$3,$4,'other',1,'test',$5,$6,$7,$8,$9)`,
      [
        seededId,
        fixture.stores.rollback,
        fixture.accounts.rollbackDestination,
        januaryPeriods.rollback,
        randomUUID(),
        randomUUID(),
        new Date('2026-01-01T10:00:00.000Z'),
        fixture.devices.rollback,
        deriveMoneyFactOperationId(
          fixture.stores.rollback,
          request.operationId,
          'transfer-destination',
        ),
      ],
    );
    try {
      await expect(
        writes.create(principal('rollback'), context('rollback'), request),
      ).rejects.toMatchObject({
        response: { code: 'MONEY_TRANSFER_FACT_IDENTITY_CONFLICT' },
      });
      const sourceId = deriveMoneyFactId(
        fixture.stores.rollback,
        request.operationId,
        'transfer-source',
      );
      const source = await adminPool.query<{ count: number }>(
        'select count(*)::integer as count from ledger.money_movements where id = $1',
        [sourceId],
      );
      expect(source.rows).toEqual([{ count: 0 }]);
      expect(await transferCount(fixture.stores.rollback, request.operationId)).toBe(0);
      expect(await processedOperation(fixture.stores.rollback, request.operationId)).toEqual({
        status: 'rejected',
        errorCode: 'MONEY_TRANSFER_FACT_IDENTITY_CONFLICT',
      });
    } finally {
      await adminPool.query('delete from ledger.money_movements where id = $1', [seededId]);
    }
  });

  it('rolls back header, both movements, and claim when operation completion fails', async () => {
    const request = transferRequest(
      fixture.accounts.rollbackSource,
      fixture.accounts.rollbackDestination,
      '9',
    );
    const completion = repository as unknown as {
      applyOperation: (...args: unknown[]) => Promise<void>;
    };
    const failure = jest
      .spyOn(completion, 'applyOperation')
      .mockRejectedValueOnce(new Error('test-only completion failure'));
    try {
      await expect(
        writes.create(principal('rollback'), context('rollback'), request),
      ).rejects.toThrow('test-only completion failure');
    } finally {
      failure.mockRestore();
    }
    expect(await movementCount(fixture.stores.rollback, request.operationId)).toBe(0);
    expect(await transferCount(fixture.stores.rollback, request.operationId)).toBe(0);
    expect(await processedOperation(fixture.stores.rollback, request.operationId)).toBeUndefined();
  });

  it('keeps posted transfer headers and movements immutable', async () => {
    let movementCode: string | undefined;
    let headerCode: string | undefined;
    try {
      await database.withTenantTransaction(context('active'), (transaction) =>
        transaction.execute(sql`
          update ledger.money_movements set notes = 'changed'
          where id = ${basicTransfer.transfer.sourceMovementId}::uuid
        `),
      );
    } catch (error) {
      movementCode = postgresqlErrorCode(error);
    }
    try {
      await database.withTenantTransaction(context('active'), (transaction) =>
        transaction.execute(sql`
          update ledger.money_transfers set amount_minor = amount_minor + 1
          where id = ${basicTransfer.transfer.id}::uuid
        `),
      );
    } catch (error) {
      headerCode = postgresqlErrorCode(error);
    }
    expect(movementCode).toBe('55000');
    expect(headerCode).toBe('55000');
  });
});
