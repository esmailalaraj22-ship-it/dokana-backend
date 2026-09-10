import { randomUUID } from 'node:crypto';

import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';

import { applyMigration, verifyChecksums, verifyMigrationSession } from '../scripts/migrate';
import { readMigrationFiles } from '../scripts/migrations/migration-files';
import {
  supplierPaymentAllocations,
  supplierPayments,
} from '../src/database/schema/supplier-finance';
import {
  createInventoryTestDatabase,
  setInventoryContext,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';

const migrationFilename = '0011_supplier_opening_payable_allocations.sql';
const stores = [randomUUID(), randomUUID()] as const;
const suppliers = [randomUUID(), randomUUID(), randomUUID()] as const;
const periods = [randomUUID(), randomUUID()] as const;
const payments = {
  existingInvoice: randomUUID(),
  newInvoice: randomUUID(),
  opening: randomUUID(),
  otherSupplier: randomUUID(),
  crossStore: randomUUID(),
} as const;
const invoices = {
  existing: randomUUID(),
  current: randomUUID(),
  otherSupplier: randomUUID(),
} as const;
const ledgerEntries = {
  opening: randomUUID(),
  otherSupplierOpening: randomUUID(),
  otherStoreOpening: randomUUID(),
  nonOpening: randomUUID(),
  supersededOpening: randomUUID(),
  supersedingReversal: randomUUID(),
} as const;
const existingAllocationId = randomUUID();
const contextUserId = randomUUID();
const contextDeviceId = randomUUID();

function postgresError(error: unknown): unknown {
  if (error instanceof Error && error.cause) return postgresError(error.cause);
  return error;
}

describe('S13.2 Opening Payable allocation physical foundation', () => {
  jest.setTimeout(120_000);

  let database: InventoryTestDatabase | undefined;
  let client: PoolClient;
  let clientConnected = false;
  let migrationFiles: Awaited<ReturnType<typeof readMigrationFiles>> = [];

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('Supplier Payment allocation database is unavailable.');
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

  async function insertAllocation(input: {
    paymentId: string;
    invoiceId?: string | null;
    openingPayableId?: string | null;
  }): Promise<void> {
    await client.query(
      `insert into ledger.supplier_payment_allocations(
         id, store_id, supplier_payment_id, purchase_invoice_id,
         opening_payable_ledger_entry_id, amount_minor
       ) values ($1, $2, $3, $4, $5, 100)`,
      [
        randomUUID(),
        stores[0],
        input.paymentId,
        input.invoiceId ?? null,
        input.openingPayableId ?? null,
      ],
    );
  }

  async function seedSupplierLedgerEntry(input: {
    id: string;
    storeId: string;
    supplierId: string;
    periodId: string;
    entryType: 'opening_balance' | 'supplier_invoice' | 'correction';
    payableDeltaMinor: number;
    sourceInvoiceId?: string | null;
    referenceType: string;
    referenceId: string;
    reversalOfId?: string | null;
  }): Promise<void> {
    await db().admin.query(
      `insert into ledger.supplier_ledger_entries(
         id,store_id,supplier_id,accounting_period_id,entry_type,
         payable_delta_minor,credit_delta_minor,source_purchase_invoice_id,
         reference_type,reference_id,transaction_group_id,occurred_at,
         reversal_of_id,operation_id
       ) values($1,$2,$3,$4,$5,$6,0,$7,$8,$9,$10,'2026-01-08T10:00:00Z',$11,$12)`,
      [
        input.id,
        input.storeId,
        input.supplierId,
        input.periodId,
        input.entryType,
        input.payableDeltaMinor,
        input.sourceInvoiceId ?? null,
        input.referenceType,
        input.referenceId,
        randomUUID(),
        input.reversalOfId ?? null,
        randomUUID(),
      ],
    );
  }

  async function expectTableMapping(table: PgTable): Promise<void> {
    const config = getTableConfig(table);
    const relation = `ledger.${config.name}`;
    const columns = await db().admin.query<{ name: string; type: string; notNull: boolean }>(
      `select attname as name, format_type(atttypid, atttypmod) as type,
              attnotnull as "notNull"
       from pg_attribute
       where attrelid=$1::regclass and attnum>0 and not attisdropped
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

    const constraints = await db().admin.query<{ type: string; names: string[] }>(
      `select contype::text as type, array_agg(conname order by conname)::text[] as names
       from pg_constraint where conrelid=$1::regclass and contype in ('c','f','u')
       group by contype order by contype`,
      [relation],
    );
    const namesFor = (type: string): string[] =>
      constraints.rows.find((row) => row.type === type)?.names ?? [];
    expect(namesFor('c')).toEqual(config.checks.map((check) => check.name).sort());
    expect(namesFor('f')).toEqual(config.foreignKeys.map((key) => key.getName()).sort());
    expect(namesFor('u')).toEqual(config.uniqueConstraints.map((key) => key.name).sort());

    const indexes = await db().admin.query<{ name: string }>(
      `select index_relation.relname as name
       from pg_index index_state
       join pg_class index_relation on index_relation.oid=index_state.indexrelid
       where index_state.indrelid=$1::regclass
         and not index_state.indisprimary
         and not exists(
           select 1 from pg_constraint constraint_state
           where constraint_state.conindid=index_state.indexrelid
         )
       order by index_relation.relname`,
      [relation],
    );
    expect(indexes.rows.map((row) => row.name)).toEqual(
      config.indexes.map((indexDefinition) => indexDefinition.config.name).sort(),
    );
  }

  beforeAll(async () => {
    migrationFiles = await readMigrationFiles();
    database = await createInventoryTestDatabase(migrationFilename);

    await db().admin.query(
      `insert into ledger.stores(id,name) values
         ($1,'S13.2 store A'),($2,'S13.2 store B')`,
      [...stores],
    );
    await db().admin.query(
      `insert into ledger.suppliers(id,store_id,name,normalized_name,operation_id) values
         ($1,$4,'Supplier A',$1::uuid::text,$6),
         ($2,$4,'Supplier B',$2::uuid::text,$7),
         ($3,$5,'Supplier C',$3::uuid::text,$8)`,
      [
        suppliers[0],
        suppliers[1],
        suppliers[2],
        stores[0],
        stores[1],
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ],
    );
    await db().admin.query(
      `insert into ledger.accounting_periods(
         id,store_id,period_year,period_month,starts_at,ends_at,status,operation_id
       ) values
         ($1,$3,2026,1,'2025-12-31T22:00:00Z','2026-01-31T22:00:00Z','open',$5),
         ($2,$4,2026,1,'2025-12-31T22:00:00Z','2026-01-31T22:00:00Z','open',$6)`,
      [periods[0], periods[1], stores[0], stores[1], randomUUID(), randomUUID()],
    );
    await db().admin.query(
      `insert into ledger.purchase_invoices(
         id,store_id,supplier_id,display_number,invoice_date_at,operation_id
       ) values
         ($1,$4,$5,'S132-EXISTING','2026-01-05T10:00:00Z',$7),
         ($2,$4,$5,'S132-CURRENT','2026-01-06T10:00:00Z',$8),
         ($3,$4,$6,'S132-OTHER','2026-01-07T10:00:00Z',$9)`,
      [
        invoices.existing,
        invoices.current,
        invoices.otherSupplier,
        stores[0],
        suppliers[0],
        suppliers[1],
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ],
    );
    await db().admin.query(
      `insert into ledger.supplier_payments(
         id,store_id,supplier_id,amount_minor,payment_source,payment_at,status,operation_id
       ) values
         ($1,$6,$7,100,'money_account','2026-01-10T10:00:00Z','draft',$9),
         ($2,$6,$7,100,'money_account','2026-01-10T10:00:00Z','draft',$10),
         ($3,$6,$7,100,'money_account','2026-01-10T10:00:00Z','draft',$11),
         ($4,$6,$8,100,'money_account','2026-01-10T10:00:00Z','draft',$12),
         ($5,$6,$7,100,'money_account','2026-01-10T10:00:00Z','draft',$13)`,
      [
        payments.existingInvoice,
        payments.newInvoice,
        payments.opening,
        payments.otherSupplier,
        payments.crossStore,
        stores[0],
        suppliers[0],
        suppliers[1],
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ],
    );
    await seedSupplierLedgerEntry({
      id: ledgerEntries.opening,
      storeId: stores[0],
      supplierId: suppliers[0],
      periodId: periods[0],
      entryType: 'opening_balance',
      payableDeltaMinor: 1200,
      referenceType: 'opening_balance',
      referenceId: ledgerEntries.opening,
    });
    await seedSupplierLedgerEntry({
      id: ledgerEntries.otherSupplierOpening,
      storeId: stores[0],
      supplierId: suppliers[1],
      periodId: periods[0],
      entryType: 'opening_balance',
      payableDeltaMinor: 800,
      referenceType: 'opening_balance',
      referenceId: ledgerEntries.otherSupplierOpening,
    });
    await seedSupplierLedgerEntry({
      id: ledgerEntries.otherStoreOpening,
      storeId: stores[1],
      supplierId: suppliers[2],
      periodId: periods[1],
      entryType: 'opening_balance',
      payableDeltaMinor: 600,
      referenceType: 'opening_balance',
      referenceId: ledgerEntries.otherStoreOpening,
    });
    await seedSupplierLedgerEntry({
      id: ledgerEntries.nonOpening,
      storeId: stores[0],
      supplierId: suppliers[0],
      periodId: periods[0],
      entryType: 'supplier_invoice',
      payableDeltaMinor: 300,
      sourceInvoiceId: invoices.existing,
      referenceType: 'supplier_invoice',
      referenceId: invoices.existing,
    });
    await seedSupplierLedgerEntry({
      id: ledgerEntries.supersededOpening,
      storeId: stores[0],
      supplierId: suppliers[0],
      periodId: periods[0],
      entryType: 'opening_balance',
      payableDeltaMinor: 500,
      referenceType: 'opening_balance',
      referenceId: ledgerEntries.supersededOpening,
    });
    await seedSupplierLedgerEntry({
      id: ledgerEntries.supersedingReversal,
      storeId: stores[0],
      supplierId: suppliers[0],
      periodId: periods[0],
      entryType: 'correction',
      payableDeltaMinor: -500,
      referenceType: 'supplier_opening_payable_correction',
      referenceId: ledgerEntries.supersededOpening,
      reversalOfId: ledgerEntries.supersededOpening,
    });
    await db().admin.query(
      `insert into ledger.supplier_payment_allocations(
         id,store_id,supplier_payment_id,purchase_invoice_id,amount_minor
       ) values ($1,$2,$3,$4,100)`,
      [existingAllocationId, stores[0], payments.existingInvoice, invoices.existing],
    );

    const migrator = await db().migration.connect();
    try {
      await verifyMigrationSession(migrator);
      await migrator.query('begin');
      await migrator.query(db().file.contents);
      expect(
        (
          await migrator.query<{ present: boolean }>(
            `select exists(select 1 from pg_attribute
             where attrelid='ledger.supplier_payment_allocations'::regclass
               and attname='opening_payable_ledger_entry_id' and not attisdropped) as present`,
          )
        ).rows[0]?.present,
      ).toBe(true);
      await migrator.query('rollback');
      expect(
        (
          await migrator.query<{ absent: boolean }>(
            `select not exists(select 1 from pg_attribute
             where attrelid='ledger.supplier_payment_allocations'::regclass
               and attname='opening_payable_ledger_entry_id' and not attisdropped) as absent`,
          )
        ).rows[0]?.absent,
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
    await setInventoryContext(client, stores[0], contextDeviceId, contextUserId);
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

  it('applies as migration 0011, preserves existing data, and matches Drizzle', async () => {
    const applied = await db().admin.query<{ filename: string; checksumSha256: string }>(
      `select filename,checksum_sha256 as "checksumSha256"
       from platform.schema_migrations order by filename`,
    );
    expect(applied.rows).toHaveLength(11);
    expect(applied.rows.at(-1)?.filename).toBe(migrationFilename);
    expect(() => verifyChecksums(migrationFiles, applied.rows)).not.toThrow();

    await expectTableMapping(supplierPayments);
    await expectTableMapping(supplierPaymentAllocations);
    expect(
      (
        await client.query(
          `select purchase_invoice_id as "purchaseInvoiceId",
                  opening_payable_ledger_entry_id as "openingPayableId",
                  amount_minor::text as "amountMinor"
           from ledger.supplier_payment_allocations
           where store_id=$1 and id=$2`,
          [stores[0], existingAllocationId],
        )
      ).rows[0],
    ).toEqual({ purchaseInvoiceId: invoices.existing, openingPayableId: null, amountMinor: '100' });
  });

  it('preserves Purchase Invoice allocations and accepts an Opening Payable target', async () => {
    await insertAllocation({ paymentId: payments.newInvoice, invoiceId: invoices.current });
    await insertAllocation({
      paymentId: payments.opening,
      openingPayableId: ledgerEntries.opening,
    });
    expect(
      (
        await client.query<{ invoices: string; openings: string }>(
          `select count(*) filter(where purchase_invoice_id is not null)::text as invoices,
                  count(*) filter(where opening_payable_ledger_entry_id is not null)::text as openings
           from ledger.supplier_payment_allocations where store_id=$1`,
          [stores[0]],
        )
      ).rows[0],
    ).toEqual({ invoices: '2', openings: '1' });
  });

  it('rejects both targets, no target, non-opening facts, and superseded openings', async () => {
    await rejectAtSavepoint(
      () =>
        insertAllocation({
          paymentId: payments.opening,
          invoiceId: invoices.current,
          openingPayableId: ledgerEntries.opening,
        }),
      '23514',
    );
    await rejectAtSavepoint(() => insertAllocation({ paymentId: payments.opening }), '23514');
    await rejectAtSavepoint(
      () =>
        insertAllocation({
          paymentId: payments.opening,
          openingPayableId: ledgerEntries.nonOpening,
        }),
      '23514',
    );
    await rejectAtSavepoint(
      () =>
        insertAllocation({
          paymentId: payments.opening,
          openingPayableId: ledgerEntries.supersededOpening,
        }),
      '23514',
    );
  });

  it('rejects cross-Supplier and cross-Store obligation targets', async () => {
    await rejectAtSavepoint(
      () =>
        insertAllocation({
          paymentId: payments.opening,
          openingPayableId: ledgerEntries.otherSupplierOpening,
        }),
      '23514',
    );
    await rejectAtSavepoint(
      () =>
        insertAllocation({
          paymentId: payments.otherSupplier,
          invoiceId: invoices.current,
        }),
      '23514',
    );
    await rejectAtSavepoint(
      () =>
        insertAllocation({
          paymentId: payments.crossStore,
          openingPayableId: ledgerEntries.otherStoreOpening,
        }),
      '23514',
    );
  });

  it('retains forced RLS, fail-closed access, ownership, and narrow trigger security', async () => {
    const relations = await db().admin.query<{
      name: string;
      owner: string;
      rls: boolean;
      forceRls: boolean;
    }>(
      `select relname as name,pg_get_userbyid(relowner) as owner,
              relrowsecurity as rls,relforcerowsecurity as "forceRls"
       from pg_class where oid=any($1::regclass[]) order by relname`,
      [['ledger.supplier_payment_allocations', 'ledger.supplier_payments']],
    );
    expect(relations.rows).toEqual([
      {
        name: 'supplier_payment_allocations',
        owner: 'shop_app_migrator',
        rls: true,
        forceRls: true,
      },
      { name: 'supplier_payments', owner: 'shop_app_migrator', rls: true, forceRls: true },
    ]);

    const validation = await db().admin.query<{
      owner: string;
      securityDefiner: boolean;
      config: string[];
      publicExecute: boolean;
      triggerCount: string;
    }>(`select pg_get_userbyid(proowner) as owner,prosecdef as "securityDefiner",
       proconfig as config,
       exists(select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner)))
         where grantee=0 and privilege_type='EXECUTE') as "publicExecute",
       (select count(*)::text from pg_trigger where
         tgrelid='ledger.supplier_payment_allocations'::regclass
         and tgname='trg_supplier_allocations_target_validate' and not tgisinternal) as "triggerCount"
       from pg_proc where oid='ledger.validate_supplier_payment_allocation_target()'::regprocedure`);
    expect(validation.rows[0]).toEqual({
      owner: 'shop_app_migrator',
      securityDefiner: false,
      config: ['search_path=pg_catalog, pg_temp'],
      publicExecute: false,
      triggerCount: '1',
    });

    const withoutContext = await db().runtime.connect();
    try {
      await withoutContext.query('begin');
      expect(
        (
          await withoutContext.query<{ count: string }>(
            `select count(*) from ledger.supplier_payment_allocations`,
          )
        ).rows[0]?.count,
      ).toBe('0');
      await expect(
        withoutContext.query(
          `insert into ledger.supplier_payment_allocations(
             id,store_id,supplier_payment_id,purchase_invoice_id,amount_minor
           ) values($1,$2,$3,$4,100)`,
          [randomUUID(), stores[0], payments.newInvoice, invoices.current],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await withoutContext.query('rollback');
      withoutContext.release();
    }
  });

  it('creates no money, inventory, Goods Receipt, or Expense effect', async () => {
    await insertAllocation({
      paymentId: payments.opening,
      openingPayableId: ledgerEntries.opening,
    });
    expect(
      (
        await client.query<{ effects: string }>(
          `select
             (select count(*) from ledger.money_movements)
             + (select count(*) from ledger.inventory_movements)
             + (select count(*) from ledger.stock_balances)
             + (select count(*) from ledger.goods_receipts)
             + (select count(*) from ledger.goods_receipt_items)
             + (select count(*) from ledger.expenses) as effects`,
        )
      ).rows[0]?.effects,
    ).toBe('0');
  });
});
