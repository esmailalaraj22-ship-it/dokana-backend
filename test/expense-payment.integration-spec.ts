import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { Pool } from 'pg';
import request, { type Response } from 'supertest';

import { deriveAccountingPeriodId } from '../src/accounting-periods/accounting-period-identity';
import { AUTH_DATABASE_POOL } from '../src/auth/auth.constants';
import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import { DATABASE_POOL } from '../src/database/database.constants';
import { ExpensePaymentRepository } from '../src/expenses/expense-payment.repository';
import type { ExpensePaymentPostingResponse } from '../src/expenses/expense-payment.types';
import type { ExpenseRecognitionResponse } from '../src/expenses/expense-recognition.types';
import { deriveMoneyFactId } from '../src/money-movements/money-movement-identity';
import { applyMigration, verifyMigrationSession } from '../scripts/migrate';
import {
  createInventoryTestDatabase,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const migrationFilename = '0015_sale_customer_credit_tender.sql';
const recognitionAt = '2026-09-15T10:00:00Z';
const paymentAt = '2026-10-15T10:00:00Z';

interface Identity {
  storeId: string;
  userId: string;
  deviceId: string;
  email: string;
  token: string;
}

const ownerA: Identity = {
  storeId: randomUUID(),
  userId: randomUUID(),
  deviceId: randomUUID(),
  email: `s163-owner-a-${randomUUID()}@example.test`,
  token: '',
};
const ownerB: Identity = {
  storeId: randomUUID(),
  userId: randomUUID(),
  deviceId: randomUUID(),
  email: `s163-owner-b-${randomUUID()}@example.test`,
  token: '',
};
const categoryIds = {
  active: randomUUID(),
  archived: randomUUID(),
} as const;
const accountIds = {
  active: randomUUID(),
  archived: randomUUID(),
  foreign: randomUUID(),
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function responseBody(response: Response): Record<string, unknown> {
  const value: unknown = response.body;
  if (!isRecord(value)) throw new Error('Expected an object response body.');
  return value;
}

describe('S16.3 due Expense Payments on isolated PostgreSQL', () => {
  jest.setTimeout(120_000);

  let database: InventoryTestDatabase | undefined;
  let runtimePool: Pool | undefined;
  let authPool: Pool | undefined;
  let app: NestExpressApplication | undefined;
  let server: Server;

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('S16.3 isolated database is unavailable.');
    return database;
  }

  function auth(identity = ownerA): { authorization: string } {
    return { authorization: `Bearer ${identity.token}` };
  }

  function recognitionBody(
    input: { id?: string; amountMinor?: string; categoryId?: string | null; at?: string } = {},
  ): Record<string, unknown> {
    return {
      id: input.id ?? randomUUID(),
      operationId: randomUUID(),
      categoryId: input.categoryId === undefined ? categoryIds.active : input.categoryId,
      description: 'S16.3 due Expense',
      amountMinor: input.amountMinor ?? '500',
      occurredAt: input.at ?? recognitionAt,
      dueAt: '2026-12-01T10:00:00Z',
      mode: 'DUE',
      notes: 'Settlement fixture',
    };
  }

  function paymentBody(
    input: {
      operationId?: string;
      paymentSource?: 'money_account' | 'owner_pocket';
      moneyAccountId?: string | null;
      amountMinor?: string;
      at?: string;
      notes?: string | null;
    } = {},
  ): Record<string, unknown> {
    const source = input.paymentSource ?? 'money_account';
    const body: Record<string, unknown> = {
      operationId: input.operationId ?? randomUUID(),
      paymentSource: source,
      amountMinor: input.amountMinor ?? '200',
      occurredAt: input.at ?? paymentAt,
      notes: input.notes === undefined ? 'Later Expense settlement' : input.notes,
    };
    if (source === 'money_account') {
      body.moneyAccountId = input.moneyAccountId ?? accountIds.active;
    } else if (input.moneyAccountId !== undefined) {
      body.moneyAccountId = input.moneyAccountId;
    }
    return body;
  }

  async function recognizeDue(
    input: { id?: string; amountMinor?: string; categoryId?: string | null; at?: string } = {},
    identity = ownerA,
  ): Promise<ExpenseRecognitionResponse> {
    const response = await request(server)
      .post('/v1/expenses')
      .set(auth(identity))
      .send(recognitionBody(input))
      .expect(201);
    return response.body as ExpenseRecognitionResponse;
  }

  function postPayment(expenseId: string, body: Record<string, unknown>, identity = ownerA) {
    return request(server)
      .post(`/v1/expenses/${expenseId}/payments`)
      .set(auth(identity))
      .send(body);
  }

  async function expenseState(expenseId: string) {
    const result = await db().admin.query<{
      amount: string;
      paidTotal: string;
      periodId: string;
      settled: string;
      outstanding: string;
      payments: number;
    }>(
      `select e.amount_minor::text as amount, e.paid_total_minor::text as "paidTotal",
         e.accounting_period_id as "periodId", b.paid_minor::text as settled,
         b.due_minor::text as outstanding,
         (select count(*)::integer from ledger.expense_payments p
           where p.store_id=e.store_id and p.expense_id=e.id and p.status='posted') as payments
       from ledger.expenses e
       join ledger.v_expense_balances b on b.store_id=e.store_id and b.expense_id=e.id
       where e.store_id=$1 and e.id=$2`,
      [ownerA.storeId, expenseId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Expected Expense state.');
    return row;
  }

  async function accountBalance(accountId = accountIds.active): Promise<string> {
    const result = await db().admin.query<{ balance: string }>(
      `select coalesce(sum(amount_delta_minor),0)::text as balance
       from ledger.money_movements where store_id=$1 and account_id=$2`,
      [ownerA.storeId, accountId],
    );
    return result.rows[0]?.balance ?? 'missing';
  }

  beforeAll(async () => {
    const environment = readLocalPostgresTestEnvironment();
    if (!environment) throw new Error('Approved non-production local test environment required.');
    database = await createInventoryTestDatabase(migrationFilename);
    const migrator = await db().migration.connect();
    try {
      await verifyMigrationSession(migrator);
      await applyMigration(migrator, db().file);
    } finally {
      await migrator.query('reset role');
      migrator.release();
    }

    const databaseName = (
      await db().admin.query<{ name: string }>('select current_database() as name')
    ).rows[0]?.name;
    if (!databaseName || !/^dokana_s112_[0-9a-f]{32}$/.test(databaseName)) {
      throw new Error('S16.3 integration database is not isolated.');
    }
    const databaseUrl = (source: string): string => {
      const parsed = new URL(source);
      parsed.pathname = `/${databaseName}`;
      return parsed.toString();
    };
    runtimePool = createTestPool(databaseUrl(environment.runtimeUrl), 'dokana-s163-runtime', 12);
    authPool = createTestPool(databaseUrl(environment.authUrl), 'dokana-s163-auth', 2);

    const password = randomUUID();
    const passwordHash = await new PasswordService().hash(password);
    for (const identity of [ownerA, ownerB]) {
      await db().admin.query(
        `insert into ledger.stores(id,name,status) values($1,'S16.3 fixture','active')`,
        [identity.storeId],
      );
      await db().admin.query(
        `insert into platform.users(id,email,normalized_email,password_hash,full_name)
         values($1,$2,$2,$3,'S16.3 owner')`,
        [identity.userId, identity.email, passwordHash],
      );
      await db().admin.query(
        `insert into platform.store_memberships(id,store_id,user_id,role,status)
         values($1,$2,$3,'owner','active')`,
        [randomUUID(), identity.storeId, identity.userId],
      );
    }
    await db().admin.query(
      `insert into ledger.expense_categories(
         id,store_id,name,normalized_name,status,operation_id
       ) values
         ($1,$3,'Utilities','utilities','active',$4),
         ($2,$3,'Archived','archived','archived',$5)`,
      [categoryIds.active, categoryIds.archived, ownerA.storeId, randomUUID(), randomUUID()],
    );
    await db().admin.query(
      `insert into ledger.money_accounts(
         id,store_id,name,normalized_name,account_type,availability,status,archived_at,operation_id
       ) values
         ($1,$4,'Settlement Bank','settlement bank','transfer','available','active',null,$6),
         ($2,$4,'Archived Bank','archived bank','transfer','available','archived',clock_timestamp(),$7),
         ($3,$5,'Foreign Bank','foreign bank','transfer','available','active',null,$8)`,
      [
        accountIds.active,
        accountIds.archived,
        accountIds.foreign,
        ownerA.storeId,
        ownerB.storeId,
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ],
    );

    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE_POOL)
      .useValue(runtimePool)
      .overrideProvider(AUTH_DATABASE_POOL)
      .useValue(authPool)
      .overrideProvider(PARAMS_PROVIDER_TOKEN)
      .useFactory({
        factory: (config: AppConfigService) =>
          createLoggingParams(config, { write: () => undefined }),
        inject: [AppConfigService],
      })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({ bodyParser: false });
    app.useLogger(app.get(Logger));
    configureApplication(app, app.get(AppConfigService));
    await app.init();
    server = app.getHttpServer();

    for (const identity of [ownerA, ownerB]) {
      const login = await request(server)
        .post('/v1/auth/login')
        .send({
          email: identity.email,
          password,
          storeId: identity.storeId,
          deviceId: identity.deviceId,
          deviceName: 'S16.3 isolated',
          devicePlatform: 'android',
        })
        .expect(200);
      const body = login.body as { accessToken?: unknown };
      if (typeof body.accessToken !== 'string') throw new Error('S16.3 login token missing.');
      identity.token = body.accessToken;
    }
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
      else {
        await runtimePool?.end();
        await authPool?.end();
      }
      if (database) {
        const idle = await database.admin.query<{ count: number }>(
          `select count(*)::integer as count from pg_stat_activity
           where datname=current_database() and state like 'idle in transaction%'`,
        );
        expect(idle.rows[0]).toEqual({ count: 0 });
      }
    } finally {
      await database?.close();
    }
  });

  it('posts partial, repeated, and final Money payments with authoritative history', async () => {
    const recognized = await recognizeDue({ amountMinor: '500' });
    const expenseId = recognized.expense.id;
    const original = await expenseState(expenseId);
    const first = await postPayment(expenseId, paymentBody({ amountMinor: '100' })).expect(201);
    expect(first.body).toMatchObject({
      expenseId,
      payment: { amountMinor: '100', paymentSource: 'money_account', status: 'posted' },
      settlement: {
        recognizedAmountMinor: '500',
        settledBeforeMinor: '0',
        settledAfterMinor: '100',
        outstandingBeforeMinor: '500',
        outstandingAfterMinor: '400',
      },
      moneyMovement: { amountDeltaMinor: '-100', movementType: 'expense_payment' },
      ownerLedgerEntry: null,
    });
    await postPayment(expenseId, paymentBody({ amountMinor: '150' })).expect(201);
    await postPayment(expenseId, paymentBody({ amountMinor: '250' })).expect(201);

    const state = await expenseState(expenseId);
    expect(state).toMatchObject({
      amount: '500',
      paidTotal: '0',
      periodId: original.periodId,
      settled: '500',
      outstanding: '0',
      payments: 3,
    });
    const detail = await request(server).get(`/v1/expenses/${expenseId}`).set(auth()).expect(200);
    expect(responseBody(detail)).toMatchObject({
      amountMinor: '500',
      paidMinor: '500',
      outstandingMinor: '0',
    });
    const detailPayments = responseBody(detail).payments;
    expect(Array.isArray(detailPayments) ? detailPayments : []).toHaveLength(3);
    const history = await request(server)
      .get(`/v1/expenses/${expenseId}/payments`)
      .set(auth())
      .expect(200);
    expect(history.body).toMatchObject({
      expenseId,
      recognizedAmountMinor: '500',
      settledMinor: '500',
      outstandingMinor: '0',
    });
    expect((history.body as { items: unknown[] }).items).toHaveLength(3);
  });

  it('posts Owner-funded partial and full settlement without Store Money or second recognition', async () => {
    const recognized = await recognizeDue({ amountMinor: '9007199254740993' });
    const expenseId = recognized.expense.id;
    const moneyBefore = await accountBalance();
    const expensesBefore = await db().admin.query<{ count: number }>(
      `select count(*)::integer as count from ledger.expenses where store_id=$1`,
      [ownerA.storeId],
    );
    const first = await postPayment(
      expenseId,
      paymentBody({
        paymentSource: 'owner_pocket',
        amountMinor: '9007199254740000',
      }),
    ).expect(201);
    expect(first.body).toMatchObject({
      payment: { paymentSource: 'owner_pocket', moneyAccountId: null },
      settlement: { outstandingAfterMinor: '993' },
      moneyMovement: null,
      ownerLedgerEntry: {
        entryType: 'owner_paid_expense',
        ownerLiabilityDeltaMinor: '9007199254740000',
        equityDeltaMinor: '0',
        moneyAccountId: null,
      },
    });
    await postPayment(
      expenseId,
      paymentBody({ paymentSource: 'owner_pocket', amountMinor: '993' }),
    ).expect(201);
    expect(await accountBalance()).toBe(moneyBefore);
    expect(await expenseState(expenseId)).toMatchObject({
      amount: '9007199254740993',
      paidTotal: '0',
      settled: '9007199254740993',
      outstanding: '0',
    });
    const expensesAfter = await db().admin.query<{ count: number }>(
      `select count(*)::integer as count from ledger.expenses where store_id=$1`,
      [ownerA.storeId],
    );
    expect(expensesAfter.rows[0]).toEqual(expensesBefore.rows[0]);
  });

  it('settles an archived-category Expense in a new period without rewriting its closed period', async () => {
    const recognized = await recognizeDue({ amountMinor: '300' });
    const expenseId = recognized.expense.id;
    const originalPeriodId = recognized.accountingPeriodId;
    await db().admin.query(
      `update ledger.expense_categories
       set status='archived',updated_at=clock_timestamp(),version=version+1
       where store_id=$1 and id=$2`,
      [ownerA.storeId, categoryIds.active],
    );
    await db().admin.query(
      `update ledger.accounting_periods set status='closed',closed_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [ownerA.storeId, originalPeriodId],
    );
    try {
      const payment = await postPayment(expenseId, paymentBody({ amountMinor: '300' })).expect(201);
      expect((payment.body as ExpensePaymentPostingResponse).accountingPeriodId).not.toBe(
        originalPeriodId,
      );
      expect(await expenseState(expenseId)).toMatchObject({
        periodId: originalPeriodId,
        settled: '300',
        outstanding: '0',
      });
    } finally {
      await db().admin.query(
        `update ledger.accounting_periods set status='open',closed_at=null
         where store_id=$1 and id=$2`,
        [ownerA.storeId, originalPeriodId],
      );
      await db().admin.query(
        `update ledger.expense_categories set status='active',updated_at=clock_timestamp()
         where store_id=$1 and id=$2`,
        [ownerA.storeId, categoryIds.active],
      );
    }
  });

  it('rejects overpayment, zero outstanding, invalid amounts, and unavailable targets atomically', async () => {
    const overpay = await recognizeDue({ amountMinor: '100' });
    const denied = await postPayment(
      overpay.expense.id,
      paymentBody({ amountMinor: '101' }),
    ).expect(409);
    expect(responseBody(denied).code).toBe('EXPENSE_PAYMENT_EXCEEDS_OUTSTANDING');
    expect(await expenseState(overpay.expense.id)).toMatchObject({
      settled: '0',
      outstanding: '100',
      payments: 0,
    });
    await postPayment(overpay.expense.id, paymentBody({ amountMinor: '100' })).expect(201);
    const settled = await postPayment(overpay.expense.id, paymentBody({ amountMinor: '1' })).expect(
      409,
    );
    expect(responseBody(settled).code).toBe('EXPENSE_ALREADY_SETTLED');

    const invalid = await recognizeDue({ amountMinor: '100' });
    await postPayment(invalid.expense.id, paymentBody({ amountMinor: '0' })).expect(400);
    await postPayment(invalid.expense.id, paymentBody({ amountMinor: '-1' })).expect(400);
    const archived = await postPayment(
      invalid.expense.id,
      paymentBody({ moneyAccountId: accountIds.archived, amountMinor: '50' }),
    ).expect(409);
    expect(responseBody(archived).code).toBe('MONEY_ACCOUNT_UNAVAILABLE');
    const foreign = await postPayment(
      invalid.expense.id,
      paymentBody({ moneyAccountId: accountIds.foreign, amountMinor: '50' }),
    ).expect(404);
    expect(responseBody(foreign).code).toBe('MONEY_ACCOUNT_NOT_FOUND');

    const foreignExpense = await recognizeDue({ amountMinor: '100', categoryId: null }, ownerB);
    await postPayment(foreignExpense.expense.id, paymentBody()).expect(404);
  });

  it('uses the current payment period and rejects a closed current period and read_only Store', async () => {
    const expense = await recognizeDue({ amountMinor: '200' });
    const currentPeriodId = deriveAccountingPeriodId(ownerA.storeId, 2026, 10);
    await db().admin.query(
      `update ledger.accounting_periods set status='closed',closed_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [ownerA.storeId, currentPeriodId],
    );
    try {
      const operationId = randomUUID();
      const denied = await postPayment(
        expense.expense.id,
        paymentBody({ operationId, amountMinor: '100' }),
      ).expect(409);
      expect(responseBody(denied).code).toBe('ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE');
      expect(await expenseState(expense.expense.id)).toMatchObject({ payments: 0 });
    } finally {
      await db().admin.query(
        `update ledger.accounting_periods set status='open',closed_at=null
         where store_id=$1 and id=$2`,
        [ownerA.storeId, currentPeriodId],
      );
    }

    await db().admin.query(`update ledger.stores set status='read_only' where id=$1`, [
      ownerA.storeId,
    ]);
    try {
      const denied = await postPayment(
        expense.expense.id,
        paymentBody({ amountMinor: '100' }),
      ).expect(403);
      expect(responseBody(denied).code).toBe('BUSINESS_WRITE_NOT_ALLOWED');
    } finally {
      await db().admin.query(`update ledger.stores set status='active' where id=$1`, [
        ownerA.storeId,
      ]);
    }
  });

  it('exact-replays, rejects changed reuse, and commits one concurrent same operation', async () => {
    const expense = await recognizeDue({ amountMinor: '400' });
    const operationId = randomUUID();
    const body = paymentBody({ operationId, amountMinor: '100' });
    const first = await postPayment(expense.expense.id, body).expect(201);
    const replay = await postPayment(expense.expense.id, body).expect(201);
    expect(replay.body).toEqual(first.body);
    const changedAmount = await postPayment(expense.expense.id, {
      ...body,
      amountMinor: '101',
    }).expect(409);
    expect(responseBody(changedAmount).code).toBe('OPERATION_ID_CONFLICT');
    const changedAccount = await postPayment(expense.expense.id, {
      ...body,
      moneyAccountId: randomUUID(),
    }).expect(409);
    expect(responseBody(changedAccount).code).toBe('OPERATION_ID_CONFLICT');

    const concurrentExpense = await recognizeDue({ amountMinor: '200' });
    const concurrentBody = paymentBody({ operationId: randomUUID(), amountMinor: '100' });
    const responses = await Promise.all([
      postPayment(concurrentExpense.expense.id, concurrentBody),
      postPayment(concurrentExpense.expense.id, concurrentBody),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(responses[0].body).toEqual(responses[1].body);
    expect(await expenseState(concurrentExpense.expense.id)).toMatchObject({
      settled: '100',
      outstanding: '100',
      payments: 1,
    });
  });

  it('serializes different concurrent payments without negative outstanding or silent reduction', async () => {
    const exact = await recognizeDue({ amountMinor: '100' });
    const exactResponses = await Promise.all([
      postPayment(exact.expense.id, paymentBody({ amountMinor: '100' })),
      postPayment(exact.expense.id, paymentBody({ amountMinor: '100' })),
    ]);
    expect(exactResponses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await expenseState(exact.expense.id)).toMatchObject({
      settled: '100',
      outstanding: '0',
      payments: 1,
    });

    const partial = await recognizeDue({ amountMinor: '150' });
    const partialResponses = await Promise.all([
      postPayment(partial.expense.id, paymentBody({ amountMinor: '100' })),
      postPayment(partial.expense.id, paymentBody({ amountMinor: '100' })),
    ]);
    expect(partialResponses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await expenseState(partial.expense.id)).toMatchObject({
      settled: '100',
      outstanding: '50',
      payments: 1,
    });
  });

  it('serializes Money Account archive against payment eligibility', async () => {
    const accountId = randomUUID();
    await db().admin.query(
      `insert into ledger.money_accounts(
         id,store_id,name,normalized_name,account_type,availability,status,operation_id
       ) values($1,$2,$3,$3,'transfer','available','active',$4)`,
      [accountId, ownerA.storeId, `s163-race-${accountId}`, randomUUID()],
    );
    const expense = await recognizeDue({ amountMinor: '100' });
    const results = await Promise.all([
      postPayment(
        expense.expense.id,
        paymentBody({ moneyAccountId: accountId, amountMinor: '100' }),
      ),
      request(server)
        .post(`/v1/money-accounts/${accountId}/archive`)
        .set(auth())
        .send({ operationId: randomUUID(), expectedVersion: '1' }),
    ]);
    const statuses = results.map((response) => response.status);
    expect(statuses).toContain(409);
    expect(statuses.some((status) => status === 200 || status === 201)).toBe(true);
    const state = await expenseState(expense.expense.id);
    expect([
      { settled: '0', outstanding: '100', payments: 0 },
      { settled: '100', outstanding: '0', payments: 1 },
    ]).toContainEqual({
      settled: state.settled,
      outstanding: state.outstanding,
      payments: state.payments,
    });
  });

  it('preserves historical archived-account reads and all non-Expense-domain firewalls', async () => {
    const expense = await recognizeDue({ amountMinor: '200' });
    const before = await db().admin.query<{
      supplier: number;
      customer: number;
      inventory: number;
      sales: number;
    }>(
      `select
        (select count(*)::integer from ledger.supplier_ledger_entries where store_id=$1) supplier,
        (select count(*)::integer from ledger.customer_ledger_entries where store_id=$1) customer,
        (select count(*)::integer from ledger.inventory_movements where store_id=$1) inventory,
        (select count(*)::integer from ledger.sales where store_id=$1) sales`,
      [ownerA.storeId],
    );
    await postPayment(expense.expense.id, paymentBody({ amountMinor: '100' })).expect(201);
    await db().admin.query(
      `update ledger.money_accounts
       set status='archived',archived_at=clock_timestamp(),updated_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [ownerA.storeId, accountIds.active],
    );
    try {
      const history = await request(server)
        .get(`/v1/expenses/${expense.expense.id}/payments`)
        .set(auth())
        .expect(200);
      const firstItem = (history.body as { items: unknown[] }).items[0];
      expect(firstItem).toMatchObject({
        moneyAccount: { id: accountIds.active, status: 'archived' },
      });
      expect(isRecord(firstItem) ? typeof firstItem.transactionGroupId : 'missing').toBe('string');
      const after = await db().admin.query<{
        supplier: number;
        customer: number;
        inventory: number;
        sales: number;
      }>(
        `select
          (select count(*)::integer from ledger.supplier_ledger_entries where store_id=$1) supplier,
          (select count(*)::integer from ledger.customer_ledger_entries where store_id=$1) customer,
          (select count(*)::integer from ledger.inventory_movements where store_id=$1) inventory,
          (select count(*)::integer from ledger.sales where store_id=$1) sales`,
        [ownerA.storeId],
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
    } finally {
      await db().admin.query(
        `update ledger.money_accounts
         set status='active',archived_at=null,updated_at=clock_timestamp()
         where store_id=$1 and id=$2`,
        [ownerA.storeId, accountIds.active],
      );
    }
  });

  it('rolls back Payment, funding, audit/change, and operation on completion failure', async () => {
    if (!app) throw new Error('Application unavailable for S16.3 fault injection.');
    const expense = await recognizeDue({ amountMinor: '200' });
    const repository = app.get<{
      applyOperation: (...arguments_: unknown[]) => Promise<void>;
    }>(ExpensePaymentRepository);
    const operationId = randomUUID();
    const paymentId = deriveMoneyFactId(operationId, 'expense-payment');
    const completion = jest
      .spyOn(repository, 'applyOperation')
      .mockRejectedValueOnce(new Error('S16.3 completion fault'));
    try {
      await postPayment(
        expense.expense.id,
        paymentBody({ operationId, paymentSource: 'owner_pocket', amountMinor: '100' }),
      ).expect(500);
    } finally {
      completion.mockRestore();
    }
    const result = await db().admin.query<{
      payments: number;
      owner: number;
      operations: number;
      changes: number;
      audits: number;
    }>(
      `select
        (select count(*)::integer from ledger.expense_payments where operation_id=$1) payments,
        (select count(*)::integer from ledger.owner_ledger_entries
          where reference_type='expense_payment' and reference_id=$2) owner,
        (select count(*)::integer from sync.processed_operations where operation_id=$1) operations,
        (select count(*)::integer from sync.change_events
          where store_id=$3 and operation_id=$1) changes,
        (select count(*)::integer from audit.central_audit_logs
          where store_id=$3 and entity_id=$2) audits`,
      [operationId, paymentId, ownerA.storeId],
    );
    expect(result.rows[0]).toEqual({
      payments: 0,
      owner: 0,
      operations: 0,
      changes: 0,
      audits: 0,
    });
    expect(await expenseState(expense.expense.id)).toMatchObject({
      settled: '0',
      outstanding: '200',
      payments: 0,
    });
  });
});
