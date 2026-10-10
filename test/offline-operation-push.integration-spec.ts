import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import request from 'supertest';

import { applyMigration, verifyMigrationSession } from '../scripts/migrate';
import { deriveAccountingPeriodId } from '../src/accounting-periods/accounting-period-identity';
import { resolveAccountingPeriodBoundaries } from '../src/accounting-periods/accounting-period-month';
import { PasswordService } from '../src/auth/password.service';
import type { AuthenticationResponse, SyncAuthenticationResponse } from '../src/auth/auth.types';
import { configureApplication } from '../src/bootstrap';
import { AppConfigService } from '../src/config/app-config.service';
import type { OfflineLicenseResponse } from '../src/offline-licenses/offline-license.types';
import {
  deriveMoneyFactOperationId,
  deriveTransactionGroupId,
} from '../src/money-movements/money-movement-identity';
import type { OfflineOperationPushResult } from '../src/sync/offline-operation.contract';
import {
  createInventoryTestDatabase,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';
import { readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const migrationFilename = '0026_durable_changed_replay_conflict.sql';
const environment = readLocalPostgresTestEnvironment();
const describeWithPostgres = environment ? describe : describe.skip;

jest.setTimeout(300_000);

interface PushEnvelopeInput {
  operationId?: string;
  operationType: string;
  aggregateId?: string;
  expectedVersion?: string;
  payload: Record<string, unknown>;
  dependencies?: string[];
  localSequence?: string;
}

interface PushResponse {
  results: OfflineOperationPushResult[];
}

function databaseUrl(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

function responseBody(response: { body: unknown }): unknown {
  return response.body;
}

describeWithPostgres('S19.5 offline operation push and canonical domain application', () => {
  let database: InventoryTestDatabase | undefined;
  let app: INestApplication | undefined;
  let server: Server;
  let login: AuthenticationResponse;
  let syncAuthentication: SyncAuthenticationResponse;
  let license: OfflineLicenseResponse;
  let occurredAt: string;
  let nextSequence = 1n;

  const originalEnvironment = {
    APP_ENV: process.env.APP_ENV,
    LOG_LEVEL: process.env.LOG_LEVEL,
    DATABASE_URL: process.env.DATABASE_URL,
    TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
    AUTH_DATABASE_URL: process.env.AUTH_DATABASE_URL,
  };
  const fixture = {
    storeId: randomUUID(),
    userId: randomUUID(),
    membershipId: randomUUID(),
    deviceId: randomUUID(),
    subscriptionId: randomUUID(),
    planId: randomUUID(),
    moneyAccountId: randomUUID(),
    expenseCategoryId: randomUUID(),
    customerId: randomUUID(),
    supplierId: randomUUID(),
    productId: randomUUID(),
    productUnitId: randomUUID(),
  };
  const password = 'S19.5-Disposable-Integration-Password!';

  const db = (): InventoryTestDatabase => {
    if (!database) throw new Error('Disposable S19.5 database is unavailable.');
    return database;
  };

  function envelope(input: PushEnvelopeInput): Record<string, unknown> {
    const signed = license.license;
    const operationId = input.operationId ?? randomUUID();
    const localSequence = input.localSequence ?? (nextSequence++).toString();
    return {
      protocolVersion: 1,
      operationId,
      operationType: input.operationType,
      storeId: fixture.storeId,
      deviceId: fixture.deviceId,
      ...(input.aggregateId ? { aggregateId: input.aggregateId } : {}),
      ...(input.expectedVersion ? { expectedVersion: input.expectedVersion } : {}),
      clientRecordedAt: occurredAt,
      payload: input.payload,
      offlineLicenseId: signed.payload.licenseId,
      signedLicense: signed,
      signingKeyId: signed.payload.signingKeyId,
      subscriptionId: signed.payload.subscriptionId,
      subscriptionVersion: signed.payload.subscriptionVersion,
      trustedTimeEvidence: {
        version: 1,
        trustedServerTime: signed.payload.issuedAt,
        observedDeviceTime: occurredAt,
        clockState: 'trusted',
        knownStoreStatus: 'active',
        knownStoreStatusAt: signed.payload.issuedAt,
      },
      localSequence,
      dependsOnOperationIds: input.dependencies ?? [],
    };
  }

  async function push(
    operations: Record<string, unknown>[],
    token = syncAuthentication.syncToken,
  ): Promise<PushResponse> {
    const response = await request(server)
      .post('/v1/sync/push')
      .set('authorization', `Bearer ${token}`)
      .send({ operations })
      .expect(200);
    return responseBody(response) as PushResponse;
  }

  async function count(table: string, operationId: string): Promise<number> {
    if (!/^[a-z_]+$/.test(table)) throw new Error('Unsafe fixture table name.');
    const result = await db().admin.query<{ count: number }>(
      `select count(*)::integer as count from ledger.${table} where operation_id = $1`,
      [operationId],
    );
    return result.rows[0]?.count ?? -1;
  }

  async function countByTransactionGroup(table: string, operationId: string): Promise<number> {
    if (!/^[a-z_]+$/.test(table)) throw new Error('Unsafe fixture table name.');
    const result = await db().admin.query<{ count: number }>(
      `select count(*)::integer as count from ledger.${table} where transaction_group_id = $1`,
      [deriveTransactionGroupId(operationId)],
    );
    return result.rows[0]?.count ?? -1;
  }

  beforeAll(async () => {
    if (!environment)
      throw new Error('The approved local PostgreSQL test environment is required.');
    database = await createInventoryTestDatabase(migrationFilename);
    const migrationClient = await db().migration.connect();
    try {
      await verifyMigrationSession(migrationClient);
      await applyMigration(migrationClient, db().file);
    } finally {
      await migrationClient.query('reset role');
      migrationClient.release();
    }

    const currentDatabase = await db().admin.query<{ name: string }>(
      'select current_database() as name',
    );
    const databaseName = currentDatabase.rows[0]?.name;
    if (!databaseName) throw new Error('Disposable database name is unavailable.');
    process.env.APP_ENV = 'test';
    process.env.LOG_LEVEL = 'silent';
    process.env.DATABASE_URL = databaseUrl(environment.runtimeUrl, databaseName);
    process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
    process.env.AUTH_DATABASE_URL = databaseUrl(environment.authUrl, databaseName);

    const passwordHash = await new PasswordService().hash(password);
    await db().admin.query(
      `insert into ledger.stores(id, name, status) values($1, 'S19.5 Push Store', 'active')`,
      [fixture.storeId],
    );
    await db().admin.query(`insert into ledger.app_settings(store_id) values($1)`, [
      fixture.storeId,
    ]);
    await db().admin.query(
      `insert into platform.users(id, email, normalized_email, password_hash, full_name, status)
       values($1, 's19-5-push@example.test', 's19-5-push@example.test', $2, 'S19.5 Owner', 'active')`,
      [fixture.userId, passwordHash],
    );
    await db().admin.query(
      `insert into platform.store_memberships(id, store_id, user_id, role, status)
       values($1, $2, $3, 'owner', 'active')`,
      [fixture.membershipId, fixture.storeId, fixture.userId],
    );
    await db().admin.query(
      `insert into platform.subscription_plans(
         id, code, name, duration_days, price_minor, max_devices, offline_grace_days, status
       ) values($1, $2, 'S19.5 Push Plan', 365, 0, 3, 7, 'active')`,
      [fixture.planId, `s19-5-${fixture.planId}`],
    );
    await db().admin.query(
      `insert into platform.subscriptions(
         id, store_id, plan_id, status, starts_at, expires_at, version
       ) values($1, $2, $3, 'active', clock_timestamp() - interval '1 day',
         clock_timestamp() + interval '30 days', 1)`,
      [fixture.subscriptionId, fixture.storeId, fixture.planId],
    );
    await db().admin.query(
      `insert into ledger.money_accounts(
         id, store_id, name, normalized_name, account_type, availability, status, operation_id
       ) values($1, $2, 'S19.5 Bank', 's19.5 bank', 'transfer', 'available', 'active', $3)`,
      [fixture.moneyAccountId, fixture.storeId, randomUUID()],
    );
    await db().admin.query(
      `insert into ledger.expense_categories(
         id, store_id, name, normalized_name, status, operation_id
       ) values($1, $2, 'S19.5 Utilities', 's19.5 utilities', 'active', $3)`,
      [fixture.expenseCategoryId, fixture.storeId, randomUUID()],
    );

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApplication(app as NestExpressApplication, app.get(AppConfigService));
    app.useLogger(app.get(Logger));
    await app.init();
    server = app.getHttpServer() as Server;

    login = responseBody(
      await request(server)
        .post('/v1/auth/login')
        .send({
          email: 's19-5-push@example.test',
          password,
          storeId: fixture.storeId,
          deviceId: fixture.deviceId,
          deviceName: 'S19.5 integration device',
          devicePlatform: 'android',
        })
        .expect(200),
    ) as AuthenticationResponse;
    license = responseBody(
      await request(server)
        .post('/v1/licenses/verify')
        .set('authorization', `Bearer ${login.accessToken}`)
        .send({ operationId: randomUUID() })
        .expect(200),
    ) as OfflineLicenseResponse;
    syncAuthentication = responseBody(
      await request(server)
        .post('/v1/sync/auth/token')
        .send({ refreshToken: login.refreshToken })
        .expect(200),
    ) as SyncAuthenticationResponse;
    const fixtureTime = await db().admin.query<{ occurredAt: string }>(
      'select clock_timestamp()::text as "occurredAt"',
    );
    const fixtureOccurredAt = fixtureTime.rows[0]?.occurredAt;
    if (!fixtureOccurredAt) throw new Error('S19.5 fixture time is unavailable.');
    occurredAt = new Date(fixtureOccurredAt).toISOString();
    const local = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Hebron',
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(new Date(occurredAt));
    const year = Number(local.find((part) => part.type === 'year')?.value);
    const month = Number(local.find((part) => part.type === 'month')?.value);
    const boundaries = resolveAccountingPeriodBoundaries(year, month);
    await db().admin.query(
      `insert into ledger.accounting_periods(
         id, store_id, period_year, period_month, starts_at, ends_at, status, operation_id
       ) values($1, $2, $3, $4, $5, $6, 'open', $7)`,
      [
        deriveAccountingPeriodId(fixture.storeId, year, month),
        fixture.storeId,
        year,
        month,
        boundaries.startsAt,
        boundaries.endsAt,
        randomUUID(),
      ],
    );
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }, 60_000);

  it('enforces the dedicated sync token and trusted Store/device context', async () => {
    const operation = envelope({
      operationType: 'customers.create.v1',
      aggregateId: randomUUID(),
      payload: { name: 'Wrong context', phone: '0599000099' },
    });
    await request(server)
      .post('/v1/sync/push')
      .set('authorization', `Bearer ${login.accessToken}`)
      .send({ operations: [operation] })
      .expect(401);
    await request(server)
      .get('/v1/customers')
      .set('authorization', `Bearer ${syncAuthentication.syncToken}`)
      .expect(401);

    const wrongContext = { ...operation, storeId: randomUUID() };
    const response = await push([wrongContext]);
    expect(response.results).toEqual([
      expect.objectContaining({ status: 'REJECTED', code: 'SYNC_CONTEXT_MISMATCH' }),
    ]);
  });

  it('resolves a real dependency chain and preserves exact/changed replay invariants', async () => {
    const supplierOperationId = randomUUID();
    const invoiceOperationId = randomUUID();
    const invoice = envelope({
      operationId: invoiceOperationId,
      operationType: 'supplier_invoices.post.v1',
      payload: {
        supplierId: fixture.supplierId,
        invoiceNumber: 'S19-5-INV-1',
        occurredAt,
        totalMinor: '1000',
        items: [
          {
            description: 'Offline payable only',
            unitName: 'unit',
            quantityMilli: '1000',
            unitCostMinor: '1000',
            lineTotalMinor: '1000',
          },
        ],
      },
      dependencies: [supplierOperationId],
    });
    const pending = await push([invoice]);
    expect(pending.results[0]).toEqual(expect.objectContaining({ status: 'DEPENDENCY_PENDING' }));
    expect(await count('purchase_invoices', invoiceOperationId)).toBe(0);
    expect(await count('supplier_ledger_entries', invoiceOperationId)).toBe(0);

    const supplier = envelope({
      operationId: supplierOperationId,
      operationType: 'suppliers.create.v1',
      aggregateId: fixture.supplierId,
      payload: { name: 'S19.5 Supplier', phone: '0599000002' },
    });
    expect((await push([supplier])).results[0]?.status).toBe('APPLIED');
    const applied = await push([invoice]);
    expect(applied.results[0]).toEqual(expect.objectContaining({ status: 'APPLIED', code: null }));
    expect(await count('purchase_invoices', invoiceOperationId)).toBe(1);
    expect(await countByTransactionGroup('supplier_ledger_entries', invoiceOperationId)).toBe(1);
    expect(await countByTransactionGroup('inventory_movements', invoiceOperationId)).toBe(0);

    const canonicalBefore = await db().admin.query<{
      hash: string;
      response: unknown;
    }>(
      `select request_hash as hash, response_body as response
       from sync.processed_operations where store_id = $1 and operation_id = $2`,
      [fixture.storeId, invoiceOperationId],
    );
    expect((await push([invoice])).results[0]?.status).toBe('EXACT_REPLAY');
    const changed = structuredClone(invoice);
    (changed.payload as Record<string, unknown>).invoiceNumber = 'S19-5-INV-CHANGED';
    const [firstConflict, concurrentConflict] = await Promise.all([
      push([changed]),
      push([changed]),
    ]);
    for (const conflict of [firstConflict, concurrentConflict]) {
      expect(conflict.results[0]).toEqual(
        expect.objectContaining({ status: 'CONFLICT', code: 'OFFLINE_OPERATION_ID_CONFLICT' }),
      );
    }
    expect(await count('purchase_invoices', invoiceOperationId)).toBe(1);
    expect(await countByTransactionGroup('supplier_ledger_entries', invoiceOperationId)).toBe(1);
    const canonicalAfter = await db().admin.query<{ hash: string; response: unknown }>(
      `select request_hash as hash, response_body as response
       from sync.processed_operations where store_id = $1 and operation_id = $2`,
      [fixture.storeId, invoiceOperationId],
    );
    expect(canonicalAfter.rows[0]).toEqual(canonicalBefore.rows[0]);
    const provenance = await db().admin.query<{
      disposition: string;
      reasonCode: string;
      responseBody: Record<string, unknown>;
      canonicalRequestHash: string;
    }>(
      `select disposition,
              reason_code as "reasonCode",
              response_body as "responseBody",
              canonical_request_hash as "canonicalRequestHash"
       from sync.offline_operation_provenance_v1
       where store_id = $1 and operation_id = $2`,
      [fixture.storeId, invoiceOperationId],
    );
    expect(provenance.rows[0]).toEqual({
      disposition: 'conflict',
      reasonCode: 'OFFLINE_OPERATION_ID_CONFLICT',
      responseBody: {
        code: 'OFFLINE_OPERATION_ID_CONFLICT',
        message: 'Offline operation conflicts with the original request.',
      },
      canonicalRequestHash: canonicalBefore.rows[0]?.hash,
    });
  });

  it('reuses representative domain authorities without duplicate financial or inventory effects', async () => {
    const customerOperationId = randomUUID();
    const productOperationId = randomUUID();
    const ownerOperationId = randomUUID();
    const inventoryOperationId = randomUUID();

    const foundations = [
      envelope({
        operationId: customerOperationId,
        operationType: 'customers.create.v1',
        aggregateId: fixture.customerId,
        payload: { name: 'S19.5 Customer', phone: '0599000001' },
      }),
      envelope({
        operationId: productOperationId,
        operationType: 'products.create.v1',
        aggregateId: fixture.productId,
        payload: {
          name: 'S19.5 Product',
          measurementType: 'count',
          trackInventory: true,
          allowNegativeStockOverride: false,
          initialBaseUnit: {
            id: fixture.productUnitId,
            unitName: 'piece',
            salePriceMinor: '500',
            purchasePriceMinor: '200',
          },
        },
      }),
      envelope({
        operationId: ownerOperationId,
        operationType: 'owner_contributions.post.v1',
        payload: { moneyAccountId: fixture.moneyAccountId, amountMinor: '5000', occurredAt },
      }),
      envelope({
        operationId: inventoryOperationId,
        operationType: 'inventory.increase.post.v1',
        aggregateId: randomUUID(),
        payload: {
          productId: fixture.productId,
          productUnitId: fixture.productUnitId,
          selectedQuantityMilli: '10000',
          totalPurchaseCostMinor: '2000',
          occurredAt,
        },
        dependencies: [productOperationId],
      }),
    ];
    const foundationResult = await push(foundations);
    expect(foundationResult.results.map(({ status, code }) => ({ status, code }))).toEqual([
      { status: 'APPLIED', code: null },
      { status: 'APPLIED', code: null },
      { status: 'APPLIED', code: null },
      { status: 'APPLIED', code: null },
    ]);

    const invoice = await db().admin.query<{ id: string }>(
      `select id from ledger.purchase_invoices
       where store_id = $1 and invoice_number = 'S19-5-INV-1'`,
      [fixture.storeId],
    );
    const invoiceId = invoice.rows[0]?.id;
    if (!invoiceId) throw new Error('Supplier Invoice fixture was not applied.');
    const supplierPaymentOperationId = randomUUID();
    const creditSaleOperationId = randomUUID();
    const expenseOperationId = randomUUID();
    const financial = [
      envelope({
        operationId: supplierPaymentOperationId,
        operationType: 'supplier_payments.post.v1',
        payload: {
          supplierId: fixture.supplierId,
          paymentSource: 'money_account',
          moneyAccountId: fixture.moneyAccountId,
          amountMinor: '600',
          occurredAt,
          allocations: [
            { targetType: 'purchase_invoice', targetId: invoiceId, amountMinor: '600' },
          ],
        },
      }),
      envelope({
        operationId: creditSaleOperationId,
        operationType: 'sales.post.v1',
        payload: {
          customerId: fixture.customerId,
          occurredAt,
          totalMinor: '500',
          items: [
            {
              isManualLine: false,
              productId: fixture.productId,
              productUnitId: fixture.productUnitId,
              quantityMilli: '1000',
              unitPriceMinor: '500',
              lineTotalMinor: '500',
            },
          ],
        },
      }),
      envelope({
        operationId: expenseOperationId,
        operationType: 'expenses.post.v1',
        aggregateId: randomUUID(),
        payload: {
          categoryId: fixture.expenseCategoryId,
          description: 'S19.5 due expense',
          amountMinor: '300',
          occurredAt,
          dueAt: occurredAt,
          mode: 'DUE',
        },
      }),
    ];
    const financialResult = await push(financial);
    expect(financialResult.results.map((item) => item.status)).toEqual([
      'APPLIED',
      'APPLIED',
      'APPLIED',
    ]);

    const sale = await db().admin.query<{ id: string }>(
      `select id from ledger.sales where store_id = $1 and operation_id = $2`,
      [fixture.storeId, creditSaleOperationId],
    );
    const expense = await db().admin.query<{ id: string }>(
      `select id from ledger.expenses where store_id = $1 and operation_id = $2`,
      [fixture.storeId, expenseOperationId],
    );
    const saleId = sale.rows[0]?.id;
    const expenseId = expense.rows[0]?.id;
    if (!saleId || !expenseId) {
      throw new Error('Sale or Expense fixture was not applied.');
    }
    const collectionOperationId = randomUUID();
    const expensePaymentOperationId = randomUUID();
    const settlement = [
      envelope({
        operationId: collectionOperationId,
        operationType: 'customer_collections.post.v1',
        payload: {
          customerId: fixture.customerId,
          occurredAt,
          allocationMode: 'fifo',
          tenders: [{ moneyAccountId: fixture.moneyAccountId, amountMinor: '500' }],
        },
        dependencies: [creditSaleOperationId],
      }),
      envelope({
        operationId: expensePaymentOperationId,
        operationType: 'expense_payments.post.v1',
        payload: {
          expenseId,
          paymentSource: 'money_account',
          moneyAccountId: fixture.moneyAccountId,
          amountMinor: '300',
          occurredAt,
        },
        dependencies: [expenseOperationId],
      }),
    ];
    const settlementResult = await push(settlement);
    expect(settlementResult.results.map((item) => item.status)).toEqual(['APPLIED', 'APPLIED']);

    const saleItem = await db().admin.query<{ id: string }>(
      `select id from ledger.sale_items where store_id = $1 and sale_id = $2 limit 1`,
      [fixture.storeId, saleId],
    );
    const saleItemId = saleItem.rows[0]?.id;
    if (!saleItemId) throw new Error('Sale Item fixture was not applied.');

    const supplierReturnOperationId = randomUUID();
    const saleReturnOperationId = randomUUID();
    const stockCountOperationId = randomUUID();
    const returnAndCount = [
      envelope({
        operationId: supplierReturnOperationId,
        operationType: 'supplier_returns.post.v1',
        payload: {
          supplierId: fixture.supplierId,
          purchaseInvoiceId: invoiceId,
          amountMinor: '100',
          occurredAt,
          reason: 'Offline Supplier Return',
        },
        dependencies: [supplierPaymentOperationId],
      }),
      envelope({
        operationId: saleReturnOperationId,
        operationType: 'sale_returns.post.v1',
        payload: {
          saleId,
          occurredAt,
          reason: 'Offline Customer Return',
          lines: [
            {
              saleItemId,
              quantityMilli: '1000',
              disposition: 'RESTOCK_SALEABLE',
            },
          ],
          residualSettlement: { choice: 'KEEP_AS_CUSTOMER_CREDIT' },
        },
        dependencies: [collectionOperationId],
      }),
      envelope({
        operationId: stockCountOperationId,
        operationType: 'stock_counts.post.v1',
        aggregateId: randomUUID(),
        payload: {
          countType: 'partial',
          occurredAt,
          items: [
            {
              productId: fixture.productId,
              productUnitId: fixture.productUnitId,
              actualQuantityMilli: '9500',
            },
          ],
        },
        dependencies: [saleReturnOperationId],
      }),
    ];
    const returnAndCountResult = await push(returnAndCount);
    expect(returnAndCountResult.results.map(({ status, code }) => ({ status, code }))).toEqual([
      { status: 'APPLIED', code: null },
      { status: 'APPLIED', code: null },
      { status: 'APPLIED', code: null },
    ]);

    expect(await count('manual_inventory_entries', inventoryOperationId)).toBe(1);
    expect(await countByTransactionGroup('inventory_movements', inventoryOperationId)).toBe(1);
    expect(await count('supplier_payments', supplierPaymentOperationId)).toBe(1);
    expect(await count('sales', creditSaleOperationId)).toBe(1);
    expect(
      await count(
        'customer_payments',
        deriveMoneyFactOperationId(
          collectionOperationId,
          `customer-payment:${fixture.moneyAccountId}`,
        ),
      ),
    ).toBe(1);
    expect(await count('expenses', expenseOperationId)).toBe(1);
    expect(await count('expense_payments', expensePaymentOperationId)).toBe(1);
    expect(await countByTransactionGroup('money_movements', ownerOperationId)).toBe(1);
    expect(await count('supplier_returns', supplierReturnOperationId)).toBe(1);
    expect(await count('sale_returns', saleReturnOperationId)).toBe(1);
    expect(await count('stock_counts', stockCountOperationId)).toBe(1);
    expect(await countByTransactionGroup('inventory_movements', saleReturnOperationId)).toBe(1);
    expect(await countByTransactionGroup('inventory_movements', stockCountOperationId)).toBe(1);
    expect(
      await countByTransactionGroup('supplier_ledger_entries', supplierReturnOperationId),
    ).toBe(1);

    const ownerFoundation = foundations[2];
    if (!ownerFoundation) throw new Error('S19.5 owner operation fixture is unavailable.');
    const replay = await push([ownerFoundation]);
    expect(replay.results[0]?.status).toBe('EXACT_REPLAY');
    expect(await countByTransactionGroup('money_movements', ownerOperationId)).toBe(1);
    const returnReplay = await push(returnAndCount);
    expect(returnReplay.results.map((item) => item.status)).toEqual([
      'EXACT_REPLAY',
      'EXACT_REPLAY',
      'EXACT_REPLAY',
    ]);
    expect(await count('supplier_returns', supplierReturnOperationId)).toBe(1);
    expect(await count('sale_returns', saleReturnOperationId)).toBe(1);
    expect(await count('stock_counts', stockCountOperationId)).toBe(1);
    const changes = await db().admin.query<{ count: number }>(
      `select count(*)::integer as count from sync.store_change_events_v1
       where store_id = $1 and operation_id = any($2::uuid[])`,
      [
        fixture.storeId,
        [
          ownerOperationId,
          inventoryOperationId,
          supplierPaymentOperationId,
          creditSaleOperationId,
          collectionOperationId,
          expenseOperationId,
          expensePaymentOperationId,
          supplierReturnOperationId,
          saleReturnOperationId,
          stockCountOperationId,
        ],
      ],
    );
    expect(changes.rows[0]?.count).toBeGreaterThan(0);
  });

  it('isolates applied, dependency-pending, and rejected items in one bounded batch', async () => {
    const validOperationId = randomUUID();
    const validCustomerId = randomUUID();
    const pendingOperationId = randomUUID();
    const rejectedOperationId = randomUUID();
    const rejectedCustomerId = randomUUID();
    const missingDependencyId = randomUUID();
    const valid = envelope({
      operationId: validOperationId,
      operationType: 'customers.create.v1',
      aggregateId: validCustomerId,
      payload: { name: 'S19.5 Batch Customer', phone: '0599000011' },
    });
    const pending = envelope({
      operationId: pendingOperationId,
      operationType: 'suppliers.update.v1',
      aggregateId: fixture.supplierId,
      expectedVersion: '1',
      payload: { name: 'Must remain pending' },
      dependencies: [missingDependencyId],
    });
    const rejected = {
      ...envelope({
        operationId: rejectedOperationId,
        operationType: 'customers.create.v1',
        aggregateId: rejectedCustomerId,
        payload: { name: 'Wrong Store', phone: '0599000012' },
      }),
      storeId: randomUUID(),
    };

    const response = await push([valid, pending, rejected]);
    expect(response.results.map(({ status }) => status)).toEqual([
      'APPLIED',
      'DEPENDENCY_PENDING',
      'REJECTED',
    ]);
    expect(await count('customers', validOperationId)).toBe(1);
    expect(await count('suppliers', pendingOperationId)).toBe(0);
    expect(await count('customers', rejectedOperationId)).toBe(0);
  });

  it('keeps identical and stale-version races deterministic', async () => {
    const duplicateOperationId = randomUUID();
    const duplicate = envelope({
      operationId: duplicateOperationId,
      operationType: 'owner_contributions.post.v1',
      payload: { moneyAccountId: fixture.moneyAccountId, amountMinor: '7', occurredAt },
    });
    const duplicateResults = await Promise.all([push([duplicate]), push([duplicate])]);
    expect(
      duplicateResults
        .map((result) => result.results[0])
        .sort((left, right) => (left?.status ?? '').localeCompare(right?.status ?? '')),
    ).toEqual([
      expect.objectContaining({ status: 'APPLIED', code: null }),
      expect.objectContaining({ status: 'EXACT_REPLAY', code: null }),
    ]);
    expect(await countByTransactionGroup('money_movements', duplicateOperationId)).toBe(1);

    const updateA = envelope({
      operationType: 'customers.update.v1',
      aggregateId: fixture.customerId,
      expectedVersion: '1',
      payload: { name: 'S19.5 Customer A', phone: '0599000001' },
    });
    const updateB = envelope({
      operationType: 'customers.update.v1',
      aggregateId: fixture.customerId,
      expectedVersion: '1',
      payload: { name: 'S19.5 Customer B', phone: '0599000001' },
    });
    const staleResults = await Promise.all([push([updateA]), push([updateB])]);
    expect(staleResults.map((result) => result.results[0]?.status).sort()).toEqual([
      'APPLIED',
      'CONFLICT',
    ]);
    const customer = await db().admin.query<{ version: string; name: string }>(
      `select version::text as version, name from ledger.customers
       where store_id = $1 and id = $2`,
      [fixture.storeId, fixture.customerId],
    );
    expect(customer.rows[0]?.version).toBe('2');
    expect(['S19.5 Customer A', 'S19.5 Customer B']).toContain(customer.rows[0]?.name);
  });
});
