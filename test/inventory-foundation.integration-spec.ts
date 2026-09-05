import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';

import { applyMigration, verifyChecksums, verifyMigrationSession } from '../scripts/migrate';
import { readMigrationFiles } from '../scripts/migrations/migration-files';
import { verifyApplicationInventory } from '../scripts/migrations/verify-application-inventory';
import { deriveAccountingPeriodId } from '../src/accounting-periods/accounting-period-identity';
import { resolveAccountingPeriodBoundaries } from '../src/accounting-periods/accounting-period-month';
import {
  inventoryMovements,
  manualInventoryEntries,
  stockBalances,
  stockCountItems,
  stockCounts,
} from '../src/database/schema/inventory';
import {
  createInventoryTestDatabase,
  inventoryMigrationFilename,
  setInventoryContext,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';

const tables = [
  inventoryMovements,
  stockBalances,
  manualInventoryEntries,
  stockCounts,
  stockCountItems,
];
const stores = [randomUUID(), randomUUID()] as const;
const devices = [randomUUID(), randomUUID()] as const;
const users = [randomUUID(), randomUUID()] as const;
const periodId = deriveAccountingPeriodId(stores[0], 2026, 1);
const at = new Date('2026-01-15T10:00:00Z');
const day = '2026-01-15';
const int8max = 9223372036854775807n;

interface ProductFixture {
  productId: string;
  productUnitId: string;
  factorNum: number;
  factorDen: number;
}
type MovementInput = typeof inventoryMovements.$inferInsert;
type EntryInput = typeof manualInventoryEntries.$inferInsert;

function postgresError(error: unknown): unknown {
  if (error instanceof Error && error.cause) return postgresError(error.cause);
  return error;
}

describe('S11.2 inventory physical foundation on isolated real PostgreSQL', () => {
  jest.setTimeout(120_000);
  let database: InventoryTestDatabase | undefined;
  let client: PoolClient;
  let clientConnected = false;
  let product: ProductFixture;

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('Inventory test database is not initialized.');
    return database;
  }

  async function createProduct(
    options: {
      store?: number;
      family?: 'count' | 'weight' | 'volume' | 'length';
      active?: boolean;
      tracked?: boolean;
      unitActive?: boolean;
      num?: number;
      den?: number;
      override?: boolean | null;
    } = {},
  ): Promise<ProductFixture> {
    const index = options.store ?? 0;
    const fixture = {
      productId: randomUUID(),
      productUnitId: randomUUID(),
      factorNum: options.num ?? 1,
      factorDen: options.den ?? 1,
    };
    await db().admin.query(
      `insert into ledger.products
      (id, store_id, name, normalized_name, measurement_type, track_inventory, status, archived_at,
       allow_negative_stock_override, operation_id)
      values ($1::uuid, $2, $1::uuid::text, $1::uuid::text, $3, $4, $5, case when $5 = 'archived' then now() end, $6, $7)`,
      [
        fixture.productId,
        stores[index],
        options.family ?? 'count',
        options.tracked ?? true,
        options.active === false ? 'archived' : 'active',
        options.override ?? null,
        randomUUID(),
      ],
    );
    await db().admin.query(
      `insert into ledger.product_units
      (id, store_id, product_id, measurement_type, unit_name, is_base, factor_num, factor_den,
       status, purchase_price_minor, operation_id)
      values ($1, $2, $3, $4, 'fixture unit', $5, $6, $7, $8, 999999, $9)`,
      [
        fixture.productUnitId,
        stores[index],
        fixture.productId,
        options.family ?? 'count',
        fixture.factorNum === 1 && fixture.factorDen === 1,
        fixture.factorNum,
        fixture.factorDen,
        options.unitActive === false ? 'archived' : 'active',
        randomUUID(),
      ],
    );
    return fixture;
  }

  function movement(overrides: Partial<MovementInput> = {}, item = product): MovementInput {
    return {
      id: randomUUID(),
      storeId: stores[0],
      ...item,
      accountingPeriodId: periodId,
      movementType: 'adjustment_in',
      selectedQuantityMilli: 1000n,
      quantityBeforeMilli: 0n,
      quantityDeltaMilli: 1000n,
      quantityAfterMilli: 1000n,
      inventoryValueBeforeMinor: 0n,
      valueDeltaMinor: 0n,
      inventoryValueAfterMinor: 0n,
      averageUnitCostAfterMinor: 0n,
      costStatus: 'known',
      costStateBefore: 'known',
      costStateAfter: 'known',
      hasPendingCostAfter: false,
      referenceType: 's112_fixture',
      referenceId: randomUUID(),
      transactionGroupId: randomUUID(),
      occurredAt: at,
      businessDate: day,
      postingDate: day,
      deviceId: devices[0],
      operationId: randomUUID(),
      ...overrides,
    };
  }

  async function insertMovement(input: MovementInput, target = client): Promise<void> {
    try {
      await drizzle(target).insert(inventoryMovements).values(input);
    } catch (error) {
      throw postgresError(error);
    }
  }

  async function insertEntry(
    cost: bigint | null,
    overrides: Partial<EntryInput> = {},
  ): Promise<EntryInput> {
    const id = randomUUID();
    const operationId = randomUUID();
    const m = movement({
      referenceType: 'manual_inventory_entry',
      referenceId: id,
      transactionGroupId: operationId,
      costStatus: cost === null ? 'unknown' : 'known',
      costStateAfter: cost === null ? 'unknown' : 'known',
      valueDeltaMinor: cost ?? 0n,
      inventoryValueAfterMinor: cost ?? 0n,
      averageUnitCostAfterMinor: cost ?? 0n,
    });
    const entry: EntryInput = {
      id,
      storeId: stores[0],
      operationId,
      ...product,
      selectedQuantityMilli: 1000n,
      baseQuantityMilli: 1000n,
      totalPurchaseCostMinor: cost,
      costStatus: cost === null ? 'unknown' : 'known',
      occurredAt: at,
      businessDate: day,
      postingDate: day,
      accountingPeriodId: periodId,
      movementId: m.id,
      transactionGroupId: operationId,
      deviceId: devices[0],
      ...overrides,
    };
    await drizzle(client).insert(manualInventoryEntries).values(entry);
    await insertMovement(m);
    return entry;
  }

  async function projection(target = client) {
    return (
      await drizzle(target)
        .select()
        .from(stockBalances)
        .where(eq(stockBalances.productId, product.productId))
    )[0];
  }

  async function reject(work: () => Promise<unknown>, code: string): Promise<void> {
    await client.query('savepoint rejection');
    try {
      await expect(
        work().catch((error: unknown) => {
          throw postgresError(error);
        }),
      ).rejects.toMatchObject({ code });
    } finally {
      await client.query('rollback to savepoint rejection');
    }
  }

  beforeAll(async () => {
    database = await createInventoryTestDatabase();
    const inventoryInspector = await db().admin.connect();
    try {
      await verifyApplicationInventory(inventoryInspector, 'shop_app_migrator', true);
    } finally {
      inventoryInspector.release();
    }
    const migrator = await db().migration.connect();
    try {
      await verifyMigrationSession(migrator);
      // SQL and privilege changes roll back together before registration.
      await migrator.query('begin');
      await migrator.query(db().file.contents);
      expect(
        (
          await migrator.query(
            `select to_regclass('ledger.manual_inventory_entries') is not null as present`,
          )
        ).rows[0],
      ).toEqual({ present: true });
      await migrator.query('rollback');
      expect(
        (
          await migrator.query(
            `select to_regclass('ledger.manual_inventory_entries') is null as absent`,
          )
        ).rows[0],
      ).toEqual({ absent: true });
      expect(
        (
          await migrator.query(
            `select has_table_privilege('shop_app_runtime', 'ledger.stock_balances', 'UPDATE') as allowed`,
          )
        ).rows[0],
      ).toEqual({ allowed: true });
      const legacyStore = randomUUID();
      const legacyProduct = randomUUID();
      await db().admin.query(
        `insert into ledger.stock_balances(store_id, product_id, quantity_milli) values ($1, $2, 10)`,
        [legacyStore, legacyProduct],
      );
      await expect(applyMigration(migrator, db().file)).rejects.toMatchObject({ code: '23502' });
      expect(
        (
          await migrator.query(
            `select to_regclass('ledger.manual_inventory_entries') is null as absent`,
          )
        ).rows[0],
      ).toEqual({ absent: true });
      await db().admin.query('delete from ledger.stock_balances where store_id = $1', [
        legacyStore,
      ]);
      await applyMigration(migrator, db().file);
    } finally {
      await migrator.query('rollback');
      await migrator.query('reset role');
      migrator.release();
    }
    for (let i = 0; i < 2; i++) {
      await db().admin.query(
        `insert into ledger.stores(id, name) values ($1, 'S11.2 isolated fixture')`,
        [stores[i]],
      );
      await db().admin.query(`insert into ledger.app_settings(store_id) values ($1)`, [stores[i]]);
      await db().admin.query(
        `insert into platform.users(id, email, normalized_email, full_name, password_hash)
        values ($1, $2, $2, 'S11.2 fixture', '!disabled-test-fixture')`,
        [users[i], `s112-${randomUUID()}@example.test`],
      );
      await db().admin.query(
        `insert into ledger.devices(id, store_id, device_name, platform, installation_id, device_prefix)
        values ($1, $2, 'S11.2 fixture', 'android', $3, 'S112')`,
        [devices[i], stores[i], randomUUID()],
      );
    }
    const bounds = resolveAccountingPeriodBoundaries(2026, 1);
    await db().admin.query(
      `insert into ledger.accounting_periods
      (id, store_id, period_year, period_month, starts_at, ends_at, operation_id)
      values ($1, $2, 2026, 1, $3, $4, $5)`,
      [periodId, stores[0], bounds.startsAt, bounds.endsAt, randomUUID()],
    );
  });

  beforeEach(async () => {
    product = await createProduct();
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

  it('applies the previous-version upgrade transactionally with an exact ledger checksum', async () => {
    const rows = await db().admin.query<{ filename: string; checksumSha256: string }>(
      `select filename, checksum_sha256 as "checksumSha256" from platform.schema_migrations order by filename`,
    );
    expect(rows.rows).toHaveLength(7);
    expect(rows.rows.at(-1)?.filename).toBe(inventoryMigrationFilename);
    expect(() => verifyChecksums(awaitedFiles, rows.rows)).not.toThrow();
    const inspector = await db().admin.connect();
    try {
      await verifyApplicationInventory(inspector, 'shop_app_migrator', true);
    } finally {
      inspector.release();
    }
  });

  // Read files outside assertions so failures retain their original diagnostic.
  let awaitedFiles: Awaited<ReturnType<typeof readMigrationFiles>> = [];
  beforeAll(async () => {
    awaitedFiles = await readMigrationFiles();
  });

  it.each(tables)(
    'maps PostgreSQL columns, nullability and relationship names exactly',
    async (table) => {
      const config = getTableConfig(table);
      const columns = await db().admin.query<{ name: string; type: string; notNull: boolean }>(
        `
      select attname as name, format_type(atttypid, atttypmod) as type, attnotnull as "notNull"
      from pg_attribute where attrelid = $1::regclass and attnum > 0 and not attisdropped order by attnum`,
        [`ledger.${config.name}`],
      );
      expect(columns.rows).toEqual(
        config.columns.map((c) => ({ name: c.name, type: c.getSQLType(), notNull: c.notNull })),
      );
      const checks = await db().admin.query<{ name: string }>(
        `select conname as name from pg_constraint where conrelid = $1::regclass and contype = 'c' order by conname`,
        [`ledger.${config.name}`],
      );
      expect(checks.rows.map((r) => r.name).sort()).toEqual(
        config.checks.map((c) => c.name).sort(),
      );
      const keys = await db().admin.query<{ name: string }>(
        `select conname as name from pg_constraint where conrelid = $1::regclass and contype = 'f' order by conname`,
        [`ledger.${config.name}`],
      );
      expect(keys.rows.map((r) => r.name).sort()).toEqual(
        config.foreignKeys.map((key) => key.getName()).sort(),
      );
    },
  );

  it('forces tenant RLS on all five tables and keeps the non-login owner', async () => {
    const state = await db().admin.query(
      `select relname, relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner) as owner
      from pg_class where oid = any($1::regclass[])`,
      [tables.map((t) => `ledger.${getTableConfig(t).name}`)],
    );
    expect(state.rows).toHaveLength(5);
    for (const row of state.rows)
      expect(row).toMatchObject({
        relrowsecurity: true,
        relforcerowsecurity: true,
        owner: 'shop_app_migrator',
      });
    expect(
      (
        await client.query(
          `select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
        )
      ).rows[0],
    ).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('pins the projection definer, excludes PUBLIC, and grants only the runtime trigger path', async () => {
    const state = await db().admin
      .query(`select prosecdef, proconfig, pg_get_userbyid(proowner) as owner,
      exists(select 1 from aclexplode(coalesce(proacl, acldefault('f', proowner))) where grantee = 0 and privilege_type = 'EXECUTE') as public
      from pg_proc where oid = 'ledger.apply_inventory_movement()'::regprocedure`);
    expect(state.rows[0]).toEqual({
      prosecdef: true,
      proconfig: ['search_path=pg_catalog, pg_temp'],
      owner: 'shop_app_migrator',
      public: false,
    });
    expect(
      (
        await client.query(`select has_function_privilege(current_user, 'ledger.apply_inventory_movement()', 'EXECUTE') as execute,
      has_schema_privilege(current_user, 'platform', 'USAGE') as platform,
      has_schema_privilege(current_user, 'audit', 'USAGE') as audit,
      pg_has_role(current_user, 'shop_app_migrator', 'SET') as migrator`)
      ).rows[0],
    ).toEqual({ execute: true, platform: false, audit: false, migrator: false });
    await reject(() => client.query('select ledger.apply_inventory_movement()'), '0A000');
  });

  it.each(['insert', 'update', 'delete'] as const)(
    'denies direct runtime projection %s',
    async (command) => {
      const queries = {
        insert: `insert into ledger.stock_balances(store_id, product_id, cost_state) values ($1, $2, 'known')`,
        update: `update ledger.stock_balances set quantity_milli = 1000 where store_id = $1 and product_id = $2`,
        delete: `delete from ledger.stock_balances where store_id = $1 and product_id = $2`,
      };
      await reject(() => client.query(queries[command], [stores[0], product.productId]), '42501');
    },
  );

  it('maintains the projection atomically and emits existing audit/change records', async () => {
    const entry = await insertEntry(0n);
    await client.query('set constraints all immediate');
    expect(await projection()).toMatchObject({
      quantityMilli: 1000n,
      inventoryValueMinor: 0n,
      averageUnitCostMinor: 0n,
      costState: 'known',
      lastMovementId: entry.movementId,
    });
    expect(
      (
        await client.query(
          `select count(*)::int as count from sync.change_events where entity_id = any($1::uuid[])`,
          [[entry.id, entry.movementId]],
        )
      ).rows[0],
    ).toEqual({ count: 2 });
    // Audit is intentionally inaccessible to runtime; inspect via admin after an
    // explicit commit, then the disposable database is removed at suite teardown.
    await client.query('commit');
    expect(
      (
        await db().admin.query(
          `select count(*)::int as count from audit.central_audit_logs where entity_id = any($1::uuid[])`,
          [[entry.id, entry.movementId]],
        )
      ).rows[0],
    ).toEqual({ count: 2 });
    await client.query('begin');
    await setInventoryContext(client, stores[0], devices[0], users[0]);
  });

  it.each(['app.store_id', 'app.user_id', 'app.device_id', 'app.request_id'])(
    'rejects writes with missing %s',
    async (setting) => {
      await client.query(`select set_config($1, '', true)`, [setting]);
      await reject(() => insertMovement(movement()), '42501');
      if (setting === 'app.store_id') {
        for (const table of tables) expect(await drizzle(client).select().from(table)).toEqual([]);
      }
    },
  );

  it('rejects cross-store writes without exposing other tenant data', async () => {
    const foreign = await createProduct({ store: 1 });
    await reject(
      () => insertMovement(movement({ storeId: stores[1], deviceId: devices[1] }, foreign)),
      '42501',
    );
    await reject(() => insertMovement(movement({}, foreign)), '23514');
    await reject(() => insertEntry(0n, { deviceId: devices[1] }), '23503');
    await setInventoryContext(client, stores[1], devices[1], users[1]);
    for (const table of tables) expect(await drizzle(client).select().from(table)).toEqual([]);
  });

  it('cannot hijack the definer through search_path or temporary relation names', async () => {
    await client.query(`create temporary table stock_balances(quantity_milli bigint)`);
    await client.query(`create temporary table products(id uuid)`);
    await client.query('set local search_path = pg_temp, ledger, pg_catalog');
    await insertMovement(movement());
    await client.query('set constraints all immediate');
    expect(await projection()).toMatchObject({ quantityMilli: 1000n });
    expect(
      (await client.query('select count(*)::int as count from pg_temp.stock_balances')).rows[0],
    ).toEqual({ count: 0 });
  });

  it.each([
    ['archived Product', { active: false }],
    ['untracked Product', { tracked: false }],
    ['archived unit', { unitActive: false }],
  ] as const)('rejects %s on the authoritative path', async (_label, options) => {
    const invalid = await createProduct(options);
    await reject(() => insertMovement(movement({}, invalid)), '23514');
    expect(await projection()).toBeUndefined();
  });

  it('rejects a unit from another Product and stale factor snapshots', async () => {
    const other = await createProduct();
    await reject(() => insertMovement(movement({ productUnitId: other.productUnitId })), '23514');
    await reject(() => insertMovement(movement({ factorNum: 2 })), '23514');
  });

  it.each(['count', 'weight', 'volume', 'length'] as const)(
    'preserves exact %s conversion',
    async (family) => {
      const item = await createProduct({ family, num: 24 });
      await insertMovement(
        movement(
          { selectedQuantityMilli: 3000n, quantityDeltaMilli: 72000n, quantityAfterMilli: 72000n },
          item,
        ),
      );
      expect(
        (
          await drizzle(client)
            .select()
            .from(stockBalances)
            .where(eq(stockBalances.productId, item.productId))
        )[0]?.quantityMilli,
      ).toBe(72000n);
    },
  );

  it.each([
    ['1000', 1, 1, '1000'],
    ['3000', 24, 1, '72000'],
    ['3', 1, 3, '1'],
    ['9223372036854775807', 2147483647, 2147483647, '9223372036854775807'],
    ['0', 1, 3, '0'],
  ])('converts %s * %s / %s exactly', async (quantity, num, den, result) => {
    expect(
      (
        await client.query(`select ledger.inventory_base_quantity($1, $2, $3)::text as quantity`, [
          quantity,
          num,
          den,
        ])
      ).rows[0],
    ).toEqual({ quantity: result });
  });

  it.each([
    ['1', 1, 3, '23514'],
    ['2', 1, 3, '23514'],
    ['1', 0, 1, '23514'],
    ['1', 1, 0, '23514'],
    ['-9223372036854775808', 1, 1, '23514'],
    ['9223372036854775807', 2, 1, '22003'],
  ])(
    'rejects unrepresentable or invalid conversion %s * %s / %s',
    async (quantity, num, den, code) => {
      await reject(
        () =>
          client.query(`select ledger.inventory_base_quantity($1, $2, $3)`, [quantity, num, den]),
        code,
      );
    },
  );

  it('rejects fractional base milli input on movement and count persistence', async () => {
    const third = await createProduct({ num: 1, den: 3 });
    await reject(
      () =>
        insertMovement(
          movement(
            { selectedQuantityMilli: 1n, quantityDeltaMilli: 1n, quantityAfterMilli: 1n },
            third,
          ),
        ),
      '23514',
    );
  });

  it('rejects int8 minimum delta rather than overflowing during negation', async () => {
    await reject(
      () =>
        insertMovement(
          movement({
            selectedQuantityMilli: int8max,
            quantityDeltaMilli: -9223372036854775808n,
            quantityAfterMilli: -9223372036854775808n,
            costStateAfter: 'pending',
            hasPendingCostAfter: true,
          }),
        ),
      '23514',
    );
  });

  it('round-trips quantities and original total cost above Number precision', async () => {
    await insertMovement(
      movement({
        selectedQuantityMilli: int8max,
        quantityDeltaMilli: int8max,
        quantityAfterMilli: int8max,
        valueDeltaMinor: int8max,
        inventoryValueAfterMinor: int8max,
        averageUnitCostAfterMinor: 1000n,
      }),
    );
    expect(await projection()).toMatchObject({
      quantityMilli: int8max,
      inventoryValueMinor: int8max,
      averageUnitCostMinor: 1000n,
    });
    await reject(
      () => insertMovement(movement({ quantityBeforeMilli: int8max, quantityAfterMilli: int8max })),
      '40001',
    );
  });

  it.each([null, 0n, 9007199254740993n])(
    'preserves original optional cost %s and never substitutes configured unit price',
    async (cost) => {
      const entry = await insertEntry(cost);
      await client.query('set constraints all immediate');
      expect(
        (
          await drizzle(client)
            .select()
            .from(manualInventoryEntries)
            .where(eq(manualInventoryEntries.id, entry.id))
        )[0],
      ).toMatchObject({
        totalPurchaseCostMinor: cost,
        costStatus: cost === null ? 'unknown' : 'known',
      });
      expect(await projection()).toMatchObject({
        costState: cost === null ? 'unknown' : 'known',
        inventoryValueMinor: cost ?? 0n,
        hasPendingCost: false,
      });
    },
  );

  it('distinguishes pending from unknown and rejects estimated ledger authority', async () => {
    await insertMovement(
      movement({ costStatus: 'pending', costStateAfter: 'pending', hasPendingCostAfter: true }),
    );
    expect(await projection()).toMatchObject({ costState: 'pending', hasPendingCost: true });
    await reject(
      () =>
        client.query(
          `update ledger.stock_balances set cost_state = 'estimated' where product_id = $1`,
          [product.productId],
        ),
      '42501',
    );
    // A fresh Product avoids stale-snapshot rejection masking the state constraint.
    const fresh = await createProduct();
    const source = await client.query<{ id: string }>(
      'select id from ledger.inventory_movements where product_id = $1',
      [product.productId],
    );
    await reject(
      () =>
        client.query(
          `insert into ledger.inventory_movements
      select (jsonb_populate_record(null::ledger.inventory_movements, to_jsonb(m) ||
        jsonb_build_object('id', $1::uuid, 'product_id', $2::uuid, 'product_unit_id', $3::uuid,
          'operation_id', $4::uuid, 'cost_status', 'estimated'))).* from ledger.inventory_movements m where id = $5`,
          [randomUUID(), fresh.productId, fresh.productUnitId, randomUUID(), source.rows[0]?.id],
        ),
      '23514',
    );
  });

  it('rejects authoritative values on unknown projection states and inconsistent pending flags', async () => {
    await reject(
      () =>
        insertMovement(
          movement({
            costStatus: 'unknown',
            costStateAfter: 'unknown',
            valueDeltaMinor: 1n,
            inventoryValueAfterMinor: 1n,
          }),
        ),
      '23514',
    );
    await reject(
      () =>
        insertMovement(
          movement({
            costStatus: 'pending',
            costStateAfter: 'pending',
            hasPendingCostAfter: false,
          }),
        ),
      '23514',
    );
    expect(await projection()).toBeUndefined();
  });

  it('cannot turn unknown input or an unresolved prior balance into known valuation', async () => {
    await reject(() => insertMovement(movement({ costStatus: 'unknown' })), '23514');
    await insertMovement(movement({ costStatus: 'unknown', costStateAfter: 'unknown' }));
    await reject(
      () =>
        insertMovement(
          movement({
            quantityBeforeMilli: 1000n,
            quantityAfterMilli: 2000n,
            costStateBefore: 'unknown',
            costStateAfter: 'known',
            valueDeltaMinor: 10n,
            inventoryValueAfterMinor: 10n,
            averageUnitCostAfterMinor: 5n,
          }),
        ),
      '23514',
    );
    expect(await projection()).toMatchObject({ quantityMilli: 1000n, costState: 'unknown' });
  });

  it.each([
    [4000n, 0n],
    [2000n, 1n],
    [1500n, 1n],
  ])(
    'checks half-up derived cost at quantity %s without rounding stock',
    async (quantity, average) => {
      await insertMovement(
        movement({
          selectedQuantityMilli: quantity,
          quantityDeltaMilli: quantity,
          quantityAfterMilli: quantity,
          valueDeltaMinor: 1n,
          inventoryValueAfterMinor: 1n,
          averageUnitCostAfterMinor: average,
        }),
      );
      expect(await projection()).toMatchObject({
        quantityMilli: quantity,
        inventoryValueMinor: 1n,
        averageUnitCostMinor: average,
      });
    },
  );

  it('requires full depletion to drain residual value and average', async () => {
    await insertMovement(
      movement({
        selectedQuantityMilli: 3n,
        quantityDeltaMilli: 3n,
        quantityAfterMilli: 3n,
        valueDeltaMinor: 1n,
        inventoryValueAfterMinor: 1n,
        averageUnitCostAfterMinor: 333n,
      }),
    );
    await reject(
      () =>
        insertMovement(
          movement({
            selectedQuantityMilli: 3n,
            quantityBeforeMilli: 3n,
            quantityDeltaMilli: -3n,
            quantityAfterMilli: 0n,
            inventoryValueBeforeMinor: 1n,
            inventoryValueAfterMinor: 1n,
          }),
        ),
      '23514',
    );
    await insertMovement(
      movement({
        selectedQuantityMilli: 3n,
        quantityBeforeMilli: 3n,
        quantityDeltaMilli: -3n,
        quantityAfterMilli: 0n,
        inventoryValueBeforeMinor: 1n,
        valueDeltaMinor: -1n,
        inventoryValueAfterMinor: 0n,
      }),
    );
    expect(await projection()).toMatchObject({
      quantityMilli: 0n,
      inventoryValueMinor: 0n,
      averageUnitCostMinor: 0n,
    });
  });

  it('retains Store/Product negative-stock precedence and never values negative quantity as known', async () => {
    const delta = {
      quantityDeltaMilli: -1000n,
      quantityAfterMilli: -1000n,
      costStatus: 'pending' as const,
      costStateAfter: 'pending' as const,
      hasPendingCostAfter: true,
    };
    await reject(() => insertMovement(movement(delta)), '23514');
    const permitted = await createProduct({ override: true });
    await insertMovement(movement(delta, permitted));
    const noValue = await createProduct({ override: true });
    await reject(
      () =>
        insertMovement(
          movement({ quantityDeltaMilli: -1000n, quantityAfterMilli: -1000n }, noValue),
        ),
      '23514',
    );
    await client.query('rollback');
    await db().admin.query(
      `update ledger.app_settings set allow_negative_stock = true where store_id = $1`,
      [stores[0]],
    );
    await client.query('begin');
    await setInventoryContext(client, stores[0], devices[0], users[0]);
    try {
      const storeAllowed = await createProduct();
      await insertMovement(movement(delta, storeAllowed));
      const denied = await createProduct({ override: false });
      await reject(() => insertMovement(movement(delta, denied)), '23514');
    } finally {
      // Release the policy lock before reverting this isolated fixture setting.
      await client.query('rollback');
      await db().admin.query(
        `update ledger.app_settings set allow_negative_stock = false where store_id = $1`,
        [stores[0]],
      );
      await client.query('begin');
      await setInventoryContext(client, stores[0], devices[0], users[0]);
    }
  });

  it('rejects stale snapshots and zero movements without partial projection residue', async () => {
    await reject(
      () => insertMovement(movement({ quantityBeforeMilli: 5n, quantityAfterMilli: 1005n })),
      '40001',
    );
    expect(await projection()).toBeUndefined();
    await reject(
      () =>
        insertMovement(
          movement({ selectedQuantityMilli: 0n, quantityDeltaMilli: 0n, quantityAfterMilli: 0n }),
        ),
      '23514',
    );
    await insertMovement(movement());
    await reject(() => insertMovement(movement()), '40001');
    expect(await projection()).toMatchObject({ quantityMilli: 1000n });
  });

  it('protects posted manual and movement facts from runtime UPDATE/DELETE', async () => {
    const entry = await insertEntry(0n);
    await client.query('set constraints all immediate');
    for (const table of [manualInventoryEntries, inventoryMovements]) {
      await reject(() => drizzle(client).update(table).set({ reason: 'rewrite' }), '42501');
      await reject(() => drizzle(client).delete(table), '42501');
    }
    expect(
      (
        await drizzle(client)
          .select()
          .from(manualInventoryEntries)
          .where(eq(manualInventoryEntries.id, entry.id))
      )[0]?.reason,
    ).toBeNull();
  });

  it('rejects missing/mismatched deferred movement links and duplicate operation identities', async () => {
    const entry = await insertEntry(0n);
    await client.query('set constraints all immediate');
    await reject(
      () =>
        drizzle(client)
          .insert(manualInventoryEntries)
          .values({ ...entry, id: randomUUID() }),
      '23505',
    );
    await reject(async () => {
      const missingOperation = randomUUID();
      await client.query('set constraints all deferred');
      await drizzle(client)
        .insert(manualInventoryEntries)
        .values({
          ...entry,
          id: randomUUID(),
          operationId: missingOperation,
          transactionGroupId: missingOperation,
          movementId: randomUUID(),
        });
      await client.query('set constraints all immediate');
    }, '23503');
    await reject(async () => {
      const differentOperation = randomUUID();
      const m = movement({
        quantityBeforeMilli: 1000n,
        quantityAfterMilli: 2000n,
        transactionGroupId: differentOperation,
      });
      await client.query('set constraints all deferred');
      await insertMovement(m);
      await drizzle(client)
        .insert(manualInventoryEntries)
        .values({
          ...entry,
          id: randomUUID(),
          operationId: differentOperation,
          transactionGroupId: differentOperation,
          movementId: m.id,
        });
      await client.query('set constraints all immediate');
    }, '23514');
  });

  it('rejects a movement with an orphaned manual-operation reference', async () => {
    await reject(async () => {
      await insertMovement(movement({ referenceType: 'manual_inventory_entry' }));
      await client.query('set constraints all immediate');
    }, '23503');
    expect(await projection()).toBeUndefined();
  });

  it('rejects reversal links to another Product or to the new movement itself', async () => {
    const other = await createProduct();
    const original = movement({}, other);
    await insertMovement(original);
    await reject(() => insertMovement(movement({ reversalOfId: original.id })), '23503');
    const id = randomUUID();
    await reject(() => insertMovement(movement({ id, reversalOfId: id })), '23514');
    expect(await projection()).toBeUndefined();
  });

  it('keeps accepted unit snapshots after later catalog edits and archive', async () => {
    const entry = await insertEntry(1n);
    await client.query('set constraints all immediate');
    await client.query('commit');
    await db().admin.query(
      `update ledger.product_units set unit_name = 'renamed unit' where id = $1`,
      [product.productUnitId],
    );
    await db().admin.query(
      `update ledger.products set status = 'archived', archived_at = now() where id = $1`,
      [product.productId],
    );
    await client.query('begin');
    await setInventoryContext(client, stores[0], devices[0], users[0]);
    expect(
      (
        await drizzle(client)
          .select()
          .from(manualInventoryEntries)
          .where(eq(manualInventoryEntries.id, entry.id))
      )[0],
    ).toMatchObject({
      selectedQuantityMilli: 1000n,
      baseQuantityMilli: 1000n,
      factorNum: 1,
      factorDen: 1,
      totalPurchaseCostMinor: 1n,
    });
    await reject(
      () =>
        insertMovement(
          movement({
            quantityBeforeMilli: 1000n,
            quantityAfterMilli: 2000n,
            inventoryValueBeforeMinor: 1n,
            inventoryValueAfterMinor: 1n,
          }),
        ),
      '23514',
    );
  });

  it('retains terminal count immutability while permitting draft and counting item edits', async () => {
    const countId = randomUUID();
    await drizzle(client).insert(stockCounts).values({
      id: countId,
      storeId: stores[0],
      displayNumber: countId,
      countType: 'partial',
      startedAt: at,
      operationId: randomUUID(),
      deviceId: devices[0],
    });
    const item = {
      id: randomUUID(),
      storeId: stores[0],
      stockCountId: countId,
      ...product,
      systemQuantityMilli: 0n,
      actualQuantityMilli: 0n,
      differenceMilli: 0n,
      selectedQuantityMilli: 0n,
    };
    await drizzle(client).insert(stockCountItems).values(item);
    await drizzle(client)
      .update(stockCounts)
      .set({ status: 'counting' })
      .where(eq(stockCounts.id, countId));
    await drizzle(client)
      .update(stockCountItems)
      .set({ reason: 'counted' })
      .where(eq(stockCountItems.id, item.id));
    await drizzle(client)
      .update(stockCounts)
      .set({
        status: 'posted',
        completedAt: at,
        occurredAt: at,
        businessDate: day,
        postingDate: day,
        accountingPeriodId: periodId,
      })
      .where(eq(stockCounts.id, countId));
    await client.query('set constraints all immediate');
    await reject(
      () =>
        drizzle(client)
          .update(stockCounts)
          .set({ status: 'draft' })
          .where(eq(stockCounts.id, countId)),
      '55000',
    );
    await reject(
      () =>
        drizzle(client)
          .update(stockCountItems)
          .set({ actualQuantityMilli: 1n })
          .where(eq(stockCountItems.id, item.id)),
      '55000',
    );
    await reject(
      () => drizzle(client).delete(stockCountItems).where(eq(stockCountItems.id, item.id)),
      '55000',
    );
  });

  it('rejects count reparenting, non-exact actual quantity, missing posting context and missing adjustments', async () => {
    const countId = randomUUID();
    await drizzle(client).insert(stockCounts).values({
      id: countId,
      storeId: stores[0],
      displayNumber: countId,
      countType: 'partial',
      startedAt: at,
      operationId: randomUUID(),
    });
    const third = await createProduct({ num: 1, den: 3 });
    await reject(
      () =>
        drizzle(client)
          .insert(stockCountItems)
          .values({
            id: randomUUID(),
            storeId: stores[0],
            stockCountId: countId,
            ...third,
            selectedQuantityMilli: 1n,
            actualQuantityMilli: 1n,
            systemQuantityMilli: 0n,
            differenceMilli: 1n,
          }),
      '23514',
    );
    const itemId = randomUUID();
    await drizzle(client)
      .insert(stockCountItems)
      .values({
        id: itemId,
        storeId: stores[0],
        stockCountId: countId,
        ...product,
        selectedQuantityMilli: 1000n,
        actualQuantityMilli: 1000n,
        systemQuantityMilli: 0n,
        differenceMilli: 1000n,
      });
    await reject(
      () =>
        drizzle(client)
          .update(stockCountItems)
          .set({ stockCountId: randomUUID() })
          .where(eq(stockCountItems.id, itemId)),
      '55000',
    );
    await reject(
      () =>
        drizzle(client)
          .update(stockCounts)
          .set({ status: 'posted', completedAt: at })
          .where(eq(stockCounts.id, countId)),
      '23503',
    );
    await reject(async () => {
      await drizzle(client)
        .update(stockCounts)
        .set({
          status: 'posted',
          completedAt: at,
          occurredAt: at,
          businessDate: day,
          postingDate: day,
          accountingPeriodId: periodId,
        })
        .where(eq(stockCounts.id, countId));
      await client.query('set constraints all immediate');
    }, '23514');
  });

  it('rejects timestamps outside the period and incorrect persisted business dates', async () => {
    await reject(
      () =>
        insertMovement(
          movement({
            occurredAt: new Date('2026-02-15T10:00:00Z'),
            businessDate: '2026-02-15',
            postingDate: '2026-02-15',
          }),
        ),
      '23514',
    );
    await reject(() => insertMovement(movement({ postingDate: '2026-01-16' })), '23514');
  });

  it('serializes concurrent first movements and rejects the losing stale snapshot', async () => {
    const other = await db().runtime.connect();
    try {
      await other.query('begin');
      await setInventoryContext(other, stores[0], devices[0], users[0]);
      await insertMovement(movement());
      const waiting = insertMovement(movement(), other);
      const rejected = expect(waiting).rejects.toMatchObject({ code: '40001' });
      await client.query('commit');
      await rejected;
      await other.query('rollback');
      await client.query('begin');
      await setInventoryContext(client, stores[0], devices[0], users[0]);
      expect(await projection()).toMatchObject({ quantityMilli: 1000n });
      expect(
        (
          await client.query(
            'select count(*)::int as count from ledger.inventory_movements where product_id = $1',
            [product.productId],
          )
        ).rows[0],
      ).toEqual({ count: 1 });
    } finally {
      await other.query('rollback');
      other.release();
    }
  });

  it('holds the existing period eligibility lock until inventory commit', async () => {
    await insertMovement(movement());
    const admin = await db().admin.connect();
    try {
      await admin.query('begin');
      await admin.query(`set local lock_timeout = '150ms'`);
      await expect(
        admin.query('select id from ledger.accounting_periods where id = $1 for update', [
          periodId,
        ]),
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await admin.query('rollback');
      admin.release();
    }
  });

  it('rolls back movement, root, projection and audit together after a later failure', async () => {
    const entry = await insertEntry(0n);
    await expect(client.query(`select 1 / 0`)).rejects.toMatchObject({ code: '22012' });
    await client.query('rollback');
    expect(
      (
        await db().admin.query<{ residue: string }>(
          `select
      (select count(*) from ledger.manual_inventory_entries where id = $1) +
      (select count(*) from ledger.inventory_movements where id = $2) +
      (select count(*) from ledger.stock_balances where product_id = $3) +
      (select count(*) from audit.central_audit_logs where entity_id = any($4::uuid[])) +
      (select count(*) from sync.change_events where entity_id = any($4::uuid[])) as residue`,
          [entry.id, entry.movementId, product.productId, [entry.id, entry.movementId]],
        )
      ).rows[0]?.residue,
    ).toBe('0');
    await client.query('begin');
    await setInventoryContext(client, stores[0], devices[0], users[0]);
  });

  it('creates no goods receipt, payable, supplier, or money effects', async () => {
    await insertEntry(null);
    await client.query('set constraints all immediate');
    expect(
      (
        await client.query<{ effects: string }>(`select
      (select count(*) from ledger.goods_receipts) + (select count(*) from ledger.supplier_ledger_entries) +
      (select count(*) from ledger.money_movements) + (select count(*) from ledger.purchase_invoices) as effects`)
      ).rows[0]?.effects,
    ).toBe('0');
  });
});
