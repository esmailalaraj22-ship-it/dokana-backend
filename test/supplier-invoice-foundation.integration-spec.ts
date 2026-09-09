import { randomUUID } from 'node:crypto';

import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';

import { applyMigration, verifyChecksums, verifyMigrationSession } from '../scripts/migrate';
import { readMigrationFiles } from '../scripts/migrations/migration-files';
import { deriveAccountingPeriodId } from '../src/accounting-periods/accounting-period-identity';
import { resolveAccountingPeriodBoundaries } from '../src/accounting-periods/accounting-period-month';
import { purchaseInvoices, supplierLedgerEntries } from '../src/database/schema/supplier-finance';
import {
  createInventoryTestDatabase,
  setInventoryContext,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';

const migrationFilename = '0009_supplier_invoice_payable_foundation.sql';
const tables = [purchaseInvoices, supplierLedgerEntries];
const stores = [randomUUID(), randomUUID()] as const;
const users = [randomUUID(), randomUUID()] as const;
const devices = [randomUUID(), randomUUID()] as const;
const suppliers = [randomUUID(), randomUUID()] as const;
const productId = randomUUID();
const productUnitId = randomUUID();
const openPeriodId = deriveAccountingPeriodId(stores[0], 2026, 1);
const closedPeriodId = deriveAccountingPeriodId(stores[0], 2026, 2);

function postgresError(error: unknown): unknown {
  if (error instanceof Error && error.cause) return postgresError(error.cause);
  return error;
}

describe('S12.1 Supplier Invoice payable physical foundation', () => {
  jest.setTimeout(120_000);

  let database: InventoryTestDatabase | undefined;
  let client: PoolClient;
  let clientConnected = false;
  let migrationFiles: Awaited<ReturnType<typeof readMigrationFiles>> = [];

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('Supplier Invoice test database is not initialized.');
    return database;
  }

  async function rejectAtSavepoint(work: () => Promise<unknown>, code: string): Promise<void> {
    await client.query('savepoint expected_rejection');
    try {
      await expect(
        work().catch((error: unknown) => {
          throw postgresError(error);
        }),
      ).rejects.toMatchObject({ code });
    } finally {
      await client.query('rollback to savepoint expected_rejection');
    }
  }

  async function createDraftInvoice(): Promise<string> {
    const invoiceId = randomUUID();
    await client.query(
      `insert into ledger.purchase_invoices (
        id, store_id, supplier_id, display_number, invoice_date_at,
        items_subtotal_minor, line_discount_total_minor, invoice_discount_minor,
        rounding_minor, total_minor, status, device_id, operation_id
      ) values ($1, $2, $3, $4, '2026-01-15T10:00:00Z', 125, 0, 0, 0, 125,
        'draft', $5, $6)`,
      [invoiceId, stores[0], suppliers[0], `PI-${invoiceId}`, devices[0], randomUUID()],
    );
    await client.query(
      `insert into ledger.purchase_items (
        id, store_id, purchase_invoice_id, product_id, product_unit_id,
        product_name_snapshot, unit_name_snapshot, quantity_milli,
        conversion_factor_num, conversion_factor_den, base_quantity_milli,
        unit_cost_minor, line_gross_minor, line_discount_minor, rounding_minor,
        line_total_minor
      ) values ($1, $2, $3, $4, $5, 'S12.1 product', 'piece', 1000,
        1, 1, 1000, 125, 125, 0, 0, 125)`,
      [randomUUID(), stores[0], invoiceId, productId, productUnitId],
    );
    return invoiceId;
  }

  async function finalizeInvoice(
    invoiceId: string,
    status: 'open' | 'closed',
    periodId = openPeriodId,
    postingDate = '2026-01-15',
  ): Promise<void> {
    await client.query(
      `update ledger.purchase_invoices
       set status = $1, accounting_period_id = $2, posting_date = $3
       where store_id = $4 and id = $5`,
      [status, periodId, postingDate, stores[0], invoiceId],
    );
  }

  beforeAll(async () => {
    migrationFiles = await readMigrationFiles();
    database = await createInventoryTestDatabase(migrationFilename);

    const migrator = await db().migration.connect();
    try {
      await verifyMigrationSession(migrator);
      await migrator.query('begin');
      await migrator.query(db().file.contents);
      expect(
        (
          await migrator.query<{ columns: string[] }>(
            `select array_agg(attname order by attnum)::text[] as columns
             from pg_attribute
             where attrelid = 'ledger.purchase_invoices'::regclass
               and attname in ('accounting_period_id', 'posting_date')
               and not attisdropped`,
          )
        ).rows[0]?.columns,
      ).toEqual(['accounting_period_id', 'posting_date']);
      await migrator.query('rollback');
      expect(
        (
          await migrator.query<{ count: string }>(
            `select count(*) from pg_attribute
             where attrelid = 'ledger.purchase_invoices'::regclass
               and attname in ('accounting_period_id', 'posting_date')
               and not attisdropped`,
          )
        ).rows[0]?.count,
      ).toBe('0');
      await applyMigration(migrator, db().file);
    } finally {
      await migrator.query('rollback');
      await migrator.query('reset role');
      migrator.release();
    }

    for (let index = 0; index < stores.length; index += 1) {
      await db().admin.query(
        `insert into ledger.stores(id, name) values ($1, 'S12.1 isolated fixture')`,
        [stores[index]],
      );
      await db().admin.query(
        `insert into platform.users(id, email, normalized_email, full_name, password_hash)
         values ($1, $2, $2, 'S12.1 fixture', '!disabled-test-fixture')`,
        [users[index], `s121-${randomUUID()}@example.test`],
      );
      await db().admin.query(
        `insert into ledger.devices(
          id, store_id, device_name, platform, installation_id, device_prefix
        ) values ($1, $2, 'S12.1 fixture', 'android', $3, 'S121')`,
        [devices[index], stores[index], randomUUID()],
      );
      await db().admin.query(
        `insert into ledger.suppliers(id, store_id, name, normalized_name, operation_id)
         values ($1, $2, 'S12.1 supplier', $1::uuid::text, $3)`,
        [suppliers[index], stores[index], randomUUID()],
      );
    }

    await db().admin.query(
      `insert into ledger.products(
        id, store_id, name, normalized_name, measurement_type, operation_id
      ) values ($1, $2, 'S12.1 product', $1::uuid::text, 'count', $3)`,
      [productId, stores[0], randomUUID()],
    );
    await db().admin.query(
      `insert into ledger.product_units(
        id, store_id, product_id, measurement_type, unit_name, is_base,
        factor_num, factor_den, purchase_price_minor, operation_id
      ) values ($1, $2, $3, 'count', 'piece', true, 1, 1, 125, $4)`,
      [productUnitId, stores[0], productId, randomUUID()],
    );

    const january = resolveAccountingPeriodBoundaries(2026, 1);
    const february = resolveAccountingPeriodBoundaries(2026, 2);
    await db().admin.query(
      `insert into ledger.accounting_periods(
        id, store_id, period_year, period_month, starts_at, ends_at,
        status, closed_at, operation_id
      ) values
        ($1, $3, 2026, 1, $4, $5, 'open', null, $6),
        ($2, $3, 2026, 2, $7, $8, 'closed', $7, $9)`,
      [
        openPeriodId,
        closedPeriodId,
        stores[0],
        january.startsAt,
        january.endsAt,
        randomUUID(),
        february.startsAt,
        february.endsAt,
        randomUUID(),
      ],
    );
  });

  beforeEach(async () => {
    client = await db().runtime.connect();
    clientConnected = true;
    await client.query('begin');
    await setInventoryContext(client, stores[0], devices[0], users[0]);
  });

  afterEach(async () => {
    if (clientConnected) {
      await client.query('rollback');
      client.release();
      clientConnected = false;
    }
  });

  afterAll(async () => {
    if (database) await database.close();
  });

  it('applies transactionally as migration 0009 and maps its stable tables exactly', async () => {
    const applied = await db().admin.query<{ filename: string; checksumSha256: string }>(
      `select filename, checksum_sha256 as "checksumSha256"
       from platform.schema_migrations order by filename`,
    );
    expect(applied.rows).toHaveLength(9);
    expect(applied.rows.at(-1)?.filename).toBe(migrationFilename);
    expect(() => verifyChecksums(migrationFiles, applied.rows)).not.toThrow();

    for (const table of tables) {
      const config = getTableConfig(table);
      const columns = await db().admin.query<{ name: string; type: string; notNull: boolean }>(
        `select attname as name, format_type(atttypid, atttypmod) as type,
                attnotnull as "notNull"
         from pg_attribute
         where attrelid = $1::regclass and attnum > 0 and not attisdropped
         order by attnum`,
        [`ledger.${config.name}`],
      );
      expect(columns.rows).toEqual(
        config.columns.map((column) => ({
          name: column.name,
          type: column.getSQLType(),
          notNull: column.notNull,
        })),
      );

      const checks = await db().admin.query<{ name: string }>(
        `select conname as name from pg_constraint
         where conrelid = $1::regclass and contype = 'c' order by conname`,
        [`ledger.${config.name}`],
      );
      expect(checks.rows.map((row) => row.name).sort()).toEqual(
        config.checks.map((checkConstraint) => checkConstraint.name).sort(),
      );

      const foreignKeys = await db().admin.query<{ name: string }>(
        `select conname as name from pg_constraint
         where conrelid = $1::regclass and contype = 'f' order by conname`,
        [`ledger.${config.name}`],
      );
      expect(foreignKeys.rows.map((row) => row.name).sort()).toEqual(
        config.foreignKeys.map((foreignKey) => foreignKey.getName()).sort(),
      );
    }

    expect(
      (
        await db().admin.query<{ deferred: boolean; initiallyDeferred: boolean }>(
          `select condeferrable as deferred, condeferred as "initiallyDeferred"
           from pg_constraint
           where conrelid = 'ledger.supplier_ledger_entries'::regclass
             and conname = 'supplier_ledger_entries_store_id_source_purchase_invoice_i_fkey'`,
        )
      ).rows[0],
    ).toEqual({ deferred: true, initiallyDeferred: true });
  });

  it('preserves forced RLS, ownership, grants, and hardened trigger functions', async () => {
    const relations = await db().admin.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      owner: string;
    }>(
      `select relname, relrowsecurity, relforcerowsecurity,
              pg_get_userbyid(relowner) as owner
       from pg_class
       where oid = any($1::regclass[])
       order by relname`,
      [
        [
          'ledger.accounting_periods',
          'ledger.purchase_invoices',
          'ledger.purchase_items',
          'ledger.supplier_ledger_entries',
          'ledger.goods_receipts',
        ],
      ],
    );
    expect(relations.rows).toHaveLength(5);
    for (const row of relations.rows) {
      expect(row).toMatchObject({
        relrowsecurity: true,
        relforcerowsecurity: true,
        owner: 'shop_app_migrator',
      });
    }

    const functions = await db().admin.query<{
      name: string;
      securityDefiner: boolean;
      config: string[];
      owner: string;
      publicExecute: boolean;
    }>(
      `select proname as name, prosecdef as "securityDefiner", proconfig as config,
              pg_get_userbyid(proowner) as owner,
              exists(
                select 1
                from aclexplode(coalesce(proacl, acldefault('f', proowner)))
                where grantee = 0 and privilege_type = 'EXECUTE'
              ) as "publicExecute"
       from pg_proc
       where oid = any($1::regprocedure[])
       order by proname`,
      [['ledger.validate_goods_receipt_post()', 'ledger.validate_purchase_status()']],
    );
    expect(functions.rows).toEqual([
      {
        name: 'validate_goods_receipt_post',
        securityDefiner: false,
        config: ['search_path=pg_catalog, pg_temp'],
        owner: 'shop_app_migrator',
        publicExecute: false,
      },
      {
        name: 'validate_purchase_status',
        securityDefiner: false,
        config: ['search_path=pg_catalog, pg_temp'],
        owner: 'shop_app_migrator',
        publicExecute: false,
      },
    ]);

    expect(
      (
        await client.query(
          `select
            has_table_privilege(current_user, 'ledger.purchase_invoices', 'SELECT,INSERT,UPDATE') as invoice,
            has_table_privilege(current_user, 'ledger.purchase_items', 'SELECT,INSERT,UPDATE') as item,
            has_table_privilege(current_user, 'ledger.supplier_ledger_entries', 'SELECT,INSERT') as payable,
            pg_has_role(current_user, 'shop_app_migrator', 'SET') as migrator,
            (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) as unsafe`,
        )
      ).rows[0],
    ).toEqual({ invoice: true, item: true, payable: true, migrator: false, unsafe: false });

    const definitions = await db().admin.query<{ purchase: string; receipt: string }>(
      `select
        pg_get_functiondef('ledger.validate_purchase_status()'::regprocedure) as purchase,
        pg_get_functiondef('ledger.validate_goods_receipt_post()'::regprocedure) as receipt`,
    );
    expect(definitions.rows[0]?.purchase).not.toContain(
      'Purchase invoice cannot close before full receipt',
    );
    expect(definitions.rows[0]?.receipt).not.toContain(
      'Supplier payable entry does not match receipt total',
    );
  });

  it('finalizes and closes an invoice with one payable and no receipt, inventory, or money effect', async () => {
    const invoiceId = await createDraftInvoice();
    await client.query(
      `insert into ledger.supplier_ledger_entries(
        id, store_id, supplier_id, accounting_period_id, entry_type,
        payable_delta_minor, credit_delta_minor, source_purchase_invoice_id,
        reference_type, reference_id, transaction_group_id, occurred_at,
        device_id, operation_id
      ) values ($1, $2, $3, $4, 'supplier_invoice', 125, 0, $5,
        'supplier_invoice', $5, $6, '2026-01-15T10:00:00Z', $7, $8)`,
      [
        randomUUID(),
        stores[0],
        suppliers[0],
        openPeriodId,
        invoiceId,
        randomUUID(),
        devices[0],
        randomUUID(),
      ],
    );
    await finalizeInvoice(invoiceId, 'open');
    await client.query(
      `update ledger.purchase_invoices set status = 'closed'
       where store_id = $1 and id = $2`,
      [stores[0], invoiceId],
    );
    await client.query('set constraints all immediate');

    expect(
      (
        await client.query(
          `select p.status, to_char(p.posting_date, 'YYYY-MM-DD') as "postingDate",
                  o.outstanding_minor as "outstandingMinor"
           from ledger.purchase_invoices p
           join ledger.v_supplier_invoice_outstanding o
             on o.store_id = p.store_id and o.purchase_invoice_id = p.id
           where p.store_id = $1 and p.id = $2`,
          [stores[0], invoiceId],
        )
      ).rows[0],
    ).toEqual({ status: 'closed', postingDate: '2026-01-15', outstandingMinor: '125' });

    expect(
      (
        await client.query<{ effects: string }>(
          `select
            (select count(*) from ledger.goods_receipts) +
            (select count(*) from ledger.goods_receipt_items) +
            (select count(*) from ledger.inventory_movements) +
            (select count(*) from ledger.stock_balances) +
            (select count(*) from ledger.money_movements) as effects`,
        )
      ).rows[0]?.effects,
    ).toBe('0');
  });

  it('allows legacy Goods Receipt validation without creating a supplier payable', async () => {
    const receiptId = randomUUID();
    await client.query(
      `insert into ledger.goods_receipts(
        id, store_id, supplier_id, accounting_period_id, display_number,
        received_at, total_cost_minor, status, device_id, operation_id
      ) values ($1, $2, $3, $4, $5, '2026-01-15T10:00:00Z', 125,
        'draft', $6, $7)`,
      [
        receiptId,
        stores[0],
        suppliers[0],
        openPeriodId,
        `GR-${receiptId}`,
        devices[0],
        randomUUID(),
      ],
    );
    await client.query(
      `insert into ledger.goods_receipt_items(
        id, store_id, goods_receipt_id, product_id, product_unit_id,
        product_name_snapshot, unit_name_snapshot, quantity_milli,
        conversion_factor_num, conversion_factor_den, base_quantity_milli,
        unit_cost_minor, line_total_minor
      ) values ($1, $2, $3, $4, $5, 'S12.1 product', 'piece', 1000,
        1, 1, 1000, 125, 125)`,
      [randomUUID(), stores[0], receiptId, productId, productUnitId],
    );
    await client.query(
      `update ledger.goods_receipts set status = 'posted'
       where store_id = $1 and id = $2`,
      [stores[0], receiptId],
    );

    expect(
      (
        await client.query<{ status: string; payables: string; inventory: string }>(
          `select status,
             (select count(*) from ledger.supplier_ledger_entries) as payables,
             (select count(*) from ledger.inventory_movements) as inventory
           from ledger.goods_receipts where store_id = $1 and id = $2`,
          [stores[0], receiptId],
        )
      ).rows[0],
    ).toEqual({ status: 'posted', payables: '0', inventory: '0' });
  });

  it('rejects missing, closed, and out-of-period S9 posting contexts without partial finalization', async () => {
    const missingContext = await createDraftInvoice();
    await rejectAtSavepoint(
      () =>
        client.query(
          `update ledger.purchase_invoices set status = 'open'
           where store_id = $1 and id = $2`,
          [stores[0], missingContext],
        ),
      '23514',
    );

    const closedPeriod = await createDraftInvoice();
    await rejectAtSavepoint(
      () => finalizeInvoice(closedPeriod, 'open', closedPeriodId, '2026-02-15'),
      '55000',
    );

    const outsidePeriod = await createDraftInvoice();
    await rejectAtSavepoint(
      () => finalizeInvoice(outsidePeriod, 'open', openPeriodId, '2026-02-01'),
      '23514',
    );

    expect(
      (
        await client.query<{ finalized: string; payables: string }>(
          `select
            count(*) filter (where status <> 'draft') as finalized,
            (select count(*) from ledger.supplier_ledger_entries) as payables
           from ledger.purchase_invoices
           where id = any($1::uuid[])`,
          [[missingContext, closedPeriod, outsidePeriod]],
        )
      ).rows[0],
    ).toEqual({ finalized: '0', payables: '0' });
  });

  it('fails closed without tenant context and blocks cross-store writes', async () => {
    await rejectAtSavepoint(
      () =>
        client.query(
          `insert into ledger.purchase_invoices(
            id, store_id, supplier_id, display_number, invoice_date_at, operation_id
          ) values ($1, $2, $3, 'cross-store', now(), $4)`,
          [randomUUID(), stores[1], suppliers[1], randomUUID()],
        ),
      '42501',
    );

    const withoutContext = await db().runtime.connect();
    try {
      await withoutContext.query('begin');
      expect(
        (
          await withoutContext.query<{ count: string }>(
            `select count(*) from ledger.purchase_invoices`,
          )
        ).rows[0]?.count,
      ).toBe('0');
      await expect(
        withoutContext.query(
          `insert into ledger.purchase_invoices(
            id, store_id, supplier_id, display_number, invoice_date_at, operation_id
          ) values ($1, $2, $3, 'missing-context', now(), $4)`,
          [randomUUID(), stores[0], suppliers[0], randomUUID()],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await withoutContext.query('rollback');
      withoutContext.release();
    }
  });
});
