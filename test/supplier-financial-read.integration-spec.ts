import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { Pool } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';

import { deriveAccountingPeriodId } from '../src/accounting-periods/accounting-period-identity';
import { resolveAccountingPeriodBoundaries } from '../src/accounting-periods/accounting-period-month';
import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import { DatabaseService } from '../src/database/database.service';
import type { TenantTransactionContext } from '../src/database/database.types';
import { SupplierFinancialReadRepository } from '../src/suppliers/supplier-financial-read.repository';
import type {
  SupplierFinancialResponse,
  SupplierInvoiceDetailResponse,
} from '../src/suppliers/supplier-financial-read.types';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const fixture = {
  stores: {
    a: '81200000-0000-4000-8000-000000000001',
    b: '81200000-0000-4000-8000-000000000002',
    readOnly: '81200000-0000-4000-8000-000000000003',
    manager: '81200000-0000-4000-8000-000000000004',
  },
  users: {
    ownerA: '81210000-0000-4000-8000-000000000001',
    ownerB: '81210000-0000-4000-8000-000000000002',
    readOnly: '81210000-0000-4000-8000-000000000003',
    manager: '81210000-0000-4000-8000-000000000004',
  },
  memberships: {
    ownerA: '81220000-0000-4000-8000-000000000001',
    ownerB: '81220000-0000-4000-8000-000000000002',
    readOnly: '81220000-0000-4000-8000-000000000003',
    manager: '81220000-0000-4000-8000-000000000004',
  },
  devices: {
    ownerA: '81230000-0000-4000-8000-000000000001',
    ownerB: '81230000-0000-4000-8000-000000000002',
    readOnly: '81230000-0000-4000-8000-000000000003',
    manager: '81230000-0000-4000-8000-000000000004',
  },
  emails: {
    ownerA: 's122-owner-a@example.test',
    ownerB: 's122-owner-b@example.test',
    readOnly: 's122-read-only@example.test',
    manager: 's122-manager@example.test',
  },
  password: 'S12.2-Focused-Test-Password!',
  suppliers: {
    primary: '81240000-0000-4000-8000-000000000001',
    archived: '81240000-0000-4000-8000-000000000002',
    foreign: '81240000-0000-4000-8000-000000000003',
    readOnly: '81240000-0000-4000-8000-000000000004',
  },
  invoices: {
    oldZero: '81250000-0000-4000-8000-000000000001',
    middle: '81250000-0000-4000-8000-000000000002',
    newestLow: '81250000-0000-4000-8000-000000000003',
    newestHigh: '81250000-0000-4000-8000-000000000004',
    archived: '81250000-0000-4000-8000-000000000005',
    foreign: '81250000-0000-4000-8000-000000000006',
    readOnly: '81250000-0000-4000-8000-000000000007',
  },
  products: {
    sugar: '81260000-0000-4000-8000-000000000001',
    ghee: '81260000-0000-4000-8000-000000000002',
    beans: '81260000-0000-4000-8000-000000000003',
  },
  units: {
    sugar: '81270000-0000-4000-8000-000000000001',
    ghee: '81270000-0000-4000-8000-000000000002',
    beans: '81270000-0000-4000-8000-000000000003',
  },
};

type AccessKey = keyof typeof fixture.emails;

interface AccessIdentity {
  accessToken: string;
  storeId: string;
  userId: string;
  deviceId: string;
}

interface ReadEffects {
  processedOperations: number;
  changeEvents: number;
  auditLogs: number;
  accountingPeriods: number;
  purchaseInvoices: number;
  purchaseItems: number;
  supplierLedgerEntries: number;
  goodsReceipts: number;
  goodsReceiptItems: number;
  inventoryMovements: number;
  stockBalances: number;
  moneyMovements: number;
  supplierPayments: number;
  supplierPaymentAllocations: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readAccessToken(response: Response): string {
  const body: unknown = response.body;
  if (!isRecord(body) || typeof body.accessToken !== 'string') {
    throw new Error('Expected an access token.');
  }
  return body.accessToken;
}

function readFinancial(response: Response): SupplierFinancialResponse {
  const body: unknown = response.body;
  if (!isRecord(body) || !Array.isArray(body.invoices)) {
    throw new Error('Expected a Supplier financial response.');
  }
  return body as unknown as SupplierFinancialResponse;
}

function readInvoice(response: Response): SupplierInvoiceDetailResponse {
  const body: unknown = response.body;
  if (!isRecord(body) || !isRecord(body.invoice) || !Array.isArray(body.items)) {
    throw new Error('Expected a Supplier Invoice response.');
  }
  return body as unknown as SupplierInvoiceDetailResponse;
}

function withoutTraceFields(body: unknown): unknown {
  if (!isRecord(body)) return body;
  const stable = { ...body };
  delete stable.requestId;
  delete stable.timestamp;
  delete stable.path;
  return stable;
}

class SynchronousLogCapture implements DestinationStream {
  private output = '';

  write(message: string): void {
    this.output += message;
  }

  clear(): void {
    this.output = '';
  }

  flush(): string {
    return this.output;
  }
}

describe('S12.2 Supplier financial reads with real PostgreSQL', () => {
  jest.setTimeout(90_000);

  const logCapture = new SynchronousLogCapture();
  const storeIds = Object.values(fixture.stores);
  const userIds = Object.values(fixture.users);
  const membershipIds = Object.values(fixture.memberships);
  const supplierIds = Object.values(fixture.suppliers);
  const invoiceIds = Object.values(fixture.invoices);
  const productIds = Object.values(fixture.products);
  const unitIds = Object.values(fixture.units);
  const periodIds = Object.values(fixture.stores).map((storeId) =>
    deriveAccountingPeriodId(storeId, 2026, 7),
  );

  let app: INestApplication | undefined;
  let server: Server;
  let adminPool: Pool;
  let runtimeInspectionPool: Pool;
  let poolsInitialized = false;
  let access: Record<AccessKey, AccessIdentity>;
  let effectsBeforeReads: ReadEffects;

  async function removeFixtures(): Promise<void> {
    await adminPool.query(`delete from platform.auth_sessions where user_id = any($1::uuid[])`, [
      userIds,
    ]);
    await adminPool.query(
      `delete from ledger.supplier_payment_allocations where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await adminPool.query(`delete from ledger.supplier_payments where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await adminPool.query(
      `delete from ledger.supplier_ledger_entries where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await adminPool.query(`delete from ledger.purchase_items where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await adminPool.query(`delete from ledger.purchase_invoices where id = any($1::uuid[])`, [
      invoiceIds,
    ]);
    await adminPool.query(`delete from ledger.accounting_periods where id = any($1::uuid[])`, [
      periodIds,
    ]);
    await adminPool.query(`delete from ledger.product_units where id = any($1::uuid[])`, [unitIds]);
    await adminPool.query(`delete from ledger.products where id = any($1::uuid[])`, [productIds]);
    await adminPool.query(
      `delete from sync.processed_operations where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await adminPool.query(`delete from sync.change_events where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await adminPool.query(`delete from audit.central_audit_logs where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await adminPool.query(`delete from ledger.suppliers where id = any($1::uuid[])`, [supplierIds]);
    await adminPool.query(`delete from ledger.devices where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await adminPool.query(`delete from platform.store_memberships where id = any($1::uuid[])`, [
      membershipIds,
    ]);
    await adminPool.query(`delete from platform.users where id = any($1::uuid[])`, [userIds]);
    await adminPool.query(`delete from ledger.stores where id = any($1::uuid[])`, [storeIds]);
  }

  async function insertInvoice(input: {
    id: string;
    storeId: string;
    supplierId: string;
    invoiceNumber: string;
    invoiceDateAt: string;
    dueAt?: string;
    totalMinor: string;
    status?: 'draft' | 'open' | 'closed';
    notes?: string;
  }): Promise<void> {
    const periodId = deriveAccountingPeriodId(input.storeId, 2026, 7);
    await adminPool.query(
      `insert into ledger.purchase_invoices(
         id, store_id, supplier_id, invoice_number, display_number,
         invoice_date_at, due_at, items_subtotal_minor, total_minor, status, notes,
         accounting_period_id, posting_date, operation_id
       ) values (
         $1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz,
         $8::bigint, $8::bigint, $9, $10,
         case when $9 = 'draft' then null else $11::uuid end,
         case when $9 = 'draft' then null else $6::timestamptz::date end,
         $12
       )`,
      [
        input.id,
        input.storeId,
        input.supplierId,
        input.invoiceNumber,
        `PI-${input.invoiceNumber}`,
        input.invoiceDateAt,
        input.dueAt ?? null,
        input.totalMinor,
        input.status ?? 'open',
        input.notes ?? null,
        periodId,
        randomUUID(),
      ],
    );
  }

  async function insertPayable(
    storeId: string,
    supplierId: string,
    invoiceId: string,
    amountMinor: string,
    entryType: 'supplier_invoice' | 'correction' = 'supplier_invoice',
  ): Promise<void> {
    await adminPool.query(
      `insert into ledger.supplier_ledger_entries(
         id, store_id, supplier_id, accounting_period_id, entry_type,
         payable_delta_minor, credit_delta_minor, source_purchase_invoice_id,
         reference_type, reference_id, transaction_group_id, occurred_at, operation_id
       ) values ($1, $2, $3, $4, $5, $6::bigint, 0, $7,
         $5, $7, $8, '2026-07-20T10:00:00Z', $9)`,
      [
        randomUUID(),
        storeId,
        supplierId,
        deriveAccountingPeriodId(storeId, 2026, 7),
        entryType,
        amountMinor,
        invoiceId,
        randomUUID(),
        randomUUID(),
      ],
    );
  }

  async function login(key: AccessKey, storeId: string): Promise<AccessIdentity> {
    const response = await request(server)
      .post('/v1/auth/login')
      .send({
        email: fixture.emails[key],
        password: fixture.password,
        storeId,
        deviceId: fixture.devices[key],
        deviceName: `S12.2 ${key} device`,
        devicePlatform: 'android',
      })
      .expect(200);
    return {
      accessToken: readAccessToken(response),
      storeId,
      userId: fixture.users[key],
      deviceId: fixture.devices[key],
    };
  }

  function authorizedGet(identity: AccessIdentity, path: string) {
    return request(server).get(path).set('authorization', `Bearer ${identity.accessToken}`);
  }

  async function readEffects(): Promise<ReadEffects> {
    const result = await adminPool.query<ReadEffects>(
      `select
         (select count(*)::integer from sync.processed_operations
           where store_id = any($1::uuid[])) as "processedOperations",
         (select count(*)::integer from sync.change_events
           where store_id = any($1::uuid[])) as "changeEvents",
         (select count(*)::integer from audit.central_audit_logs
           where store_id = any($1::uuid[])) as "auditLogs",
         (select count(*)::integer from ledger.accounting_periods
           where store_id = any($1::uuid[])) as "accountingPeriods",
         (select count(*)::integer from ledger.purchase_invoices
           where store_id = any($1::uuid[])) as "purchaseInvoices",
         (select count(*)::integer from ledger.purchase_items
           where store_id = any($1::uuid[])) as "purchaseItems",
         (select count(*)::integer from ledger.supplier_ledger_entries
           where store_id = any($1::uuid[])) as "supplierLedgerEntries",
         (select count(*)::integer from ledger.goods_receipts
           where store_id = any($1::uuid[])) as "goodsReceipts",
         (select count(*)::integer from ledger.goods_receipt_items
           where store_id = any($1::uuid[])) as "goodsReceiptItems",
         (select count(*)::integer from ledger.inventory_movements
           where store_id = any($1::uuid[])) as "inventoryMovements",
         (select count(*)::integer from ledger.stock_balances
           where store_id = any($1::uuid[])) as "stockBalances",
         (select count(*)::integer from ledger.money_movements
           where store_id = any($1::uuid[])) as "moneyMovements",
         (select count(*)::integer from ledger.supplier_payments
           where store_id = any($1::uuid[])) as "supplierPayments",
         (select count(*)::integer from ledger.supplier_payment_allocations
           where store_id = any($1::uuid[])) as "supplierPaymentAllocations"`,
      [storeIds],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Expected S12.2 read effect counts.');
    return row;
  }

  beforeAll(async () => {
    if (!environment) {
      throw new Error('The approved local PostgreSQL test environment is unavailable.');
    }
    process.env.APP_ENV = 'test';
    process.env.LOG_LEVEL = 'info';
    process.env.DATABASE_URL = environment.runtimeUrl;
    process.env.AUTH_DATABASE_URL = environment.authUrl;

    adminPool = createTestPool(
      environment.adminUrl,
      'dokana-s122-admin',
      1,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    runtimeInspectionPool = createTestPool(
      environment.runtimeUrl,
      'dokana-s122-runtime-inspection',
      1,
    );
    poolsInitialized = true;

    const approved = await adminPool.query<{ databaseName: string; isSuperuser: boolean }>(`
      select current_database() as "databaseName", r.rolsuper as "isSuperuser"
      from pg_roles r where r.rolname = current_user
    `);
    if (
      approved.rows[0]?.databaseName !== environment.databaseName ||
      !approved.rows[0].isSuperuser
    ) {
      throw new Error('The local S12.2 fixture database is not approved.');
    }

    await removeFixtures();
    const passwordHash = await new PasswordService().hash(fixture.password);
    await adminPool.query(
      `insert into ledger.stores(id, name, status) values
         ($1, 'S12.2 Store A', 'active'),
         ($2, 'S12.2 Store B', 'active'),
         ($3, 'S12.2 Read Only', 'read_only'),
         ($4, 'S12.2 Manager', 'active')`,
      storeIds,
    );
    await adminPool.query(
      `insert into platform.users(id, email, normalized_email, password_hash, full_name, status)
       values
         ($1, $2, $2, $9, 'S12.2 Owner A', 'active'),
         ($3, $4, $4, $9, 'S12.2 Owner B', 'active'),
         ($5, $6, $6, $9, 'S12.2 Read Only Owner', 'active'),
         ($7, $8, $8, $9, 'S12.2 Manager', 'active')`,
      [
        fixture.users.ownerA,
        fixture.emails.ownerA,
        fixture.users.ownerB,
        fixture.emails.ownerB,
        fixture.users.readOnly,
        fixture.emails.readOnly,
        fixture.users.manager,
        fixture.emails.manager,
        passwordHash,
      ],
    );
    await adminPool.query(
      `insert into platform.store_memberships(id, store_id, user_id, role, status) values
         ($1, $2, $3, 'owner', 'active'),
         ($4, $5, $6, 'owner', 'active'),
         ($7, $8, $9, 'owner', 'active'),
         ($10, $11, $12, 'manager', 'active')`,
      [
        fixture.memberships.ownerA,
        fixture.stores.a,
        fixture.users.ownerA,
        fixture.memberships.ownerB,
        fixture.stores.b,
        fixture.users.ownerB,
        fixture.memberships.readOnly,
        fixture.stores.readOnly,
        fixture.users.readOnly,
        fixture.memberships.manager,
        fixture.stores.manager,
        fixture.users.manager,
      ],
    );
    await adminPool.query(
      `insert into ledger.suppliers(
         id, store_id, name, normalized_name, phone, normalized_phone,
         status, archived_at, operation_id
       ) values
         ($1, $2, 'Supplier A', 'supplier a', '+970 599 000 001', '+970599000001',
          'active', null, $8),
         ($3, $2, 'Archived Supplier', 'archived supplier', null, null,
          'archived', '2026-08-01T00:00:00Z', $9),
         ($4, $5, 'Foreign Supplier', 'foreign supplier', null, null,
          'active', null, $10),
         ($6, $7, 'Read Only Supplier', 'read only supplier', null, null,
          'active', null, $11)`,
      [
        fixture.suppliers.primary,
        fixture.stores.a,
        fixture.suppliers.archived,
        fixture.suppliers.foreign,
        fixture.stores.b,
        fixture.suppliers.readOnly,
        fixture.stores.readOnly,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ],
    );

    const boundaries = resolveAccountingPeriodBoundaries(2026, 7);
    for (const [index, storeId] of storeIds.entries()) {
      await adminPool.query(
        `insert into ledger.accounting_periods(
           id, store_id, period_year, period_month, starts_at, ends_at, status, operation_id
         ) values ($1, $2, 2026, 7, $3, $4, 'open', $5)`,
        [periodIds[index], storeId, boundaries.startsAt, boundaries.endsAt, randomUUID()],
      );
    }
    for (const [index, productId] of productIds.entries()) {
      const unitId = unitIds[index];
      if (!unitId) throw new Error('Missing S12.2 Product Unit fixture ID.');
      await adminPool.query(
        `insert into ledger.products(
           id, store_id, name, normalized_name, measurement_type, operation_id
         ) values ($1, $2, $3, $4, 'count', $5)`,
        [productId, fixture.stores.a, ['Sugar', 'Ghee', 'Beans'][index], productId, randomUUID()],
      );
      await adminPool.query(
        `insert into ledger.product_units(
           id, store_id, product_id, measurement_type, unit_name, is_base,
           factor_num, factor_den, purchase_price_minor, operation_id
         ) values ($1, $2, $3, 'count', 'piece', true, 1, 1, 100, $4)`,
        [unitId, fixture.stores.a, productId, randomUUID()],
      );
    }

    await insertInvoice({
      id: fixture.invoices.oldZero,
      storeId: fixture.stores.a,
      supplierId: fixture.suppliers.primary,
      invoiceNumber: 'EXT-001',
      invoiceDateAt: '2026-07-03T10:00:00Z',
      totalMinor: '0',
      status: 'draft',
    });
    await insertInvoice({
      id: fixture.invoices.middle,
      storeId: fixture.stores.a,
      supplierId: fixture.suppliers.primary,
      invoiceNumber: 'EXT-002',
      invoiceDateAt: '2026-07-10T10:00:00Z',
      dueAt: '2026-08-10T10:00:00Z',
      totalMinor: '700',
      status: 'closed',
    });
    await insertInvoice({
      id: fixture.invoices.newestLow,
      storeId: fixture.stores.a,
      supplierId: fixture.suppliers.primary,
      invoiceNumber: 'EXT-003',
      invoiceDateAt: '2026-07-20T10:00:00Z',
      dueAt: '2026-08-20T10:00:00Z',
      totalMinor: '300',
      notes: 'S12.2 private invoice note',
    });
    await insertInvoice({
      id: fixture.invoices.newestHigh,
      storeId: fixture.stores.a,
      supplierId: fixture.suppliers.primary,
      invoiceNumber: 'EXT-004',
      invoiceDateAt: '2026-07-20T10:00:00Z',
      totalMinor: '9007199254740993',
    });
    await insertInvoice({
      id: fixture.invoices.archived,
      storeId: fixture.stores.a,
      supplierId: fixture.suppliers.archived,
      invoiceNumber: 'EXT-005',
      invoiceDateAt: '2026-07-15T10:00:00Z',
      totalMinor: '111',
    });
    await insertInvoice({
      id: fixture.invoices.foreign,
      storeId: fixture.stores.b,
      supplierId: fixture.suppliers.foreign,
      invoiceNumber: 'EXT-006',
      invoiceDateAt: '2026-07-15T10:00:00Z',
      totalMinor: '222',
    });
    await insertInvoice({
      id: fixture.invoices.readOnly,
      storeId: fixture.stores.readOnly,
      supplierId: fixture.suppliers.readOnly,
      invoiceNumber: 'EXT-007',
      invoiceDateAt: '2026-07-15T10:00:00Z',
      totalMinor: '333',
    });

    const itemNames = ['Sugar', 'Ghee', 'Beans'];
    for (const [index, itemName] of itemNames.entries()) {
      await adminPool.query(
        `insert into ledger.purchase_items(
           id, store_id, purchase_invoice_id, product_id, product_unit_id,
           product_name_snapshot, unit_name_snapshot, quantity_milli,
           conversion_factor_num, conversion_factor_den, base_quantity_milli,
           unit_cost_minor, line_gross_minor, line_discount_minor, rounding_minor,
           line_total_minor, created_at
         ) values ($1, $2, $3, $4, $5, $6, 'piece', 1000,
           1, 1, 1000, 100, 100, 0, 0, 100, $7::timestamptz)`,
        [
          `81280000-0000-4000-8000-00000000000${(index + 1).toString()}`,
          fixture.stores.a,
          fixture.invoices.newestLow,
          productIds[index],
          unitIds[index],
          itemName,
          `2026-07-20T10:00:0${(index + 1).toString()}Z`,
        ],
      );
    }

    await insertPayable(
      fixture.stores.a,
      fixture.suppliers.primary,
      fixture.invoices.middle,
      '700',
    );
    await insertPayable(
      fixture.stores.a,
      fixture.suppliers.primary,
      fixture.invoices.middle,
      '-500',
      'correction',
    );
    await insertPayable(
      fixture.stores.a,
      fixture.suppliers.primary,
      fixture.invoices.newestLow,
      '300',
    );
    await insertPayable(
      fixture.stores.a,
      fixture.suppliers.primary,
      fixture.invoices.newestHigh,
      '9007199254740993',
    );
    await insertPayable(
      fixture.stores.a,
      fixture.suppliers.archived,
      fixture.invoices.archived,
      '111',
    );
    await insertPayable(
      fixture.stores.b,
      fixture.suppliers.foreign,
      fixture.invoices.foreign,
      '222',
    );
    await insertPayable(
      fixture.stores.readOnly,
      fixture.suppliers.readOnly,
      fixture.invoices.readOnly,
      '333',
    );

    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PARAMS_PROVIDER_TOKEN)
      .useFactory({
        factory: (config: AppConfigService) => createLoggingParams(config, logCapture),
        inject: [AppConfigService],
      })
      .compile();
    const nestApp = module.createNestApplication<NestExpressApplication>({ bodyParser: false });
    nestApp.useLogger(nestApp.get(Logger));
    configureApplication(nestApp, nestApp.get(AppConfigService));
    await nestApp.init();
    app = nestApp;
    server = nestApp.getHttpServer();

    access = {
      ownerA: await login('ownerA', fixture.stores.a),
      ownerB: await login('ownerB', fixture.stores.b),
      readOnly: await login('readOnly', fixture.stores.readOnly),
      manager: await login('manager', fixture.stores.manager),
    };
    effectsBeforeReads = await readEffects();
  });

  beforeEach(() => {
    logCapture.clear();
  });

  afterAll(async () => {
    await app?.close();
    if (!poolsInitialized) return;
    await removeFixtures();
    const residue = await adminPool.query<{ count: number }>(
      `select (
         (select count(*) from ledger.stores where id = any($1::uuid[])) +
         (select count(*) from platform.users where id = any($2::uuid[])) +
         (select count(*) from platform.store_memberships where id = any($3::uuid[])) +
         (select count(*) from ledger.devices where store_id = any($1::uuid[])) +
         (select count(*) from ledger.suppliers where id = any($4::uuid[])) +
         (select count(*) from ledger.purchase_invoices where id = any($5::uuid[])) +
         (select count(*) from ledger.products where id = any($6::uuid[])) +
         (select count(*) from ledger.product_units where id = any($7::uuid[])) +
         (select count(*) from ledger.accounting_periods where id = any($8::uuid[])) +
         (select count(*) from sync.processed_operations where store_id = any($1::uuid[])) +
         (select count(*) from sync.change_events where store_id = any($1::uuid[])) +
         (select count(*) from audit.central_audit_logs where store_id = any($1::uuid[]))
       )::integer as count`,
      [storeIds, userIds, membershipIds, supplierIds, invoiceIds, productIds, unitIds, periodIds],
    );
    expect(residue.rows[0]?.count).toBe(0);
    const idleTransactions = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count from pg_stat_activity
       where datname = current_database()
         and application_name like 'dokana-s122-%'
         and state = 'idle in transaction'
         and pid <> pg_backend_pid()`,
    );
    expect(idleTransactions.rows[0]?.count).toBe(0);
    await Promise.all([runtimeInspectionPool.end(), adminPool.end()]);
  });

  it('requires an owner and permits owner reads in a read-only Store', async () => {
    await request(server).get(`/v1/suppliers/${fixture.suppliers.primary}/invoices`).expect(401);
    await authorizedGet(access.manager, `/v1/suppliers/${fixture.suppliers.primary}/invoices`)
      .expect(403)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'SUPPLIER_READ_NOT_ALLOWED' }));

    const readOnly = readFinancial(
      await authorizedGet(
        access.readOnly,
        `/v1/suppliers/${fixture.suppliers.readOnly}/invoices`,
      ).expect(200),
    );
    expect(readOnly.totalOutstandingMinor).toBe('333');
    expect(readOnly.invoices.map((invoice) => invoice.id)).toEqual([fixture.invoices.readOnly]);
  });

  it('returns the Supplier financial view with exact authoritative balances and stable pages', async () => {
    const first = readFinancial(
      await authorizedGet(access.ownerA, `/v1/suppliers/${fixture.suppliers.primary}/invoices`)
        .query({ limit: 2 })
        .expect(200),
    );
    expect(first.supplier).toMatchObject({
      id: fixture.suppliers.primary,
      name: 'Supplier A',
      phone: '+970 599 000 001',
      status: 'active',
    });
    expect(first.totalOutstandingMinor).toBe('9007199254741493');
    expect(first.invoices.map((invoice) => invoice.id)).toEqual([
      fixture.invoices.newestHigh,
      fixture.invoices.newestLow,
    ]);
    expect(first.invoices[0]).toMatchObject({
      invoiceNumber: 'EXT-004',
      invoiceDateAt: '2026-07-20T10:00:00.000Z',
      postingDate: '2026-07-20',
      status: 'open',
      totalMinor: '9007199254740993',
      outstandingMinor: '9007199254740993',
      paidAmountMinor: null,
    });
    expect(first.nextCursor).not.toBeNull();

    const second = readFinancial(
      await authorizedGet(access.ownerA, `/v1/suppliers/${fixture.suppliers.primary}/invoices`)
        .query({ limit: 2, cursor: first.nextCursor })
        .expect(200),
    );
    expect(second.invoices.map((invoice) => invoice.id)).toEqual([
      fixture.invoices.middle,
      fixture.invoices.oldZero,
    ]);
    expect(second.invoices[0]).toMatchObject({
      dueAt: '2026-08-10T10:00:00.000Z',
      totalMinor: '700',
      outstandingMinor: '200',
      paidAmountMinor: null,
    });
    expect(second.invoices[1]).toMatchObject({
      status: 'draft',
      totalMinor: '0',
      outstandingMinor: '0',
      paidAmountMinor: null,
      accountingPeriodId: null,
      postingDate: null,
    });
    expect(second.nextCursor).toBeNull();
    expect([...first.invoices, ...second.invoices].map((invoice) => invoice.id)).toHaveLength(4);

    await authorizedGet(access.ownerA, `/v1/suppliers/${fixture.suppliers.archived}/invoices`)
      .query({ cursor: first.nextCursor })
      .expect(400);
  });

  it('returns exact financial invoice lines without implying inventory receipt', async () => {
    const detail = readInvoice(
      await authorizedGet(
        access.ownerA,
        `/v1/suppliers/${fixture.suppliers.primary}/invoices/${fixture.invoices.newestLow}`,
      ).expect(200),
    );
    expect(detail.supplier).toMatchObject({ id: fixture.suppliers.primary, name: 'Supplier A' });
    expect(detail.invoice).toMatchObject({
      id: fixture.invoices.newestLow,
      invoiceNumber: 'EXT-003',
      invoiceDateAt: '2026-07-20T10:00:00.000Z',
      dueAt: '2026-08-20T10:00:00.000Z',
      postingDate: '2026-07-20',
      totalMinor: '300',
      outstandingMinor: '300',
      paidAmountMinor: null,
      itemsSubtotalMinor: '300',
      lineDiscountTotalMinor: '0',
      invoiceDiscountMinor: '0',
      roundingMinor: '0',
      notes: 'S12.2 private invoice note',
    });
    expect(detail.items.map((item) => item.productName)).toEqual(['Sugar', 'Ghee', 'Beans']);
    expect(detail.items[0]).toMatchObject({
      unitName: 'piece',
      quantityMilli: '1000',
      conversionFactorNumerator: 1,
      conversionFactorDenominator: 1,
      baseQuantityMilli: '1000',
      unitCostMinor: '100',
      lineGrossMinor: '100',
      lineDiscountMinor: '0',
      roundingMinor: '0',
      lineTotalMinor: '100',
    });
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toMatch(/inventory|stock|goodsReceipt/i);
    expect(logCapture.flush()).not.toContain('S12.2 private invoice note');

    const archived = readInvoice(
      await authorizedGet(
        access.ownerA,
        `/v1/suppliers/${fixture.suppliers.archived}/invoices/${fixture.invoices.archived}`,
      ).expect(200),
    );
    expect(archived.supplier.status).toBe('archived');
    expect(archived.invoice.outstandingMinor).toBe('111');
  });

  it('fails closed and does not distinguish foreign Supplier or invoice existence', async () => {
    const absentSupplier = await authorizedGet(
      access.ownerA,
      `/v1/suppliers/${randomUUID()}/invoices`,
    ).expect(404);
    const foreignSupplier = await authorizedGet(
      access.ownerA,
      `/v1/suppliers/${fixture.suppliers.foreign}/invoices`,
    ).expect(404);
    expect(withoutTraceFields(foreignSupplier.body)).toEqual(
      withoutTraceFields(absentSupplier.body),
    );

    const absentInvoice = await authorizedGet(
      access.ownerA,
      `/v1/suppliers/${fixture.suppliers.primary}/invoices/${randomUUID()}`,
    ).expect(404);
    const foreignInvoice = await authorizedGet(
      access.ownerA,
      `/v1/suppliers/${fixture.suppliers.primary}/invoices/${fixture.invoices.foreign}`,
    ).expect(404);
    const wrongSupplier = await authorizedGet(
      access.ownerA,
      `/v1/suppliers/${fixture.suppliers.primary}/invoices/${fixture.invoices.archived}`,
    ).expect(404);
    expect(withoutTraceFields(foreignInvoice.body)).toEqual(withoutTraceFields(absentInvoice.body));
    expect(withoutTraceFields(wrongSupplier.body)).toEqual(withoutTraceFields(absentInvoice.body));
  });

  it('uses forced least-privileged RLS and fails closed without tenant context', async () => {
    if (!app || !environment) throw new Error('The S12.2 application is unavailable.');
    const roleState = await runtimeInspectionPool.query<{
      isSuperuser: boolean;
      bypassesRls: boolean;
      ownsProtectedTables: boolean;
      allRlsEnabled: boolean;
      allRlsForced: boolean;
    }>(`
      select
        r.rolsuper as "isSuperuser",
        r.rolbypassrls as "bypassesRls",
        bool_or(c.relowner = r.oid) as "ownsProtectedTables",
        bool_and(c.relrowsecurity) as "allRlsEnabled",
        bool_and(c.relforcerowsecurity) as "allRlsForced"
      from pg_roles r
      cross join pg_class c
      where r.rolname = current_user
        and c.oid = any(array[
          'ledger.suppliers'::regclass,
          'ledger.purchase_invoices'::regclass,
          'ledger.purchase_items'::regclass,
          'ledger.supplier_ledger_entries'::regclass
        ])
      group by r.rolsuper, r.rolbypassrls
    `);
    expect(roleState.rows[0]).toEqual({
      isSuperuser: false,
      bypassesRls: false,
      ownsProtectedTables: false,
      allRlsEnabled: true,
      allRlsForced: true,
    });
    const noContext = await runtimeInspectionPool.query<{
      invoices: number;
      items: number;
      ledgerEntries: number;
      invoiceBalances: number;
      supplierBalances: number;
    }>(`
      select
        (select count(*)::integer from ledger.purchase_invoices) as invoices,
        (select count(*)::integer from ledger.purchase_items) as items,
        (select count(*)::integer from ledger.supplier_ledger_entries) as "ledgerEntries",
        (select count(*)::integer from ledger.v_supplier_invoice_outstanding) as "invoiceBalances",
        (select count(*)::integer from ledger.v_supplier_balances) as "supplierBalances"
    `);
    expect(noContext.rows[0]).toEqual({
      invoices: 0,
      items: 0,
      ledgerEntries: 0,
      invoiceBalances: 0,
      supplierBalances: 0,
    });

    const database = app.get(DatabaseService);
    const contextA: TenantTransactionContext = {
      storeId: access.ownerA.storeId,
      userId: access.ownerA.userId,
      deviceId: access.ownerA.deviceId,
      requestId: randomUUID(),
    };
    const contextB: TenantTransactionContext = {
      storeId: access.ownerB.storeId,
      userId: access.ownerB.userId,
      deviceId: access.ownerB.deviceId,
      requestId: randomUUID(),
    };
    const visible = (context: TenantTransactionContext) =>
      database.withTenantTransaction(context, async (transaction) => {
        const result = await transaction.execute<{ id: string } & Record<string, unknown>>(sql`
          select id from ledger.purchase_invoices order by id
        `);
        return result.rows.map((row) => row.id);
      });
    const [visibleA, visibleB] = await Promise.all([visible(contextA), visible(contextB)]);
    expect(visibleA).toEqual([
      fixture.invoices.oldZero,
      fixture.invoices.middle,
      fixture.invoices.newestLow,
      fixture.invoices.newestHigh,
      fixture.invoices.archived,
    ]);
    expect(visibleB).toEqual([fixture.invoices.foreign]);

    const repository = app.get(SupplierFinancialReadRepository);
    await expect(
      repository.readSupplierFinancialPage(
        undefined as unknown as TenantTransactionContext,
        fixture.suppliers.primary,
        { anchor: null, limit: 1 },
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('creates no business, period, inventory, receipt, money, payment, audit, or sync writes', async () => {
    expect(await readEffects()).toEqual(effectsBeforeReads);
  });
});
