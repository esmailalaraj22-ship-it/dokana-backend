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
import {
  parseOfflineOperationEnvelope,
  type OfflineOperationPushResult,
} from '../src/sync/offline-operation.contract';
import { SyncCursorService } from '../src/sync/sync-cursor.service';
import {
  createInventoryTestDatabase,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';
import { readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const migrationFilename = '0028_offline_operation_recovery_authority.sql';
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
  clockState?: 'trusted' | 'clock_rollback_suspected';
}

interface PushResponse {
  results: OfflineOperationPushResult[];
}

interface PullResponse {
  changeFeedVersion: number;
  changes: {
    sequence: string;
    entityType: string;
    operationId: string | null;
    representationVersion: number;
    representation: Record<string, unknown>;
  }[];
  nextCursor: string;
  hasMore: boolean;
}

interface AccountingEffectVector {
  moneyMovements: number;
  moneyDelta: string;
  receivableEntries: number;
  receivableDelta: string;
  customerCreditDelta: string;
  payableEntries: number;
  payableDelta: string;
  supplierCreditDelta: string;
  inventoryMovements: number;
  inventoryQuantityDelta: string;
  inventoryValueDelta: string;
  supplierInvoices: number;
  supplierPayments: number;
  supplierReturns: number;
  sales: number;
  expenses: number;
  saleReturns: number;
  manualInventoryEntries: number;
  stockCounts: number;
  authoritativeChanges: number;
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
    REQUEST_ID_TRUST_INCOMING: process.env.REQUEST_ID_TRUST_INCOMING,
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
        clockState: input.clockState ?? 'trusted',
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

  async function recover(
    operation: Record<string, unknown>,
    requestId?: string,
  ): Promise<OfflineOperationPushResult> {
    const recoveryRequest = request(server)
      .post(`/v1/sync/operations/${String(operation.operationId)}/recover`)
      .set('authorization', `Bearer ${syncAuthentication.syncToken}`);
    if (requestId) recoveryRequest.set('x-request-id', requestId);
    const response = await recoveryRequest.send({ operation }).expect(200);
    return responseBody(response) as OfflineOperationPushResult;
  }

  async function operationStatus(
    operationId: string,
    provenanceHash?: string,
  ): Promise<Record<string, unknown>> {
    const response = await request(server)
      .get(`/v1/sync/operations/${operationId}`)
      .set('authorization', `Bearer ${syncAuthentication.syncToken}`)
      .query(provenanceHash ? { provenanceHash } : {})
      .expect(200);
    return responseBody(response) as Record<string, unknown>;
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

  async function accountingEffectVector(operationId: string): Promise<AccountingEffectVector> {
    const result = await db().admin.query<AccountingEffectVector>(
      `select
         (select count(*)::integer from ledger.money_movements
          where store_id = $1 and transaction_group_id = $3) as "moneyMovements",
         (select coalesce(sum(amount_delta_minor), 0)::text from ledger.money_movements
          where store_id = $1 and transaction_group_id = $3) as "moneyDelta",
         (select count(*)::integer from ledger.customer_ledger_entries
          where store_id = $1 and transaction_group_id = $3) as "receivableEntries",
         (select coalesce(sum(receivable_delta_minor), 0)::text
          from ledger.customer_ledger_entries
          where store_id = $1 and transaction_group_id = $3) as "receivableDelta",
         (select coalesce(sum(credit_delta_minor), 0)::text
          from ledger.customer_ledger_entries
          where store_id = $1 and transaction_group_id = $3) as "customerCreditDelta",
         (select count(*)::integer from ledger.supplier_ledger_entries
          where store_id = $1 and transaction_group_id = $3) as "payableEntries",
         (select coalesce(sum(payable_delta_minor), 0)::text
          from ledger.supplier_ledger_entries
          where store_id = $1 and transaction_group_id = $3) as "payableDelta",
         (select coalesce(sum(credit_delta_minor), 0)::text
          from ledger.supplier_ledger_entries
          where store_id = $1 and transaction_group_id = $3) as "supplierCreditDelta",
         (select count(*)::integer from ledger.inventory_movements
          where store_id = $1 and transaction_group_id = $3) as "inventoryMovements",
         (select coalesce(sum(quantity_delta_milli), 0)::text from ledger.inventory_movements
          where store_id = $1 and transaction_group_id = $3) as "inventoryQuantityDelta",
         (select coalesce(sum(value_delta_minor), 0)::text from ledger.inventory_movements
          where store_id = $1 and transaction_group_id = $3) as "inventoryValueDelta",
         (select count(*)::integer from ledger.purchase_invoices
          where store_id = $1 and operation_id = $2) as "supplierInvoices",
         (select count(*)::integer from ledger.supplier_payments
          where store_id = $1 and operation_id = $2) as "supplierPayments",
         (select count(*)::integer from ledger.supplier_returns
          where store_id = $1 and operation_id = $2) as "supplierReturns",
         (select count(*)::integer from ledger.sales
          where store_id = $1 and operation_id = $2) as sales,
         (select count(*)::integer from ledger.expenses
          where store_id = $1 and operation_id = $2) as expenses,
         (select count(*)::integer from ledger.sale_returns
          where store_id = $1 and operation_id = $2) as "saleReturns",
         (select count(*)::integer from ledger.manual_inventory_entries
          where store_id = $1 and operation_id = $2) as "manualInventoryEntries",
         (select count(*)::integer from ledger.stock_counts
          where store_id = $1 and operation_id = $2) as "stockCounts",
         (select count(*)::integer from sync.store_change_events_v1
          where store_id = $1 and operation_id = $2) as "authoritativeChanges"`,
      [fixture.storeId, operationId, deriveTransactionGroupId(operationId)],
    );
    const vector = result.rows[0];
    if (!vector) throw new Error('Accounting effect vector is unavailable.');
    return vector;
  }

  async function streamHead(): Promise<string> {
    const result = await db().admin.query<{ sequence: string }>(
      `select last_sequence::text as sequence
       from sync.store_change_watermarks_v1
       where store_id = $1`,
      [fixture.storeId],
    );
    const sequence = result.rows[0]?.sequence;
    if (sequence === undefined) throw new Error('S19 Store change watermark is unavailable.');
    return sequence;
  }

  function issueCursor(sequence: string): string {
    if (!app) throw new Error('S19 application is unavailable.');
    return app.get(SyncCursorService).issue(fixture.storeId, sequence);
  }

  async function pull(cursor: string, limit = 100): Promise<PullResponse> {
    const response = await request(server)
      .get('/v1/sync/pull')
      .set('authorization', `Bearer ${login.accessToken}`)
      .query({ cursor, limit })
      .expect(200);
    return responseBody(response) as PullResponse;
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
    process.env.REQUEST_ID_TRUST_INCOMING = 'true';

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
    const pendingChanges = await db().admin.query<{ count: number }>(
      `select count(*)::integer as count
       from sync.store_change_events_v1
       where store_id = $1 and operation_id = $2`,
      [fixture.storeId, invoiceOperationId],
    );
    expect(pendingChanges.rows[0]?.count).toBe(0);

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
    const appliedChangeCount = await db().admin.query<{ count: number }>(
      `select count(*)::integer as count
       from sync.store_change_events_v1
       where store_id = $1 and operation_id = $2`,
      [fixture.storeId, invoiceOperationId],
    );
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
    const unchangedChangeCount = await db().admin.query<{ count: number }>(
      `select count(*)::integer as count
       from sync.store_change_events_v1
       where store_id = $1 and operation_id = $2`,
      [fixture.storeId, invoiceOperationId],
    );
    expect(unchangedChangeCount.rows[0]?.count).toBe(appliedChangeCount.rows[0]?.count);
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

    const invoice = await db().admin.query<{ id: string; operationId: string }>(
      `select id, operation_id as "operationId" from ledger.purchase_invoices
       where store_id = $1 and invoice_number = 'S19-5-INV-1'`,
      [fixture.storeId],
    );
    const invoiceId = invoice.rows[0]?.id;
    const invoiceOperationId = invoice.rows[0]?.operationId;
    if (!invoiceId || !invoiceOperationId) {
      throw new Error('Supplier Invoice fixture was not applied.');
    }
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

    await expect(accountingEffectVector(invoiceOperationId)).resolves.toMatchObject({
      moneyMovements: 0,
      moneyDelta: '0',
      payableEntries: 1,
      payableDelta: '1000',
      inventoryMovements: 0,
      inventoryQuantityDelta: '0',
      supplierInvoices: 1,
      expenses: 0,
    });
    await expect(accountingEffectVector(ownerOperationId)).resolves.toMatchObject({
      moneyMovements: 1,
      moneyDelta: '5000',
      receivableDelta: '0',
      payableDelta: '0',
      inventoryQuantityDelta: '0',
    });
    await expect(accountingEffectVector(inventoryOperationId)).resolves.toMatchObject({
      moneyDelta: '0',
      receivableDelta: '0',
      payableDelta: '0',
      inventoryMovements: 1,
      inventoryQuantityDelta: '10000',
      inventoryValueDelta: '2000',
      manualInventoryEntries: 1,
    });
    await expect(accountingEffectVector(supplierPaymentOperationId)).resolves.toMatchObject({
      moneyMovements: 1,
      moneyDelta: '-600',
      payableEntries: 1,
      payableDelta: '-600',
      inventoryMovements: 0,
      supplierPayments: 1,
      expenses: 0,
    });
    await expect(accountingEffectVector(creditSaleOperationId)).resolves.toMatchObject({
      moneyMovements: 0,
      receivableEntries: 1,
      receivableDelta: '500',
      customerCreditDelta: '0',
      inventoryMovements: 1,
      inventoryQuantityDelta: '-1000',
      inventoryValueDelta: '-200',
      sales: 1,
      expenses: 0,
    });
    await expect(accountingEffectVector(collectionOperationId)).resolves.toMatchObject({
      moneyMovements: 1,
      moneyDelta: '500',
      receivableEntries: 1,
      receivableDelta: '-500',
      customerCreditDelta: '0',
      payableDelta: '0',
      inventoryMovements: 0,
      sales: 0,
      expenses: 0,
    });
    await expect(accountingEffectVector(expenseOperationId)).resolves.toMatchObject({
      moneyMovements: 0,
      moneyDelta: '0',
      receivableDelta: '0',
      payableDelta: '0',
      inventoryMovements: 0,
      expenses: 1,
    });
    await expect(accountingEffectVector(expensePaymentOperationId)).resolves.toMatchObject({
      moneyMovements: 1,
      moneyDelta: '-300',
      receivableDelta: '0',
      payableDelta: '0',
      inventoryMovements: 0,
      expenses: 0,
    });
    await expect(accountingEffectVector(supplierReturnOperationId)).resolves.toMatchObject({
      moneyMovements: 0,
      moneyDelta: '0',
      payableEntries: 1,
      payableDelta: '-100',
      supplierCreditDelta: '0',
      inventoryMovements: 0,
      supplierReturns: 1,
      expenses: 0,
    });
    await expect(accountingEffectVector(saleReturnOperationId)).resolves.toMatchObject({
      moneyMovements: 0,
      receivableDelta: '0',
      customerCreditDelta: '500',
      inventoryMovements: 1,
      inventoryQuantityDelta: '1000',
      inventoryValueDelta: '200',
      saleReturns: 1,
      expenses: 0,
    });
    await expect(accountingEffectVector(stockCountOperationId)).resolves.toMatchObject({
      moneyDelta: '0',
      receivableDelta: '0',
      payableDelta: '0',
      inventoryMovements: 1,
      inventoryQuantityDelta: '-500',
      inventoryValueDelta: '-100',
      stockCounts: 1,
    });

    const propagatedOperationIds = [
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
    ];
    const vectorsBeforeReplay = await Promise.all(
      propagatedOperationIds.map((operationId) => accountingEffectVector(operationId)),
    );
    const changeCountBeforeReplay = await db().admin.query<{ count: number }>(
      `select count(*)::integer as count from sync.store_change_events_v1
       where store_id = $1 and operation_id = any($2::uuid[])`,
      [fixture.storeId, propagatedOperationIds],
    );
    const foundationReplay = await push(foundations);
    expect(foundationReplay.results.map((item) => item.status)).toEqual([
      'EXACT_REPLAY',
      'EXACT_REPLAY',
      'EXACT_REPLAY',
      'EXACT_REPLAY',
    ]);
    expect(await countByTransactionGroup('money_movements', ownerOperationId)).toBe(1);
    expect((await push(financial)).results.map((item) => item.status)).toEqual([
      'EXACT_REPLAY',
      'EXACT_REPLAY',
      'EXACT_REPLAY',
    ]);
    expect((await push(settlement)).results.map((item) => item.status)).toEqual([
      'EXACT_REPLAY',
      'EXACT_REPLAY',
    ]);
    const returnReplay = await push(returnAndCount);
    expect(returnReplay.results.map((item) => item.status)).toEqual([
      'EXACT_REPLAY',
      'EXACT_REPLAY',
      'EXACT_REPLAY',
    ]);
    expect(await count('supplier_returns', supplierReturnOperationId)).toBe(1);
    expect(await count('sale_returns', saleReturnOperationId)).toBe(1);
    expect(await count('stock_counts', stockCountOperationId)).toBe(1);
    await expect(
      Promise.all(propagatedOperationIds.map((operationId) => accountingEffectVector(operationId))),
    ).resolves.toEqual(vectorsBeforeReplay);
    const changes = await db().admin.query<{ count: number }>(
      `select count(*)::integer as count from sync.store_change_events_v1
       where store_id = $1 and operation_id = any($2::uuid[])`,
      [fixture.storeId, propagatedOperationIds],
    );
    expect(changes.rows[0]?.count).toBe(changeCountBeforeReplay.rows[0]?.count);
    expect(changes.rows[0]?.count).toBeGreaterThan(0);
  });

  it('delivers online and offline mutations through one retry-safe ordered stream', async () => {
    const customerId = randomUUID();
    const onlineCreateOperationId = randomUUID();
    const offlineUpdateOperationId = randomUUID();
    const onlineUpdateOperationId = randomUUID();
    const baseline = await streamHead();

    await request(server)
      .post('/v1/customers')
      .set('authorization', `Bearer ${login.accessToken}`)
      .send({
        id: customerId,
        operationId: onlineCreateOperationId,
        name: 'S19.6 Unified Stream Customer',
        phone: '0599000031',
      })
      .expect(201);

    const offlineUpdate = envelope({
      operationId: offlineUpdateOperationId,
      operationType: 'customers.update.v1',
      aggregateId: customerId,
      expectedVersion: '1',
      payload: { notes: 'offline update' },
    });
    expect((await push([offlineUpdate])).results[0]?.status).toBe('APPLIED');

    await request(server)
      .patch(`/v1/customers/${customerId}`)
      .set('authorization', `Bearer ${login.accessToken}`)
      .send({
        operationId: onlineUpdateOperationId,
        expectedVersion: '2',
        name: 'S19.6 Unified Stream Customer Updated',
      })
      .expect(200);

    const cursor = issueCursor(baseline);
    const firstPage = await pull(cursor, 2);
    const retriedFirstPage = await pull(cursor, 2);
    expect(retriedFirstPage).toEqual(firstPage);
    expect(firstPage).toMatchObject({ changeFeedVersion: 1, hasMore: true });
    expect(firstPage.changes).toHaveLength(2);

    const secondPage = await pull(firstPage.nextCursor, 2);
    expect(secondPage).toMatchObject({ changeFeedVersion: 1, hasMore: false });
    expect(secondPage.changes).toHaveLength(1);
    const changes = [...firstPage.changes, ...secondPage.changes];
    expect(changes.map((change) => change.operationId)).toEqual([
      onlineCreateOperationId,
      offlineUpdateOperationId,
      onlineUpdateOperationId,
    ]);
    expect(changes.map((change) => change.sequence)).toEqual([
      (BigInt(baseline) + 1n).toString(),
      (BigInt(baseline) + 2n).toString(),
      (BigInt(baseline) + 3n).toString(),
    ]);
    expect(changes.every((change) => change.entityType === 'customer')).toBe(true);
    expect(changes.every((change) => change.representationVersion === 1)).toBe(true);
    expect(changes.map((change) => change.representation.version)).toEqual(['1', '2', '3']);

    const headBeforeReplay = await streamHead();
    expect((await push([offlineUpdate])).results[0]?.status).toBe('EXACT_REPLAY');
    expect(await streamHead()).toBe(headBeforeReplay);
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
    const falseChanges = await db().admin.query<{ count: number }>(
      `select count(*)::integer as count
       from sync.store_change_events_v1
       where store_id = $1 and operation_id = any($2::uuid[])`,
      [fixture.storeId, [pendingOperationId, rejectedOperationId]],
    );
    expect(falseChanges.rows[0]?.count).toBe(0);
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

  it('recovers a durable clock quarantine once and publishes one canonical change', async () => {
    const operationId = randomUUID();
    const customerId = randomUUID();
    const quarantined = envelope({
      operationId,
      operationType: 'customers.create.v1',
      aggregateId: customerId,
      payload: { name: 'Recovered Offline Customer', phone: '0599000077' },
      clockState: 'clock_rollback_suspected',
    });
    const streamBefore = await streamHead();

    expect((await push([quarantined])).results[0]).toMatchObject({
      status: 'QUARANTINED',
      code: 'OFFLINE_CLOCK_ROLLBACK_SUSPECTED',
    });
    expect(await count('customers', operationId)).toBe(0);
    await expect(operationStatus(operationId)).resolves.toMatchObject({
      operationId,
      status: 'QUARANTINED',
      recoveryEligible: true,
      recoveryAttemptCount: 0,
    });

    const firstRecoveryRequestId = randomUUID();
    await expect(recover(quarantined, firstRecoveryRequestId)).resolves.toMatchObject({
      operationId,
      status: 'APPLIED',
      code: null,
    });
    expect(await count('customers', operationId)).toBe(1);
    expect(BigInt(await streamHead()) - BigInt(streamBefore)).toBe(1n);
    await expect(recover(quarantined, firstRecoveryRequestId)).resolves.toMatchObject({
      operationId,
      status: 'EXACT_REPLAY',
      code: null,
    });
    expect(await count('customers', operationId)).toBe(1);
    expect(BigInt(await streamHead()) - BigInt(streamBefore)).toBe(1n);

    const concurrentReplay = await Promise.all([recover(quarantined), recover(quarantined)]);
    expect(concurrentReplay.map((result) => result.status)).toEqual([
      'EXACT_REPLAY',
      'EXACT_REPLAY',
    ]);
    expect(await count('customers', operationId)).toBe(1);
    expect(BigInt(await streamHead()) - BigInt(streamBefore)).toBe(1n);
    await expect(operationStatus(operationId)).resolves.toMatchObject({
      status: 'APPLIED',
      recoveryEligible: false,
      recoveryAttemptCount: 3,
    });
    await expect(
      operationStatus(operationId, parseOfflineOperationEnvelope(quarantined).provenanceHash),
    ).resolves.toMatchObject({ status: 'EXACT_REPLAY' });

    const changedRecovery = structuredClone(quarantined);
    (changedRecovery.payload as Record<string, unknown>).name = 'Changed Recovery Intent';
    await expect(recover(changedRecovery)).resolves.toMatchObject({
      status: 'CONFLICT',
      code: 'OFFLINE_OPERATION_ID_CONFLICT',
    });
    expect(await count('customers', operationId)).toBe(1);

    const lineage = await db().admin.query<{ events: number; attempts: number }>(
      `select count(*)::integer as events,
              count(distinct recovery_attempt_id)::integer as attempts
       from sync.offline_operation_recovery_events_v1
       where store_id = $1 and operation_id = $2`,
      [fixture.storeId, operationId],
    );
    expect(lineage.rows[0]).toEqual({ events: 6, attempts: 3 });
  });

  it('fails dependency cycles closed without executing either domain command', async () => {
    const firstOperationId = randomUUID();
    const secondOperationId = randomUUID();
    const first = envelope({
      operationId: firstOperationId,
      operationType: 'customers.create.v1',
      aggregateId: randomUUID(),
      payload: { name: 'Cycle A', phone: '0599000078' },
      dependencies: [secondOperationId],
    });
    const second = envelope({
      operationId: secondOperationId,
      operationType: 'customers.create.v1',
      aggregateId: randomUUID(),
      payload: { name: 'Cycle B', phone: '0599000079' },
      dependencies: [firstOperationId],
    });

    expect((await push([first])).results[0]?.status).toBe('DEPENDENCY_PENDING');
    expect((await push([second])).results[0]).toMatchObject({
      status: 'CONFLICT',
      code: 'OFFLINE_DEPENDENCY_CYCLE',
    });
    expect((await push([first])).results[0]?.status).toBe('CONFLICT');
    expect(await count('customers', firstOperationId)).toBe(0);
    expect(await count('customers', secondOperationId)).toBe(0);
  });

  it('serializes two first recovery attempts and re-evaluates dependency release', async () => {
    const concurrentOperationId = randomUUID();
    const concurrent = envelope({
      operationId: concurrentOperationId,
      operationType: 'customers.create.v1',
      aggregateId: randomUUID(),
      payload: { name: 'Concurrent Recovery', phone: '0599000082' },
      clockState: 'clock_rollback_suspected',
    });
    expect((await push([concurrent])).results[0]?.status).toBe('QUARANTINED');
    const concurrentResults = await Promise.all([recover(concurrent), recover(concurrent)]);
    expect(concurrentResults.map((result) => result.status).sort()).toEqual([
      'APPLIED',
      'EXACT_REPLAY',
    ]);
    expect(await count('customers', concurrentOperationId)).toBe(1);

    const prerequisiteOperationId = randomUUID();
    const dependentOperationId = randomUUID();
    const prerequisite = envelope({
      operationId: prerequisiteOperationId,
      operationType: 'customers.create.v1',
      aggregateId: randomUUID(),
      payload: { name: 'Recovered Prerequisite', phone: '0599000083' },
      clockState: 'clock_rollback_suspected',
    });
    const dependent = envelope({
      operationId: dependentOperationId,
      operationType: 'customers.create.v1',
      aggregateId: randomUUID(),
      payload: { name: 'Recovered Dependent', phone: '0599000084' },
      dependencies: [prerequisiteOperationId],
    });
    expect((await push([prerequisite])).results[0]?.status).toBe('QUARANTINED');
    expect((await push([dependent])).results[0]).toMatchObject({
      status: 'QUARANTINED',
      code: 'OFFLINE_DEPENDENCY_QUARANTINED',
    });
    await expect(recover(dependent)).resolves.toMatchObject({
      status: 'QUARANTINED',
      code: 'OFFLINE_DEPENDENCY_QUARANTINED',
    });
    expect((await recover(prerequisite)).status).toBe('APPLIED');
    expect((await recover(dependent)).status).toBe('APPLIED');
    expect(await count('customers', prerequisiteOperationId)).toBe(1);
    expect(await count('customers', dependentOperationId)).toBe(1);
  });

  it('revalidates expectedVersion and never overwrites a newer server version', async () => {
    const version = await db().admin.query<{ version: string }>(
      `select version::text as version from ledger.customers
       where store_id = $1 and id = $2`,
      [fixture.storeId, fixture.customerId],
    );
    const expectedVersion = version.rows[0]?.version;
    if (!expectedVersion) throw new Error('Customer version fixture is unavailable.');
    const recoveryOperationId = randomUUID();
    const quarantined = envelope({
      operationId: recoveryOperationId,
      operationType: 'customers.update.v1',
      aggregateId: fixture.customerId,
      expectedVersion,
      payload: { name: 'Must Not Win Recovery Race' },
      clockState: 'clock_rollback_suspected',
    });
    expect((await push([quarantined])).results[0]?.status).toBe('QUARANTINED');

    await request(server)
      .patch(`/v1/customers/${fixture.customerId}`)
      .set('authorization', `Bearer ${login.accessToken}`)
      .send({
        operationId: randomUUID(),
        expectedVersion,
        name: 'Authoritative Newer Customer',
      })
      .expect(200);

    await expect(recover(quarantined)).resolves.toMatchObject({ status: 'CONFLICT' });
    const customer = await db().admin.query<{ name: string; version: string }>(
      `select name, version::text as version from ledger.customers
       where store_id = $1 and id = $2`,
      [fixture.storeId, fixture.customerId],
    );
    expect(customer.rows[0]).toEqual({
      name: 'Authoritative Newer Customer',
      version: (BigInt(expectedVersion) + 1n).toString(),
    });
    expect(await count('customers', recoveryOperationId)).toBe(0);
  });

  it('recovers representative money, payable, and inventory effects exactly once', async () => {
    const moneyOperationId = randomUUID();
    const payableOperationId = randomUUID();
    const inventoryOperationId = randomUUID();
    const operations = [
      envelope({
        operationId: moneyOperationId,
        operationType: 'owner_contributions.post.v1',
        payload: { moneyAccountId: fixture.moneyAccountId, amountMinor: '23', occurredAt },
        clockState: 'clock_rollback_suspected',
      }),
      envelope({
        operationId: payableOperationId,
        operationType: 'supplier_invoices.post.v1',
        payload: {
          supplierId: fixture.supplierId,
          invoiceNumber: `S19-7-${payableOperationId}`,
          occurredAt,
          totalMinor: '41',
          items: [
            {
              description: 'Recovered payable only',
              unitName: 'unit',
              quantityMilli: '1000',
              unitCostMinor: '41',
              lineTotalMinor: '41',
            },
          ],
        },
        clockState: 'clock_rollback_suspected',
      }),
      envelope({
        operationId: inventoryOperationId,
        operationType: 'inventory.increase.post.v1',
        aggregateId: randomUUID(),
        payload: {
          productId: fixture.productId,
          productUnitId: fixture.productUnitId,
          selectedQuantityMilli: '1000',
          totalPurchaseCostMinor: '200',
          occurredAt,
        },
        clockState: 'clock_rollback_suspected',
      }),
    ];
    expect((await push(operations)).results.map((result) => result.status)).toEqual([
      'QUARANTINED',
      'QUARANTINED',
      'QUARANTINED',
    ]);
    expect(
      (await Promise.all(operations.map((operation) => recover(operation)))).map(
        (result) => result.status,
      ),
    ).toEqual(['APPLIED', 'APPLIED', 'APPLIED']);
    expect(await countByTransactionGroup('money_movements', moneyOperationId)).toBe(1);
    expect(await count('purchase_invoices', payableOperationId)).toBe(1);
    expect(await countByTransactionGroup('supplier_ledger_entries', payableOperationId)).toBe(1);
    expect(await countByTransactionGroup('inventory_movements', payableOperationId)).toBe(0);
    expect(await count('manual_inventory_entries', inventoryOperationId)).toBe(1);
    expect(await countByTransactionGroup('inventory_movements', inventoryOperationId)).toBe(1);

    expect(
      (await Promise.all(operations.map((operation) => recover(operation)))).map(
        (result) => result.status,
      ),
    ).toEqual(['EXACT_REPLAY', 'EXACT_REPLAY', 'EXACT_REPLAY']);
    expect(await countByTransactionGroup('money_movements', moneyOperationId)).toBe(1);
    expect(await countByTransactionGroup('supplier_ledger_entries', payableOperationId)).toBe(1);
    expect(await countByTransactionGroup('inventory_movements', inventoryOperationId)).toBe(1);
  });

  it('serializes recovery against normal push and fails unknown quarantine reasons closed', async () => {
    const operationId = randomUUID();
    const recoverable = envelope({
      operationId,
      operationType: 'owner_contributions.post.v1',
      payload: { moneyAccountId: fixture.moneyAccountId, amountMinor: '37', occurredAt },
      clockState: 'clock_rollback_suspected',
    });
    expect((await push([recoverable])).results[0]?.status).toBe('QUARANTINED');

    const raced = await Promise.all([recover(recoverable), push([recoverable])]);
    const statuses = [raced[0].status, raced[1].results[0]?.status];
    expect(statuses).toContain('APPLIED');
    expect(['EXACT_REPLAY', 'QUARANTINED']).toContain(
      statuses.find((value) => value !== 'APPLIED'),
    );
    await expect(accountingEffectVector(operationId)).resolves.toMatchObject({
      moneyMovements: 1,
      moneyDelta: '37',
      receivableDelta: '0',
      payableDelta: '0',
      inventoryQuantityDelta: '0',
    });

    const blockedOperationId = randomUUID();
    const blocked = envelope({
      operationId: blockedOperationId,
      operationType: 'customers.create.v1',
      aggregateId: randomUUID(),
      payload: { name: 'Permanent Quarantine', phone: '0599000081' },
      clockState: 'clock_rollback_suspected',
    });
    expect((await push([blocked])).results[0]?.status).toBe('QUARANTINED');
    await db().admin.query(
      `update sync.offline_operation_provenance_v1
       set reason_code = 'OFFLINE_UNKNOWN_QUARANTINE'
       where store_id = $1 and operation_id = $2`,
      [fixture.storeId, blockedOperationId],
    );
    await expect(recover(blocked)).resolves.toMatchObject({
      status: 'QUARANTINED',
      code: 'OFFLINE_RECOVERY_NOT_ALLOWED',
    });
    expect(await count('customers', blockedOperationId)).toBe(0);
  });

  it('preserves period authority and least-privilege Store isolation during recovery', async () => {
    const operationId = randomUUID();
    const quarantined = envelope({
      operationId,
      operationType: 'owner_contributions.post.v1',
      payload: { moneyAccountId: fixture.moneyAccountId, amountMinor: '19', occurredAt },
      clockState: 'clock_rollback_suspected',
    });
    expect((await push([quarantined])).results[0]?.status).toBe('QUARANTINED');

    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Hebron',
      year: 'numeric',
      month: 'numeric',
    }).formatToParts(new Date(occurredAt));
    const year = Number(parts.find((part) => part.type === 'year')?.value);
    const month = Number(parts.find((part) => part.type === 'month')?.value);
    const periodId = deriveAccountingPeriodId(fixture.storeId, year, month);
    await db().admin.query(
      `update ledger.accounting_periods set status = 'closed', closed_at = clock_timestamp()
       where store_id = $1 and id = $2`,
      [fixture.storeId, periodId],
    );
    try {
      const recovered = await recover(quarantined);
      expect(['CONFLICT', 'REJECTED']).toContain(recovered.status);
      expect(await countByTransactionGroup('money_movements', operationId)).toBe(0);
    } finally {
      await db().admin.query(
        `update ledger.accounting_periods set status = 'open', closed_at = null
         where store_id = $1 and id = $2`,
        [fixture.storeId, periodId],
      );
    }

    const privilegeState = await db().admin.query<{
      forcedRls: boolean;
      runtimeSelect: boolean;
      runtimeInsert: boolean;
      runtimeUpdate: boolean;
      runtimeDelete: boolean;
      publicStatusExecute: boolean;
      runtimeStatusExecute: boolean;
      runtimeLegacyBeginExecute: boolean;
    }>(
      `select
         (select relrowsecurity and relforcerowsecurity from pg_class
          where oid = 'sync.offline_operation_recovery_events_v1'::regclass) as "forcedRls",
         has_table_privilege('shop_app_runtime', 'sync.offline_operation_recovery_events_v1', 'SELECT') as "runtimeSelect",
         has_table_privilege('shop_app_runtime', 'sync.offline_operation_recovery_events_v1', 'INSERT') as "runtimeInsert",
         has_table_privilege('shop_app_runtime', 'sync.offline_operation_recovery_events_v1', 'UPDATE') as "runtimeUpdate",
         has_table_privilege('shop_app_runtime', 'sync.offline_operation_recovery_events_v1', 'DELETE') as "runtimeDelete",
         has_function_privilege('public', 'sync.read_offline_operation_status_v1(uuid,uuid,text)', 'EXECUTE') as "publicStatusExecute",
         has_function_privilege('shop_app_runtime', 'sync.read_offline_operation_status_v1(uuid,uuid,text)', 'EXECUTE') as "runtimeStatusExecute",
         has_function_privilege('shop_app_runtime', 'sync.begin_offline_operation_v1(uuid,uuid,uuid,text,bigint,text,uuid,uuid,bigint,timestamptz,timestamptz,timestamptz,text,text,timestamptz,uuid[])', 'EXECUTE') as "runtimeLegacyBeginExecute"`,
    );
    expect(privilegeState.rows[0]).toEqual({
      forcedRls: true,
      runtimeSelect: false,
      runtimeInsert: false,
      runtimeUpdate: false,
      runtimeDelete: false,
      publicStatusExecute: false,
      runtimeStatusExecute: true,
      runtimeLegacyBeginExecute: false,
    });

    const runtime = await db().runtime.connect();
    try {
      await runtime.query('begin');
      await runtime.query(
        `select set_config('app.store_id', $1, true),
                set_config('app.user_id', $2, true),
                set_config('app.device_id', $3, true),
                set_config('app.request_id', $4, true)`,
        [fixture.storeId, fixture.userId, fixture.deviceId, randomUUID()],
      );
      await expect(
        runtime.query(
          `select * from sync.read_offline_operation_status_v1($1::uuid, $2::uuid, null)`,
          [randomUUID(), operationId],
        ),
      ).rejects.toMatchObject({ code: '22023' });
      await runtime.query('rollback');
      await expect(
        runtime.query('select * from sync.offline_operation_recovery_events_v1'),
      ).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await runtime.query('rollback').catch(() => undefined);
      runtime.release();
    }

    const immutableAttempt = await db().admin.query<{ recoveryAttemptId: string }>(
      `select recovery_attempt_id as "recoveryAttemptId"
       from sync.offline_operation_recovery_events_v1
       where store_id = $1 and operation_id = $2
       order by recorded_at limit 1`,
      [fixture.storeId, operationId],
    );
    const recoveryAttemptId = immutableAttempt.rows[0]?.recoveryAttemptId;
    if (!recoveryAttemptId) throw new Error('Recovery lineage fixture is unavailable.');
    const migration = await db().migration.connect();
    try {
      await verifyMigrationSession(migration);
      await expect(
        migration.query(
          `update sync.offline_operation_recovery_events_v1
           set reason_code = 'MUTATION_MUST_FAIL'
           where store_id = $1 and recovery_attempt_id = $2`,
          [fixture.storeId, recoveryAttemptId],
        ),
      ).rejects.toMatchObject({ code: '55000' });
    } finally {
      await migration.query('reset role').catch(() => undefined);
      migration.release();
    }
  });
});
