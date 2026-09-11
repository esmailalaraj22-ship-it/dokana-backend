import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { Pool } from 'pg';
import request from 'supertest';

import { deriveAccountingPeriodId } from '../src/accounting-periods/accounting-period-identity';
import { resolveAccountingPeriodBoundaries } from '../src/accounting-periods/accounting-period-month';
import { AUTH_DATABASE_POOL } from '../src/auth/auth.constants';
import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import { DATABASE_POOL } from '../src/database/database.constants';
import type {
  SupplierFinancialResponse,
  SupplierInvoiceDetailResponse,
} from '../src/suppliers/supplier-financial-read.types';
import type {
  SupplierInvoicePostingResponse,
  SupplierOpeningPayableResponse,
} from '../src/suppliers/supplier-invoice-posting.types';
import { applyMigration, verifyMigrationSession } from '../scripts/migrate';
import {
  createInventoryTestDatabase,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const migrationFilename = '0011_supplier_opening_payable_allocations.sql';
const invoiceInstant = '2026-07-15T10:00:00Z';

interface TestIdentity {
  storeId: string;
  userId: string;
  deviceId: string;
  email: string;
  role: 'owner' | 'manager';
  status: 'active' | 'read_only';
  token: string;
}

interface SupplierPostingFacts {
  invoices: number;
  items: number;
  supplierEntries: number;
  goodsReceipts: number;
  goodsReceiptItems: number;
  manualInventoryEntries: number;
  inventoryMovements: number;
  stockBalances: number;
  moneyMovements: number;
  supplierPayments: number;
  supplierAllocations: number;
}

const identities: TestIdentity[] = [
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s123-owner-a-${randomUUID()}@example.test`,
    role: 'owner',
    status: 'active',
    token: '',
  },
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s123-owner-b-${randomUUID()}@example.test`,
    role: 'owner',
    status: 'active',
    token: '',
  },
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s123-manager-${randomUUID()}@example.test`,
    role: 'manager',
    status: 'active',
    token: '',
  },
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s123-read-only-${randomUUID()}@example.test`,
    role: 'owner',
    status: 'read_only',
    token: '',
  },
];

const ownerA = identities[0];
const ownerB = identities[1];
const manager = identities[2];
const readOnlyOwner = identities[3];
if (!ownerA || !ownerB || !manager || !readOnlyOwner) {
  throw new Error('Missing S12.3 test identities.');
}

describe('S12.3 Supplier Invoice and opening payable posting on isolated PostgreSQL', () => {
  jest.setTimeout(120_000);

  let database: InventoryTestDatabase | undefined;
  let app: NestExpressApplication | undefined;
  let server: Server;
  let runtimePool: Pool | undefined;
  let authPool: Pool | undefined;

  const suppliers = {
    primary: randomUUID(),
    linked: randomUUID(),
    opening: randomUUID(),
    huge: randomUUID(),
    concurrent: randomUUID(),
    closed: randomUUID(),
    foreign: randomUUID(),
    readOnly: randomUUID(),
  };
  const products = { local: randomUUID(), foreign: randomUUID() };
  const units = { local: randomUUID(), foreign: randomUUID() };

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('Isolated S12.3 database is unavailable.');
    return database;
  }

  function postInvoice(identity: TestIdentity, supplierId: string, body: Record<string, unknown>) {
    return request(server)
      .post(`/v1/suppliers/${supplierId}/invoices`)
      .set('authorization', `Bearer ${identity.token}`)
      .send(body);
  }

  function postOpening(identity: TestIdentity, supplierId: string, body: Record<string, unknown>) {
    return request(server)
      .post(`/v1/suppliers/${supplierId}/opening-payables`)
      .set('authorization', `Bearer ${identity.token}`)
      .send(body);
  }

  function invoiceBody(
    operationId = randomUUID(),
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      operationId,
      invoiceNumber: `EXT-${operationId.slice(0, 8)}`,
      occurredAt: invoiceInstant,
      items: [
        {
          description: 'Plain text item',
          unitName: 'piece',
          quantityMilli: '1500',
          unitCostMinor: '101',
          lineDiscountMinor: '2',
          lineTotalMinor: '150',
        },
        {
          description: 'Second plain item',
          unitName: 'box',
          quantityMilli: '2500',
          unitCostMinor: '200',
          lineTotalMinor: '500',
        },
      ],
      invoiceDiscountMinor: '10',
      roundingMinor: '-1',
      totalMinor: '639',
      ...overrides,
    };
  }

  async function facts(storeId: string): Promise<SupplierPostingFacts> {
    const result = await db().admin.query<SupplierPostingFacts>(
      `select
        (select count(*)::integer from ledger.purchase_invoices where store_id=$1) as invoices,
        (select count(*)::integer from ledger.purchase_items where store_id=$1) as items,
        (select count(*)::integer from ledger.supplier_ledger_entries where store_id=$1) as "supplierEntries",
        (select count(*)::integer from ledger.goods_receipts where store_id=$1) as "goodsReceipts",
        (select count(*)::integer from ledger.goods_receipt_items where store_id=$1) as "goodsReceiptItems",
        (select count(*)::integer from ledger.manual_inventory_entries where store_id=$1) as "manualInventoryEntries",
        (select count(*)::integer from ledger.inventory_movements where store_id=$1) as "inventoryMovements",
        (select count(*)::integer from ledger.stock_balances where store_id=$1) as "stockBalances",
        (select count(*)::integer from ledger.money_movements where store_id=$1) as "moneyMovements",
        (select count(*)::integer from ledger.supplier_payments where store_id=$1) as "supplierPayments",
        (select count(*)::integer from ledger.supplier_payment_allocations where store_id=$1) as "supplierAllocations"`,
      [storeId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Expected S12.3 fact counts.');
    return row;
  }

  async function countForSupplier(table: string, supplierId: string): Promise<number> {
    if (!['purchase_invoices', 'supplier_ledger_entries'].includes(table)) {
      throw new Error('Unexpected S12.3 count table.');
    }
    const result = await db().admin.query<{ count: number }>(
      `select count(*)::integer as count from ledger.${table} where supplier_id=$1`,
      [supplierId],
    );
    return result.rows[0]?.count ?? -1;
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
    if (
      !databaseName ||
      !/^dokana_s112_[0-9a-f]{32}$/.test(databaseName) ||
      databaseName === environment.databaseName
    ) {
      throw new Error('S12.3 integration database is not isolated.');
    }

    const databaseUrl = (source: string): string => {
      const parsed = new URL(source);
      parsed.pathname = `/${databaseName}`;
      return parsed.toString();
    };
    runtimePool = createTestPool(databaseUrl(environment.runtimeUrl), 'dokana-s123-runtime', 6);
    authPool = createTestPool(databaseUrl(environment.authUrl), 'dokana-s123-auth', 2);

    const password = randomUUID();
    const passwordHash = await new PasswordService().hash(password);
    for (const identity of identities) {
      await db().admin.query(
        `insert into ledger.stores(id,name,status) values($1,'S12.3 fixture',$2)`,
        [identity.storeId, identity.status],
      );
      await db().admin.query(
        `insert into platform.users(id,email,normalized_email,password_hash,full_name)
         values($1,$2,$2,$3,'S12.3 fixture')`,
        [identity.userId, identity.email, passwordHash],
      );
      await db().admin.query(
        `insert into platform.store_memberships(id,store_id,user_id,role,status)
         values($1,$2,$3,$4,'active')`,
        [randomUUID(), identity.storeId, identity.userId, identity.role],
      );
    }

    await db().admin.query(
      `insert into ledger.suppliers(id,store_id,name,normalized_name,status,operation_id) values
        ($1,$9,'Primary Supplier','primary supplier','active',$10),
        ($2,$9,'Linked Supplier','linked supplier','active',$11),
        ($3,$9,'Opening Supplier','opening supplier','active',$12),
        ($4,$9,'Huge Supplier','huge supplier','active',$13),
        ($5,$9,'Concurrent Supplier','concurrent supplier','active',$14),
        ($6,$9,'Closed Supplier','closed supplier','active',$15),
        ($7,$16,'Foreign Supplier','foreign supplier','active',$17),
        ($8,$18,'Read Only Supplier','read only supplier','active',$19)`,
      [
        suppliers.primary,
        suppliers.linked,
        suppliers.opening,
        suppliers.huge,
        suppliers.concurrent,
        suppliers.closed,
        suppliers.foreign,
        suppliers.readOnly,
        ownerA.storeId,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        ownerB.storeId,
        randomUUID(),
        readOnlyOwner.storeId,
        randomUUID(),
      ],
    );

    await db().admin.query(
      `insert into ledger.products(
         id,store_id,name,normalized_name,measurement_type,operation_id
       ) values
         ($1,$3,'Local Product','local product','count',$4),
         ($2,$5,'Foreign Product','foreign product','count',$6)`,
      [
        products.local,
        products.foreign,
        ownerA.storeId,
        randomUUID(),
        ownerB.storeId,
        randomUUID(),
      ],
    );
    await db().admin.query(
      `insert into ledger.product_units(
         id,store_id,product_id,measurement_type,unit_name,is_base,
         factor_num,factor_den,purchase_price_minor,operation_id
       ) values
         ($1,$3,$4,'count','case',false,2,1,100,$5),
         ($2,$6,$7,'count','case',false,2,1,100,$8)`,
      [
        units.local,
        units.foreign,
        ownerA.storeId,
        products.local,
        randomUUID(),
        ownerB.storeId,
        products.foreign,
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

    for (const identity of identities) {
      const login = await request(server)
        .post('/v1/auth/login')
        .send({
          email: identity.email,
          password,
          storeId: identity.storeId,
          deviceId: identity.deviceId,
          deviceName: 'S12.3 isolated',
          devicePlatform: 'android',
        })
        .expect(200);
      const body = login.body as { accessToken?: unknown };
      if (typeof body.accessToken !== 'string') throw new Error('S12.3 login token missing.');
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

  it('posts authoritative plain-text items, one payable, and exposes the result through S12.2 reads', async () => {
    const body = invoiceBody();
    const before = await facts(ownerA.storeId);
    const posted = await postInvoice(ownerA, suppliers.primary, body).expect(201);
    const response = posted.body as SupplierInvoicePostingResponse;

    expect(response).toMatchObject({
      operationId: body.operationId,
      supplierId: suppliers.primary,
      businessDate: '2026-07-15',
      postingDate: '2026-07-15',
      invoice: {
        totalMinor: '639',
        itemsSubtotalMinor: '652',
        lineDiscountTotalMinor: '2',
        invoiceDiscountMinor: '10',
        roundingMinor: '-1',
        status: 'open',
      },
      payable: {
        entryType: 'supplier_invoice',
        payableDeltaMinor: '639',
        creditDeltaMinor: '0',
      },
    });
    expect(response.items).toHaveLength(2);
    expect(response.items[0]).toMatchObject({
      productId: null,
      productUnitId: null,
      lineGrossMinor: '152',
      lineTotalMinor: '150',
    });

    const financial = await request(server)
      .get(`/v1/suppliers/${suppliers.primary}/invoices`)
      .set('authorization', `Bearer ${ownerA.token}`)
      .expect(200);
    expect(financial.body).toMatchObject({
      totalOutstandingMinor: '639',
      invoices: [{ id: response.invoice.id, totalMinor: '639', outstandingMinor: '639' }],
    });
    const detail = await request(server)
      .get(`/v1/suppliers/${suppliers.primary}/invoices/${response.invoice.id}`)
      .set('authorization', `Bearer ${ownerA.token}`)
      .expect(200);
    const detailBody = detail.body as unknown as SupplierInvoiceDetailResponse;
    expect(detailBody).toMatchObject({
      invoice: { id: response.invoice.id, totalMinor: '639' },
    });
    const detailItems = detailBody.items;
    expect(detailItems).toHaveLength(2);
    expect(detailItems.map((item) => item.lineTotalMinor).sort()).toEqual(['150', '500']);
    expect(
      detailItems.every((item) => item.productId === null && item.productUnitId === null),
    ).toBe(true);

    const after = await facts(ownerA.storeId);
    expect(after).toEqual({
      ...before,
      invoices: before.invoices + 1,
      items: before.items + 2,
      supplierEntries: before.supplierEntries + 1,
    });
  });

  it('replays exactly, rejects changed reuse, and creates no duplicate invoice or payable', async () => {
    const body = invoiceBody();
    const first = await postInvoice(ownerA, suppliers.linked, body).expect(201);
    const replay = await postInvoice(ownerA, suppliers.linked, body).expect(201);
    expect(replay.body).toEqual(first.body);

    await postInvoice(ownerA, suppliers.linked, {
      ...body,
      notes: 'changed semantic request',
    })
      .expect(409)
      .expect(({ body: error }) => expect(error).toMatchObject({ code: 'OPERATION_ID_CONFLICT' }));
    expect(await countForSupplier('purchase_invoices', suppliers.linked)).toBe(1);
    expect(await countForSupplier('supplier_ledger_entries', suppliers.linked)).toBe(1);
  });

  it('accepts an optional same-store Product link only as traceability and accumulates multiple invoices', async () => {
    const first = invoiceBody(randomUUID(), {
      items: [
        {
          description: 'Linked item snapshot',
          unitName: 'case',
          quantityMilli: '1500',
          unitCostMinor: '200',
          productId: products.local,
          productUnitId: units.local,
          lineTotalMinor: '300',
        },
      ],
      invoiceDiscountMinor: '0',
      roundingMinor: '0',
      totalMinor: '300',
    });
    const second = invoiceBody(randomUUID(), {
      items: [
        {
          description: 'Another invoice',
          unitName: 'piece',
          quantityMilli: '1000',
          unitCostMinor: '25',
          lineTotalMinor: '25',
        },
      ],
      invoiceDiscountMinor: '0',
      roundingMinor: '0',
      totalMinor: '25',
    });
    const before = await facts(ownerA.storeId);
    const linked = await postInvoice(ownerA, suppliers.huge, first).expect(201);
    await postInvoice(ownerA, suppliers.huge, second).expect(201);
    const response = linked.body as SupplierInvoicePostingResponse;
    expect(response.items[0]).toMatchObject({
      productId: products.local,
      productUnitId: units.local,
      baseQuantityMilli: '3000',
      lineTotalMinor: '300',
    });

    const financial = await request(server)
      .get(`/v1/suppliers/${suppliers.huge}/invoices`)
      .set('authorization', `Bearer ${ownerA.token}`)
      .expect(200);
    const financialBody = financial.body as unknown as SupplierFinancialResponse;
    expect(financialBody).toMatchObject({ totalOutstandingMinor: '325' });
    expect(financialBody.invoices).toHaveLength(2);
    const detail = await request(server)
      .get(`/v1/suppliers/${suppliers.huge}/invoices/${response.invoice.id}`)
      .set('authorization', `Bearer ${ownerA.token}`)
      .expect(200);
    expect(detail.body as unknown as SupplierInvoiceDetailResponse).toMatchObject({
      items: [{ productId: products.local, productUnitId: units.local }],
    });

    const after = await facts(ownerA.storeId);
    expect(after.goodsReceipts).toBe(before.goodsReceipts);
    expect(after.goodsReceiptItems).toBe(before.goodsReceiptItems);
    expect(after.manualInventoryEntries).toBe(before.manualInventoryEntries);
    expect(after.inventoryMovements).toBe(before.inventoryMovements);
    expect(after.stockBalances).toBe(before.stockBalances);
    expect(after.moneyMovements).toBe(before.moneyMovements);
    expect(after.supplierPayments).toBe(before.supplierPayments);
    expect(after.supplierAllocations).toBe(before.supplierAllocations);
  });

  it('preserves bigint amounts above JavaScript safe integer range', async () => {
    const amount = '9007199254740993';
    const body = invoiceBody(randomUUID(), {
      items: [
        {
          description: 'Large exact amount',
          unitName: 'piece',
          quantityMilli: '1000',
          unitCostMinor: amount,
          lineTotalMinor: amount,
        },
      ],
      invoiceDiscountMinor: '0',
      roundingMinor: '0',
      totalMinor: amount,
    });
    const posted = await postInvoice(ownerA, suppliers.concurrent, body).expect(201);
    expect(posted.body).toMatchObject({
      invoice: { totalMinor: amount },
      payable: { payableDeltaMinor: amount },
    });
  });

  it('serializes concurrent duplicate operations into one exact accepted result', async () => {
    const body = invoiceBody();
    const [first, second] = await Promise.all([
      postInvoice(ownerA, suppliers.concurrent, body),
      postInvoice(ownerA, suppliers.concurrent, body),
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(await countForSupplier('purchase_invoices', suppliers.concurrent)).toBe(2);
    expect(await countForSupplier('supplier_ledger_entries', suppliers.concurrent)).toBe(2);
  });

  it('posts one opening payable without an invoice, replays it, and rejects a second opening', async () => {
    const body = {
      operationId: randomUUID(),
      amountMinor: '9007199254740993',
      occurredAt: invoiceInstant,
      notes: 'Opening payable',
    };
    const before = await facts(ownerA.storeId);
    const first = await postOpening(ownerA, suppliers.opening, body).expect(201);
    const response = first.body as SupplierOpeningPayableResponse;
    expect(response).toMatchObject({
      operationId: body.operationId,
      supplierId: suppliers.opening,
      payable: {
        entryType: 'opening_balance',
        payableDeltaMinor: body.amountMinor,
        sourcePurchaseInvoiceId: null,
      },
    });
    const replay = await postOpening(ownerA, suppliers.opening, body).expect(201);
    expect(replay.body).toEqual(first.body);
    await postOpening(ownerA, suppliers.opening, { ...body, amountMinor: '2' })
      .expect(409)
      .expect(({ body: error }) => expect(error).toMatchObject({ code: 'OPERATION_ID_CONFLICT' }));
    await postOpening(ownerA, suppliers.opening, {
      ...body,
      operationId: randomUUID(),
    })
      .expect(409)
      .expect(({ body: error }) =>
        expect(error).toMatchObject({ code: 'OPENING_PAYABLE_ALREADY_EXISTS' }),
      );

    expect(await countForSupplier('purchase_invoices', suppliers.opening)).toBe(0);
    expect(await countForSupplier('supplier_ledger_entries', suppliers.opening)).toBe(1);
    const after = await facts(ownerA.storeId);
    expect(after.invoices).toBe(before.invoices);
    expect(after.items).toBe(before.items);
    expect(after.supplierEntries).toBe(before.supplierEntries + 1);
    expect(after.goodsReceipts).toBe(before.goodsReceipts);
    expect(after.goodsReceiptItems).toBe(before.goodsReceiptItems);
    expect(after.manualInventoryEntries).toBe(before.manualInventoryEntries);
    expect(after.inventoryMovements).toBe(before.inventoryMovements);
    expect(after.stockBalances).toBe(before.stockBalances);
    expect(after.moneyMovements).toBe(before.moneyMovements);
    expect(after.supplierPayments).toBe(before.supplierPayments);
    expect(after.supplierAllocations).toBe(before.supplierAllocations);
  });

  it('rejects a closed-period write and replays the rejection after the period reopens', async () => {
    const periodId = deriveAccountingPeriodId(ownerA.storeId, 2026, 8);
    const boundaries = resolveAccountingPeriodBoundaries(2026, 8);
    await db().admin.query(
      `insert into ledger.accounting_periods(
         id,store_id,period_year,period_month,starts_at,ends_at,status,closed_at,operation_id
       ) values($1,$2,2026,8,$3,$4,'closed',clock_timestamp(),$5)`,
      [periodId, ownerA.storeId, boundaries.startsAt, boundaries.endsAt, randomUUID()],
    );
    const body = invoiceBody(randomUUID(), { occurredAt: '2026-08-15T10:00:00Z' });
    await postInvoice(ownerA, suppliers.closed, body)
      .expect(409)
      .expect(({ body: error }) =>
        expect(error).toMatchObject({ code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE' }),
      );
    expect(await countForSupplier('purchase_invoices', suppliers.closed)).toBe(0);
    expect(await countForSupplier('supplier_ledger_entries', suppliers.closed)).toBe(0);

    await db().admin.query(`update ledger.accounting_periods set status='open' where id=$1`, [
      periodId,
    ]);
    await postInvoice(ownerA, suppliers.closed, body)
      .expect(409)
      .expect(({ body: error }) =>
        expect(error).toMatchObject({ code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE' }),
      );
    expect(await countForSupplier('purchase_invoices', suppliers.closed)).toBe(0);
  });

  it('enforces owner, active-store, tenant, and Product-link boundaries without partial effects', async () => {
    const body = invoiceBody();
    await request(server)
      .post(`/v1/suppliers/${suppliers.primary}/invoices`)
      .send(body)
      .expect(401);
    await postInvoice(manager, suppliers.primary, body)
      .expect(403)
      .expect(({ body: error }) =>
        expect(error).toMatchObject({ code: 'SUPPLIER_FINANCIAL_WRITE_NOT_ALLOWED' }),
      );
    await postInvoice(readOnlyOwner, suppliers.readOnly, body)
      .expect(403)
      .expect(({ body: error }) =>
        expect(error).toMatchObject({ code: 'BUSINESS_WRITE_NOT_ALLOWED' }),
      );
    await postInvoice(ownerA, suppliers.foreign, body)
      .expect(404)
      .expect(({ body: error }) => expect(error).toMatchObject({ code: 'SUPPLIER_NOT_FOUND' }));

    const crossStoreBody = invoiceBody(randomUUID(), {
      items: [
        {
          description: 'Foreign link',
          unitName: 'case',
          quantityMilli: '1000',
          unitCostMinor: '25',
          lineTotalMinor: '25',
          productId: products.foreign,
          productUnitId: units.foreign,
        },
      ],
      invoiceDiscountMinor: '0',
      roundingMinor: '0',
      totalMinor: '25',
    });
    const before = await facts(ownerA.storeId);
    await postInvoice(ownerA, suppliers.primary, crossStoreBody)
      .expect(404)
      .expect(({ body: error }) =>
        expect(error).toMatchObject({ code: 'SUPPLIER_INVOICE_PRODUCT_LINK_NOT_FOUND' }),
      );
    const after = await facts(ownerA.storeId);
    expect(after.invoices).toBe(before.invoices);
    expect(after.items).toBe(before.items);
    expect(after.supplierEntries).toBe(before.supplierEntries);
  });

  it('fails closed under the runtime role when tenant context is absent', async () => {
    if (!runtimePool) throw new Error('S12.3 runtime pool missing.');
    const result = await runtimePool.query<{ count: number }>(
      'select count(*)::integer as count from ledger.purchase_invoices',
    );
    expect(result.rows[0]).toEqual({ count: 0 });
  });
});
