import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { Pool } from 'pg';
import request from 'supertest';

import { AUTH_DATABASE_POOL } from '../src/auth/auth.constants';
import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import { DATABASE_POOL } from '../src/database/database.constants';
import { ExpenseCorrectionRepository } from '../src/expenses/expense-correction.repository';
import type {
  ExpensePaymentCorrectionResponse,
  ExpenseRecognitionCorrectionResponse,
} from '../src/expenses/expense-correction.types';
import type { ExpensePaymentPostingResponse } from '../src/expenses/expense-payment.types';
import type { ExpenseRecognitionResponse } from '../src/expenses/expense-recognition.types';
import { applyMigration, verifyMigrationSession } from '../scripts/migrate';
import {
  createInventoryTestDatabase,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const migrationFilename = '0015_sale_customer_credit_tender.sql';
const recognitionAt = '2026-09-15T10:00:00Z';
const correctionAt = '2026-10-20T10:00:00Z';

interface Identity {
  storeId: string;
  userId: string;
  deviceId: string;
  email: string;
  token: string;
}

interface Recognized {
  operationId: string;
  requestBody: Record<string, unknown>;
  response: ExpenseRecognitionResponse;
}

const ownerA: Identity = {
  storeId: randomUUID(),
  userId: randomUUID(),
  deviceId: randomUUID(),
  email: `s164-owner-a-${randomUUID()}@example.test`,
  token: '',
};
const ownerB: Identity = {
  storeId: randomUUID(),
  userId: randomUUID(),
  deviceId: randomUUID(),
  email: `s164-owner-b-${randomUUID()}@example.test`,
  token: '',
};
const categoryId = randomUUID();
const accountIds = {
  cash: randomUUID(),
  bank: randomUUID(),
  archived: randomUUID(),
  foreign: randomUUID(),
} as const;

describe('S16.4 immutable Expense corrections on isolated PostgreSQL', () => {
  jest.setTimeout(120_000);

  let database: InventoryTestDatabase | undefined;
  let runtimePool: Pool | undefined;
  let authPool: Pool | undefined;
  let app: NestExpressApplication | undefined;
  let server: Server;

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('S16.4 isolated database is unavailable.');
    return database;
  }

  function auth(identity = ownerA): { authorization: string } {
    return { authorization: `Bearer ${identity.token}` };
  }

  async function recognize(
    mode: 'DUE' | 'MONEY_PAID' | 'OWNER_FUNDED',
    input: {
      amountMinor?: string;
      category?: string | null;
      accountId?: string;
      at?: string;
      identity?: Identity;
    } = {},
  ): Promise<Recognized> {
    const operationId = randomUUID();
    const body: Record<string, unknown> = {
      id: randomUUID(),
      operationId,
      categoryId: input.category === undefined ? categoryId : input.category,
      description: `S16.4 ${mode} Expense`,
      amountMinor: input.amountMinor ?? '500',
      occurredAt: input.at ?? recognitionAt,
      mode,
      notes: 'S16.4 fixture',
    };
    if (mode === 'DUE') body.dueAt = '2026-12-01T10:00:00Z';
    if (mode === 'MONEY_PAID') body.moneyAccountId = input.accountId ?? accountIds.cash;
    const result = await request(server)
      .post('/v1/expenses')
      .set(auth(input.identity))
      .send(body)
      .expect(201);
    return { operationId, requestBody: body, response: result.body as ExpenseRecognitionResponse };
  }

  async function pay(
    expenseId: string,
    input: {
      operationId?: string;
      amountMinor?: string;
      source?: 'money_account' | 'owner_pocket';
      accountId?: string;
      identity?: Identity;
    } = {},
  ): Promise<{ operationId: string; response: ExpensePaymentPostingResponse }> {
    const operationId = input.operationId ?? randomUUID();
    const source = input.source ?? 'money_account';
    const body: Record<string, unknown> = {
      operationId,
      paymentSource: source,
      amountMinor: input.amountMinor ?? '200',
      occurredAt: correctionAt,
      notes: 'S16.4 payment fixture',
    };
    if (source === 'money_account') body.moneyAccountId = input.accountId ?? accountIds.cash;
    const result = await request(server)
      .post(`/v1/expenses/${expenseId}/payments`)
      .set(auth(input.identity))
      .send(body)
      .expect(201);
    return { operationId, response: result.body as ExpensePaymentPostingResponse };
  }

  function cancelExpense(targetOperationId: string, operationId = randomUUID(), identity = ownerA) {
    return request(server)
      .post(`/v1/expenses/${targetOperationId}/cancel`)
      .set(auth(identity))
      .send({ operationId, occurredAt: correctionAt, reason: 'Incorrect Expense' });
  }

  function editExpense(
    targetOperationId: string,
    replacement: Record<string, unknown>,
    operationId = randomUUID(),
  ) {
    return request(server).post(`/v1/expenses/${targetOperationId}/edit`).set(auth()).send({
      operationId,
      occurredAt: correctionAt,
      reason: 'Replace incorrect Expense',
      replacement,
    });
  }

  function cancelPayment(targetOperationId: string, operationId = randomUUID(), identity = ownerA) {
    return request(server)
      .post(`/v1/expense-payments/${targetOperationId}/cancel`)
      .set(auth(identity))
      .send({ operationId, occurredAt: correctionAt, reason: 'Incorrect Payment' });
  }

  function editPayment(
    targetOperationId: string,
    expenseId: string,
    input: {
      amountMinor: string;
      source?: 'money_account' | 'owner_pocket';
      accountId?: string;
      operationId?: string;
    },
  ) {
    const source = input.source ?? 'money_account';
    return request(server)
      .post(`/v1/expense-payments/${targetOperationId}/edit`)
      .set(auth())
      .send({
        operationId: input.operationId ?? randomUUID(),
        occurredAt: correctionAt,
        reason: 'Replace incorrect Payment',
        replacement: {
          expenseId,
          paymentSource: source,
          ...(source === 'money_account'
            ? { moneyAccountId: input.accountId ?? accountIds.bank }
            : {}),
          amountMinor: input.amountMinor,
          occurredAt: '2026-10-21T10:00:00Z',
          notes: 'Corrected Payment',
        },
      });
  }

  function dueReplacement(
    amountMinor: string,
    input: {
      mode?: 'DUE' | 'MONEY_PAID' | 'OWNER_FUNDED';
      category?: string;
      accountId?: string;
    } = {},
  ): Record<string, unknown> {
    const mode = input.mode ?? 'DUE';
    return {
      id: randomUUID(),
      categoryId: input.category ?? categoryId,
      description: 'Corrected Expense',
      amountMinor,
      occurredAt: '2026-10-21T10:00:00Z',
      ...(mode === 'DUE' ? { dueAt: '2026-12-15T10:00:00Z' } : {}),
      mode,
      ...(mode === 'MONEY_PAID' ? { moneyAccountId: input.accountId ?? accountIds.bank } : {}),
      notes: 'Corrected recognition',
    };
  }

  async function balance(accountId: string): Promise<string> {
    const result = await db().admin.query<{ value: string }>(
      `select coalesce(sum(amount_delta_minor),0)::text as value
       from ledger.money_movements where store_id=$1 and account_id=$2`,
      [ownerA.storeId, accountId],
    );
    return result.rows[0]?.value ?? 'missing';
  }

  async function ownerLiability(): Promise<string> {
    const result = await db().admin.query<{ value: string }>(
      `select coalesce(sum(owner_liability_delta_minor),0)::text as value
       from ledger.owner_ledger_entries where store_id=$1`,
      [ownerA.storeId],
    );
    return result.rows[0]?.value ?? 'missing';
  }

  async function settlement(expenseId: string) {
    const result = await db().admin.query<{ paid: string; due: string }>(
      `select paid_minor::text as paid,due_minor::text as due
       from ledger.v_expense_balances where store_id=$1 and expense_id=$2`,
      [ownerA.storeId, expenseId],
    );
    return result.rows[0] ?? null;
  }

  async function domainCounts() {
    const result = await db().admin.query<{
      customers: number;
      suppliers: number;
      inventory: number;
      sales: number;
    }>(
      `select
        (select count(*)::integer from ledger.customer_ledger_entries where store_id=$1) customers,
        (select count(*)::integer from ledger.supplier_ledger_entries where store_id=$1) suppliers,
        (select count(*)::integer from ledger.inventory_movements where store_id=$1) inventory,
        (select count(*)::integer from ledger.sales where store_id=$1) sales`,
      [ownerA.storeId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Expected domain counts.');
    return row;
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
      throw new Error('S16.4 integration database is not isolated.');
    }
    const databaseUrl = (source: string): string => {
      const parsed = new URL(source);
      parsed.pathname = `/${databaseName}`;
      return parsed.toString();
    };
    runtimePool = createTestPool(databaseUrl(environment.runtimeUrl), 'dokana-s164-runtime', 16);
    authPool = createTestPool(databaseUrl(environment.authUrl), 'dokana-s164-auth', 2);

    const password = randomUUID();
    const passwordHash = await new PasswordService().hash(password);
    for (const identity of [ownerA, ownerB]) {
      await db().admin.query(
        `insert into ledger.stores(id,name,status) values($1,'S16.4 fixture','active')`,
        [identity.storeId],
      );
      await db().admin.query(
        `insert into platform.users(id,email,normalized_email,password_hash,full_name)
         values($1,$2,$2,$3,'S16.4 owner')`,
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
         id,store_id,name,normalized_name,status,operation_id)
       values($1,$2,'S16.4 Category','s16.4 category','active',$3)`,
      [categoryId, ownerA.storeId, randomUUID()],
    );
    await db().admin.query(
      `insert into ledger.money_accounts(
         id,store_id,name,normalized_name,account_type,availability,status,archived_at,operation_id)
       values
         ($1,$5,'S16.4 Cash','s16.4 cash','cash','available','active',null,$7),
         ($2,$5,'S16.4 Bank','s16.4 bank','transfer','available','active',null,$8),
         ($3,$5,'S16.4 Archived','s16.4 archived','transfer','available','archived',clock_timestamp(),$9),
         ($4,$6,'S16.4 Foreign','s16.4 foreign','transfer','available','active',null,$10)`,
      [
        accountIds.cash,
        accountIds.bank,
        accountIds.archived,
        accountIds.foreign,
        ownerA.storeId,
        ownerB.storeId,
        randomUUID(),
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
      const login = await request(server).post('/v1/auth/login').send({
        email: identity.email,
        password,
        storeId: identity.storeId,
        deviceId: identity.deviceId,
        deviceName: 'S16.4 isolated',
        devicePlatform: 'android',
      });
      expect(login.status).toBe(200);
      const token = (login.body as { accessToken?: unknown }).accessToken;
      if (typeof token !== 'string') throw new Error('S16.4 login token missing.');
      identity.token = token;
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

  it('cancels a DUE Expense immutably and exposes correction lineage', async () => {
    const original = await recognize('DUE');
    const before = await domainCounts();
    const correctionOperationId = randomUUID();
    const result = await cancelExpense(original.operationId, correctionOperationId).expect(201);
    const correction = result.body as ExpenseRecognitionCorrectionResponse;
    expect(correction).toMatchObject({
      aggregate: 'expense',
      intent: 'cancel',
      reason: 'Incorrect Expense',
      target: { expenseId: original.response.expense.id, status: 'cancelled' },
      reversal: { originalAmountMinor: '500', amountDeltaMinor: '-500' },
      replacement: null,
    });
    expect(correction.reversal.moneyMovement).toBeNull();
    expect(correction.reversal.ownerLedgerEntry).toBeNull();
    expect(await settlement(original.response.expense.id)).toBeNull();
    const detail = await request(server)
      .get(`/v1/expenses/${original.response.expense.id}`)
      .set(auth())
      .expect(200);
    expect(detail.body).toMatchObject({
      id: original.response.expense.id,
      status: 'cancelled',
      paidMinor: '0',
      outstandingMinor: '0',
      currentActiveId: null,
      correction: { type: 'cancel', reason: 'Incorrect Expense' },
    });
    expect(await domainCounts()).toEqual(before);

    const correctionReplay = await cancelExpense(
      original.operationId,
      correctionOperationId,
    ).expect(201);
    expect(correctionReplay.body).toEqual(result.body);
    await request(server)
      .post(`/v1/expenses/${original.operationId}/cancel`)
      .set(auth())
      .send({
        operationId: correctionOperationId,
        occurredAt: correctionAt,
        reason: 'Changed correction identity',
      })
      .expect(409)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'OPERATION_ID_CONFLICT' }));

    const originalReplay = await request(server)
      .post('/v1/expenses')
      .set(auth())
      .send(original.requestBody)
      .expect(201);
    expect(originalReplay.body).toEqual(original.response);
  });

  it('cancels MONEY_PAID bigint recognition through the exact archived account', async () => {
    const amount = '9007199254740993';
    const original = await recognize('MONEY_PAID', { amountMinor: amount });
    const replacementTarget = await recognize('DUE');
    expect(await balance(accountIds.cash)).toBe(`-${amount}`);
    await db().admin.query(
      `update ledger.money_accounts set status='archived',archived_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [ownerA.storeId, accountIds.cash],
    );
    try {
      await editExpense(
        replacementTarget.operationId,
        dueReplacement('100', { mode: 'MONEY_PAID', accountId: accountIds.cash }),
      )
        .expect(409)
        .expect(({ body }) => expect(body).toMatchObject({ code: 'MONEY_ACCOUNT_UNAVAILABLE' }));
      const result = await cancelExpense(original.operationId).expect(201);
      const correction = result.body as ExpenseRecognitionCorrectionResponse;
      expect(correction.reversal.moneyMovement).toMatchObject({
        accountId: accountIds.cash,
        amountDeltaMinor: amount,
        reversalOfId: original.response.moneyMovement?.id,
      });
      expect(await balance(accountIds.cash)).toBe('0');
      const internal = await cancelPayment(
        original.response.payment?.operationId ?? randomUUID(),
      ).expect(404);
      expect(internal.body).toMatchObject({ code: 'EXPENSE_CORRECTION_TARGET_NOT_FOUND' });
      const replacementTargetRow = await db().admin.query<{ status: string }>(
        `select status from ledger.expenses where store_id=$1 and id=$2`,
        [ownerA.storeId, replacementTarget.response.expense.id],
      );
      expect(replacementTargetRow.rows[0]).toEqual({ status: 'posted' });
    } finally {
      await db().admin.query(
        `update ledger.money_accounts set status='active',archived_at=null
         where store_id=$1 and id=$2`,
        [ownerA.storeId, accountIds.cash],
      );
    }
  });

  it('cancels OWNER_FUNDED recognition with exact Owner reversal and no Money effect', async () => {
    const original = await recognize('OWNER_FUNDED', { amountMinor: '700' });
    const moneyBefore = await balance(accountIds.cash);
    expect(await ownerLiability()).toBe('700');
    const result = await cancelExpense(original.operationId).expect(201);
    const correction = result.body as ExpenseRecognitionCorrectionResponse;
    expect(correction.reversal.moneyMovement).toBeNull();
    expect(correction.reversal.ownerLedgerEntry).toMatchObject({
      ownerLiabilityDeltaMinor: '-700',
      reversalOfId: original.response.ownerLedgerEntry?.id,
    });
    expect(await ownerLiability()).toBe('0');
    expect(await balance(accountIds.cash)).toBe(moneyBefore);
  });

  it('replaces recognition across modes and rejects active Payment dependency and archived Category', async () => {
    const due = await recognize('DUE');
    const replacementOperation = randomUUID();
    const edited = await editExpense(
      due.operationId,
      dueReplacement('450', { mode: 'MONEY_PAID' }),
      replacementOperation,
    ).expect(201);
    const correction = edited.body as ExpenseRecognitionCorrectionResponse;
    expect(correction.replacement).toMatchObject({
      operationId: replacementOperation,
      mode: 'MONEY_PAID',
      expense: { amountMinor: '450' },
      moneyMovement: { amountDeltaMinor: '-450', accountId: accountIds.bank },
    });
    const oldDetail = await request(server)
      .get(`/v1/expenses/${due.response.expense.id}`)
      .set(auth())
      .expect(200);
    expect(oldDetail.body).toMatchObject({
      status: 'cancelled',
      currentActiveId: correction.replacement?.expense.id,
      correction: { type: 'replace', replacementId: correction.replacement?.expense.id },
    });

    const dependent = await recognize('DUE');
    const payment = await pay(dependent.response.expense.id, { amountMinor: '100' });
    await cancelExpense(dependent.operationId)
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'EXPENSE_CORRECTION_ACTIVE_PAYMENT_DEPENDENCY' }),
      );
    await cancelPayment(payment.operationId).expect(201);
    await cancelExpense(dependent.operationId).expect(201);

    const archived = await recognize('DUE');
    await db().admin.query(
      `update ledger.expense_categories set status='archived' where store_id=$1 and id=$2`,
      [ownerA.storeId, categoryId],
    );
    try {
      await editExpense(archived.operationId, dueReplacement('500', { category: categoryId }))
        .expect(409)
        .expect(({ body }) => expect(body).toMatchObject({ code: 'EXPENSE_CATEGORY_UNAVAILABLE' }));
      await cancelExpense(archived.operationId).expect(201);
    } finally {
      await db().admin.query(
        `update ledger.expense_categories set status='active' where store_id=$1 and id=$2`,
        [ownerA.storeId, categoryId],
      );
    }
  });

  it('cancels an earlier Money Payment while a later Payment remains active', async () => {
    const expense = await recognize('DUE');
    const first = await pay(expense.response.expense.id, { amountMinor: '200' });
    await pay(expense.response.expense.id, { amountMinor: '300', accountId: accountIds.bank });
    const result = await cancelPayment(first.operationId).expect(201);
    const correction = result.body as ExpensePaymentCorrectionResponse;
    expect(correction.reversal).toMatchObject({
      expenseRecognitionDeltaMinor: '0',
      moneyMovement: {
        amountDeltaMinor: '200',
        reversalOfId: first.response.moneyMovement?.id,
      },
    });
    expect(await settlement(expense.response.expense.id)).toEqual({ paid: '300', due: '200' });
    const history = await request(server)
      .get(`/v1/expenses/${expense.response.expense.id}/payments`)
      .set(auth())
      .expect(200);
    expect(history.body).toMatchObject({ settledMinor: '300', outstandingMinor: '200' });
    expect(
      (history.body as { items: { status: string }[] }).items.map((item) => item.status).sort(),
    ).toEqual(['cancelled', 'posted']);
  });

  it('cancels Owner Payment and replaces Money and Owner funding atomically', async () => {
    const expense = await recognize('DUE', { amountMinor: '600' });
    const ownerPayment = await pay(expense.response.expense.id, {
      source: 'owner_pocket',
      amountMinor: '200',
    });
    const ownerCancel = await cancelPayment(ownerPayment.operationId).expect(201);
    expect((ownerCancel.body as ExpensePaymentCorrectionResponse).reversal).toMatchObject({
      moneyMovement: null,
      ownerLedgerEntry: { ownerLiabilityDeltaMinor: '-200' },
    });

    const moneyPayment = await pay(expense.response.expense.id, { amountMinor: '200' });
    const moneyToOwner = await editPayment(moneyPayment.operationId, expense.response.expense.id, {
      amountMinor: '150',
      source: 'owner_pocket',
    }).expect(201);
    expect((moneyToOwner.body as ExpensePaymentCorrectionResponse).replacement).toMatchObject({
      payment: { paymentSource: 'owner_pocket', amountMinor: '150' },
      moneyMovement: null,
      ownerLedgerEntry: { ownerLiabilityDeltaMinor: '150' },
    });
    expect(await settlement(expense.response.expense.id)).toEqual({ paid: '150', due: '450' });

    const ownerOperation = (moneyToOwner.body as ExpensePaymentCorrectionResponse).operationId;
    const ownerToMoney = await editPayment(ownerOperation, expense.response.expense.id, {
      amountMinor: '100',
      source: 'money_account',
      accountId: accountIds.bank,
    }).expect(201);
    expect((ownerToMoney.body as ExpensePaymentCorrectionResponse).replacement).toMatchObject({
      payment: { paymentSource: 'money_account', amountMinor: '100' },
      moneyMovement: { accountId: accountIds.bank, amountDeltaMinor: '-100' },
    });
  });

  it('rolls back an over-replacement and exact-replays correction and original operations', async () => {
    const expense = await recognize('DUE');
    const first = await pay(expense.response.expense.id, { amountMinor: '200' });
    await pay(expense.response.expense.id, { amountMinor: '300' });
    const correctionOperation = randomUUID();
    const failed = await editPayment(first.operationId, expense.response.expense.id, {
      operationId: correctionOperation,
      amountMinor: '250',
    }).expect(409);
    expect(failed.body).toMatchObject({ code: 'EXPENSE_PAYMENT_EXCEEDS_OUTSTANDING' });
    expect(await settlement(expense.response.expense.id)).toEqual({ paid: '500', due: '0' });
    const paymentRow = await db().admin.query<{ status: string }>(
      `select status from ledger.expense_payments where store_id=$1 and id=$2`,
      [ownerA.storeId, first.response.payment.id],
    );
    expect(paymentRow.rows[0]).toEqual({ status: 'posted' });
    const repeated = await editPayment(first.operationId, expense.response.expense.id, {
      operationId: correctionOperation,
      amountMinor: '250',
    }).expect(409);
    const failedBody = failed.body as { code: string; message: string };
    expect(repeated.body).toMatchObject({
      code: failedBody.code,
      message: failedBody.message,
      statusCode: 409,
    });

    const originalReplay = await request(server)
      .post(`/v1/expenses/${expense.response.expense.id}/payments`)
      .set(auth())
      .send({
        operationId: first.operationId,
        paymentSource: 'money_account',
        moneyAccountId: accountIds.cash,
        amountMinor: '200',
        occurredAt: correctionAt,
        notes: 'S16.4 payment fixture',
      })
      .expect(201);
    expect(originalReplay.body).toEqual(first.response);
  });

  it('uses current correction period, fails closed cross-Store/read_only, and preserves history', async () => {
    const historical = await recognize('DUE');
    await db().admin.query(
      `update ledger.accounting_periods set status='closed',closed_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [ownerA.storeId, historical.response.accountingPeriodId],
    );
    try {
      const correction = await cancelExpense(historical.operationId).expect(201);
      expect((correction.body as ExpenseRecognitionCorrectionResponse).accountingPeriodId).not.toBe(
        historical.response.accountingPeriodId,
      );
      const row = await db().admin.query<{ periodId: string }>(
        `select accounting_period_id as "periodId" from ledger.expenses where id=$1`,
        [historical.response.expense.id],
      );
      expect(row.rows[0]?.periodId).toBe(historical.response.accountingPeriodId);
    } finally {
      await db().admin.query(
        `update ledger.accounting_periods set status='open',closed_at=null
         where store_id=$1 and id=$2`,
        [ownerA.storeId, historical.response.accountingPeriodId],
      );
    }

    const closedCorrectionPeriod = await recognize('DUE');
    const correctionPeriod = await db().admin.query<{ id: string }>(
      `select id from ledger.accounting_periods
       where store_id=$1 and period_year=2026 and period_month=10`,
      [ownerA.storeId],
    );
    const correctionPeriodId = correctionPeriod.rows[0]?.id;
    if (!correctionPeriodId) throw new Error('Expected current correction period.');
    await db().admin.query(
      `update ledger.accounting_periods set status='closed',closed_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [ownerA.storeId, correctionPeriodId],
    );
    try {
      await cancelExpense(closedCorrectionPeriod.operationId)
        .expect(409)
        .expect(({ body }) =>
          expect(body).toMatchObject({ code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE' }),
        );
      const row = await db().admin.query<{ status: string }>(
        `select status from ledger.expenses where store_id=$1 and id=$2`,
        [ownerA.storeId, closedCorrectionPeriod.response.expense.id],
      );
      expect(row.rows[0]).toEqual({ status: 'posted' });
    } finally {
      await db().admin.query(
        `update ledger.accounting_periods set status='open',closed_at=null
         where store_id=$1 and id=$2`,
        [ownerA.storeId, correctionPeriodId],
      );
    }

    const foreign = await recognize('DUE', { identity: ownerB, category: null });
    await cancelExpense(foreign.operationId)
      .expect(404)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'EXPENSE_CORRECTION_TARGET_NOT_FOUND' }),
      );

    const readOnly = await recognize('DUE');
    await db().admin.query(`update ledger.stores set status='read_only' where id=$1`, [
      ownerA.storeId,
    ]);
    try {
      await cancelExpense(readOnly.operationId).expect(403);
    } finally {
      await db().admin.query(`update ledger.stores set status='active' where id=$1`, [
        ownerA.storeId,
      ]);
    }
  });

  it('serializes correction races and correction versus new Payment without branching', async () => {
    const expense = await recognize('DUE');
    const race = await Promise.all([
      cancelExpense(expense.operationId),
      request(server)
        .post(`/v1/expenses/${expense.response.expense.id}/payments`)
        .set(auth())
        .send({
          operationId: randomUUID(),
          paymentSource: 'money_account',
          moneyAccountId: accountIds.cash,
          amountMinor: '100',
          occurredAt: correctionAt,
          notes: 'Race Payment',
        }),
    ]);
    expect(race.map((result) => result.status).sort()).toEqual([201, 409]);

    const expenseReplacementRace = await recognize('DUE');
    const replacementAndPayment = await Promise.all([
      editExpense(expenseReplacementRace.operationId, dueReplacement('400')),
      request(server)
        .post(`/v1/expenses/${expenseReplacementRace.response.expense.id}/payments`)
        .set(auth())
        .send({
          operationId: randomUUID(),
          paymentSource: 'money_account',
          moneyAccountId: accountIds.cash,
          amountMinor: '100',
          occurredAt: correctionAt,
          notes: 'Replacement race Payment',
        }),
    ]);
    expect(replacementAndPayment.map((result) => result.status).sort()).toEqual([201, 409]);

    const paymentExpense = await recognize('DUE');
    const payment = await pay(paymentExpense.response.expense.id, { amountMinor: '100' });
    const competing = await Promise.all([
      cancelPayment(payment.operationId),
      editPayment(payment.operationId, paymentExpense.response.expense.id, {
        amountMinor: '90',
      }),
    ]);
    expect(competing.map((result) => result.status).sort()).toEqual([201, 409]);

    const replacementRace = await recognize('DUE');
    const replacements = await Promise.all([
      editExpense(replacementRace.operationId, dueReplacement('400')),
      editExpense(replacementRace.operationId, dueReplacement('300')),
    ]);
    expect(replacements.map((result) => result.status).sort()).toEqual([201, 409]);

    const cancelPaymentRaceExpense = await recognize('DUE', { amountMinor: '300' });
    const cancelPaymentRaceTarget = await pay(cancelPaymentRaceExpense.response.expense.id, {
      amountMinor: '100',
    });
    const cancelAndPay = await Promise.all([
      cancelPayment(cancelPaymentRaceTarget.operationId),
      request(server)
        .post(`/v1/expenses/${cancelPaymentRaceExpense.response.expense.id}/payments`)
        .set(auth())
        .send({
          operationId: randomUUID(),
          paymentSource: 'money_account',
          moneyAccountId: accountIds.bank,
          amountMinor: '300',
          occurredAt: correctionAt,
          notes: 'Payment correction race',
        }),
    ]);
    expect(cancelAndPay[0].status).toBe(201);
    expect([201, 409]).toContain(cancelAndPay[1].status);
    const cancelRaceSettlement = await settlement(cancelPaymentRaceExpense.response.expense.id);
    expect(['0', '300']).toContain(cancelRaceSettlement?.paid);
    expect(BigInt(cancelRaceSettlement?.paid ?? '-1')).toBeLessThanOrEqual(300n);

    const replacePaymentRaceExpense = await recognize('DUE', { amountMinor: '300' });
    const replacePaymentRaceTarget = await pay(replacePaymentRaceExpense.response.expense.id, {
      amountMinor: '100',
    });
    const replaceAndPay = await Promise.all([
      editPayment(
        replacePaymentRaceTarget.operationId,
        replacePaymentRaceExpense.response.expense.id,
        { amountMinor: '250' },
      ),
      request(server)
        .post(`/v1/expenses/${replacePaymentRaceExpense.response.expense.id}/payments`)
        .set(auth())
        .send({
          operationId: randomUUID(),
          paymentSource: 'money_account',
          moneyAccountId: accountIds.cash,
          amountMinor: '200',
          occurredAt: correctionAt,
          notes: 'Payment replacement race',
        }),
    ]);
    expect(replaceAndPay.map((result) => result.status).sort()).toEqual([201, 409]);
    const replacementRaceSettlement = await settlement(
      replacePaymentRaceExpense.response.expense.id,
    );
    expect(BigInt(replacementRaceSettlement?.paid ?? '-1')).toBeLessThanOrEqual(300n);
  });

  it('serializes shared Money Account and Owner Ledger correction resources', async () => {
    const moneyBefore = await balance(accountIds.bank);
    const moneyA = await recognize('MONEY_PAID', {
      amountMinor: '101',
      accountId: accountIds.bank,
    });
    const moneyB = await recognize('MONEY_PAID', {
      amountMinor: '202',
      accountId: accountIds.bank,
    });
    const moneyCorrections = await Promise.all([
      cancelExpense(moneyA.operationId),
      cancelExpense(moneyB.operationId),
    ]);
    expect(moneyCorrections.map((result) => result.status)).toEqual([201, 201]);
    expect(await balance(accountIds.bank)).toBe(moneyBefore);

    const ownerBefore = await ownerLiability();
    const ownerAExpense = await recognize('OWNER_FUNDED', { amountMinor: '303' });
    const ownerBExpense = await recognize('OWNER_FUNDED', { amountMinor: '404' });
    const ownerCorrections = await Promise.all([
      cancelExpense(ownerAExpense.operationId),
      cancelExpense(ownerBExpense.operationId),
    ]);
    expect(ownerCorrections.map((result) => result.status)).toEqual([201, 201]);
    expect(await ownerLiability()).toBe(ownerBefore);
    expect(await domainCounts()).toEqual({ customers: 0, suppliers: 0, inventory: 0, sales: 0 });
  });

  it('commits one concurrent same correction and rolls back an unexpected completion failure', async () => {
    const same = await recognize('DUE');
    const operationId = randomUUID();
    const concurrent = await Promise.all([
      cancelExpense(same.operationId, operationId),
      cancelExpense(same.operationId, operationId),
    ]);
    expect(concurrent.map((result) => result.status)).toEqual([201, 201]);
    expect(concurrent[0].body).toEqual(concurrent[1].body);

    if (!app) throw new Error('S16.4 application is unavailable for fault injection.');
    const rollback = await recognize('MONEY_PAID');
    const repository = app.get<{ completeApplied: (...args: unknown[]) => Promise<void> }>(
      ExpenseCorrectionRepository,
    );
    const completion = jest
      .spyOn(repository, 'completeApplied')
      .mockRejectedValueOnce(new Error('S16.4 completion fault'));
    const before = await balance(accountIds.cash);
    try {
      await cancelExpense(rollback.operationId).expect(500);
    } finally {
      completion.mockRestore();
    }
    const row = await db().admin.query<{ status: string; claims: number; reversals: number }>(
      `select e.status,
        (select count(*)::integer from sync.processed_operations o
         where o.store_id=e.store_id and o.action like 'expenses.%'
           and o.response_body ->> 'targetOperationId'=$3) claims,
        (select count(*)::integer from ledger.money_movements r
         where r.store_id=e.store_id and r.reversal_of_id=$4) reversals
       from ledger.expenses e where e.store_id=$1 and e.id=$2`,
      [
        ownerA.storeId,
        rollback.response.expense.id,
        rollback.operationId,
        rollback.response.moneyMovement?.id,
      ],
    );
    expect(row.rows[0]).toEqual({ status: 'posted', claims: 0, reversals: 0 });
    expect(await balance(accountIds.cash)).toBe(before);
  });
});
