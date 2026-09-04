import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { Pool } from 'pg';

import { AccountingCorrectionPostingRepository } from '../src/accounting-corrections/accounting-correction-posting.repository';
import { AccountingCorrectionWriteService } from '../src/accounting-corrections/accounting-correction-write.service';
import { deriveAccountingPeriodId } from '../src/accounting-periods/accounting-period-identity';
import { resolveAccountingPeriodBoundaries } from '../src/accounting-periods/accounting-period-month';
import type { AuthenticatedPrincipal } from '../src/auth/auth.types';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import type { TenantTransactionContext } from '../src/database/database.types';
import { deriveMoneyFactId } from '../src/money-movements/money-movement-identity';
import { MoneyTransferWriteService } from '../src/money-transfers/money-transfer-write.service';
import { OwnerLedgerPostingRepository } from '../src/owner-ledger/owner-ledger-posting.repository';
import { OwnerLedgerWriteService } from '../src/owner-ledger/owner-ledger-write.service';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();

jest.setTimeout(120_000);

const fixture = {
  stores: {
    active: 'c1000000-0000-4000-8000-000000000001',
    tenantB: 'c1000000-0000-4000-8000-000000000002',
    concurrent: 'c1000000-0000-4000-8000-000000000003',
    loan: 'c1000000-0000-4000-8000-000000000004',
    reimbursement: 'c1000000-0000-4000-8000-000000000005',
    readOnly: 'c1000000-0000-4000-8000-000000000006',
    rollback: 'c1000000-0000-4000-8000-000000000007',
    liabilityConcurrent: 'c1000000-0000-4000-8000-000000000008',
  },
  users: {
    active: 'c1100000-0000-4000-8000-000000000001',
    tenantB: 'c1100000-0000-4000-8000-000000000002',
    concurrent: 'c1100000-0000-4000-8000-000000000003',
    loan: 'c1100000-0000-4000-8000-000000000004',
    reimbursement: 'c1100000-0000-4000-8000-000000000005',
    readOnly: 'c1100000-0000-4000-8000-000000000006',
    rollback: 'c1100000-0000-4000-8000-000000000007',
    liabilityConcurrent: 'c1100000-0000-4000-8000-000000000008',
  },
  devices: {
    active: 'c1200000-0000-4000-8000-000000000001',
    tenantB: 'c1200000-0000-4000-8000-000000000002',
    concurrent: 'c1200000-0000-4000-8000-000000000003',
    loan: 'c1200000-0000-4000-8000-000000000004',
    reimbursement: 'c1200000-0000-4000-8000-000000000005',
    readOnly: 'c1200000-0000-4000-8000-000000000006',
    rollback: 'c1200000-0000-4000-8000-000000000007',
    liabilityConcurrent: 'c1200000-0000-4000-8000-000000000008',
  },
  accounts: {
    activeCash: 'c1300000-0000-4000-8000-000000000001',
    activeBank: 'c1300000-0000-4000-8000-000000000002',
    activeAlternate: 'c1300000-0000-4000-8000-000000000003',
    openingPositive: 'c1300000-0000-4000-8000-000000000004',
    openingNegative: 'c1300000-0000-4000-8000-000000000005',
    tenantBCash: 'c1300000-0000-4000-8000-000000000006',
    concurrentCash: 'c1300000-0000-4000-8000-000000000007',
    concurrentBank: 'c1300000-0000-4000-8000-000000000008',
    loanCash: 'c1300000-0000-4000-8000-000000000009',
    loanBank: 'c1300000-0000-4000-8000-000000000010',
    reimbursementCash: 'c1300000-0000-4000-8000-000000000011',
    reimbursementBank: 'c1300000-0000-4000-8000-000000000012',
    readOnlyCash: 'c1300000-0000-4000-8000-000000000013',
    rollbackCash: 'c1300000-0000-4000-8000-000000000014',
    rollbackBank: 'c1300000-0000-4000-8000-000000000015',
    concurrentAlternate: 'c1300000-0000-4000-8000-000000000016',
    liabilityConcurrentCash: 'c1300000-0000-4000-8000-000000000017',
    liabilityConcurrentBank: 'c1300000-0000-4000-8000-000000000018',
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
  amountDeltaMinor: string;
  movementType: string;
  transactionGroupId: string;
  reversalOfId: string | null;
  operationId: string;
}

interface OwnerRow {
  id: string;
  ownerLiabilityDeltaMinor: string;
  equityDeltaMinor: string;
  entryType: string;
  transactionGroupId: string;
  reversalOfId: string | null;
}

describe('S10.5 same-domain accounting corrections with real PostgreSQL', () => {
  let app: INestApplication | undefined;
  let adminPool: Pool;
  let ownerWrites: OwnerLedgerWriteService;
  let transferWrites: MoneyTransferWriteService;
  let corrections: AccountingCorrectionWriteService;
  let correctionRepository: AccountingCorrectionPostingRepository;
  let ownerPosting: OwnerLedgerPostingRepository;
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

  function ownerRequest(accountId: string, amountMinor: string, operationId = randomUUID()) {
    return {
      operationId,
      moneyAccountId: accountId,
      amountMinor,
      occurredAt: '2026-01-15T10:00:00.000Z',
    };
  }

  function reversal(operationId = randomUUID(), occurredAt = '2026-01-20T10:00:00.000Z') {
    return { operationId, occurredAt };
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
  ): Promise<void> {
    await adminPool.query(
      `insert into ledger.money_accounts (
         id, store_id, name, normalized_name, account_type, availability, is_default,
         status, operation_id, version
       ) values ($1,$2,$3,$4,$5,'available',$6,'active',$7,1)`,
      [id, storeId, name, name.toLowerCase(), accountType, accountType === 'cash', randomUUID()],
    );
  }

  async function movementRows(storeId: string, operationId: string): Promise<MovementRow[]> {
    const result = await adminPool.query<MovementRow>(
      `select id, account_id as "accountId", amount_delta_minor::text as "amountDeltaMinor",
              movement_type as "movementType", transaction_group_id as "transactionGroupId",
              reversal_of_id as "reversalOfId", operation_id as "operationId"
       from ledger.money_movements
       where store_id = $1 and transaction_group_id = $2
       order by created_at, id`,
      [storeId, operationId],
    );
    return result.rows;
  }

  async function ownerRows(storeId: string, operationId: string): Promise<OwnerRow[]> {
    const result = await adminPool.query<OwnerRow>(
      `select id, owner_liability_delta_minor::text as "ownerLiabilityDeltaMinor",
              equity_delta_minor::text as "equityDeltaMinor", entry_type as "entryType",
              transaction_group_id as "transactionGroupId", reversal_of_id as "reversalOfId"
       from ledger.owner_ledger_entries
       where store_id = $1 and transaction_group_id = $2
       order by created_at, id`,
      [storeId, operationId],
    );
    return result.rows;
  }

  async function balance(storeId: string, accountId: string): Promise<bigint> {
    const result = await adminPool.query<{ value: string }>(
      `select coalesce(sum(amount_delta_minor),0)::text as value
       from ledger.money_movements where store_id = $1 and account_id = $2`,
      [storeId, accountId],
    );
    return BigInt(result.rows[0]?.value ?? '0');
  }

  async function ownerPosition(storeId: string): Promise<{ liability: bigint; equity: bigint }> {
    const result = await adminPool.query<{ liability: string; equity: string }>(
      `select coalesce(sum(owner_liability_delta_minor),0)::text as liability,
              coalesce(sum(equity_delta_minor),0)::text as equity
       from ledger.owner_ledger_entries where store_id = $1`,
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
    process.env.DB_POOL_MAX = '16';

    adminPool = createTestPool(
      environment.adminUrl,
      'dokana-s105-admin',
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
      throw new Error('The local S10.5 mutation fixture database is not approved.');
    }

    await removeFixtures();
    for (const [index, key] of (Object.keys(fixture.stores) as StoreKey[]).entries()) {
      await adminPool.query(
        `insert into platform.users (
           id, email, normalized_email, password_hash, full_name, status
         ) values ($1,$2,$2,'test-only-hash',$3,'active')`,
        [fixture.users[key], `s105-${key.toLowerCase()}@example.test`, `S10.5 ${key}`],
      );
      await adminPool.query(
        "insert into ledger.stores (id, name, status) values ($1,$2,'active')",
        [fixture.stores[key], `S10.5 ${key} store`],
      );
      await adminPool.query(
        `insert into ledger.devices (
           id, store_id, device_name, platform, installation_id, device_prefix, status
         ) values ($1,$2,$3,'android',$4,$5,'active')`,
        [
          fixture.devices[key],
          fixture.stores[key],
          `S10.5 ${key} device`,
          randomUUID(),
          `c${index.toString()}`,
        ],
      );
      await insertPeriod(fixture.stores[key], januaryPeriods[key], 2026, 1, 'open');
    }
    await insertPeriod(fixture.stores.active, closedFebruaryPeriod, 2026, 2, 'closed');

    await insertAccount(fixture.stores.active, fixture.accounts.activeCash, 'active cash', 'cash');
    await insertAccount(fixture.stores.active, fixture.accounts.activeBank, 'active bank');
    await insertAccount(
      fixture.stores.active,
      fixture.accounts.activeAlternate,
      'active alternate',
    );
    await insertAccount(
      fixture.stores.active,
      fixture.accounts.openingPositive,
      'opening positive',
    );
    await insertAccount(
      fixture.stores.active,
      fixture.accounts.openingNegative,
      'opening negative',
    );
    await insertAccount(
      fixture.stores.tenantB,
      fixture.accounts.tenantBCash,
      'tenant b cash',
      'cash',
    );
    await insertAccount(
      fixture.stores.concurrent,
      fixture.accounts.concurrentCash,
      'concurrent cash',
      'cash',
    );
    await insertAccount(
      fixture.stores.concurrent,
      fixture.accounts.concurrentBank,
      'concurrent bank',
    );
    await insertAccount(
      fixture.stores.concurrent,
      fixture.accounts.concurrentAlternate,
      'concurrent alternate',
    );
    await insertAccount(fixture.stores.loan, fixture.accounts.loanCash, 'loan cash', 'cash');
    await insertAccount(fixture.stores.loan, fixture.accounts.loanBank, 'loan bank');
    await insertAccount(
      fixture.stores.reimbursement,
      fixture.accounts.reimbursementCash,
      'reimbursement cash',
      'cash',
    );
    await insertAccount(
      fixture.stores.reimbursement,
      fixture.accounts.reimbursementBank,
      'reimbursement bank',
    );
    await insertAccount(
      fixture.stores.readOnly,
      fixture.accounts.readOnlyCash,
      'read only cash',
      'cash',
    );
    await insertAccount(
      fixture.stores.rollback,
      fixture.accounts.rollbackCash,
      'rollback cash',
      'cash',
    );
    await insertAccount(fixture.stores.rollback, fixture.accounts.rollbackBank, 'rollback bank');
    await insertAccount(
      fixture.stores.liabilityConcurrent,
      fixture.accounts.liabilityConcurrentCash,
      'liability concurrent cash',
      'cash',
    );
    await insertAccount(
      fixture.stores.liabilityConcurrent,
      fixture.accounts.liabilityConcurrentBank,
      'liability concurrent bank',
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
    ownerWrites = nestApp.get(OwnerLedgerWriteService);
    transferWrites = nestApp.get(MoneyTransferWriteService);
    corrections = nestApp.get(AccountingCorrectionWriteService);
    correctionRepository = nestApp.get(AccountingCorrectionPostingRepository);
    ownerPosting = nestApp.get(OwnerLedgerPostingRepository);
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
        ((select count(*) from ledger.money_transfers where store_id = any($1::uuid[]))
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
          + (select count(*) from ledger.stores where id = any($1::uuid[])))::integer as "fixtureRows",
        (select count(*)::integer from platform.users) as users,
        (select count(*)::integer from ledger.stores) as stores,
        ((select count(*) from ledger.money_transfers)
          + (select count(*) from ledger.money_movements)
          + (select count(*) from ledger.owner_ledger_entries)
          + (select count(*) from ledger.document_sequences)
          + (select count(*) from ledger.money_accounts)
          + (select count(*) from ledger.accounting_periods))::integer as "accountingRows",
        (select count(*)::integer from pg_stat_activity
          where datname = current_database() and state = 'idle in transaction') as "idleTransactions"`,
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

  it('replaces signed Opening state through a linear active-leaf chain and terminates it by reversal', async () => {
    const originalOperationId = randomUUID();
    await ownerWrites.postOpeningBalance(
      principal('active'),
      context('active'),
      ownerRequest(fixture.accounts.openingPositive, '100', originalOperationId),
    );
    const firstOperationId = randomUUID();
    const first = await corrections.replaceOpeningBalance(
      principal('active'),
      context('active'),
      originalOperationId,
      { operationId: firstOperationId, amountMinor: '150', occurredAt: '2026-01-20T10:00:00Z' },
    );
    expect(first.movements.map((row) => row.amountDeltaMinor)).toEqual(['-100', '150']);
    expect(first.movements[0]?.reversalOfId).toBe(
      deriveMoneyFactId(originalOperationId, 'opening'),
    );
    expect(first.movements[1]?.reversalOfId).toBeNull();
    expect(await balance(fixture.stores.active, fixture.accounts.openingPositive)).toBe(150n);

    const secondOperationId = randomUUID();
    await corrections.replaceOpeningBalance(
      principal('active'),
      context('active'),
      firstOperationId,
      { operationId: secondOperationId, amountMinor: '-40', occurredAt: '2026-01-21T10:00:00Z' },
    );
    expect(await balance(fixture.stores.active, fixture.accounts.openingPositive)).toBe(-40n);
    await expect(
      corrections.reverse(
        principal('active'),
        context('active'),
        originalOperationId,
        'opening_balance',
        reversal(),
      ),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNTING_CORRECTION_TARGET_NOT_ACTIVE' } });

    const replay = await corrections.replaceOpeningBalance(
      principal('active'),
      context('active'),
      originalOperationId,
      { operationId: firstOperationId, amountMinor: '150', occurredAt: '2026-01-20T10:00:00Z' },
    );
    expect(replay).toEqual(first);

    await expect(
      corrections.replaceOpeningBalance(principal('active'), context('active'), secondOperationId, {
        operationId: randomUUID(),
        amountMinor: '-40',
        occurredAt: '2026-01-22T10:00:00Z',
      }),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNTING_CORRECTION_NO_OP' } });

    const terminal = reversal();
    await corrections.reverse(
      principal('active'),
      context('active'),
      secondOperationId,
      'opening_balance',
      terminal,
    );
    expect(await balance(fixture.stores.active, fixture.accounts.openingPositive)).toBe(0n);
    await expect(
      corrections.reverse(
        principal('active'),
        context('active'),
        secondOperationId,
        'opening_balance',
        reversal(),
      ),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNTING_CORRECTION_TARGET_NOT_ACTIVE' } });
  });

  it('reverses a negative Opening without Owner effects and rejects zero/account replacement', async () => {
    const target = randomUUID();
    await ownerWrites.postOpeningBalance(
      principal('active'),
      context('active'),
      ownerRequest(fixture.accounts.openingNegative, '-25', target),
    );
    const response = await corrections.reverse(
      principal('active'),
      context('active'),
      target,
      'opening_balance',
      reversal(),
    );
    expect(response.movements.map((row) => row.amountDeltaMinor)).toEqual(['25']);
    expect(response.ownerEntries).toEqual([]);
    expect(await ownerRows(fixture.stores.active, response.operationId)).toEqual([]);
    expect(await balance(fixture.stores.active, fixture.accounts.openingNegative)).toBe(0n);
    expect(() =>
      corrections.replaceOpeningBalance(principal('active'), context('active'), target, {
        operationId: randomUUID(),
        amountMinor: '0',
        occurredAt: '2026-01-20T10:00:00Z',
      }),
    ).toThrow(BadRequestException);
  });

  it('replaces Contribution account and amount atomically without liability or revenue/expense effects', async () => {
    const target = randomUUID();
    await ownerWrites.postContribution(
      principal('active'),
      context('active'),
      ownerRequest(fixture.accounts.activeCash, '100', target),
    );
    const operationId = randomUUID();
    const result = await corrections.replaceOwnerEvent(
      principal('active'),
      context('active'),
      target,
      'owner_contribution',
      {
        operationId,
        moneyAccountId: fixture.accounts.activeBank,
        amountMinor: '150',
        occurredAt: '2026-01-20T10:00:00Z',
      },
    );
    expect(result.movements.map((row) => row.amountDeltaMinor)).toEqual(['-100', '150']);
    expect(result.ownerEntries.map((row) => row.equityDeltaMinor)).toEqual(['-100', '150']);
    expect(result.ownerEntries.map((row) => row.ownerLiabilityDeltaMinor)).toEqual(['0', '0']);
    expect((await ownerPosition(fixture.stores.active)).equity).toBe(150n);
    expect(await balance(fixture.stores.active, fixture.accounts.activeCash)).toBe(0n);
    expect(await balance(fixture.stores.active, fixture.accounts.activeBank)).toBe(150n);
    expect(
      (await movementRows(fixture.stores.active, operationId)).every(
        (row) => row.movementType === 'correction',
      ),
    ).toBe(true);
  });

  it('supports amount-only, account-only, combined, and reversal Contribution corrections', async () => {
    const before = await ownerPosition(fixture.stores.active);
    const original = randomUUID();
    await ownerWrites.postContribution(
      principal('active'),
      context('active'),
      ownerRequest(fixture.accounts.activeCash, '40', original),
    );
    const amountOnly = randomUUID();
    await corrections.replaceOwnerEvent(
      principal('active'),
      context('active'),
      original,
      'owner_contribution',
      {
        operationId: amountOnly,
        moneyAccountId: fixture.accounts.activeCash,
        amountMinor: '50',
        occurredAt: '2026-01-20T10:00:00Z',
      },
    );
    const accountOnly = randomUUID();
    await corrections.replaceOwnerEvent(
      principal('active'),
      context('active'),
      amountOnly,
      'owner_contribution',
      {
        operationId: accountOnly,
        moneyAccountId: fixture.accounts.activeBank,
        amountMinor: '50',
        occurredAt: '2026-01-21T10:00:00Z',
      },
    );
    const combined = randomUUID();
    await corrections.replaceOwnerEvent(
      principal('active'),
      context('active'),
      accountOnly,
      'owner_contribution',
      {
        operationId: combined,
        moneyAccountId: fixture.accounts.activeCash,
        amountMinor: '60',
        occurredAt: '2026-01-22T10:00:00Z',
      },
    );
    await expect(
      corrections.replaceOwnerEvent(
        principal('active'),
        context('active'),
        combined,
        'owner_contribution',
        {
          operationId: randomUUID(),
          moneyAccountId: fixture.accounts.activeCash,
          amountMinor: '60',
          occurredAt: '2026-01-23T10:00:00Z',
        },
      ),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNTING_CORRECTION_NO_OP' } });
    await corrections.reverse(
      principal('active'),
      context('active'),
      combined,
      'owner_contribution',
      reversal(),
    );
    expect(await ownerPosition(fixture.stores.active)).toEqual(before);
  });

  it('enforces final-state Owner Loan liability under the Store serialization lock', async () => {
    const loanOperationId = randomUUID();
    await ownerWrites.postLoan(
      principal('loan'),
      context('loan'),
      ownerRequest(fixture.accounts.loanCash, '100', loanOperationId),
    );
    await ownerWrites.postReimbursement(
      principal('loan'),
      context('loan'),
      ownerRequest(fixture.accounts.loanCash, '80'),
    );
    await expect(
      corrections.reverse(
        principal('loan'),
        context('loan'),
        loanOperationId,
        'owner_loan',
        reversal(),
      ),
    ).rejects.toMatchObject({ response: { code: 'OWNER_LIABILITY_EXCEEDED' } });

    await corrections.replaceOwnerEvent(
      principal('loan'),
      context('loan'),
      loanOperationId,
      'owner_loan',
      {
        operationId: randomUUID(),
        moneyAccountId: fixture.accounts.loanBank,
        amountMinor: '90',
        occurredAt: '2026-01-22T10:00:00Z',
      },
    );
    expect((await ownerPosition(fixture.stores.loan)).liability).toBe(10n);
  });

  it('supports safe amount-only, account-only, and reversal Loan corrections', async () => {
    const before = await ownerPosition(fixture.stores.loan);
    const original = randomUUID();
    await ownerWrites.postLoan(
      principal('loan'),
      context('loan'),
      ownerRequest(fixture.accounts.loanCash, '30', original),
    );
    const amountOnly = randomUUID();
    await corrections.replaceOwnerEvent(
      principal('loan'),
      context('loan'),
      original,
      'owner_loan',
      {
        operationId: amountOnly,
        moneyAccountId: fixture.accounts.loanCash,
        amountMinor: '40',
        occurredAt: '2026-01-23T10:00:00Z',
      },
    );
    const accountOnly = randomUUID();
    await corrections.replaceOwnerEvent(
      principal('loan'),
      context('loan'),
      amountOnly,
      'owner_loan',
      {
        operationId: accountOnly,
        moneyAccountId: fixture.accounts.loanBank,
        amountMinor: '40',
        occurredAt: '2026-01-24T10:00:00Z',
      },
    );
    await corrections.reverse(
      principal('loan'),
      context('loan'),
      accountOnly,
      'owner_loan',
      reversal(),
    );
    expect(await ownerPosition(fixture.stores.loan)).toEqual(before);
  });

  it('serializes liability-sensitive corrections against the final authoritative position', async () => {
    await ownerWrites.postLoan(
      principal('liabilityConcurrent'),
      context('liabilityConcurrent'),
      ownerRequest(fixture.accounts.liabilityConcurrentCash, '100'),
    );
    const firstTarget = randomUUID();
    const secondTarget = randomUUID();
    await ownerWrites.postReimbursement(
      principal('liabilityConcurrent'),
      context('liabilityConcurrent'),
      ownerRequest(fixture.accounts.liabilityConcurrentCash, '40', firstTarget),
    );
    await ownerWrites.postReimbursement(
      principal('liabilityConcurrent'),
      context('liabilityConcurrent'),
      ownerRequest(fixture.accounts.liabilityConcurrentBank, '40', secondTarget),
    );

    const attempts = await Promise.allSettled([
      corrections.replaceOwnerEvent(
        principal('liabilityConcurrent'),
        context('liabilityConcurrent'),
        firstTarget,
        'owner_reimbursement',
        {
          operationId: randomUUID(),
          moneyAccountId: fixture.accounts.liabilityConcurrentCash,
          amountMinor: '55',
          occurredAt: '2026-01-23T10:00:00Z',
        },
      ),
      corrections.replaceOwnerEvent(
        principal('liabilityConcurrent'),
        context('liabilityConcurrent'),
        secondTarget,
        'owner_reimbursement',
        {
          operationId: randomUUID(),
          moneyAccountId: fixture.accounts.liabilityConcurrentBank,
          amountMinor: '55',
          occurredAt: '2026-01-23T10:00:00Z',
        },
      ),
    ]);

    expect(attempts.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find((entry) => entry.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { response: { code: 'OWNER_LIABILITY_EXCEEDED' } },
    });
    expect((await ownerPosition(fixture.stores.liabilityConcurrent)).liability).toBe(5n);
  });

  it('replaces a Reimbursement using post-neutralization final liability and a new account', async () => {
    await ownerWrites.postLoan(
      principal('reimbursement'),
      context('reimbursement'),
      ownerRequest(fixture.accounts.reimbursementCash, '200'),
    );
    const target = randomUUID();
    await ownerWrites.postReimbursement(
      principal('reimbursement'),
      context('reimbursement'),
      ownerRequest(fixture.accounts.reimbursementCash, '80', target),
    );
    const result = await corrections.replaceOwnerEvent(
      principal('reimbursement'),
      context('reimbursement'),
      target,
      'owner_reimbursement',
      {
        operationId: randomUUID(),
        moneyAccountId: fixture.accounts.reimbursementBank,
        amountMinor: '90',
        occurredAt: '2026-01-20T10:00:00Z',
      },
    );
    expect(result.movements.map((row) => row.amountDeltaMinor)).toEqual(['80', '-90']);
    expect(result.ownerEntries.map((row) => row.ownerLiabilityDeltaMinor)).toEqual(['80', '-90']);
    expect((await ownerPosition(fixture.stores.reimbursement)).liability).toBe(110n);
  });

  it('supports amount-only, account-only, and reversal Reimbursement corrections', async () => {
    const before = await ownerPosition(fixture.stores.reimbursement);
    const original = randomUUID();
    await ownerWrites.postReimbursement(
      principal('reimbursement'),
      context('reimbursement'),
      ownerRequest(fixture.accounts.reimbursementCash, '20', original),
    );
    const amountOnly = randomUUID();
    await corrections.replaceOwnerEvent(
      principal('reimbursement'),
      context('reimbursement'),
      original,
      'owner_reimbursement',
      {
        operationId: amountOnly,
        moneyAccountId: fixture.accounts.reimbursementCash,
        amountMinor: '25',
        occurredAt: '2026-01-21T10:00:00Z',
      },
    );
    const accountOnly = randomUUID();
    await corrections.replaceOwnerEvent(
      principal('reimbursement'),
      context('reimbursement'),
      amountOnly,
      'owner_reimbursement',
      {
        operationId: accountOnly,
        moneyAccountId: fixture.accounts.reimbursementBank,
        amountMinor: '25',
        occurredAt: '2026-01-22T10:00:00Z',
      },
    );
    await corrections.reverse(
      principal('reimbursement'),
      context('reimbursement'),
      accountOnly,
      'owner_reimbursement',
      reversal(),
    );
    expect(await ownerPosition(fixture.stores.reimbursement)).toEqual(before);
  });

  it('corrects personal and capital withdrawals without liability, Expense, or Profit Withdrawal', async () => {
    const before = await ownerPosition(fixture.stores.active);
    const personal = randomUUID();
    await ownerWrites.postPersonalWithdrawal(
      principal('active'),
      context('active'),
      ownerRequest(fixture.accounts.activeCash, '30', personal),
    );
    const personalCorrection = await corrections.replaceOwnerEvent(
      principal('active'),
      context('active'),
      personal,
      'owner_personal_withdrawal',
      {
        operationId: randomUUID(),
        moneyAccountId: fixture.accounts.activeBank,
        amountMinor: '20',
        occurredAt: '2026-01-23T10:00:00Z',
      },
    );
    const capital = randomUUID();
    await ownerWrites.postCapitalWithdrawal(
      principal('active'),
      context('active'),
      ownerRequest(fixture.accounts.activeCash, '10', capital),
    );
    const capitalCorrection = await corrections.reverse(
      principal('active'),
      context('active'),
      capital,
      'owner_capital_withdrawal',
      reversal(),
    );
    const after = await ownerPosition(fixture.stores.active);
    expect(after.liability).toBe(before.liability);
    expect(after.equity - before.equity).toBe(-20n);
    expect(
      [...personalCorrection.ownerEntries, ...capitalCorrection.ownerEntries].every(
        (row) => row.entryType === 'correction',
      ),
    ).toBe(true);
    expect(
      [...personalCorrection.ownerEntries, ...capitalCorrection.ownerEntries].some(
        (row) => row.entryType === 'profit_withdrawal',
      ),
    ).toBe(false);
  });

  it('supports amount-only, account-only, and reversal Personal Withdrawal corrections', async () => {
    const before = await ownerPosition(fixture.stores.active);
    const original = randomUUID();
    await ownerWrites.postPersonalWithdrawal(
      principal('active'),
      context('active'),
      ownerRequest(fixture.accounts.activeCash, '10', original),
    );
    const amountOnly = randomUUID();
    await corrections.replaceOwnerEvent(
      principal('active'),
      context('active'),
      original,
      'owner_personal_withdrawal',
      {
        operationId: amountOnly,
        moneyAccountId: fixture.accounts.activeCash,
        amountMinor: '12',
        occurredAt: '2026-01-24T10:00:00Z',
      },
    );
    const accountOnly = randomUUID();
    await corrections.replaceOwnerEvent(
      principal('active'),
      context('active'),
      amountOnly,
      'owner_personal_withdrawal',
      {
        operationId: accountOnly,
        moneyAccountId: fixture.accounts.activeBank,
        amountMinor: '12',
        occurredAt: '2026-01-25T10:00:00Z',
      },
    );
    await corrections.reverse(
      principal('active'),
      context('active'),
      accountOnly,
      'owner_personal_withdrawal',
      reversal(),
    );
    expect(await ownerPosition(fixture.stores.active)).toEqual(before);
  });

  it('replaces a Transfer destination/amount with immutable net-zero correction history', async () => {
    const target = randomUUID();
    const original = await transferWrites.create(principal('active'), context('active'), {
      operationId: target,
      sourceAccountId: fixture.accounts.activeCash,
      destinationAccountId: fixture.accounts.activeBank,
      amountMinor: '100',
      occurredAt: '2026-01-15T10:00:00Z',
    });
    const operationId = randomUUID();
    const result = await corrections.replaceTransfer(
      principal('active'),
      context('active'),
      target,
      {
        operationId,
        destinationAccountId: fixture.accounts.activeAlternate,
        amountMinor: '150',
        occurredAt: '2026-01-24T10:00:00Z',
      },
    );
    expect(result.movements.map((row) => row.amountDeltaMinor)).toEqual([
      '100',
      '-100',
      '-150',
      '150',
    ]);
    expect(result.movements.reduce((sum, row) => sum + BigInt(row.amountDeltaMinor), 0n)).toBe(0n);
    expect(result.replacementTransfer).toMatchObject({
      id: deriveMoneyFactId(operationId, 'replacement:transfer-header'),
      sourceAccountId: fixture.accounts.activeCash,
      destinationAccountId: fixture.accounts.activeAlternate,
      amountMinor: '150',
    });
    const unchanged = await adminPool.query(
      'select source_account_id, destination_account_id, amount_minor::text from ledger.money_transfers where id = $1',
      [original.transfer.id],
    );
    expect(unchanged.rows[0]).toEqual({
      source_account_id: fixture.accounts.activeCash,
      destination_account_id: fixture.accounts.activeBank,
      amount_minor: '100',
    });
    await expect(
      corrections.replaceTransfer(principal('active'), context('active'), operationId, {
        operationId: randomUUID(),
        destinationAccountId: fixture.accounts.activeAlternate,
        amountMinor: '150',
        occurredAt: '2026-01-25T10:00:00Z',
      }),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNTING_CORRECTION_NO_OP' } });
  });

  it('supports amount-only and destination-only Transfer replacements', async () => {
    const amountTarget = randomUUID();
    await transferWrites.create(principal('active'), context('active'), {
      operationId: amountTarget,
      sourceAccountId: fixture.accounts.activeCash,
      destinationAccountId: fixture.accounts.activeBank,
      amountMinor: '20',
      occurredAt: '2026-01-15T10:00:00Z',
    });
    const amountOnly = await corrections.replaceTransfer(
      principal('active'),
      context('active'),
      amountTarget,
      {
        operationId: randomUUID(),
        destinationAccountId: fixture.accounts.activeBank,
        amountMinor: '25',
        occurredAt: '2026-01-24T10:00:00Z',
      },
    );
    expect(amountOnly.replacementTransfer).toMatchObject({
      sourceAccountId: fixture.accounts.activeCash,
      destinationAccountId: fixture.accounts.activeBank,
      amountMinor: '25',
    });

    const destinationTarget = randomUUID();
    await transferWrites.create(principal('active'), context('active'), {
      operationId: destinationTarget,
      sourceAccountId: fixture.accounts.activeCash,
      destinationAccountId: fixture.accounts.activeBank,
      amountMinor: '30',
      occurredAt: '2026-01-15T10:00:00Z',
    });
    const destinationOnly = await corrections.replaceTransfer(
      principal('active'),
      context('active'),
      destinationTarget,
      {
        operationId: randomUUID(),
        destinationAccountId: fixture.accounts.activeAlternate,
        amountMinor: '30',
        occurredAt: '2026-01-25T10:00:00Z',
      },
    );
    expect(destinationOnly.replacementTransfer).toMatchObject({
      sourceAccountId: fixture.accounts.activeCash,
      destinationAccountId: fixture.accounts.activeAlternate,
      amountMinor: '30',
    });
    await expect(
      corrections.replaceTransfer(
        principal('active'),
        context('active'),
        destinationOnly.operationId,
        {
          operationId: randomUUID(),
          destinationAccountId: fixture.accounts.activeCash,
          amountMinor: '30',
          occurredAt: '2026-01-26T10:00:00Z',
        },
      ),
    ).rejects.toMatchObject({ response: { code: 'MONEY_TRANSFER_SAME_ACCOUNT' } });
  });

  it('purely reverses a Transfer without creating a replacement header', async () => {
    const beforeSource = await balance(fixture.stores.active, fixture.accounts.activeCash);
    const beforeDestination = await balance(fixture.stores.active, fixture.accounts.activeBank);
    const target = randomUUID();
    await transferWrites.create(principal('active'), context('active'), {
      operationId: target,
      sourceAccountId: fixture.accounts.activeCash,
      destinationAccountId: fixture.accounts.activeBank,
      amountMinor: '35',
      occurredAt: '2026-01-15T10:00:00Z',
    });
    const command = reversal();
    const result = await corrections.reverse(
      principal('active'),
      context('active'),
      target,
      'internal_transfer',
      command,
    );

    expect(result.replacementTransfer).toBeNull();
    expect(result.movements.map((row) => row.amountDeltaMinor)).toEqual(['35', '-35']);
    expect(result.movements.reduce((sum, row) => sum + BigInt(row.amountDeltaMinor), 0n)).toBe(0n);
    expect(await balance(fixture.stores.active, fixture.accounts.activeCash)).toBe(beforeSource);
    expect(await balance(fixture.stores.active, fixture.accounts.activeBank)).toBe(
      beforeDestination,
    );
    const replacementHeader = await adminPool.query(
      'select id from ledger.money_transfers where store_id = $1 and id = $2',
      [
        fixture.stores.active,
        deriveMoneyFactId(command.operationId, 'replacement:transfer-header'),
      ],
    );
    expect(replacementHeader.rows).toEqual([]);
  });

  it('locks overlapping Transfer correction account sets canonically without deadlock', async () => {
    const firstTarget = randomUUID();
    const secondTarget = randomUUID();
    await transferWrites.create(principal('concurrent'), context('concurrent'), {
      operationId: firstTarget,
      sourceAccountId: fixture.accounts.concurrentCash,
      destinationAccountId: fixture.accounts.concurrentBank,
      amountMinor: '10',
      occurredAt: '2026-01-15T10:00:00Z',
    });
    await transferWrites.create(principal('concurrent'), context('concurrent'), {
      operationId: secondTarget,
      sourceAccountId: fixture.accounts.concurrentBank,
      destinationAccountId: fixture.accounts.concurrentAlternate,
      amountMinor: '20',
      occurredAt: '2026-01-15T10:00:00Z',
    });
    const firstOperationId = randomUUID();
    const secondOperationId = randomUUID();
    const results = await Promise.all([
      corrections.replaceTransfer(principal('concurrent'), context('concurrent'), firstTarget, {
        operationId: firstOperationId,
        destinationAccountId: fixture.accounts.concurrentAlternate,
        amountMinor: '15',
        occurredAt: '2026-01-24T10:00:00Z',
      }),
      corrections.replaceTransfer(principal('concurrent'), context('concurrent'), secondTarget, {
        operationId: secondOperationId,
        destinationAccountId: fixture.accounts.concurrentCash,
        amountMinor: '25',
        occurredAt: '2026-01-24T10:00:00Z',
      }),
    ]);

    expect(results).toHaveLength(2);
    for (const operationId of [firstOperationId, secondOperationId]) {
      const rows = await movementRows(fixture.stores.concurrent, operationId);
      expect(rows).toHaveLength(4);
      expect(rows.reduce((sum, row) => sum + BigInt(row.amountDeltaMinor), 0n)).toBe(0n);
    }
  });

  it('serializes competing Opening corrections against one active target with no double reversal', async () => {
    const target = randomUUID();
    await ownerWrites.postOpeningBalance(
      principal('concurrent'),
      context('concurrent'),
      ownerRequest(fixture.accounts.concurrentCash, '100', target),
    );
    const attempts = await Promise.allSettled([
      corrections.replaceOpeningBalance(principal('concurrent'), context('concurrent'), target, {
        operationId: randomUUID(),
        amountMinor: '150',
        occurredAt: '2026-01-20T10:00:00Z',
      }),
      corrections.replaceOpeningBalance(principal('concurrent'), context('concurrent'), target, {
        operationId: randomUUID(),
        amountMinor: '130',
        occurredAt: '2026-01-20T10:00:00Z',
      }),
    ]);
    expect(attempts.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
    const reversals = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.money_movements
       where store_id = $1 and reversal_of_id = $2`,
      [fixture.stores.concurrent, deriveMoneyFactId(target, 'opening')],
    );
    expect(reversals.rows[0]?.count).toBe(1);
  });

  it('fails cross-Store targets closed and rejects a mismatched same-Store domain', async () => {
    const target = randomUUID();
    await ownerWrites.postContribution(
      principal('tenantB'),
      context('tenantB'),
      ownerRequest(fixture.accounts.tenantBCash, '20', target),
    );
    await expect(
      corrections.reverse(
        principal('active'),
        context('active'),
        target,
        'owner_contribution',
        reversal(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    const localTarget = randomUUID();
    await ownerWrites.postContribution(
      principal('active'),
      context('active'),
      ownerRequest(fixture.accounts.activeCash, '5', localTarget),
    );
    await expect(
      corrections.reverse(
        principal('active'),
        context('active'),
        localTarget,
        'owner_loan',
        reversal(),
      ),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNTING_CORRECTION_DOMAIN_MISMATCH' } });

    const activeReplacement = await corrections.replaceOwnerEvent(
      principal('active'),
      context('active'),
      localTarget,
      'owner_contribution',
      {
        operationId: randomUUID(),
        moneyAccountId: fixture.accounts.activeCash,
        amountMinor: '6',
        occurredAt: '2026-01-20T10:00:00Z',
      },
    );
    await expect(
      corrections.reverse(
        principal('active'),
        context('active'),
        activeReplacement.operationId,
        'owner_loan',
        reversal(),
      ),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNTING_CORRECTION_DOMAIN_MISMATCH' } });
  });

  it('fails closed when the target processed-operation aggregate identity is inconsistent', async () => {
    const target = randomUUID();
    await ownerWrites.postContribution(
      principal('active'),
      context('active'),
      ownerRequest(fixture.accounts.activeCash, '9', target),
    );
    await adminPool.query(
      'update sync.processed_operations set aggregate_id = $1 where store_id = $2 and operation_id = $3',
      [randomUUID(), fixture.stores.active, target],
    );
    const operationId = randomUUID();
    try {
      await expect(
        corrections.reverse(
          principal('active'),
          context('active'),
          target,
          'owner_contribution',
          reversal(operationId),
        ),
      ).rejects.toMatchObject({
        response: { code: 'ACCOUNTING_CORRECTION_TARGET_INTEGRITY_CONFLICT' },
      });
      expect(await movementRows(fixture.stores.active, operationId)).toEqual([]);
      expect(await ownerRows(fixture.stores.active, operationId)).toEqual([]);
    } finally {
      await adminPool.query(
        'update sync.processed_operations set aggregate_id = $1 where store_id = $2 and operation_id = $3',
        [target, fixture.stores.active, target],
      );
    }
  });

  it('uses the correction instant for S9 and rejects a correction into a closed period', async () => {
    const target = randomUUID();
    await ownerWrites.postPersonalWithdrawal(
      principal('active'),
      context('active'),
      ownerRequest(fixture.accounts.activeCash, '6', target),
    );
    const operationId = randomUUID();
    await expect(
      corrections.reverse(
        principal('active'),
        context('active'),
        target,
        'owner_personal_withdrawal',
        {
          operationId,
          occurredAt: '2026-02-15T10:00:00Z',
        },
      ),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE' } });
    expect(await movementRows(fixture.stores.active, operationId)).toEqual([]);
  });

  it('returns exact historical replay in read_only but rejects a new correction', async () => {
    const target = randomUUID();
    await ownerWrites.postContribution(
      principal('readOnly'),
      context('readOnly'),
      ownerRequest(fixture.accounts.readOnlyCash, '10', target),
    );
    const command = reversal();
    const first = await corrections.reverse(
      principal('readOnly'),
      context('readOnly'),
      target,
      'owner_contribution',
      command,
    );
    await adminPool.query("update ledger.stores set status = 'read_only' where id = $1", [
      fixture.stores.readOnly,
    ]);
    const replay = await corrections.reverse(
      principal('readOnly'),
      context('readOnly'),
      target,
      'owner_contribution',
      command,
    );
    expect(replay).toEqual(first);
    await expect(
      corrections.reverse(
        principal('readOnly'),
        context('readOnly'),
        command.operationId,
        'owner_contribution',
        reversal(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rolls back reversal Money when reversal Owner insertion fails', async () => {
    const target = randomUUID();
    await ownerWrites.postContribution(
      principal('rollback'),
      context('rollback'),
      ownerRequest(fixture.accounts.rollbackCash, '45', target),
    );
    const operationId = randomUUID();
    const spy = jest
      .spyOn(ownerPosting, 'insertOwnerEntryWithinTransaction')
      .mockRejectedValueOnce(new Error('controlled reversal owner failure'));
    try {
      await expect(
        corrections.replaceOwnerEvent(
          principal('rollback'),
          context('rollback'),
          target,
          'owner_contribution',
          {
            operationId,
            moneyAccountId: fixture.accounts.rollbackBank,
            amountMinor: '50',
            occurredAt: '2026-01-20T10:00:00Z',
          },
        ),
      ).rejects.toThrow('controlled reversal owner failure');
    } finally {
      spy.mockRestore();
    }
    expect(await movementRows(fixture.stores.rollback, operationId)).toEqual([]);
    expect(await ownerRows(fixture.stores.rollback, operationId)).toEqual([]);
  });

  it('rolls back a complete Owner reversal when the replacement Money insert fails', async () => {
    const target = randomUUID();
    await ownerWrites.postContribution(
      principal('rollback'),
      context('rollback'),
      ownerRequest(fixture.accounts.rollbackCash, '55', target),
    );
    const operationId = randomUUID();
    const conflictingId = deriveMoneyFactId(operationId, 'replacement:owner-money');
    await adminPool.query(
      `insert into ledger.money_movements (
         id, store_id, account_id, accounting_period_id, movement_type, amount_delta_minor,
         reference_type, reference_id, transaction_group_id, occurred_at, operation_id
       ) values ($1,$2,$3,$4,'correction',1,'test_fixture',$5,$6,'2026-01-10T10:00:00Z',$7)`,
      [
        conflictingId,
        fixture.stores.rollback,
        fixture.accounts.rollbackBank,
        januaryPeriods.rollback,
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ],
    );
    try {
      await expect(
        corrections.replaceOwnerEvent(
          principal('rollback'),
          context('rollback'),
          target,
          'owner_contribution',
          {
            operationId,
            moneyAccountId: fixture.accounts.rollbackBank,
            amountMinor: '60',
            occurredAt: '2026-01-20T10:00:00Z',
          },
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(await movementRows(fixture.stores.rollback, operationId)).toEqual([]);
      expect(await ownerRows(fixture.stores.rollback, operationId)).toEqual([]);
    } finally {
      await adminPool.query('delete from ledger.money_movements where id = $1', [conflictingId]);
    }
  });

  it('rolls back all financial facts when processed-operation completion fails', async () => {
    const target = randomUUID();
    await ownerWrites.postContribution(
      principal('rollback'),
      context('rollback'),
      ownerRequest(fixture.accounts.rollbackCash, '40', target),
    );
    const operationId = randomUUID();
    interface CompletionHook {
      applyOperation(...arguments_: unknown[]): Promise<void>;
    }
    const hook = correctionRepository as unknown as CompletionHook;
    const spy = jest.spyOn(hook, 'applyOperation').mockRejectedValueOnce(new Error('controlled'));
    try {
      await expect(
        corrections.replaceOwnerEvent(
          principal('rollback'),
          context('rollback'),
          target,
          'owner_contribution',
          {
            operationId,
            moneyAccountId: fixture.accounts.rollbackBank,
            amountMinor: '50',
            occurredAt: '2026-01-20T10:00:00Z',
          },
        ),
      ).rejects.toThrow('controlled');
    } finally {
      spy.mockRestore();
    }
    expect(await movementRows(fixture.stores.rollback, operationId)).toEqual([]);
    expect(await ownerRows(fixture.stores.rollback, operationId)).toEqual([]);
    const operation = await adminPool.query(
      'select status from sync.processed_operations where store_id = $1 and operation_id = $2',
      [fixture.stores.rollback, operationId],
    );
    expect(operation.rows).toEqual([]);
  });

  it('rolls back a Transfer replacement when a late deterministic child insert fails', async () => {
    const target = randomUUID();
    await transferWrites.create(principal('rollback'), context('rollback'), {
      operationId: target,
      sourceAccountId: fixture.accounts.rollbackCash,
      destinationAccountId: fixture.accounts.rollbackBank,
      amountMinor: '25',
      occurredAt: '2026-01-15T10:00:00Z',
    });
    const operationId = randomUUID();
    const conflictingId = deriveMoneyFactId(operationId, 'replacement:transfer-destination');
    await adminPool.query(
      `insert into ledger.money_movements (
         id, store_id, account_id, accounting_period_id, movement_type, amount_delta_minor,
         reference_type, reference_id, transaction_group_id, occurred_at, operation_id
       ) values ($1,$2,$3,$4,'correction',1,'test_fixture',$5,$6,'2026-01-10T10:00:00Z',$7)`,
      [
        conflictingId,
        fixture.stores.rollback,
        fixture.accounts.rollbackBank,
        januaryPeriods.rollback,
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ],
    );
    await expect(
      corrections.replaceTransfer(principal('rollback'), context('rollback'), target, {
        operationId,
        destinationAccountId: fixture.accounts.rollbackBank,
        amountMinor: '30',
        occurredAt: '2026-01-20T10:00:00Z',
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(await movementRows(fixture.stores.rollback, operationId)).toEqual([]);
    const header = await adminPool.query(
      'select id from ledger.money_transfers where store_id = $1 and id = $2',
      [fixture.stores.rollback, deriveMoneyFactId(operationId, 'replacement:transfer-header')],
    );
    expect(header.rows).toEqual([]);
    await adminPool.query('delete from ledger.money_movements where id = $1', [conflictingId]);
  });

  it('rejects changed correction intent under the same operationId', async () => {
    const target = randomUUID();
    await ownerWrites.postCapitalWithdrawal(
      principal('active'),
      context('active'),
      ownerRequest(fixture.accounts.activeCash, '7', target),
    );
    const command = reversal();
    await corrections.reverse(
      principal('active'),
      context('active'),
      target,
      'owner_capital_withdrawal',
      command,
    );
    await expect(
      corrections.reverse(
        principal('active'),
        context('active'),
        target,
        'owner_capital_withdrawal',
        { ...command, occurredAt: '2026-01-21T10:00:00Z' },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
