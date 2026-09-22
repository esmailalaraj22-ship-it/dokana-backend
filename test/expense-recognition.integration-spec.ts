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
import { ExpenseRecognitionRepository } from '../src/expenses/expense-recognition.repository';
import type { ExpenseRecognitionResponse } from '../src/expenses/expense-recognition.types';
import { applyMigration, verifyMigrationSession } from '../scripts/migrate';
import {
  createInventoryTestDatabase,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const migrationFilename = '0015_sale_customer_credit_tender.sql';
const occurredAt = '2026-09-15T10:00:00Z';

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
  email: `s162-owner-a-${randomUUID()}@example.test`,
  token: '',
};
const ownerB: Identity = {
  storeId: randomUUID(),
  userId: randomUUID(),
  deviceId: randomUUID(),
  email: `s162-owner-b-${randomUUID()}@example.test`,
  token: '',
};
const categoryIds = {
  active: randomUUID(),
  archived: randomUUID(),
  foreign: randomUUID(),
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

describe('S16.2 Expense recognition foundation on isolated PostgreSQL', () => {
  jest.setTimeout(120_000);

  let database: InventoryTestDatabase | undefined;
  let runtimePool: Pool | undefined;
  let authPool: Pool | undefined;
  let app: NestExpressApplication | undefined;
  let server: Server;

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('S16.2 isolated database is unavailable.');
    return database;
  }

  function auth(identity = ownerA): { authorization: string } {
    return { authorization: `Bearer ${identity.token}` };
  }

  function expenseBody(
    input: {
      id?: string;
      operationId?: string;
      categoryId?: string | null;
      amountMinor?: string;
      mode?: 'DUE' | 'MONEY_PAID' | 'OWNER_FUNDED';
      moneyAccountId?: string | null;
      at?: string;
    } = {},
  ): Record<string, unknown> {
    const mode = input.mode ?? 'DUE';
    const body: Record<string, unknown> = {
      id: input.id ?? randomUUID(),
      operationId: input.operationId ?? randomUUID(),
      categoryId: input.categoryId === undefined ? categoryIds.active : input.categoryId,
      description: 'S16.2 test Expense',
      amountMinor: input.amountMinor ?? '500',
      occurredAt: input.at ?? occurredAt,
      mode,
      notes: 'Focused Expense fixture',
    };
    if (mode === 'DUE') body.dueAt = '2026-10-01T10:00:00Z';
    if (mode === 'MONEY_PAID') {
      body.moneyAccountId = input.moneyAccountId ?? accountIds.active;
    } else if (input.moneyAccountId !== undefined) {
      body.moneyAccountId = input.moneyAccountId;
    }
    return body;
  }

  function postExpense(body: Record<string, unknown>, identity = ownerA) {
    return request(server).post('/v1/expenses').set(auth(identity)).send(body);
  }

  async function countFacts(storeId = ownerA.storeId) {
    const result = await db().admin.query<{
      expenses: number;
      payments: number;
      money: number;
      owner: number;
      supplier: number;
      customer: number;
      inventory: number;
      sales: number;
    }>(
      `select
        (select count(*)::integer from ledger.expenses where store_id=$1) as expenses,
        (select count(*)::integer from ledger.expense_payments where store_id=$1) as payments,
        (select count(*)::integer from ledger.money_movements
          where store_id=$1 and movement_type='expense_payment') as money,
        (select count(*)::integer from ledger.owner_ledger_entries
          where store_id=$1 and entry_type='owner_paid_expense') as owner,
        (select count(*)::integer from ledger.supplier_ledger_entries where store_id=$1) as supplier,
        (select count(*)::integer from ledger.customer_ledger_entries where store_id=$1) as customer,
        (select count(*)::integer from ledger.inventory_movements where store_id=$1) as inventory,
        (select count(*)::integer from ledger.sales where store_id=$1) as sales`,
      [storeId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Expected Expense fact counts.');
    return row;
  }

  async function accountBalance(accountId: string): Promise<string> {
    const result = await db().admin.query<{ amount: string }>(
      `select coalesce(sum(amount_delta_minor),0)::text as amount
       from ledger.money_movements where account_id=$1`,
      [accountId],
    );
    return result.rows[0]?.amount ?? 'missing';
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
      throw new Error('S16.2 integration database is not isolated.');
    }
    const databaseUrl = (source: string): string => {
      const parsed = new URL(source);
      parsed.pathname = `/${databaseName}`;
      return parsed.toString();
    };
    runtimePool = createTestPool(databaseUrl(environment.runtimeUrl), 'dokana-s162-runtime', 8);
    authPool = createTestPool(databaseUrl(environment.authUrl), 'dokana-s162-auth', 2);

    const password = randomUUID();
    const passwordHash = await new PasswordService().hash(password);
    for (const identity of [ownerA, ownerB]) {
      await db().admin.query(
        `insert into ledger.stores(id,name,status) values($1,'S16.2 fixture','active')`,
        [identity.storeId],
      );
      await db().admin.query(
        `insert into platform.users(id,email,normalized_email,password_hash,full_name)
         values($1,$2,$2,$3,'S16.2 owner')`,
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
         ($1,$4,'Utilities','utilities','active',$6),
         ($2,$4,'Archived','archived','archived',$7),
         ($3,$5,'Foreign','foreign','active',$8)`,
      [
        categoryIds.active,
        categoryIds.archived,
        categoryIds.foreign,
        ownerA.storeId,
        ownerB.storeId,
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ],
    );
    await db().admin.query(
      `insert into ledger.money_accounts(
         id,store_id,name,normalized_name,account_type,availability,status,archived_at,operation_id
       ) values
         ($1,$4,'Expense Bank','expense bank','transfer','available','active',null,$6),
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
          deviceName: 'S16.2 isolated',
          devicePlatform: 'android',
        })
        .expect(200);
      const body = login.body as { accessToken?: unknown };
      if (typeof body.accessToken !== 'string') throw new Error('S16.2 login token missing.');
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

  it('provides the complete Expense Category lifecycle and preserves historical reads', async () => {
    const categoryId = randomUUID();
    const created = await request(server)
      .post('/v1/expense-categories')
      .set(auth())
      .send({ id: categoryId, operationId: randomUUID(), name: ' Office  Supplies ' })
      .expect(201);
    expect(created.body).toMatchObject({ id: categoryId, name: 'Office Supplies', version: '1' });

    await request(server).get('/v1/expense-categories').set(auth()).expect(200);
    await request(server).get(`/v1/expense-categories/${categoryId}`).set(auth()).expect(200);
    const updated = await request(server)
      .patch(`/v1/expense-categories/${categoryId}`)
      .set(auth())
      .send({ operationId: randomUUID(), expectedVersion: '1', name: 'Office Costs' })
      .expect(200);
    expect(updated.body).toMatchObject({ name: 'Office Costs', version: '2' });

    const historical = expenseBody({ categoryId });
    const posted = await postExpense(historical).expect(201);
    const archived = await request(server)
      .post(`/v1/expense-categories/${categoryId}/archive`)
      .set(auth())
      .send({ operationId: randomUUID(), expectedVersion: '2' })
      .expect(200);
    expect(archived.body).toMatchObject({ status: 'archived', version: '3' });
    const forbiddenUpdate = await request(server)
      .patch(`/v1/expense-categories/${categoryId}`)
      .set(auth())
      .send({ operationId: randomUUID(), expectedVersion: '3', name: 'Forbidden Rename' })
      .expect(409);
    expect(responseBody(forbiddenUpdate).code).toBe('EXPENSE_CATEGORY_ARCHIVED');
    const historicalDetail = await request(server)
      .get(`/v1/expenses/${(posted.body as ExpenseRecognitionResponse).expense.id}`)
      .set(auth())
      .expect(200);
    expect(responseBody(historicalDetail).category).toMatchObject({ status: 'archived' });
    const unavailable = await postExpense(expenseBody({ categoryId })).expect(409);
    expect(responseBody(unavailable).code).toBe('EXPENSE_CATEGORY_UNAVAILABLE');

    const restored = await request(server)
      .post(`/v1/expense-categories/${categoryId}/restore`)
      .set(auth())
      .send({ operationId: randomUUID(), expectedVersion: '3' })
      .expect(200);
    expect(restored.body).toMatchObject({ status: 'active', version: '4' });
  });

  it('recognizes DUE Expense once with full derived outstanding and no funding effect', async () => {
    const before = await countFacts();
    const posted = await postExpense(expenseBody({ amountMinor: '500' })).expect(201);
    const body = posted.body as ExpenseRecognitionResponse;
    expect(body).toMatchObject({
      mode: 'DUE',
      expense: { amountMinor: '500', paidTotalMinor: '0', outstandingMinor: '500' },
      payment: null,
      moneyMovement: null,
      ownerLedgerEntry: null,
    });
    const after = await countFacts();
    expect(after).toEqual({ ...before, expenses: before.expenses + 1 });
    const firstPage = await request(server).get('/v1/expenses?limit=1').set(auth()).expect(200);
    const firstPageBody = responseBody(firstPage);
    const firstItems = firstPageBody.items;
    if (!Array.isArray(firstItems) || typeof firstPageBody.nextCursor !== 'string') {
      throw new Error('Expected a paginated Expense response.');
    }
    expect(firstItems).toHaveLength(1);
    const secondPage = await request(server)
      .get(`/v1/expenses?limit=1&cursor=${firstPageBody.nextCursor}`)
      .set(auth())
      .expect(200);
    const secondItems = responseBody(secondPage).items;
    if (!Array.isArray(secondItems)) throw new Error('Expected Expense page items.');
    expect(secondItems[0]).not.toEqual(firstItems[0]);
    await request(server).get('/v1/expenses?cursor=invalid*').set(auth()).expect(400);
    await request(server).get(`/v1/expenses/${body.expense.id}`).set(auth()).expect(200);
  });

  it('recognizes a lossless MONEY_PAID Expense with one exact negative movement', async () => {
    const amount = '9007199254740993';
    const before = BigInt(await accountBalance(accountIds.active));
    const posted = await postExpense(
      expenseBody({ mode: 'MONEY_PAID', amountMinor: amount }),
    ).expect(201);
    const body = posted.body as ExpenseRecognitionResponse;
    expect(body).toMatchObject({
      mode: 'MONEY_PAID',
      expense: { amountMinor: amount, outstandingMinor: '0' },
      payment: { amountMinor: amount, paymentSource: 'money_account' },
      moneyMovement: { amountDeltaMinor: `-${amount}`, movementType: 'expense_payment' },
      ownerLedgerEntry: null,
    });
    const detail = await request(server)
      .get(`/v1/expenses/${body.expense.id}`)
      .set(auth())
      .expect(200);
    expect(responseBody(detail).recognitionFunding).toMatchObject({
      source: 'money_account',
      moneyAccountId: accountIds.active,
      moneyMovementId: body.moneyMovement?.id,
    });
    expect(await accountBalance(accountIds.active)).toBe((before - BigInt(amount)).toString());
  });

  it('recognizes OWNER_FUNDED with an exact owner claim and zero Store Money effect', async () => {
    const before = await countFacts();
    const posted = await postExpense(
      expenseBody({ mode: 'OWNER_FUNDED', amountMinor: '700' }),
    ).expect(201);
    const body = posted.body as ExpenseRecognitionResponse;
    expect(body).toMatchObject({
      mode: 'OWNER_FUNDED',
      expense: { amountMinor: '700', outstandingMinor: '0' },
      payment: { paymentSource: 'owner_pocket', moneyAccountId: null },
      moneyMovement: null,
      ownerLedgerEntry: {
        entryType: 'owner_paid_expense',
        ownerLiabilityDeltaMinor: '700',
        equityDeltaMinor: '0',
        moneyAccountId: null,
      },
    });
    const detail = await request(server)
      .get(`/v1/expenses/${body.expense.id}`)
      .set(auth())
      .expect(200);
    expect(responseBody(detail).recognitionFunding).toMatchObject({
      source: 'owner_pocket',
      moneyAccountId: null,
      ownerLedgerEntryId: body.ownerLedgerEntry?.id,
    });
    const after = await countFacts();
    expect(after).toEqual({
      ...before,
      expenses: before.expenses + 1,
      payments: before.payments + 1,
      owner: before.owner + 1,
    });
  });

  it('exact-replays, rejects changed reuse, and serializes concurrent identical submission', async () => {
    const operationId = randomUUID();
    const body = expenseBody({ operationId });
    const first = await postExpense(body).expect(201);
    const replay = await postExpense(body).expect(201);
    expect(replay.body).toEqual(first.body);
    const conflict = await postExpense({ ...body, amountMinor: '501' }).expect(409);
    expect(responseBody(conflict).code).toBe('OPERATION_ID_CONFLICT');

    const concurrentBody = expenseBody({ operationId: randomUUID() });
    const responses = await Promise.all([postExpense(concurrentBody), postExpense(concurrentBody)]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(responses[0].body).toEqual(responses[1].body);
    const count = await db().admin.query<{ count: number }>(
      `select count(*)::integer as count from ledger.expenses
       where store_id=$1 and operation_id=$2`,
      [ownerA.storeId, concurrentBody.operationId],
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it('fails closed for cross-tenant/category/account, unavailable account, and read_only', async () => {
    await postExpense(expenseBody({ categoryId: categoryIds.foreign })).expect(404);
    await postExpense(
      expenseBody({ mode: 'MONEY_PAID', moneyAccountId: accountIds.foreign }),
    ).expect(404);
    await postExpense(
      expenseBody({ mode: 'MONEY_PAID', moneyAccountId: accountIds.archived }),
    ).expect(409);

    await db().admin.query(`update ledger.stores set status='read_only' where id=$1`, [
      ownerA.storeId,
    ]);
    try {
      const denied = await postExpense(expenseBody()).expect(403);
      expect(responseBody(denied).code).toBe('BUSINESS_WRITE_NOT_ALLOWED');
    } finally {
      await db().admin.query(`update ledger.stores set status='active' where id=$1`, [
        ownerA.storeId,
      ]);
    }
  });

  it('rejects a closed period atomically', async () => {
    const periodId = deriveAccountingPeriodId(ownerA.storeId, 2026, 9);
    await db().admin.query(
      `update ledger.accounting_periods set status='closed',closed_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [ownerA.storeId, periodId],
    );
    const operationId = randomUUID();
    try {
      const denied = await postExpense(expenseBody({ operationId })).expect(409);
      expect(responseBody(denied).code).toBe('ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE');
      const facts = await db().admin.query<{ expenses: number; operation: string }>(
        `select
          (select count(*)::integer from ledger.expenses where operation_id=$1) as expenses,
          (select status from sync.processed_operations
            where store_id=$2 and operation_id=$1) as operation`,
        [operationId, ownerA.storeId],
      );
      expect(facts.rows[0]).toEqual({ expenses: 0, operation: 'rejected' });
    } finally {
      await db().admin.query(
        `update ledger.accounting_periods set status='open',closed_at=null
         where store_id=$1 and id=$2`,
        [ownerA.storeId, periodId],
      );
    }
  });

  it('serializes Category archive and Money Account archive races with recognition', async () => {
    const categoryId = randomUUID();
    await request(server)
      .post('/v1/expense-categories')
      .set(auth())
      .send({ id: categoryId, operationId: randomUUID(), name: `Race ${categoryId}` })
      .expect(201);
    const categoryRace = await Promise.all([
      postExpense(expenseBody({ categoryId })),
      request(server)
        .post(`/v1/expense-categories/${categoryId}/archive`)
        .set(auth())
        .send({ operationId: randomUUID(), expectedVersion: '1' }),
    ]);
    expect(categoryRace[1].status).toBe(200);
    expect([201, 409]).toContain(categoryRace[0].status);

    const accountId = randomUUID();
    await db().admin.query(
      `insert into ledger.money_accounts(
         id,store_id,name,normalized_name,account_type,availability,status,operation_id
       ) values($1,$2,$3,$3,'transfer','available','active',$4)`,
      [accountId, ownerA.storeId, `race-${accountId}`, randomUUID()],
    );
    const accountRace = await Promise.all([
      postExpense(expenseBody({ mode: 'MONEY_PAID', moneyAccountId: accountId })),
      request(server)
        .post(`/v1/money-accounts/${accountId}/archive`)
        .set(auth())
        .send({ operationId: randomUUID(), expectedVersion: '1' }),
    ]);
    expect(accountRace.every((response) => [200, 201, 409].includes(response.status))).toBe(true);
    expect(accountRace.some((response) => response.status >= 400)).toBe(true);
  });

  it('rolls back Expense, funding, audit/change effects, and operation on completion failure', async () => {
    if (!app) throw new Error('Application unavailable for S16.2 fault injection.');
    const repository = app.get<{
      applyOperation: (...arguments_: unknown[]) => Promise<void>;
    }>(ExpenseRecognitionRepository);
    const operationId = randomUUID();
    const expenseId = randomUUID();
    const completion = jest
      .spyOn(repository, 'applyOperation')
      .mockRejectedValueOnce(new Error('S16.2 completion fault'));
    try {
      await postExpense(expenseBody({ id: expenseId, operationId, mode: 'OWNER_FUNDED' })).expect(
        500,
      );
    } finally {
      completion.mockRestore();
    }
    const result = await db().admin.query<{
      expenses: number;
      payments: number;
      owner: number;
      operations: number;
      changes: number;
      audits: number;
    }>(
      `select
        (select count(*)::integer from ledger.expenses where id=$1) as expenses,
        (select count(*)::integer from ledger.expense_payments where expense_id=$1) as payments,
        (select count(*)::integer from ledger.owner_ledger_entries
          where transaction_group_id=$2) as owner,
        (select count(*)::integer from sync.processed_operations where operation_id=$2) as operations,
        (select count(*)::integer from sync.change_events
          where store_id=$3 and operation_id=$2) as changes,
        (select count(*)::integer from audit.central_audit_logs
          where store_id=$3 and entity_id=$1) as audits`,
      [expenseId, operationId, ownerA.storeId],
    );
    expect(result.rows[0]).toMatchObject({
      expenses: 0,
      payments: 0,
      owner: 0,
      operations: 0,
      changes: 0,
      audits: 0,
    });
  });
});
