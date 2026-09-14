import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import { deriveAccountingPeriodId } from '../src/accounting-periods/accounting-period-identity';
import { resolveAccountingPeriodBoundaries } from '../src/accounting-periods/accounting-period-month';
import { inventoryMovements } from '../src/database/schema/inventory';
import { applyMigration, verifyChecksums, verifyMigrationSession } from '../scripts/migrate';
import { readMigrationFiles } from '../scripts/migrations/migration-files';
import { verifyApplicationInventory } from '../scripts/migrations/verify-application-inventory';
import {
  createInventoryTestDatabase,
  setInventoryContext,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';

const migrationFilename = '0013_historical_inventory_reversal_lifecycle.sql';
const stores = [randomUUID(), randomUUID()] as const;
const users = [randomUUID(), randomUUID()] as const;
const devices = [randomUUID(), randomUUID()] as const;
const occurredAt = new Date('2026-08-15T10:00:00Z');
const postingDate = '2026-08-15';
const periods = [
  deriveAccountingPeriodId(stores[0], 2026, 8),
  deriveAccountingPeriodId(stores[1], 2026, 8),
] as const;

type MovementInput = typeof inventoryMovements.$inferInsert;

interface ProductFixture {
  store: 0 | 1;
  productId: string;
  productUnitId: string;
  baseUnitId: string;
}

function postgresError(error: unknown): unknown {
  if (error instanceof Error && error.cause) return postgresError(error.cause);
  return error;
}

describe('S14.5 exact historical inventory reversal lifecycle on isolated PostgreSQL', () => {
  jest.setTimeout(120_000);

  let database: InventoryTestDatabase | undefined;

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('Historical reversal test database is unavailable.');
    return database;
  }

  async function inRuntimeTransaction<T>(
    store: 0 | 1,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await db().runtime.connect();
    try {
      await client.query('begin');
      await setInventoryContext(client, stores[store], devices[store], users[store]);
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw postgresError(error);
    } finally {
      client.release();
    }
  }

  async function createProduct(
    store: 0 | 1 = 0,
    tracked = true,
    factorNum = 1,
  ): Promise<ProductFixture> {
    const fixture = {
      store,
      productId: randomUUID(),
      productUnitId: randomUUID(),
      baseUnitId: factorNum === 1 ? '' : randomUUID(),
    };
    if (factorNum === 1) fixture.baseUnitId = fixture.productUnitId;
    await db().admin.query(
      `insert into ledger.products(
         id,store_id,name,normalized_name,measurement_type,track_inventory,status,operation_id)
       values($1,$2,$1::uuid::text,$1::uuid::text,'count',$3,'active',$4)`,
      [fixture.productId, stores[store], tracked, randomUUID()],
    );
    await db().admin.query(
      `insert into ledger.product_units(
         id,store_id,product_id,measurement_type,unit_name,is_base,
         factor_num,factor_den,status,operation_id)
       values($1,$2,$3,'count',$1::uuid::text,$4,$5,1,'active',$6)`,
      [
        fixture.productUnitId,
        stores[store],
        fixture.productId,
        factorNum === 1,
        factorNum,
        randomUUID(),
      ],
    );
    if (fixture.baseUnitId !== fixture.productUnitId) {
      await db().admin.query(
        `insert into ledger.product_units(
           id,store_id,product_id,measurement_type,unit_name,is_base,
           factor_num,factor_den,status,operation_id)
         values($1,$2,$3,'count',$1::uuid::text,true,1,1,'active',$4)`,
        [fixture.baseUnitId, stores[store], fixture.productId, randomUUID()],
      );
    }
    return fixture;
  }

  function originalMovement(product: ProductFixture, factorNum = 1): MovementInput {
    const quantity = BigInt(factorNum) * 1000n;
    const averageCost = (100000n + quantity / 2n) / quantity;
    return {
      id: randomUUID(),
      storeId: stores[product.store],
      productId: product.productId,
      productUnitId: product.productUnitId,
      accountingPeriodId: periods[product.store],
      movementType: 'adjustment_in',
      quantityBeforeMilli: 0n,
      quantityDeltaMilli: quantity,
      quantityAfterMilli: quantity,
      inventoryValueBeforeMinor: 0n,
      valueDeltaMinor: 100n,
      inventoryValueAfterMinor: 100n,
      averageUnitCostAfterMinor: averageCost,
      costStatus: 'known',
      hasPendingCostAfter: false,
      referenceType: 'historical_reversal_fixture',
      referenceId: randomUUID(),
      transactionGroupId: randomUUID(),
      occurredAt,
      reversalOfId: null,
      reason: null,
      deviceId: devices[product.store],
      operationId: randomUUID(),
      selectedQuantityMilli: 1000n,
      factorNum,
      factorDen: 1,
      businessDate: postingDate,
      postingDate,
      costStateBefore: 'known',
      costStateAfter: 'known',
      quantityFactKind: 'movement',
    };
  }

  function exactReversal(
    product: ProductFixture,
    original: MovementInput,
    overrides: Partial<MovementInput> = {},
  ): MovementInput {
    const originalQuantity = original.quantityDeltaMilli;
    return {
      id: randomUUID(),
      storeId: stores[product.store],
      productId: product.productId,
      productUnitId: original.productUnitId,
      accountingPeriodId: periods[product.store],
      movementType: 'correction',
      quantityBeforeMilli: originalQuantity,
      quantityDeltaMilli: -originalQuantity,
      quantityAfterMilli: 0n,
      inventoryValueBeforeMinor: 100n,
      valueDeltaMinor: -100n,
      inventoryValueAfterMinor: 0n,
      averageUnitCostAfterMinor: 0n,
      costStatus: 'known',
      hasPendingCostAfter: false,
      referenceType: 'historical_reversal_fixture',
      referenceId: original.referenceId,
      transactionGroupId: randomUUID(),
      occurredAt,
      reversalOfId: original.id,
      reason: 'exact historical reversal fixture',
      deviceId: devices[product.store],
      operationId: randomUUID(),
      selectedQuantityMilli: original.selectedQuantityMilli,
      factorNum: original.factorNum,
      factorDen: original.factorDen,
      businessDate: postingDate,
      postingDate,
      costStateBefore: 'known',
      costStateAfter: 'known',
      quantityFactKind: 'movement',
      ...overrides,
    };
  }

  async function insertMovement(client: PoolClient, input: MovementInput): Promise<void> {
    await drizzle(client).insert(inventoryMovements).values(input);
  }

  async function postOriginal(product: ProductFixture, factorNum = 1): Promise<MovementInput> {
    const input = originalMovement(product, factorNum);
    await inRuntimeTransaction(product.store, (client) => insertMovement(client, input));
    return input;
  }

  async function rejectMovement(store: 0 | 1, input: MovementInput, code: string): Promise<void> {
    await expect(
      inRuntimeTransaction(store, (client) => insertMovement(client, input)),
    ).rejects.toMatchObject({ code });
  }

  async function projection(product: ProductFixture): Promise<{
    quantity: string;
    value: string;
    movements: number;
    reversals: number;
  }> {
    const result = await db().admin.query<{
      quantity: string;
      value: string;
      movements: number;
      reversals: number;
    }>(
      `select balance.quantity_milli::text as quantity,
              balance.inventory_value_minor::text as value,
              (select count(*)::int from ledger.inventory_movements movement
               where movement.store_id=balance.store_id
                 and movement.product_id=balance.product_id) as movements,
              (select count(*)::int from ledger.inventory_movements movement
               where movement.store_id=balance.store_id
                 and movement.product_id=balance.product_id
                 and movement.reversal_of_id is not null) as reversals
       from ledger.stock_balances balance
       where balance.store_id=$1 and balance.product_id=$2`,
      [stores[product.store], product.productId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Expected inventory projection.');
    return row;
  }

  beforeAll(async () => {
    database = await createInventoryTestDatabase(migrationFilename);
    const migrator = await db().migration.connect();
    try {
      await verifyMigrationSession(migrator);
      const before = (
        await migrator.query<{ definition: string }>(
          `select pg_get_functiondef('ledger.apply_inventory_movement()'::regprocedure) as definition`,
        )
      ).rows[0]?.definition;
      await migrator.query('begin');
      await migrator.query(db().file.contents);
      expect(
        (
          await migrator.query<{ changed: boolean }>(
            `select position('exact_historical_reversal' in
               pg_get_functiondef('ledger.apply_inventory_movement()'::regprocedure)) > 0 as changed`,
          )
        ).rows[0],
      ).toEqual({ changed: true });
      await migrator.query('rollback');
      expect(
        (
          await migrator.query<{ definition: string }>(
            `select pg_get_functiondef('ledger.apply_inventory_movement()'::regprocedure) as definition`,
          )
        ).rows[0]?.definition,
      ).toBe(before);
      await applyMigration(migrator, db().file);
    } finally {
      await migrator.query('rollback');
      await migrator.query('reset role');
      migrator.release();
    }

    for (let index = 0; index < stores.length; index += 1) {
      await db().admin.query(
        `insert into ledger.stores(id,name,status) values($1,'S14.5 reversal fixture','active')`,
        [stores[index]],
      );
      await db().admin.query(`insert into ledger.app_settings(store_id) values($1)`, [
        stores[index],
      ]);
      await db().admin.query(
        `insert into platform.users(id,email,normalized_email,password_hash,full_name)
         values($1,$2,$2,'!disabled-test-fixture','S14.5 reversal fixture')`,
        [users[index], `s145-reversal-${randomUUID()}@example.test`],
      );
      await db().admin.query(
        `insert into ledger.devices(
           id,store_id,device_name,platform,installation_id,device_prefix)
         values($1,$2,'S14.5 reversal fixture','android',$3,'S145')`,
        [devices[index], stores[index], randomUUID()],
      );
      const boundaries = resolveAccountingPeriodBoundaries(2026, 8);
      await db().admin.query(
        `insert into ledger.accounting_periods(
           id,store_id,period_year,period_month,starts_at,ends_at,status,operation_id)
         values($1,$2,2026,8,$3,$4,'open',$5)`,
        [periods[index], stores[index], boundaries.startsAt, boundaries.endsAt, randomUUID()],
      );
    }
  });

  afterAll(async () => {
    if (database) {
      expect(
        (
          await database.admin.query(
            `select count(*)::int as count from pg_stat_activity
             where datname=current_database() and state like 'idle in transaction%'`,
          )
        ).rows[0],
      ).toEqual({ count: 0 });
      await database.close();
    }
  });

  it('applies transactionally from the prior version with exact checksum and no object drift', async () => {
    const files = await readMigrationFiles();
    const applied = await db().admin.query<{ filename: string; checksumSha256: string }>(
      `select filename,checksum_sha256 as "checksumSha256"
       from platform.schema_migrations order by filename`,
    );
    expect(applied.rows).toHaveLength(13);
    expect(applied.rows.at(-1)?.filename).toBe(migrationFilename);
    expect(() => verifyChecksums(files, applied.rows)).not.toThrow();
    const inspector = await db().admin.connect();
    try {
      await verifyApplicationInventory(inspector, 'shop_app_migrator', true);
    } finally {
      inspector.release();
    }
  });

  it('preserves forced RLS, trigger ownership, pinned search_path, and narrow grants', async () => {
    const state = await db().admin.query(
      `select p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner,
          has_function_privilege('shop_app_runtime', p.oid, 'EXECUTE') as runtime_execute,
          has_function_privilege('shop_app_readonly', p.oid, 'EXECUTE') as readonly_execute,
          exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))
                 where grantee=0 and privilege_type='EXECUTE') as public_execute,
          (select count(*)::int from pg_class c
           where c.oid=any(array[
             'ledger.products'::regclass,'ledger.product_units'::regclass,
             'ledger.inventory_movements'::regclass,'ledger.stock_balances'::regclass])
             and c.relrowsecurity and c.relforcerowsecurity) as forced_rls,
          exists(select 1 from pg_trigger t where t.tgrelid='ledger.inventory_movements'::regclass
            and t.tgname='trg_inventory_apply_balance' and t.tgenabled='O'
            and t.tgfoid=p.oid) as trigger_intact
       from pg_proc p where p.oid='ledger.apply_inventory_movement()'::regprocedure`,
    );
    expect(state.rows[0]).toEqual({
      prosecdef: true,
      proconfig: ['search_path=pg_catalog, pg_temp'],
      owner: 'shop_app_migrator',
      runtime_execute: true,
      readonly_execute: false,
      public_execute: false,
      forced_rls: 4,
      trigger_intact: true,
    });
    expect(
      (
        await db().admin.query(
          `select has_table_privilege(
             'shop_app_runtime','ledger.stock_balances','INSERT,UPDATE,DELETE') as projection_dml`,
        )
      ).rows[0],
    ).toEqual({ projection_dml: false });
  });

  it.each([
    ['active Product and ProductUnit', false, false, 1],
    ['archived Product', true, false, 1],
    ['archived ProductUnit with changed current factor', false, true, 10],
    ['archived Product and ProductUnit', true, true, 10],
  ] as const)(
    'accepts an exact historical reversal for %s',
    async (_label, archiveProduct, archiveUnit, factorNum) => {
      const product = await createProduct(0, true, factorNum);
      const original = await postOriginal(product, factorNum);
      if (archiveProduct) {
        await db().admin.query(
          `update ledger.products set status='archived',archived_at=clock_timestamp() where id=$1`,
          [product.productId],
        );
      }
      if (archiveUnit) {
        await db().admin.query(
          `update ledger.product_units set status='archived',factor_num=12 where id=$1`,
          [product.productUnitId],
        );
      }
      await inRuntimeTransaction(0, (client) =>
        insertMovement(client, exactReversal(product, original)),
      );
      expect(await projection(product)).toEqual({
        quantity: '0',
        value: '0',
        movements: 2,
        reversals: 1,
      });
    },
  );

  it('accepts the same-Product canonical base-unit form used by existing S11 corrections', async () => {
    const product = await createProduct(0, true, 10);
    const original = await postOriginal(product, 10);
    await db().admin.query(
      `update ledger.product_units set status='archived',factor_num=12 where id=$1`,
      [product.productUnitId],
    );
    await inRuntimeTransaction(0, (client) =>
      insertMovement(
        client,
        exactReversal(product, original, {
          productUnitId: product.baseUnitId,
          selectedQuantityMilli: 10000n,
          factorNum: 1,
          factorDen: 1,
        }),
      ),
    );
    expect(await projection(product)).toEqual({
      quantity: '0',
      value: '0',
      movements: 2,
      reversals: 1,
    });
  });

  it('keeps ordinary, opening, manual-adjustment, and Sale writes blocked on archived catalog', async () => {
    const archivedProduct = await createProduct();
    const productOriginal = await postOriginal(archivedProduct);
    await db().admin.query(
      `update ledger.products set status='archived',archived_at=clock_timestamp() where id=$1`,
      [archivedProduct.productId],
    );
    for (const movementType of ['adjustment_in', 'opening_balance', 'sale'] as const) {
      await rejectMovement(
        0,
        exactReversal(archivedProduct, productOriginal, {
          reversalOfId: null,
          movementType,
          quantityBeforeMilli: 1000n,
          quantityDeltaMilli: 1000n,
          quantityAfterMilli: 2000n,
          inventoryValueBeforeMinor: 100n,
          valueDeltaMinor: 100n,
          inventoryValueAfterMinor: 200n,
          averageUnitCostAfterMinor: 100n,
        }),
        '23514',
      );
    }

    const archivedUnit = await createProduct();
    const unitOriginal = await postOriginal(archivedUnit);
    await db().admin.query(`update ledger.product_units set status='archived' where id=$1`, [
      archivedUnit.productUnitId,
    ]);
    await rejectMovement(
      0,
      exactReversal(archivedUnit, unitOriginal, {
        reversalOfId: null,
        movementType: 'adjustment_out',
      }),
      '23514',
    );
    expect(await projection(archivedProduct)).toMatchObject({ movements: 1, reversals: 0 });
    expect(await projection(archivedUnit)).toMatchObject({ movements: 1, reversals: 0 });
  });

  it('rejects fake, unlinked, wrong-identity, wrong-sign, wrong-value, and untracked reversals', async () => {
    const product = await createProduct();
    const original = await postOriginal(product);
    const other = await createProduct();
    await db().admin.query(
      `update ledger.products set status='archived',archived_at=clock_timestamp() where id=$1`,
      [product.productId],
    );

    await rejectMovement(
      0,
      exactReversal(product, original, { reversalOfId: randomUUID() }),
      '23514',
    );
    await rejectMovement(0, exactReversal(product, original, { reversalOfId: null }), '23514');
    await rejectMovement(
      0,
      exactReversal(other, original, { productUnitId: other.productUnitId }),
      '23514',
    );
    await rejectMovement(
      0,
      exactReversal(product, original, {
        quantityDeltaMilli: 1000n,
        quantityAfterMilli: 2000n,
      }),
      '23514',
    );
    await rejectMovement(
      0,
      exactReversal(product, original, {
        valueDeltaMinor: -99n,
        inventoryValueAfterMinor: 1n,
        averageUnitCostAfterMinor: 1n,
      }),
      '23514',
    );

    await db().admin.query(`update ledger.products set track_inventory=false where id=$1`, [
      product.productId,
    ]);
    await rejectMovement(0, exactReversal(product, original), '23514');
    expect(await projection(product)).toMatchObject({ quantity: '1000', movements: 1 });
  });

  it('rejects duplicate reversal lineage and preserves a single projection update', async () => {
    const product = await createProduct();
    const original = await postOriginal(product);
    await inRuntimeTransaction(0, (client) =>
      insertMovement(client, exactReversal(product, original)),
    );
    await rejectMovement(
      0,
      exactReversal(product, original, {
        quantityBeforeMilli: 0n,
        quantityAfterMilli: -1000n,
        inventoryValueBeforeMinor: 0n,
        inventoryValueAfterMinor: -100n,
        costStateAfter: 'pending',
        hasPendingCostAfter: true,
        averageUnitCostAfterMinor: 0n,
      }),
      '23514',
    );
    expect(await projection(product)).toEqual({
      quantity: '0',
      value: '0',
      movements: 2,
      reversals: 1,
    });
  });

  it('serializes competing exact reversals without a branch', async () => {
    const product = await createProduct();
    const original = await postOriginal(product);
    const outcomes = await Promise.allSettled([
      inRuntimeTransaction(0, (client) => insertMovement(client, exactReversal(product, original))),
      inRuntimeTransaction(0, (client) => insertMovement(client, exactReversal(product, original))),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected).toBeDefined();
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toMatchObject({ code: '23514' });
    }
    expect(await projection(product)).toEqual({
      quantity: '0',
      value: '0',
      movements: 2,
      reversals: 1,
    });
  });

  it('fails closed for missing or cross-tenant context', async () => {
    const local = await createProduct();
    const localMovement = originalMovement(local);
    const contextless = await db().runtime.connect();
    try {
      await expect(insertMovement(contextless, localMovement)).rejects.toMatchObject({
        cause: { code: '42501' },
      });
    } finally {
      contextless.release();
    }

    const foreign = await createProduct(1);
    const foreignOriginal = await postOriginal(foreign);
    await rejectMovement(0, exactReversal(foreign, foreignOriginal), '42501');
    expect(await projection(foreign)).toMatchObject({ quantity: '1000', movements: 1 });
  });
});
