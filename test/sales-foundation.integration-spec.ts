import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';

import { applyMigration, verifyChecksums, verifyMigrationSession } from '../scripts/migrate';
import { readMigrationFiles } from '../scripts/migrations/migration-files';
import { deriveAccountingPeriodId } from '../src/accounting-periods/accounting-period-identity';
import { resolveAccountingPeriodBoundaries } from '../src/accounting-periods/accounting-period-month';
import { inventoryMovements } from '../src/database/schema/inventory';
import {
  customerLedgerEntries,
  saleItems,
  salePayments,
  sales,
} from '../src/database/schema/sales';
import {
  createInventoryTestDatabase,
  setInventoryContext,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';

const migrationFilename = '0012_sales_inventory_validation.sql';
const tables = [sales, saleItems, salePayments, customerLedgerEntries];
const stores = [randomUUID(), randomUUID()] as const;
const users = [randomUUID(), randomUUID()] as const;
const devices = [randomUUID(), randomUUID()] as const;
const customers = [randomUUID(), randomUUID()] as const;
const periods = [
  deriveAccountingPeriodId(stores[0], 2026, 1),
  deriveAccountingPeriodId(stores[1], 2026, 1),
] as const;
const trackedProducts = [randomUUID(), randomUUID()] as const;
const trackedUnits = [randomUUID(), randomUUID()] as const;
const untrackedProduct = randomUUID();
const untrackedUnit = randomUUID();
const saleAt = new Date('2026-01-15T10:00:00Z');
const businessDate = '2026-01-15';

type MovementInput = typeof inventoryMovements.$inferInsert;
type SaleLine = 'tracked' | 'untracked' | 'manual';

function postgresError(error: unknown): unknown {
  if (error instanceof Error && error.cause) return postgresError(error.cause);
  return error;
}

describe('S14.2 Sale contract and physical foundation', () => {
  jest.setTimeout(120_000);

  let database: InventoryTestDatabase | undefined;
  let client: PoolClient;
  let clientConnected = false;
  let migrationFiles: Awaited<ReturnType<typeof readMigrationFiles>> = [];

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('Sale foundation test database is not initialized.');
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

  async function insertMovement(input: MovementInput): Promise<void> {
    try {
      await drizzle(client).insert(inventoryMovements).values(input);
    } catch (error) {
      throw postgresError(error);
    }
  }

  async function seedTrackedStock(productIndex: 0 | 1): Promise<void> {
    await insertMovement({
      id: randomUUID(),
      storeId: stores[0],
      productId: trackedProducts[productIndex],
      productUnitId: trackedUnits[productIndex],
      accountingPeriodId: periods[0],
      movementType: 'adjustment_in',
      selectedQuantityMilli: 5000n,
      factorNum: 1,
      factorDen: 1,
      quantityBeforeMilli: 0n,
      quantityDeltaMilli: 5000n,
      quantityAfterMilli: 5000n,
      inventoryValueBeforeMinor: 0n,
      valueDeltaMinor: 500n,
      inventoryValueAfterMinor: 500n,
      averageUnitCostAfterMinor: 100n,
      costStatus: 'known',
      costStateBefore: 'known',
      costStateAfter: 'known',
      hasPendingCostAfter: false,
      referenceType: 's14_2_stock_fixture',
      referenceId: randomUUID(),
      transactionGroupId: randomUUID(),
      occurredAt: saleAt,
      businessDate,
      postingDate: businessDate,
      deviceId: devices[0],
      operationId: randomUUID(),
    });
  }

  async function createCreditSale(line: SaleLine): Promise<{ saleId: string; itemId: string }> {
    const saleId = randomUUID();
    const itemId = randomUUID();
    const tracked = line === 'tracked';
    const productId = tracked ? trackedProducts[0] : line === 'untracked' ? untrackedProduct : null;
    const productUnitId = tracked ? trackedUnits[0] : line === 'untracked' ? untrackedUnit : null;

    await client.query(
      `insert into ledger.sales (
        id, store_id, customer_id, accounting_period_id, display_number, sale_at,
        items_subtotal_minor, line_discount_total_minor, invoice_discount_minor,
        rounding_minor, total_minor, paid_total_minor, credit_total_minor,
        known_cost_total_minor, pending_cost_line_count, unknown_cost_line_count,
        payment_status, status, device_id, operation_id
      ) values (
        $1, $2, $3, $4, $5, $6,
        100, 0, 0, 0, 100, 0, 100,
        $7, 0, $8, 'credit', 'draft', $9, $10
      )`,
      [
        saleId,
        stores[0],
        customers[0],
        periods[0],
        `S142-${saleId}`,
        saleAt,
        tracked ? 100 : 0,
        tracked ? 0 : 1,
        devices[0],
        randomUUID(),
      ],
    );

    await client.query(
      `insert into ledger.sale_items (
        id, store_id, sale_id, product_id, product_unit_id, is_manual_line,
        product_name_snapshot, unit_name_snapshot, quantity_milli,
        conversion_factor_num, conversion_factor_den, base_quantity_milli,
        unit_price_minor, line_gross_minor, line_discount_minor, rounding_minor,
        line_total_minor, cost_status, unit_cost_minor, line_cost_minor
      ) values (
        $1, $2, $3, $4, $5, $6,
        $7, $8, 1000, 1, 1, $9,
        100, 100, 0, 0, 100, $10, $11, $12
      )`,
      [
        itemId,
        stores[0],
        saleId,
        productId,
        productUnitId,
        line === 'manual',
        line === 'manual' ? 'Manual service' : 'Product snapshot',
        line === 'manual' ? null : 'piece',
        line === 'manual' ? null : 1000,
        tracked ? 'known' : 'unknown',
        tracked ? 100 : null,
        tracked ? 100 : null,
      ],
    );

    await client.query(
      `insert into ledger.customer_ledger_entries (
        id, store_id, customer_id, accounting_period_id, entry_type,
        receivable_delta_minor, credit_delta_minor, source_sale_id,
        reference_type, reference_id, transaction_group_id, occurred_at,
        device_id, operation_id
      ) values (
        $1, $2, $3, $4, 'sale_credit', 100, 0, $5,
        'sale', $5, $6, $7, $8, $9
      )`,
      [
        randomUUID(),
        stores[0],
        customers[0],
        periods[0],
        saleId,
        randomUUID(),
        saleAt,
        devices[0],
        randomUUID(),
      ],
    );
    return { saleId, itemId };
  }

  async function addSaleMovement(
    saleId: string,
    itemId: string,
    productIndex: 0 | 1,
    linkToItem = true,
  ): Promise<string> {
    const movementId = randomUUID();
    await insertMovement({
      id: movementId,
      storeId: stores[0],
      productId: trackedProducts[productIndex],
      productUnitId: trackedUnits[productIndex],
      accountingPeriodId: periods[0],
      movementType: 'sale',
      selectedQuantityMilli: 1000n,
      factorNum: 1,
      factorDen: 1,
      quantityBeforeMilli: 5000n,
      quantityDeltaMilli: -1000n,
      quantityAfterMilli: 4000n,
      inventoryValueBeforeMinor: 500n,
      valueDeltaMinor: -100n,
      inventoryValueAfterMinor: 400n,
      averageUnitCostAfterMinor: 100n,
      costStatus: 'known',
      costStateBefore: 'known',
      costStateAfter: 'known',
      hasPendingCostAfter: false,
      referenceType: 'sale',
      referenceId: saleId,
      transactionGroupId: randomUUID(),
      occurredAt: saleAt,
      businessDate,
      postingDate: businessDate,
      deviceId: devices[0],
      operationId: randomUUID(),
    });
    if (linkToItem) {
      await client.query(
        `update ledger.sale_items set inventory_movement_id = $1
         where store_id = $2 and id = $3`,
        [movementId, stores[0], itemId],
      );
    }
    return movementId;
  }

  async function postSale(saleId: string): Promise<void> {
    await client.query(
      `update ledger.sales set status = 'posted' where store_id = $1 and id = $2`,
      [stores[0], saleId],
    );
  }

  beforeAll(async () => {
    migrationFiles = await readMigrationFiles();
    database = await createInventoryTestDatabase(migrationFilename);

    const migrator = await db().migration.connect();
    try {
      await verifyMigrationSession(migrator);
      const original = await migrator.query<{ definition: string }>(
        `select pg_get_functiondef('ledger.validate_sale_post()'::regprocedure) as definition`,
      );
      expect(original.rows[0]?.definition).toContain(
        'Tracked sale items require inventory movements',
      );
      expect(original.rows[0]?.definition).not.toContain('track_inventory');

      await migrator.query('begin');
      await migrator.query(db().file.contents);
      expect(
        (
          await migrator.query<{ definition: string }>(
            `select pg_get_functiondef('ledger.validate_sale_post()'::regprocedure) as definition`,
          )
        ).rows[0]?.definition,
      ).toContain('product_state.track_inventory');
      await migrator.query('rollback');

      expect(
        (
          await migrator.query<{ definition: string }>(
            `select pg_get_functiondef('ledger.validate_sale_post()'::regprocedure) as definition`,
          )
        ).rows[0]?.definition,
      ).not.toContain('track_inventory');
      await applyMigration(migrator, db().file);
    } finally {
      await migrator.query('rollback');
      await migrator.query('reset role');
      migrator.release();
    }

    const boundaries = resolveAccountingPeriodBoundaries(2026, 1);
    for (let index = 0; index < stores.length; index += 1) {
      await db().admin.query(
        `insert into ledger.stores(id, name) values ($1, 'S14.2 isolated fixture')`,
        [stores[index]],
      );
      await db().admin.query(`insert into ledger.app_settings(store_id) values ($1)`, [
        stores[index],
      ]);
      await db().admin.query(
        `insert into platform.users(id, email, normalized_email, full_name, password_hash)
         values ($1, $2, $2, 'S14.2 fixture', '!disabled-test-fixture')`,
        [users[index], `s142-${randomUUID()}@example.test`],
      );
      await db().admin.query(
        `insert into ledger.devices(
          id, store_id, device_name, platform, installation_id, device_prefix
        ) values ($1, $2, 'S14.2 fixture', 'android', $3, $4)`,
        [devices[index], stores[index], randomUUID(), `S14${String(index)}`],
      );
      await db().admin.query(
        `insert into ledger.customers(
          id, store_id, name, normalized_name, phone, normalized_phone,
          credit_policy, device_id, operation_id
        ) values ($1, $2, 'S14.2 customer', $1::uuid::text, $3, $3, 'allow', $4, $5)`,
        [
          customers[index],
          stores[index],
          `+97059000000${String(index)}`,
          devices[index],
          randomUUID(),
        ],
      );
      await db().admin.query(
        `insert into ledger.accounting_periods(
          id, store_id, period_year, period_month, starts_at, ends_at, status, operation_id
        ) values ($1, $2, 2026, 1, $3, $4, 'open', $5)`,
        [periods[index], stores[index], boundaries.startsAt, boundaries.endsAt, randomUUID()],
      );
    }

    for (let index = 0; index < trackedProducts.length; index += 1) {
      await db().admin.query(
        `insert into ledger.products(
          id, store_id, name, normalized_name, measurement_type,
          track_inventory, status, operation_id
        ) values ($1, $2, $1::uuid::text, $1::uuid::text, 'count', true, 'active', $3)`,
        [trackedProducts[index], stores[0], randomUUID()],
      );
      await db().admin.query(
        `insert into ledger.product_units(
          id, store_id, product_id, measurement_type, unit_name, is_base,
          factor_num, factor_den, status, operation_id
        ) values ($1, $2, $3, 'count', 'piece', true, 1, 1, 'active', $4)`,
        [trackedUnits[index], stores[0], trackedProducts[index], randomUUID()],
      );
    }
    await db().admin.query(
      `insert into ledger.products(
        id, store_id, name, normalized_name, measurement_type,
        track_inventory, status, operation_id
      ) values ($1, $2, $1::uuid::text, $1::uuid::text, 'count', false, 'active', $3)`,
      [untrackedProduct, stores[0], randomUUID()],
    );
    await db().admin.query(
      `insert into ledger.product_units(
        id, store_id, product_id, measurement_type, unit_name, is_base,
        factor_num, factor_den, status, operation_id
      ) values ($1, $2, $3, 'count', 'piece', true, 1, 1, 'active', $4)`,
      [untrackedUnit, stores[0], untrackedProduct, randomUUID()],
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

  it('applies transactionally as migration 0012 and maps the required Sale tables exactly', async () => {
    const applied = await db().admin.query<{ filename: string; checksumSha256: string }>(
      `select filename, checksum_sha256 as "checksumSha256"
       from platform.schema_migrations order by filename`,
    );
    expect(applied.rows).toHaveLength(12);
    expect(applied.rows.at(-1)?.filename).toBe(migrationFilename);
    expect(() => verifyChecksums(migrationFiles, applied.rows)).not.toThrow();
    expect(db().file.contents).not.toMatch(/^\s*(?:alter|create|drop|truncate)\s+table\b/im);
    expect(db().file.contents).not.toMatch(
      /^\s*(?:insert\s+into|update|delete\s+from)\s+ledger\./im,
    );

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
        config.checks.map((constraint) => constraint.name).sort(),
      );

      const foreignKeys = await db().admin.query<{ name: string }>(
        `select conname as name from pg_constraint
         where conrelid = $1::regclass and contype = 'f' order by conname`,
        [`ledger.${config.name}`],
      );
      expect(foreignKeys.rows.map((row) => row.name).sort()).toEqual(
        config.foreignKeys.map((foreignKey) => foreignKey.getName()).sort(),
      );

      const uniqueConstraints = await db().admin.query<{ name: string }>(
        `select conname as name from pg_constraint
         where conrelid = $1::regclass and contype = 'u' order by conname`,
        [`ledger.${config.name}`],
      );
      expect(uniqueConstraints.rows.map((row) => row.name).sort()).toEqual(
        config.uniqueConstraints.map((constraint) => constraint.name).sort(),
      );

      const indexes = await db().admin.query<{ name: string }>(
        `select index_relation.relname as name
         from pg_index index_state
         join pg_class index_relation on index_relation.oid = index_state.indexrelid
         where index_state.indrelid = $1::regclass
           and not index_state.indisprimary
           and not exists (
             select 1 from pg_constraint constraint_state
             where constraint_state.conindid = index_state.indexrelid
           )
         order by index_relation.relname`,
        [`ledger.${config.name}`],
      );
      expect(indexes.rows.map((row) => row.name)).toEqual(
        config.indexes.map((indexDefinition) => indexDefinition.config.name).sort(),
      );
    }

    expect(
      (
        await db().admin.query<{ deferred: boolean; initiallyDeferred: boolean }>(
          `select condeferrable as deferred, condeferred as "initiallyDeferred"
           from pg_constraint
           where conrelid = 'ledger.customer_ledger_entries'::regclass
             and conname = 'customer_ledger_entries_store_id_source_sale_id_fkey'`,
        )
      ).rows[0],
    ).toEqual({ deferred: true, initiallyDeferred: true });
  });

  it('preserves forced RLS, least-privilege ownership, trigger wiring, and function hardening', async () => {
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
          'ledger.sales',
          'ledger.sale_items',
          'ledger.sale_payments',
          'ledger.customer_ledger_entries',
          'ledger.products',
          'ledger.inventory_movements',
          'ledger.money_movements',
        ],
      ],
    );
    expect(relations.rows).toHaveLength(7);
    for (const row of relations.rows) {
      expect(row).toMatchObject({
        relrowsecurity: true,
        relforcerowsecurity: true,
        owner: 'shop_app_migrator',
      });
    }

    expect(
      (
        await db().admin.query(
          `select p.prosecdef as "securityDefiner", p.proconfig as config,
                  pg_get_userbyid(p.proowner) as owner,
                  not has_function_privilege('public', p.oid, 'execute') as "noPublicExecute",
                  not has_function_privilege('shop_app_runtime', p.oid, 'execute') as "noRuntimeExecute",
                  exists (
                    select 1 from pg_trigger
                    where tgrelid = 'ledger.sales'::regclass
                      and tgname = 'trg_sales_post_validate'
                      and tgfoid = p.oid and tgenabled = 'O' and not tgisinternal
                  ) as "triggerIntact"
           from pg_proc p
           where p.oid = 'ledger.validate_sale_post()'::regprocedure`,
        )
      ).rows[0],
    ).toEqual({
      securityDefiner: false,
      config: ['search_path=pg_catalog, pg_temp'],
      owner: 'shop_app_migrator',
      noPublicExecute: true,
      noRuntimeExecute: true,
      triggerIntact: true,
    });
  });

  it('posts a tracked Product line only with its exact S11 inventory decrement', async () => {
    await seedTrackedStock(0);
    const sale = await createCreditSale('tracked');
    const movementId = await addSaleMovement(sale.saleId, sale.itemId, 0);
    await postSale(sale.saleId);

    expect(
      (
        await client.query(
          `select s.status, i.inventory_movement_id as "movementId",
                  b.quantity_milli as "quantityMilli", b.inventory_value_minor as "valueMinor"
           from ledger.sales s
           join ledger.sale_items i on i.store_id = s.store_id and i.sale_id = s.id
           join ledger.stock_balances b on b.store_id = i.store_id and b.product_id = i.product_id
           where s.store_id = $1 and s.id = $2`,
          [stores[0], sale.saleId],
        )
      ).rows[0],
    ).toEqual({ status: 'posted', movementId, quantityMilli: '4000', valueMinor: '400' });
  });

  it('rejects a tracked Product line with a missing or mismatched inventory movement', async () => {
    await seedTrackedStock(0);
    const missing = await createCreditSale('tracked');
    await rejectAtSavepoint(() => postSale(missing.saleId), '23514');

    await seedTrackedStock(1);
    const mismatched = await createCreditSale('tracked');
    await addSaleMovement(mismatched.saleId, mismatched.itemId, 1);
    await rejectAtSavepoint(() => postSale(mismatched.saleId), '23514');
  });

  it('posts an untracked Product line without inventory and rejects an attached movement', async () => {
    const valid = await createCreditSale('untracked');
    await postSale(valid.saleId);
    expect(
      (
        await client.query(`select status from ledger.sales where store_id = $1 and id = $2`, [
          stores[0],
          valid.saleId,
        ])
      ).rows[0],
    ).toEqual({ status: 'posted' });

    await seedTrackedStock(1);
    const invalid = await createCreditSale('untracked');
    await rejectAtSavepoint(async () => {
      await addSaleMovement(invalid.saleId, invalid.itemId, 1);
      return postSale(invalid.saleId);
    }, '23514');

    const unlinked = await createCreditSale('untracked');
    await rejectAtSavepoint(async () => {
      await addSaleMovement(unlinked.saleId, unlinked.itemId, 1, false);
      return postSale(unlinked.saleId);
    }, '23514');
  });

  it('posts a manual line without an inventory movement', async () => {
    const sale = await createCreditSale('manual');
    await postSale(sale.saleId);
    expect(
      (
        await client.query(
          `select s.status, i.is_manual_line as "manual", i.inventory_movement_id as "movementId"
           from ledger.sales s join ledger.sale_items i
             on i.store_id = s.store_id and i.sale_id = s.id
           where s.store_id = $1 and s.id = $2`,
          [stores[0], sale.saleId],
        )
      ).rows[0],
    ).toEqual({ status: 'posted', manual: true, movementId: null });
  });

  it('continues to fail closed for cross-store runtime access', async () => {
    await rejectAtSavepoint(
      () =>
        client.query(
          `insert into ledger.sales(
            id, store_id, accounting_period_id, display_number, sale_at,
            total_minor, paid_total_minor, credit_total_minor, status,
            device_id, operation_id
          ) values ($1, $2, $3, $4, $5, 0, 0, 0, 'draft', $6, $7)`,
          [
            randomUUID(),
            stores[1],
            periods[1],
            `CROSS-${randomUUID()}`,
            saleAt,
            devices[1],
            randomUUID(),
          ],
        ),
      '42501',
    );
  });
});
