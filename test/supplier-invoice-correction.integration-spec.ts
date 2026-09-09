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
import type { SupplierFinancialResponse } from '../src/suppliers/supplier-financial-read.types';
import type {
  SupplierFinancialCorrectionResponse,
  SupplierInvoiceCorrectionResponse,
  SupplierOpeningPayableCorrectionResponse,
} from '../src/suppliers/supplier-invoice-correction.types';
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

const migrationFilename = '0010_supplier_invoice_optional_product_links.sql';
const julyInstant = '2026-07-15T10:00:00Z';
const augustInstant = '2026-08-05T10:00:00Z';

interface TestIdentity {
  storeId: string;
  userId: string;
  deviceId: string;
  email: string;
  role: 'owner' | 'manager';
  token: string;
}

interface SideEffectCounts {
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
  expenses: number;
}

const ownerA: TestIdentity = {
  storeId: randomUUID(),
  userId: randomUUID(),
  deviceId: randomUUID(),
  email: `s124-owner-a-${randomUUID()}@example.test`,
  role: 'owner',
  token: '',
};
const ownerB: TestIdentity = {
  storeId: randomUUID(),
  userId: randomUUID(),
  deviceId: randomUUID(),
  email: `s124-owner-b-${randomUUID()}@example.test`,
  role: 'owner',
  token: '',
};
const manager: TestIdentity = {
  storeId: randomUUID(),
  userId: randomUUID(),
  deviceId: randomUUID(),
  email: `s124-manager-${randomUUID()}@example.test`,
  role: 'manager',
  token: '',
};
const readOnlyOwner: TestIdentity = {
  storeId: randomUUID(),
  userId: randomUUID(),
  deviceId: randomUUID(),
  email: `s124-read-only-${randomUUID()}@example.test`,
  role: 'owner',
  token: '',
};
const identities = [ownerA, ownerB, manager, readOnlyOwner];

const suppliers = {
  cancel: randomUUID(),
  edit: randomUUID(),
  linked: randomUUID(),
  opening: randomUUID(),
  openingCollision: randomUUID(),
  openingOccupied: randomUUID(),
  closed: randomUUID(),
  race: randomUUID(),
  bigint: randomUUID(),
  auth: randomUUID(),
  foreign: randomUUID(),
  readOnly: randomUUID(),
};
const products = { local: randomUUID(), foreign: randomUUID() };
const units = { local: randomUUID(), foreign: randomUUID() };

describe('S12.4 Supplier Invoice lifecycle corrections on isolated PostgreSQL', () => {
  jest.setTimeout(120_000);

  let database: InventoryTestDatabase | undefined;
  let app: NestExpressApplication | undefined;
  let server: Server;
  let runtimePool: Pool | undefined;
  let authPool: Pool | undefined;

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('Isolated S12.4 database is unavailable.');
    return database;
  }

  function invoiceBody(
    operationId = randomUUID(),
    amountMinor = '500',
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      operationId,
      invoiceNumber: `EXT-${operationId.slice(0, 8)}`,
      occurredAt: julyInstant,
      items: [
        {
          description: 'Original item',
          unitName: 'piece',
          quantityMilli: '1000',
          unitCostMinor: amountMinor,
          lineTotalMinor: amountMinor,
        },
      ],
      totalMinor: amountMinor,
      ...overrides,
    };
  }

  function replacement(amountMinor = '450', overrides: Record<string, unknown> = {}) {
    return {
      supplierId: suppliers.edit,
      invoiceNumber: `EDIT-${amountMinor}`,
      items: [
        {
          description: 'Corrected item',
          unitName: 'piece',
          quantityMilli: '1000',
          unitCostMinor: amountMinor,
          lineTotalMinor: amountMinor,
        },
      ],
      totalMinor: amountMinor,
      ...overrides,
    };
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

  function cancelInvoice(
    identity: TestIdentity,
    targetOperationId: string,
    body: Record<string, unknown>,
  ) {
    return request(server)
      .post(`/v1/suppliers/invoices/${targetOperationId}/cancel`)
      .set('authorization', `Bearer ${identity.token}`)
      .send(body);
  }

  function editInvoice(
    identity: TestIdentity,
    targetOperationId: string,
    body: Record<string, unknown>,
  ) {
    return request(server)
      .post(`/v1/suppliers/invoices/${targetOperationId}/edit`)
      .set('authorization', `Bearer ${identity.token}`)
      .send(body);
  }

  function cancelOpening(
    identity: TestIdentity,
    targetOperationId: string,
    body: Record<string, unknown>,
  ) {
    return request(server)
      .post(`/v1/suppliers/opening-payables/${targetOperationId}/cancel`)
      .set('authorization', `Bearer ${identity.token}`)
      .send(body);
  }

  function editOpening(
    identity: TestIdentity,
    targetOperationId: string,
    body: Record<string, unknown>,
  ) {
    return request(server)
      .post(`/v1/suppliers/opening-payables/${targetOperationId}/edit`)
      .set('authorization', `Bearer ${identity.token}`)
      .send(body);
  }

  async function sideEffects(storeId: string): Promise<SideEffectCounts> {
    const result = await db().admin.query<SideEffectCounts>(
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
        (select count(*)::integer from ledger.supplier_payment_allocations where store_id=$1) as "supplierAllocations",
        (select count(*)::integer from ledger.expenses where store_id=$1) as expenses`,
      [storeId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Expected S12.4 side-effect counts.');
    return row;
  }

  async function supplierBalance(supplierId: string): Promise<string> {
    const result = await db().admin.query<{ total: string }>(
      `select coalesce(sum(payable_delta_minor-credit_delta_minor),0)::text as total
       from ledger.supplier_ledger_entries where supplier_id=$1`,
      [supplierId],
    );
    return result.rows[0]?.total ?? 'missing';
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
      throw new Error('S12.4 integration database is not isolated.');
    }
    const databaseUrl = (source: string): string => {
      const parsed = new URL(source);
      parsed.pathname = `/${databaseName}`;
      return parsed.toString();
    };
    runtimePool = createTestPool(databaseUrl(environment.runtimeUrl), 'dokana-s124-runtime', 8);
    authPool = createTestPool(databaseUrl(environment.authUrl), 'dokana-s124-auth', 2);

    const password = randomUUID();
    const passwordHash = await new PasswordService().hash(password);
    for (const identity of identities) {
      await db().admin.query(
        `insert into ledger.stores(id,name,status) values($1,'S12.4 fixture','active')`,
        [identity.storeId],
      );
      await db().admin.query(
        `insert into platform.users(id,email,normalized_email,password_hash,full_name)
         values($1,$2,$2,$3,'S12.4 fixture')`,
        [identity.userId, identity.email, passwordHash],
      );
      await db().admin.query(
        `insert into platform.store_memberships(id,store_id,user_id,role,status)
         values($1,$2,$3,$4,'active')`,
        [randomUUID(), identity.storeId, identity.userId, identity.role],
      );
    }

    const ownerSuppliers = [
      suppliers.cancel,
      suppliers.edit,
      suppliers.linked,
      suppliers.opening,
      suppliers.openingCollision,
      suppliers.openingOccupied,
      suppliers.closed,
      suppliers.race,
      suppliers.bigint,
      suppliers.auth,
    ];
    for (const [index, supplierId] of ownerSuppliers.entries()) {
      await db().admin.query(
        `insert into ledger.suppliers(id,store_id,name,normalized_name,status,operation_id)
         values($1,$2,$3,$4,'active',$5)`,
        [
          supplierId,
          ownerA.storeId,
          `S12.4 Supplier ${String(index)}`,
          `s12.4 supplier ${String(index)}`,
          randomUUID(),
        ],
      );
    }
    await db().admin.query(
      `insert into ledger.suppliers(id,store_id,name,normalized_name,status,operation_id) values
       ($1,$2,'Foreign Supplier','foreign supplier','active',$3),
       ($4,$5,'Read Only Supplier','read only supplier','active',$6)`,
      [
        suppliers.foreign,
        ownerB.storeId,
        randomUUID(),
        suppliers.readOnly,
        readOnlyOwner.storeId,
        randomUUID(),
      ],
    );
    await db().admin.query(
      `insert into ledger.products(id,store_id,name,normalized_name,measurement_type,operation_id)
       values($1,$2,'Local Product','local product','count',$3),
             ($4,$5,'Foreign Product','foreign product','count',$6)`,
      [
        products.local,
        ownerA.storeId,
        randomUUID(),
        products.foreign,
        ownerB.storeId,
        randomUUID(),
      ],
    );
    await db().admin.query(
      `insert into ledger.product_units(
         id,store_id,product_id,measurement_type,unit_name,is_base,
         factor_num,factor_den,purchase_price_minor,operation_id)
       values($1,$2,$3,'count','case',false,2,1,100,$4),
             ($5,$6,$7,'count','case',false,2,1,100,$8)`,
      [
        units.local,
        ownerA.storeId,
        products.local,
        randomUUID(),
        units.foreign,
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
          deviceName: 'S12.4 isolated',
          devicePlatform: 'android',
        })
        .expect(200);
      const body = login.body as { accessToken?: unknown };
      if (typeof body.accessToken !== 'string') throw new Error('S12.4 login token missing.');
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

  it('maps Cancel Invoice to one pure reversal while preserving immutable invoice and items', async () => {
    const sourceOperationId = randomUUID();
    const posted = await postInvoice(
      ownerA,
      suppliers.cancel,
      invoiceBody(sourceOperationId),
    ).expect(201);
    const source = posted.body as SupplierInvoicePostingResponse;
    const originalHeader = await db().admin.query(
      `select supplier_id,invoice_number,invoice_date_at,due_at,items_subtotal_minor,
        line_discount_total_minor,invoice_discount_minor,rounding_minor,total_minor,notes
       from ledger.purchase_invoices where id=$1`,
      [source.invoice.id],
    );
    const originalItems = await db().admin.query(
      `select product_id,product_unit_id,product_name_snapshot,unit_name_snapshot,
        quantity_milli,conversion_factor_num,conversion_factor_den,base_quantity_milli,
        unit_cost_minor,line_gross_minor,line_discount_minor,rounding_minor,line_total_minor
       from ledger.purchase_items where purchase_invoice_id=$1 order by id`,
      [source.invoice.id],
    );
    const afterPosting = await sideEffects(ownerA.storeId);
    const operationId = randomUUID();
    const command = { operationId, occurredAt: augustInstant };
    const cancelled = await cancelInvoice(ownerA, sourceOperationId, command).expect(201);
    const response = cancelled.body as SupplierInvoiceCorrectionResponse;

    expect(response).toMatchObject({
      operationId,
      targetOperationId: sourceOperationId,
      family: 'invoice',
      intent: 'cancel',
      target: { invoiceId: source.invoice.id, status: 'cancelled' },
      reversal: {
        entryType: 'correction',
        payableDeltaMinor: '-500',
        sourcePurchaseInvoiceId: source.invoice.id,
        reversalOfId: source.payable.id,
      },
      replacement: null,
    });
    const replay = await cancelInvoice(ownerA, sourceOperationId, command).expect(201);
    expect(replay.body).toEqual(cancelled.body);
    await cancelInvoice(ownerA, sourceOperationId, {
      ...command,
      occurredAt: '2026-08-06T10:00:00Z',
    })
      .expect(409)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'OPERATION_ID_CONFLICT' }));

    const currentHeader = await db().admin.query(
      `select supplier_id,invoice_number,invoice_date_at,due_at,items_subtotal_minor,
        line_discount_total_minor,invoice_discount_minor,rounding_minor,total_minor,notes,
        status,cancelled_at,version
       from ledger.purchase_invoices where id=$1`,
      [source.invoice.id],
    );
    expect(currentHeader.rows[0]).toMatchObject({ status: 'cancelled' });
    const {
      status: _status,
      cancelled_at: _cancelledAt,
      version: _version,
      ...financialHeader
    } = currentHeader.rows[0] as Record<string, unknown>;
    expect(financialHeader).toEqual(originalHeader.rows[0]);
    const currentItems = await db().admin.query(
      `select product_id,product_unit_id,product_name_snapshot,unit_name_snapshot,
        quantity_milli,conversion_factor_num,conversion_factor_den,base_quantity_milli,
        unit_cost_minor,line_gross_minor,line_discount_minor,rounding_minor,line_total_minor
       from ledger.purchase_items where purchase_invoice_id=$1 order by id`,
      [source.invoice.id],
    );
    expect(currentItems.rows).toEqual(originalItems.rows);
    expect(await supplierBalance(suppliers.cancel)).toBe('0');

    const after = await sideEffects(ownerA.storeId);
    expect(after).toEqual({ ...afterPosting, supplierEntries: afterPosting.supplierEntries + 1 });
    const financial = await request(server)
      .get(`/v1/suppliers/${suppliers.cancel}/invoices`)
      .set('authorization', `Bearer ${ownerA.token}`)
      .expect(200);
    expect(financial.body).toMatchObject({
      totalOutstandingMinor: '0',
      invoices: [
        {
          id: source.invoice.id,
          status: 'cancelled',
          outstandingMinor: '0',
          correctionOfId: null,
          replacedById: null,
        },
      ],
    });
  });

  it('maps Edit Invoice to a linear replacement chain and keeps unrelated liability intact', async () => {
    const sourceOperationId = randomUUID();
    const unrelatedOperationId = randomUUID();
    const source = (
      await postInvoice(ownerA, suppliers.edit, invoiceBody(sourceOperationId)).expect(201)
    ).body as SupplierInvoicePostingResponse;
    await postInvoice(ownerA, suppliers.edit, invoiceBody(unrelatedOperationId, '700')).expect(201);

    const firstEditOperationId = randomUUID();
    const firstEdit = await editInvoice(ownerA, sourceOperationId, {
      operationId: firstEditOperationId,
      occurredAt: augustInstant,
      replacement: replacement('450'),
    }).expect(201);
    const first = firstEdit.body as SupplierInvoiceCorrectionResponse;
    expect(first).toMatchObject({
      intent: 'edit',
      reversal: { payableDeltaMinor: '-500', reversalOfId: source.payable.id },
      replacement: {
        supplierId: suppliers.edit,
        invoice: { totalMinor: '450', status: 'open' },
        payable: { payableDeltaMinor: '450' },
      },
    });
    if (!first.replacement) throw new Error('Expected first invoice replacement.');

    const page = await request(server)
      .get(`/v1/suppliers/${suppliers.edit}/invoices`)
      .set('authorization', `Bearer ${ownerA.token}`)
      .expect(200);
    const financial = page.body as SupplierFinancialResponse;
    expect(financial.totalOutstandingMinor).toBe('1150');
    expect(financial.invoices.find((invoice) => invoice.id === source.invoice.id)).toMatchObject({
      status: 'cancelled',
      outstandingMinor: '0',
      replacedById: first.replacement.invoice.id,
      replacedBySupplierId: suppliers.edit,
    });
    expect(
      financial.invoices.find((invoice) => invoice.id === first.replacement?.invoice.id),
    ).toMatchObject({
      status: 'open',
      correctionOfId: source.invoice.id,
      outstandingMinor: '450',
    });

    const secondEditOperationId = randomUUID();
    const secondEdit = await editInvoice(ownerA, firstEditOperationId, {
      operationId: secondEditOperationId,
      occurredAt: '2026-08-06T10:00:00Z',
      replacement: replacement('400'),
    }).expect(201);
    const second = secondEdit.body as SupplierInvoiceCorrectionResponse;
    if (!second.replacement) throw new Error('Expected second invoice replacement.');
    const lineage = await db().admin.query<{
      id: string;
      correctionOfId: string | null;
      status: string;
    }>(
      `select id,correction_of_id as "correctionOfId",status
       from ledger.purchase_invoices where id=any($1::uuid[]) order by created_at,id`,
      [[source.invoice.id, first.replacement.invoice.id, second.replacement.invoice.id]],
    );
    expect(lineage.rows).toEqual([
      { id: source.invoice.id, correctionOfId: null, status: 'cancelled' },
      {
        id: first.replacement.invoice.id,
        correctionOfId: source.invoice.id,
        status: 'cancelled',
      },
      {
        id: second.replacement.invoice.id,
        correctionOfId: first.replacement.invoice.id,
        status: 'open',
      },
    ]);

    for (const targetOperationId of [sourceOperationId, firstEditOperationId]) {
      await cancelInvoice(ownerA, targetOperationId, {
        operationId: randomUUID(),
        occurredAt: '2026-08-07T10:00:00Z',
      })
        .expect(409)
        .expect(({ body }) =>
          expect(body).toMatchObject({ code: 'SUPPLIER_CORRECTION_TARGET_NOT_ACTIVE' }),
        );
    }
    const finalCancelOperationId = randomUUID();
    await cancelInvoice(ownerA, secondEditOperationId, {
      operationId: finalCancelOperationId,
      occurredAt: '2026-08-07T10:00:00Z',
    }).expect(201);
    await cancelInvoice(ownerA, finalCancelOperationId, {
      operationId: randomUUID(),
      occurredAt: '2026-08-08T10:00:00Z',
    })
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'SUPPLIER_CORRECTION_TARGET_NOT_ACTIVE' }),
      );
    expect(await supplierBalance(suppliers.edit)).toBe('700');
  });

  it('preserves Product-pair snapshots and rolls back an invalid replacement atomically', async () => {
    const sourceOperationId = randomUUID();
    const source = (
      await postInvoice(ownerA, suppliers.linked, invoiceBody(sourceOperationId)).expect(201)
    ).body as SupplierInvoicePostingResponse;
    const before = await sideEffects(ownerA.storeId);

    await editInvoice(ownerA, sourceOperationId, {
      operationId: randomUUID(),
      occurredAt: augustInstant,
      replacement: replacement('300', {
        supplierId: suppliers.linked,
        items: [
          {
            description: 'Broken pair',
            unitName: 'case',
            quantityMilli: '1000',
            unitCostMinor: '300',
            productId: products.local,
          },
        ],
      }),
    }).expect(400);

    const rejectedOperationId = randomUUID();
    const foreignReplacement = replacement('300', {
      supplierId: suppliers.linked,
      items: [
        {
          description: 'Foreign linked item',
          unitName: 'case',
          quantityMilli: '1000',
          unitCostMinor: '300',
          productId: products.foreign,
          productUnitId: units.foreign,
        },
      ],
    });
    await editInvoice(ownerA, sourceOperationId, {
      operationId: rejectedOperationId,
      occurredAt: augustInstant,
      replacement: foreignReplacement,
    })
      .expect(404)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'SUPPLIER_INVOICE_PRODUCT_LINK_NOT_FOUND' }),
      );
    const afterRejected = await sideEffects(ownerA.storeId);
    expect(afterRejected).toEqual(before);
    const stillOpen = await db().admin.query<{ status: string; reversalCount: number }>(
      `select p.status,
        (select count(*)::integer from ledger.supplier_ledger_entries r
          where r.reversal_of_id=$2) as "reversalCount"
       from ledger.purchase_invoices p where p.id=$1`,
      [source.invoice.id, source.payable.id],
    );
    expect(stillOpen.rows[0]).toEqual({ status: 'open', reversalCount: 0 });

    const accepted = await editInvoice(ownerA, sourceOperationId, {
      operationId: randomUUID(),
      occurredAt: augustInstant,
      replacement: replacement('300', {
        supplierId: suppliers.linked,
        items: [
          {
            description: 'Invoice-time Product snapshot',
            unitName: 'case snapshot',
            quantityMilli: '1000',
            unitCostMinor: '300',
            lineTotalMinor: '300',
            productId: products.local,
            productUnitId: units.local,
          },
        ],
      }),
    }).expect(201);
    const corrected = accepted.body as SupplierInvoiceCorrectionResponse;
    expect(corrected.replacement?.items[0]).toMatchObject({
      productId: products.local,
      productUnitId: units.local,
      description: 'Invoice-time Product snapshot',
      unitName: 'case snapshot',
      conversionFactorNumerator: 2,
      conversionFactorDenominator: 1,
    });
    const after = await sideEffects(ownerA.storeId);
    expect(after.goodsReceipts).toBe(before.goodsReceipts);
    expect(after.goodsReceiptItems).toBe(before.goodsReceiptItems);
    expect(after.manualInventoryEntries).toBe(before.manualInventoryEntries);
    expect(after.inventoryMovements).toBe(before.inventoryMovements);
    expect(after.stockBalances).toBe(before.stockBalances);
    expect(after.moneyMovements).toBe(before.moneyMovements);
    expect(after.supplierPayments).toBe(before.supplierPayments);
    expect(after.supplierAllocations).toBe(before.supplierAllocations);
    expect(after.expenses).toBe(before.expenses);
  });

  it('edits and cancels an opening payable through one append-only active chain', async () => {
    const sourceOperationId = randomUUID();
    const opening = (
      await postOpening(ownerA, suppliers.opening, {
        operationId: sourceOperationId,
        amountMinor: '800',
        occurredAt: julyInstant,
        notes: 'Original opening',
      }).expect(201)
    ).body as SupplierOpeningPayableResponse;
    await editInvoice(ownerA, sourceOperationId, {
      operationId: randomUUID(),
      occurredAt: augustInstant,
      replacement: replacement('700', { supplierId: suppliers.opening }),
    })
      .expect(404)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'SUPPLIER_CORRECTION_TARGET_NOT_FOUND' }),
      );
    const editOperationId = randomUUID();
    const edited = await editOpening(ownerA, sourceOperationId, {
      operationId: editOperationId,
      occurredAt: augustInstant,
      replacement: {
        supplierId: suppliers.opening,
        amountMinor: '700',
        notes: 'Corrected opening',
      },
    }).expect(201);
    const response = edited.body as SupplierOpeningPayableCorrectionResponse;
    expect(response).toMatchObject({
      family: 'opening_payable',
      intent: 'edit',
      target: { payableId: opening.payable.id, amountMinor: '800' },
      reversal: { payableDeltaMinor: '-800', reversalOfId: opening.payable.id },
      replacement: { payable: { entryType: 'opening_balance', payableDeltaMinor: '700' } },
    });
    expect(await supplierBalance(suppliers.opening)).toBe('700');

    await postOpening(ownerA, suppliers.opening, {
      operationId: randomUUID(),
      amountMinor: '1',
      occurredAt: augustInstant,
    })
      .expect(409)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'OPENING_PAYABLE_ALREADY_EXISTS' }));
    await cancelOpening(ownerA, sourceOperationId, {
      operationId: randomUUID(),
      occurredAt: '2026-08-06T10:00:00Z',
    })
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'SUPPLIER_CORRECTION_TARGET_NOT_ACTIVE' }),
      );
    await cancelOpening(ownerA, editOperationId, {
      operationId: randomUUID(),
      occurredAt: '2026-08-06T10:00:00Z',
    }).expect(201);
    expect(await supplierBalance(suppliers.opening)).toBe('0');
    expect(
      await db().admin.query(`select 1 from ledger.purchase_invoices where supplier_id=$1`, [
        suppliers.opening,
      ]),
    ).toMatchObject({ rowCount: 0 });
  });

  it('preserves opening uniqueness when a replacement Supplier already has an opening', async () => {
    const sourceOperationId = randomUUID();
    await postOpening(ownerA, suppliers.openingCollision, {
      operationId: sourceOperationId,
      amountMinor: '100',
      occurredAt: julyInstant,
    }).expect(201);
    const otherOpeningOperationId = randomUUID();
    await postOpening(ownerA, suppliers.openingOccupied, {
      operationId: otherOpeningOperationId,
      amountMinor: '200',
      occurredAt: julyInstant,
    }).expect(201);
    await editOpening(ownerA, sourceOperationId, {
      operationId: randomUUID(),
      occurredAt: augustInstant,
      replacement: { supplierId: suppliers.openingOccupied, amountMinor: '150' },
    })
      .expect(409)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'OPENING_PAYABLE_ALREADY_EXISTS' }));
    expect(await supplierBalance(suppliers.openingCollision)).toBe('100');
    expect(await supplierBalance(suppliers.openingOccupied)).toBe('200');
  });

  it('rejects a closed-period correction and preserves its exact historical rejection', async () => {
    const sourceOperationId = randomUUID();
    const posted = (
      await postInvoice(ownerA, suppliers.closed, invoiceBody(sourceOperationId)).expect(201)
    ).body as SupplierInvoicePostingResponse;
    const periodId = deriveAccountingPeriodId(ownerA.storeId, 2026, 8);
    const boundaries = resolveAccountingPeriodBoundaries(2026, 8);
    await db().admin.query(
      `insert into ledger.accounting_periods(
         id,store_id,period_year,period_month,starts_at,ends_at,status,closed_at,operation_id)
       values($1,$2,2026,8,$3,$4,'closed',clock_timestamp(),$5)
       on conflict(id) do update set status='closed',closed_at=clock_timestamp()`,
      [periodId, ownerA.storeId, boundaries.startsAt, boundaries.endsAt, randomUUID()],
    );
    const operationId = randomUUID();
    const command = { operationId, occurredAt: augustInstant };
    await cancelInvoice(ownerA, sourceOperationId, command)
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE' }),
      );
    await db().admin.query(`update ledger.accounting_periods set status='open' where id=$1`, [
      periodId,
    ]);
    await cancelInvoice(ownerA, sourceOperationId, command)
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE' }),
      );
    await cancelInvoice(ownerA, sourceOperationId, {
      operationId,
      occurredAt: '2026-08-06T10:00:00Z',
    })
      .expect(409)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'OPERATION_ID_CONFLICT' }));
    const state = await db().admin.query<{ status: string; count: number }>(
      `select p.status,
        (select count(*)::integer from ledger.supplier_ledger_entries r
          where r.reversal_of_id=$2) as count
       from ledger.purchase_invoices p where p.id=$1`,
      [posted.invoice.id, posted.payable.id],
    );
    expect(state.rows[0]).toEqual({ status: 'open', count: 0 });
  });

  it('serializes competing edit and cancel so only one active-leaf correction wins', async () => {
    const sourceOperationId = randomUUID();
    const posted = (
      await postInvoice(ownerA, suppliers.race, invoiceBody(sourceOperationId)).expect(201)
    ).body as SupplierInvoicePostingResponse;
    const [cancelled, edited] = await Promise.all([
      cancelInvoice(ownerA, sourceOperationId, {
        operationId: randomUUID(),
        occurredAt: augustInstant,
      }),
      editInvoice(ownerA, sourceOperationId, {
        operationId: randomUUID(),
        occurredAt: augustInstant,
        replacement: replacement('450', { supplierId: suppliers.race }),
      }),
    ]);
    expect([cancelled.status, edited.status].sort()).toEqual([201, 409]);
    const rejected = [cancelled, edited].find((response) => response.status === 409);
    expect(rejected?.body).toMatchObject({ code: 'SUPPLIER_CORRECTION_TARGET_NOT_ACTIVE' });
    const reversals = await db().admin.query<{ count: number }>(
      `select count(*)::integer as count from ledger.supplier_ledger_entries
       where reversal_of_id=$1`,
      [posted.payable.id],
    );
    expect(reversals.rows[0]).toEqual({ count: 1 });
    expect(await supplierBalance(suppliers.race)).toBe(edited.status === 201 ? '450' : '0');
  });

  it('fails closed for authorization, tenant boundaries, and missing runtime context', async () => {
    const localOperationId = randomUUID();
    await postInvoice(ownerA, suppliers.auth, invoiceBody(localOperationId)).expect(201);
    const foreignOperationId = randomUUID();
    await postInvoice(ownerB, suppliers.foreign, invoiceBody(foreignOperationId)).expect(201);
    const readOnlyOperationId = randomUUID();
    await postInvoice(readOnlyOwner, suppliers.readOnly, invoiceBody(readOnlyOperationId)).expect(
      201,
    );
    await db().admin.query(`update ledger.stores set status='read_only' where id=$1`, [
      readOnlyOwner.storeId,
    ]);

    await request(server)
      .post(`/v1/suppliers/invoices/${localOperationId}/cancel`)
      .send({ operationId: randomUUID(), occurredAt: augustInstant })
      .expect(401);
    await cancelInvoice(manager, localOperationId, {
      operationId: randomUUID(),
      occurredAt: augustInstant,
    }).expect(403);
    await cancelInvoice(ownerA, foreignOperationId, {
      operationId: randomUUID(),
      occurredAt: augustInstant,
    })
      .expect(404)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'SUPPLIER_CORRECTION_TARGET_NOT_FOUND' }),
      );
    await cancelInvoice(readOnlyOwner, readOnlyOperationId, {
      operationId: randomUUID(),
      occurredAt: augustInstant,
    })
      .expect(403)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'BUSINESS_WRITE_NOT_ALLOWED' }));

    if (!runtimePool) throw new Error('S12.4 runtime pool missing.');
    const hidden = await runtimePool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.purchase_invoices`,
    );
    expect(hidden.rows[0]).toEqual({ count: 0 });
  });

  it('preserves exact bigint money above JavaScript safe integer range', async () => {
    const sourceOperationId = randomUUID();
    const amount = '9007199254740993';
    const replacementAmount = '9007199254740991';
    await postInvoice(ownerA, suppliers.bigint, invoiceBody(sourceOperationId, amount)).expect(201);
    const edited = await editInvoice(ownerA, sourceOperationId, {
      operationId: randomUUID(),
      occurredAt: augustInstant,
      replacement: replacement(replacementAmount, { supplierId: suppliers.bigint }),
    }).expect(201);
    const response = edited.body as SupplierFinancialCorrectionResponse;
    expect(response.reversal.payableDeltaMinor).toBe(`-${amount}`);
    expect(response.family === 'invoice' ? response.replacement?.invoice.totalMinor : null).toBe(
      replacementAmount,
    );
    expect(await supplierBalance(suppliers.bigint)).toBe(replacementAmount);
  });

  it('exposes no child-line correction endpoint', async () => {
    await request(server)
      .post(`/v1/suppliers/invoice-items/${randomUUID()}/cancel`)
      .set('authorization', `Bearer ${ownerA.token}`)
      .send({ operationId: randomUUID(), occurredAt: augustInstant })
      .expect(404);
  });
});
