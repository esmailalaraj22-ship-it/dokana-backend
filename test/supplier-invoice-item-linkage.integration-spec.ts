import { randomUUID } from 'node:crypto';

import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';

import { applyMigration, verifyChecksums, verifyMigrationSession } from '../scripts/migrate';
import { readMigrationFiles } from '../scripts/migrations/migration-files';
import { purchaseItems } from '../src/database/schema/supplier-finance';
import {
  createInventoryTestDatabase,
  setInventoryContext,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';

const migrationFilename = '0010_supplier_invoice_optional_product_links.sql';
const stores = [randomUUID(), randomUUID()] as const;
const users = [randomUUID(), randomUUID()] as const;
const devices = [randomUUID(), randomUUID()] as const;
const suppliers = [randomUUID(), randomUUID()] as const;
const invoices = [randomUUID(), randomUUID()] as const;
const products = [randomUUID(), randomUUID()] as const;
const units = [randomUUID(), randomUUID()] as const;
const existingItemId = randomUUID();

function postgresError(error: unknown): unknown {
  if (error instanceof Error && error.cause) return postgresError(error.cause);
  return error;
}

describe('S12.3 optional Supplier Invoice Product linkage migration', () => {
  jest.setTimeout(120_000);

  let database: InventoryTestDatabase | undefined;
  let client: PoolClient;
  let clientConnected = false;
  let migrationFiles: Awaited<ReturnType<typeof readMigrationFiles>> = [];

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('Supplier Invoice linkage database is unavailable.');
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

  async function insertItem(productId: string | null, productUnitId: string | null): Promise<void> {
    await client.query(
      `insert into ledger.purchase_items(
        id, store_id, purchase_invoice_id, product_id, product_unit_id,
        product_name_snapshot, unit_name_snapshot, quantity_milli,
        conversion_factor_num, conversion_factor_den, base_quantity_milli,
        unit_cost_minor, line_gross_minor, line_discount_minor, rounding_minor,
        line_total_minor
      ) values ($1, $2, $3, $4, $5, 'Financial line', 'unit', 1000,
        1, 1, 1000, 125, 125, 0, 0, 125)`,
      [randomUUID(), stores[0], invoices[0], productId, productUnitId],
    );
  }

  beforeAll(async () => {
    migrationFiles = await readMigrationFiles();
    database = await createInventoryTestDatabase(migrationFilename);

    for (let index = 0; index < stores.length; index += 1) {
      await db().admin.query(`insert into ledger.stores(id, name) values ($1, 'S12.3 link')`, [
        stores[index],
      ]);
      await db().admin.query(
        `insert into platform.users(id, email, normalized_email, full_name, password_hash)
         values ($1, $2, $2, 'S12.3 link', '!disabled-test-fixture')`,
        [users[index], `s123-link-${randomUUID()}@example.test`],
      );
      await db().admin.query(
        `insert into ledger.devices(
          id, store_id, device_name, platform, installation_id, device_prefix
        ) values ($1, $2, 'S12.3 link', 'android', $3, 'S123')`,
        [devices[index], stores[index], randomUUID()],
      );
      await db().admin.query(
        `insert into ledger.suppliers(id, store_id, name, normalized_name, operation_id)
         values ($1, $2, 'S12.3 supplier', $1::uuid::text, $3)`,
        [suppliers[index], stores[index], randomUUID()],
      );
      await db().admin.query(
        `insert into ledger.products(
          id, store_id, name, normalized_name, measurement_type, operation_id
        ) values ($1, $2, 'S12.3 product', $1::uuid::text, 'count', $3)`,
        [products[index], stores[index], randomUUID()],
      );
      await db().admin.query(
        `insert into ledger.product_units(
          id, store_id, product_id, measurement_type, unit_name, is_base,
          factor_num, factor_den, operation_id
        ) values ($1, $2, $3, 'count', 'piece', true, 1, 1, $4)`,
        [units[index], stores[index], products[index], randomUUID()],
      );
    }
    await db().admin.query(
      `insert into ledger.purchase_invoices(
        id, store_id, supplier_id, display_number, invoice_date_at, operation_id
      ) values ($1, $2, $3, $4, '2026-07-03T10:00:00Z', $5),
               ($6, $2, $3, $7, '2026-07-04T10:00:00Z', $8)`,
      [
        invoices[0],
        stores[0],
        suppliers[0],
        `PI-${invoices[0]}`,
        randomUUID(),
        invoices[1],
        `PI-${invoices[1]}`,
        randomUUID(),
      ],
    );
    await db().admin.query(
      `insert into ledger.purchase_items(
        id, store_id, purchase_invoice_id, product_id, product_unit_id,
        product_name_snapshot, unit_name_snapshot, quantity_milli,
        conversion_factor_num, conversion_factor_den, base_quantity_milli,
        unit_cost_minor, line_gross_minor, line_total_minor
      ) values ($1, $2, $3, $4, $5, 'Existing linked line', 'piece', 1000,
        1, 1, 1000, 125, 125, 125)`,
      [existingItemId, stores[0], invoices[1], products[0], units[0]],
    );

    const migrator = await db().migration.connect();
    try {
      await verifyMigrationSession(migrator);
      await migrator.query('begin');
      await migrator.query(db().file.contents);
      expect(
        (
          await migrator.query<{ nullable: boolean }>(
            `select bool_and(not attnotnull) as nullable
             from pg_attribute
             where attrelid = 'ledger.purchase_items'::regclass
               and attname in ('product_id', 'product_unit_id') and not attisdropped`,
          )
        ).rows[0]?.nullable,
      ).toBe(true);
      await migrator.query('rollback');
      expect(
        (
          await migrator.query<{ required: boolean }>(
            `select bool_and(attnotnull) as required
             from pg_attribute
             where attrelid = 'ledger.purchase_items'::regclass
               and attname in ('product_id', 'product_unit_id') and not attisdropped`,
          )
        ).rows[0]?.required,
      ).toBe(true);
      await applyMigration(migrator, db().file);
    } finally {
      await migrator.query('rollback');
      await migrator.query('reset role');
      migrator.release();
    }
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

  it('applies as migration 0010 and maps the nullable pair exactly', async () => {
    const applied = await db().admin.query<{ filename: string; checksumSha256: string }>(
      `select filename, checksum_sha256 as "checksumSha256"
       from platform.schema_migrations order by filename`,
    );
    expect(applied.rows).toHaveLength(10);
    expect(applied.rows.at(-1)?.filename).toBe(migrationFilename);
    expect(() => verifyChecksums(migrationFiles, applied.rows)).not.toThrow();

    const config = getTableConfig(purchaseItems);
    const columns = await db().admin.query<{ name: string; notNull: boolean }>(
      `select attname as name, attnotnull as "notNull"
       from pg_attribute
       where attrelid = 'ledger.purchase_items'::regclass
         and attname in ('product_id', 'product_unit_id') and not attisdropped
       order by attnum`,
    );
    expect(columns.rows).toEqual(
      config.columns
        .filter((column) => column.name === 'product_id' || column.name === 'product_unit_id')
        .map((column) => ({ name: column.name, notNull: column.notNull })),
    );
    expect(config.checks.map((check) => check.name)).toContain(
      'purchase_items_product_link_pair_check',
    );

    const physical = await db().admin.query<{
      owner: string;
      rls: boolean;
      forceRls: boolean;
      foreignKeys: string;
      pairCheck: boolean;
      runtimeWrite: boolean;
    }>(`select
      pg_get_userbyid(c.relowner) as owner,
      c.relrowsecurity as rls,
      c.relforcerowsecurity as "forceRls",
      (select count(*) from pg_constraint where conrelid=c.oid and contype='f'
        and conname in ('purchase_items_store_id_product_id_fkey',
          'purchase_items_store_id_product_id_product_unit_id_fkey'))::text as "foreignKeys",
      exists(select 1 from pg_constraint where conrelid=c.oid
        and conname='purchase_items_product_link_pair_check' and convalidated) as "pairCheck",
      has_table_privilege('shop_app_runtime', c.oid, 'SELECT,INSERT,UPDATE') as "runtimeWrite"
      from pg_class c where c.oid='ledger.purchase_items'::regclass`);
    expect(physical.rows[0]).toEqual({
      owner: 'shop_app_migrator',
      rls: true,
      forceRls: true,
      foreignKeys: '2',
      pairCheck: true,
      runtimeWrite: true,
    });
    expect(
      (
        await client.query<{ present: boolean }>(
          `select exists(select 1 from ledger.purchase_items
           where store_id=$1 and id=$2) as present`,
          [stores[0], existingItemId],
        )
      ).rows[0]?.present,
    ).toBe(true);
  });

  it('accepts either a complete Product link or a plain-text financial line', async () => {
    await insertItem(null, null);
    await insertItem(products[0], units[0]);
    expect(
      (
        await client.query<{ count: string }>(
          `select count(*) from ledger.purchase_items
           where store_id=$1 and purchase_invoice_id=$2`,
          [stores[0], invoices[0]],
        )
      ).rows[0]?.count,
    ).toBe('2');
  });

  it('rejects either half of the Product link pair', async () => {
    await rejectAtSavepoint(() => insertItem(products[0], null), '23514');
    await rejectAtSavepoint(() => insertItem(null, units[0]), '23514');
  });

  it('preserves tenant-safe Product foreign keys and creates no inventory effect', async () => {
    await rejectAtSavepoint(() => insertItem(products[1], units[1]), '23503');
    await insertItem(null, null);
    expect(
      (
        await client.query<{ effects: string }>(
          `select (select count(*) from ledger.goods_receipts) +
                  (select count(*) from ledger.inventory_movements) +
                  (select count(*) from ledger.stock_balances) as effects`,
        )
      ).rows[0]?.effects,
    ).toBe('0');
  });
});
