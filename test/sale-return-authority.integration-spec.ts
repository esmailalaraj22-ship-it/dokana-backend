import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';

import { deriveAccountingPeriodId } from '../src/accounting-periods/accounting-period-identity';
import { resolveAccountingPeriodBoundaries } from '../src/accounting-periods/accounting-period-month';
import { customerHasNoFinancialBalance } from '../src/customers/customer-financial-archive-guard';
import type { DatabaseTransaction } from '../src/database/database.types';
import * as schema from '../src/database/schema';
import {
  saleReturnItems,
  saleReturns,
  saleReturnSettlements,
  supplierReturnItems,
  supplierReturns,
  supplierReturnSettlements,
} from '../src/database/schema/returns';
import { parseSaleReturnCommand } from '../src/returns/sale-return-command';
import { SaleReturnAuthorityRepository } from '../src/returns/sale-return-authority.repository';
import { SaleReturnAuthorityError } from '../src/returns/sale-return.types';
import { applyMigration, verifyChecksums, verifyMigrationSession } from '../scripts/migrate';
import { readMigrationFiles } from '../scripts/migrations/migration-files';
import {
  createInventoryTestDatabase,
  setInventoryContext,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';

const migrationFilename = '0015_sale_customer_credit_tender.sql';
const tables = [
  saleReturns,
  saleReturnItems,
  saleReturnSettlements,
  supplierReturns,
  supplierReturnItems,
  supplierReturnSettlements,
];
const stores = [randomUUID(), randomUUID()] as const;
const users = [randomUUID(), randomUUID()] as const;
const devices = [randomUUID(), randomUUID()] as const;
const customers = [randomUUID(), randomUUID()] as const;
const products = [randomUUID(), randomUUID()] as const;
const units = [randomUUID(), randomUUID()] as const;
const sales = [randomUUID(), randomUUID()] as const;
const saleItems = [randomUUID(), randomUUID()] as const;
const moneyAccounts = [randomUUID(), randomUUID()] as const;
const periods = [
  deriveAccountingPeriodId(stores[0], 2026, 9),
  deriveAccountingPeriodId(stores[1], 2026, 9),
] as const;
const repository = new SaleReturnAuthorityRepository();
let saleAt: Date;
let acceptedAt: Date;
let businessDate: string;

function command(
  saleId: string,
  saleItemId: string,
  quantityMilli = '1000',
  disposition: 'RESTOCK_SALEABLE' | 'DAMAGED_NO_RESTOCK' = 'RESTOCK_SALEABLE',
  refundMoneyAccountId: string | null = null,
) {
  return parseSaleReturnCommand(saleId, {
    operationId: randomUUID(),
    occurredAt: acceptedAt.toISOString(),
    reason: 'Focused S17.2 authority test',
    lines: [{ saleItemId, quantityMilli, disposition }],
    residualSettlement: refundMoneyAccountId
      ? { choice: 'REFUND', moneyAccountId: refundMoneyAccountId }
      : null,
  });
}

function asTransaction(client: PoolClient): DatabaseTransaction {
  return drizzle(client, { schema }) as unknown as DatabaseTransaction;
}

function postgresError(error: unknown): unknown {
  if (error instanceof Error && error.cause) return postgresError(error.cause);
  return error;
}

describe('S17.2 Sale Return internal authority', () => {
  jest.setTimeout(120_000);

  let database: InventoryTestDatabase | undefined;
  let migrationFiles: Awaited<ReturnType<typeof readMigrationFiles>> = [];

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('Sale Return test database is not initialized.');
    return database;
  }

  async function runtimeTransaction<T>(
    storeIndex: 0 | 1,
    work: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await db().runtime.connect();
    try {
      await client.query('begin');
      await setInventoryContext(client, stores[storeIndex], devices[storeIndex], users[storeIndex]);
      const result = await work(asTransaction(client));
      await client.query('rollback');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw postgresError(error);
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    migrationFiles = await readMigrationFiles();
    database = await createInventoryTestDatabase(migrationFilename);
    const migrator = await db().migration.connect();
    try {
      await verifyMigrationSession(migrator);
      await applyMigration(migrator, db().file);
    } finally {
      await migrator.query('rollback');
      await migrator.query('reset role');
      migrator.release();
    }

    const clock = await db().admin.query<{ acceptedAt: string; businessDate: string }>(
      `select transaction_timestamp()::text as "acceptedAt",
              ((transaction_timestamp() - interval '1 hour') at time zone 'Asia/Hebron')::date::text
                as "businessDate"`,
    );
    const acceptedAtText = clock.rows[0]?.acceptedAt;
    const resolvedBusinessDate = clock.rows[0]?.businessDate;
    if (!acceptedAtText || !resolvedBusinessDate) {
      throw new Error('PostgreSQL transaction time is unavailable.');
    }
    acceptedAt = new Date(acceptedAtText);
    businessDate = resolvedBusinessDate;
    saleAt = new Date(acceptedAt.getTime() - 60 * 60 * 1000);

    const boundaries = resolveAccountingPeriodBoundaries(2026, 9);
    for (let index = 0; index < stores.length; index += 1) {
      await db().admin.query(
        `insert into ledger.stores(id, name) values ($1, 'S17.2 isolated fixture')`,
        [stores[index]],
      );
      await db().admin.query(`insert into ledger.app_settings(store_id) values ($1)`, [
        stores[index],
      ]);
      await db().admin.query(
        `insert into platform.users(id, email, normalized_email, full_name, password_hash)
         values ($1, $2, $2, 'S17.2 fixture', '!disabled-test-fixture')`,
        [users[index], `s172-${randomUUID()}@example.test`],
      );
      await db().admin.query(
        `insert into ledger.devices(
          id, store_id, device_name, platform, installation_id, device_prefix
        ) values ($1, $2, 'S17.2 fixture', 'android', $3, $4)`,
        [devices[index], stores[index], randomUUID(), `R17${String(index)}`],
      );
      await db().admin.query(
        `insert into ledger.customers(
          id, store_id, name, normalized_name, phone, normalized_phone,
          credit_policy, device_id, operation_id
        ) values ($1, $2, 'S17.2 customer', $1::uuid::text, $3, $3, 'allow', $4, $5)`,
        [
          customers[index],
          stores[index],
          `+97059010000${String(index)}`,
          devices[index],
          randomUUID(),
        ],
      );
      await db().admin.query(
        `insert into ledger.accounting_periods(
          id, store_id, period_year, period_month, starts_at, ends_at, status, operation_id
        ) values ($1, $2, 2026, 9, $3, $4, 'open', $5)`,
        [periods[index], stores[index], boundaries.startsAt, boundaries.endsAt, randomUUID()],
      );
      await db().admin.query(
        `insert into ledger.products(
          id, store_id, name, normalized_name, measurement_type,
          track_inventory, status, operation_id
        ) values ($1, $2, 'S17.2 Product', $1::uuid::text, 'count', true, 'active', $3)`,
        [products[index], stores[index], randomUUID()],
      );
      await db().admin.query(
        `insert into ledger.money_accounts(
          id, store_id, name, normalized_name, account_type,
          availability, status, device_id, operation_id
        ) values ($1, $2, 'S17.2 Cash', $1::uuid::text, 'cash',
          'available', 'active', $3, $4)`,
        [moneyAccounts[index], stores[index], devices[index], randomUUID()],
      );
      await db().admin.query(
        `insert into ledger.product_units(
          id, store_id, product_id, measurement_type, unit_name, is_base,
          factor_num, factor_den, status, operation_id
        ) values ($1, $2, $3, 'count', 'piece', true, 1, 1, 'active', $4)`,
        [units[index], stores[index], products[index], randomUUID()],
      );
      const inventoryMovementId = randomUUID();
      await db().admin.query(
        `insert into ledger.inventory_movements(
          id, store_id, product_id, accounting_period_id, movement_type,
          quantity_before_milli, quantity_delta_milli, quantity_after_milli,
          inventory_value_before_minor, value_delta_minor, inventory_value_after_minor,
          average_unit_cost_after_minor, cost_status, has_pending_cost_after,
          reference_type, reference_id, transaction_group_id, occurred_at,
          device_id, operation_id, product_unit_id, selected_quantity_milli,
          factor_num, factor_den, business_date, posting_date,
          cost_state_before, cost_state_after
        ) values (
          $1, $2, $3, $4, 'sale', 10000, -5000, 5000,
          1000, -251, 749, 150, 'known', false,
          'sale', $5, $6, $7,
          $8, $9, $10, 5000,
          1, 1, $11, $11, 'known', 'known'
        )`,
        [
          inventoryMovementId,
          stores[index],
          products[index],
          periods[index],
          sales[index],
          randomUUID(),
          saleAt,
          devices[index],
          randomUUID(),
          units[index],
          businessDate,
        ],
      );
      await db().admin.query(
        `insert into ledger.sales(
          id, store_id, customer_id, accounting_period_id, display_number, sale_at,
          items_subtotal_minor, line_discount_total_minor, invoice_discount_minor,
          rounding_minor, total_minor, paid_total_minor, credit_total_minor,
          known_cost_total_minor, pending_cost_line_count, unknown_cost_line_count,
          payment_status, status, device_id, operation_id
        ) values (
          $1, $2, $3, $4, $5, $6,
          600, 50, 48, 1, 503, 0, 503,
          251, 0, 0, 'credit', 'posted', $7, $8
        )`,
        [
          sales[index],
          stores[index],
          customers[index],
          periods[index],
          `SALE-S172-${String(index)}`,
          saleAt,
          devices[index],
          randomUUID(),
        ],
      );
      await db().admin.query(
        `insert into ledger.sale_items(
          id, store_id, sale_id, product_id, product_unit_id, is_manual_line,
          product_name_snapshot, unit_name_snapshot, quantity_milli,
          conversion_factor_num, conversion_factor_den, base_quantity_milli,
          unit_price_minor, line_gross_minor, line_discount_minor, rounding_minor,
          line_total_minor, cost_status, unit_cost_minor, line_cost_minor,
          inventory_movement_id
        ) values (
          $1, $2, $3, $4, $5, false,
          'Historical S17.2 Product', 'piece', 5000,
          1, 1, 5000,
          120, 600, 50, 0,
          550, 'known', 50, 251,
          $6
        )`,
        [
          saleItems[index],
          stores[index],
          sales[index],
          products[index],
          units[index],
          inventoryMovementId,
        ],
      );
      if (index === 0) {
        await db().admin.query(
          `insert into ledger.customer_ledger_entries(
            id, store_id, customer_id, accounting_period_id, entry_type,
            receivable_delta_minor, credit_delta_minor, source_sale_id,
            reference_type, reference_id, transaction_group_id, occurred_at,
            device_id, operation_id
          ) values (
            $1, $2, $3, $4, 'sale_credit', 503, 0, $5,
            'sale', $5, $6, $7, $8, $9
          )`,
          [
            randomUUID(),
            stores[index],
            customers[index],
            periods[index],
            sales[index],
            randomUUID(),
            saleAt,
            devices[index],
            randomUUID(),
          ],
        );
      }
    }

    const priorReturnId = randomUUID();
    await db().admin.query(
      `insert into ledger.sale_returns(
        id, store_id, sale_id, customer_id, accounting_period_id,
        display_number, return_at, total_minor, status, notes,
        device_id, operation_id
      ) values ($1, $2, $3, $4, $5, $6, $7, 0, 'posted', 'prior active quantity', $8, $9)`,
      [
        priorReturnId,
        stores[0],
        sales[0],
        customers[0],
        periods[0],
        `RETURN-S172-${priorReturnId}`,
        acceptedAt,
        devices[0],
        randomUUID(),
      ],
    );
    await db().admin.query(
      `insert into ledger.sale_return_items(
        id, store_id, sale_return_id, sale_item_id, quantity_milli,
        base_quantity_milli, line_refund_minor, item_condition
      ) values ($1, $2, $3, $4, 1000, 1000, 0, 'damaged')`,
      [randomUUID(), stores[0], priorReturnId, saleItems[0]],
    );
  });

  afterAll(async () => {
    if (database) await database.close();
  });

  it('maps all six existing Return tables exactly and keeps migrations at 15', async () => {
    const applied = await db().admin.query<{ filename: string; checksumSha256: string }>(
      `select filename, checksum_sha256 as "checksumSha256"
       from platform.schema_migrations order by filename`,
    );
    expect(applied.rows).toHaveLength(15);
    expect(applied.rows.at(-1)?.filename).toBe(migrationFilename);
    expect(() => verifyChecksums(migrationFiles, applied.rows)).not.toThrow();

    for (const table of tables) {
      const config = getTableConfig(table);
      const relation = `ledger.${config.name}`;
      const columns = await db().admin.query<{ name: string; type: string; notNull: boolean }>(
        `select attname as name, format_type(atttypid, atttypmod) as type,
                attnotnull as "notNull"
         from pg_attribute
         where attrelid = $1::regclass and attnum > 0 and not attisdropped
         order by attnum`,
        [relation],
      );
      expect(columns.rows).toEqual(
        config.columns.map((column) => ({
          name: column.name,
          type: column.getSQLType(),
          notNull: column.notNull,
        })),
      );
      for (const [type, expected] of [
        ['c', config.checks.map((constraint) => constraint.name)],
        ['f', config.foreignKeys.map((constraint) => constraint.getName())],
        ['u', config.uniqueConstraints.map((constraint) => constraint.name)],
      ] as const) {
        const constraints = await db().admin.query<{ name: string }>(
          `select conname as name from pg_constraint
           where conrelid = $1::regclass and contype = $2 order by conname`,
          [relation, type],
        );
        expect(constraints.rows.map((row) => row.name).sort()).toEqual([...expected].sort());
      }
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
        [relation],
      );
      expect(indexes.rows.map((row) => row.name)).toEqual(
        config.indexes.map((definition) => definition.config.name).sort(),
      );
    }
  });

  it('resolves the exact tenant Sale and derives active prior returned quantity', async () => {
    const plan = await runtimeTransaction(0, (transaction) =>
      repository.buildNewPlanWithinTransaction(
        transaction,
        stores[0],
        command(sales[0], saleItems[0]),
      ),
    );
    expect(plan).toMatchObject({
      saleId: sales[0],
      saleDisplayNumber: 'SALE-S172-0',
      customerId: customers[0],
      customerStatus: 'active',
      totalReturnValueMinor: 101n,
      currentSaleReceivableMinor: 503n,
      settlement: { receivableReductionMinor: 101n, refundMinor: 0n },
    });
    expect(plan.lines[0]).toMatchObject({
      saleItemId: saleItems[0],
      previousReturnedQuantityMilli: 1000n,
      requestedQuantityMilli: 1000n,
      cumulativeReturnedQuantityMilli: 2000n,
      historicalNetValueMinor: 503n,
      returnValueMinor: 101n,
      returnHistoricalCostMinor: 50n,
    });
  });

  it('rejects a Sale line from another Sale transactionally', async () => {
    await expect(
      runtimeTransaction(0, (transaction) =>
        repository.buildNewPlanWithinTransaction(
          transaction,
          stores[0],
          command(sales[0], saleItems[1]),
        ),
      ),
    ).rejects.toMatchObject({ code: 'SALE_RETURN_LINE_NOT_FOUND' });
  });

  it('fails closed for a Sale from another Store', async () => {
    await expect(
      runtimeTransaction(0, (transaction) =>
        repository.buildNewPlanWithinTransaction(
          transaction,
          stores[0],
          command(sales[1], saleItems[1]),
        ),
      ),
    ).rejects.toMatchObject({ code: 'SALE_RETURN_SALE_NOT_FOUND' });
  });

  it('rejects cancelled and reversed Sale leaves, then accepts the restored active leaf', async () => {
    try {
      await db().admin.query(
        `update ledger.sales
         set status='cancelled', cancelled_at=clock_timestamp()
         where id=$1`,
        [sales[0]],
      );
      await expect(
        runtimeTransaction(0, (transaction) =>
          repository.buildNewPlanWithinTransaction(
            transaction,
            stores[0],
            command(sales[0], saleItems[0]),
          ),
        ),
      ).rejects.toMatchObject({ code: 'SALE_RETURN_SALE_INACTIVE' });

      await db().admin.query(
        `update ledger.sales
         set status='posted', cancelled_at=null, reversed_by_id=id
         where id=$1`,
        [sales[0]],
      );
      await expect(
        runtimeTransaction(0, (transaction) =>
          repository.buildNewPlanWithinTransaction(
            transaction,
            stores[0],
            command(sales[0], saleItems[0]),
          ),
        ),
      ).rejects.toMatchObject({ code: 'SALE_RETURN_SALE_INACTIVE' });
    } finally {
      await db().admin.query(
        `update ledger.sales
         set status='posted', cancelled_at=null, reversed_by_id=null
         where id=$1`,
        [sales[0]],
      );
    }

    await expect(
      runtimeTransaction(0, (transaction) =>
        repository.buildNewPlanWithinTransaction(
          transaction,
          stores[0],
          command(sales[0], saleItems[0]),
        ),
      ),
    ).resolves.toMatchObject({ saleId: sales[0] });
  });

  it('uses server transaction time so a client timestamp cannot bypass the 48-hour window', async () => {
    const expiredSaleAt = new Date(acceptedAt.getTime() - 49 * 60 * 60 * 1000);
    await db().admin.query(`update ledger.sales set sale_at=$2 where id=$1`, [
      sales[0],
      expiredSaleAt,
    ]);
    const backdated = parseSaleReturnCommand(sales[0], {
      operationId: randomUUID(),
      occurredAt: new Date(expiredSaleAt.getTime() + 60 * 60 * 1000).toISOString(),
      reason: 'Client backdate must not control eligibility',
      lines: [
        {
          saleItemId: saleItems[0],
          quantityMilli: '1000',
          disposition: 'DAMAGED_NO_RESTOCK',
        },
      ],
      residualSettlement: null,
    });
    try {
      await expect(
        runtimeTransaction(0, (transaction) =>
          repository.buildNewPlanWithinTransaction(transaction, stores[0], backdated),
        ),
      ).rejects.toMatchObject({ code: 'SALE_RETURN_WINDOW_EXPIRED' });
    } finally {
      await db().admin.query(`update ledger.sales set sale_at=$2 where id=$1`, [sales[0], saleAt]);
    }
  });

  it('locks one tenant-owned active and available Money Account for a refund residual', async () => {
    const refundable = command(
      sales[1],
      saleItems[1],
      '1000',
      'DAMAGED_NO_RESTOCK',
      moneyAccounts[1],
    );
    await expect(
      runtimeTransaction(1, (transaction) =>
        repository.buildNewPlanWithinTransaction(transaction, stores[1], refundable),
      ),
    ).resolves.toMatchObject({
      settlement: { refundMinor: 100n, refundMoneyAccountId: moneyAccounts[1] },
    });

    await db().admin.query(
      `update ledger.money_accounts
       set status='archived', archived_at=clock_timestamp()
       where id=$1`,
      [moneyAccounts[1]],
    );
    try {
      await expect(
        runtimeTransaction(1, (transaction) =>
          repository.buildNewPlanWithinTransaction(transaction, stores[1], refundable),
        ),
      ).rejects.toMatchObject({ code: 'SALE_RETURN_REFUND_ACCOUNT_UNAVAILABLE' });
    } finally {
      await db().admin.query(
        `update ledger.money_accounts set status='active', archived_at=null where id=$1`,
        [moneyAccounts[1]],
      );
    }

    const foreignAccount = command(
      sales[1],
      saleItems[1],
      '1000',
      'DAMAGED_NO_RESTOCK',
      moneyAccounts[0],
    );
    await expect(
      runtimeTransaction(1, (transaction) =>
        repository.buildNewPlanWithinTransaction(transaction, stores[1], foreignAccount),
      ),
    ).rejects.toMatchObject({ code: 'SALE_RETURN_REFUND_ACCOUNT_UNAVAILABLE' });
  });

  it('reads archived historical Product linkage but requires restoration for saleable restock', async () => {
    await db().admin.query(
      `update ledger.products set status='archived', archived_at=clock_timestamp() where id=$1`,
      [products[0]],
    );
    try {
      await expect(
        runtimeTransaction(0, (transaction) =>
          repository.buildNewPlanWithinTransaction(
            transaction,
            stores[0],
            command(sales[0], saleItems[0], '1000', 'RESTOCK_SALEABLE'),
          ),
        ),
      ).rejects.toMatchObject({ code: 'SALE_RETURN_RESTOCK_UNAVAILABLE' });
      const damaged = await runtimeTransaction(0, (transaction) =>
        repository.buildNewPlanWithinTransaction(
          transaction,
          stores[0],
          command(sales[0], saleItems[0], '1000', 'DAMAGED_NO_RESTOCK'),
        ),
      );
      expect(damaged.lines[0]).toMatchObject({
        productId: products[0],
        productNameSnapshot: 'Historical S17.2 Product',
        currentRestockEligible: false,
        inventoryQuantityDeltaMilli: 0n,
      });
    } finally {
      await db().admin.query(
        `update ledger.products set status='active', archived_at=null where id=$1`,
        [products[0]],
      );
    }
  });

  it('serializes competing plans on the Sale root and prevents a stale over-return authorization', async () => {
    const first = await db().runtime.connect();
    const second = await db().runtime.connect();
    let firstOpen = false;
    let secondOpen = false;
    try {
      await first.query('begin');
      firstOpen = true;
      await second.query('begin');
      secondOpen = true;
      await setInventoryContext(first, stores[0], devices[0], users[0]);
      await setInventoryContext(second, stores[0], devices[0], users[0]);
      const firstTransaction = asTransaction(first);
      const secondTransaction = asTransaction(second);

      const firstPlan = await repository.buildNewPlanWithinTransaction(
        firstTransaction,
        stores[0],
        command(sales[0], saleItems[0], '3000'),
      );
      expect(firstPlan.lines[0]?.cumulativeReturnedQuantityMilli).toBe(4000n);

      let secondSettled = false;
      const competing = repository
        .buildNewPlanWithinTransaction(
          secondTransaction,
          stores[0],
          command(sales[0], saleItems[0], '3000'),
        )
        .finally(() => {
          secondSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(secondSettled).toBe(false);

      const returnId = randomUUID();
      await firstTransaction.insert(saleReturns).values({
        id: returnId,
        storeId: stores[0],
        saleId: sales[0],
        customerId: customers[0],
        accountingPeriodId: periods[0],
        displayNumber: `RETURN-S172-${returnId}`,
        returnAt: acceptedAt,
        totalMinor: 0n,
        status: 'draft',
        notes: 'serialization fixture',
        deviceId: devices[0],
        operationId: randomUUID(),
      });
      await firstTransaction.insert(saleReturnItems).values({
        id: randomUUID(),
        storeId: stores[0],
        saleReturnId: returnId,
        saleItemId: saleItems[0],
        quantityMilli: 3000n,
        baseQuantityMilli: 3000n,
        lineRefundMinor: 0n,
        itemCondition: 'damaged',
      });
      await firstTransaction
        .update(saleReturns)
        .set({ status: 'posted' })
        .where(and(eq(saleReturns.storeId, stores[0]), eq(saleReturns.id, returnId)));
      await first.query('commit');
      firstOpen = false;

      await expect(competing).rejects.toBeInstanceOf(SaleReturnAuthorityError);
      await expect(competing).rejects.toMatchObject({ code: 'SALE_RETURN_QUANTITY_EXCEEDED' });
    } finally {
      if (firstOpen) await first.query('rollback');
      if (secondOpen) await second.query('rollback');
      first.release();
      second.release();
    }
  });

  it('enforces the Customer archive financial-zero guard under tenant context', async () => {
    await runtimeTransaction(0, async (transaction) => {
      await expect(
        customerHasNoFinancialBalance(transaction, stores[0], customers[0]),
      ).resolves.toBe(false);
    });
    await runtimeTransaction(1, async (transaction) => {
      await expect(
        customerHasNoFinancialBalance(transaction, stores[1], customers[1]),
      ).resolves.toBe(true);
      expect((await transaction.execute(sql`select 1 as value`)).rows[0]).toMatchObject({
        value: 1,
      });
    });
  });

  it('keeps Return tables forced-RLS and fails closed without tenant context', async () => {
    const relations = await db().admin.query<{
      name: string;
      rls: boolean;
      forceRls: boolean;
      owner: string;
    }>(
      `select relname as name, relrowsecurity as rls, relforcerowsecurity as "forceRls",
              pg_get_userbyid(relowner) as owner
       from pg_class
       where oid = any($1::regclass[])
       order by relname`,
      [tables.map((table) => `ledger.${getTableConfig(table).name}`)],
    );
    expect(relations.rows).toHaveLength(6);
    expect(relations.rows.every((row) => row.rls && row.forceRls)).toBe(true);
    expect(new Set(relations.rows.map((row) => row.owner))).toEqual(new Set(['shop_app_migrator']));

    const client = await db().runtime.connect();
    try {
      await client.query('begin');
      const result = await client.query<{ count: number }>(
        `select count(*)::int as count from ledger.sale_returns`,
      );
      expect(result.rows[0]?.count).toBe(0);
      await client.query('rollback');
    } finally {
      client.release();
    }
  });
});
