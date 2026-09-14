import { randomUUID } from 'node:crypto';

import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';

import { applyMigration, verifyChecksums, verifyMigrationSession } from '../scripts/migrate';
import { readMigrationFiles } from '../scripts/migrations/migration-files';
import { customerPaymentAllocations, customerPayments } from '../src/database/schema/sales';
import {
  createInventoryTestDatabase,
  setInventoryContext,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';

const migrationFilename = '0014_customer_receivable_allocation_targets.sql';
const stores = [randomUUID(), randomUUID()] as const;
const customers = [randomUUID(), randomUUID(), randomUUID()] as const;
const periods = [randomUUID(), randomUUID()] as const;
const accounts = [randomUUID(), randomUUID()] as const;
const sales = {
  existing: randomUUID(),
  current: randomUUID(),
  otherCustomer: randomUUID(),
  otherStore: randomUUID(),
  anonymous: randomUUID(),
  withoutReceivable: randomUUID(),
} as const;
const payments = {
  existing: randomUUID(),
  sale: randomUUID(),
  opening: randomUUID(),
  manyTargets: randomUUID(),
  secondOpening: randomUUID(),
  lineageOpening: randomUUID(),
} as const;
const ledgerEntries = {
  saleExisting: randomUUID(),
  saleCurrent: randomUUID(),
  saleOtherCustomer: randomUUID(),
  saleOtherStore: randomUUID(),
  opening: randomUUID(),
  otherCustomerOpening: randomUUID(),
  otherStoreOpening: randomUUID(),
  supersededOpening: randomUUID(),
  supersedingReversal: randomUUID(),
  payment: randomUUID(),
  settlement: randomUUID(),
  creditCreated: randomUUID(),
  creditUsed: randomUUID(),
  refund: randomUUID(),
  malformedOpening: randomUUID(),
  existingPaymentEffect: randomUUID(),
  openingPaymentEffect: randomUUID(),
} as const;
const existingAllocationId = randomUUID();
const contextUserId = randomUUID();
const contextDeviceId = randomUUID();

type CustomerLedgerEntryType =
  | 'sale_credit'
  | 'payment'
  | 'settlement'
  | 'opening_balance'
  | 'credit_created'
  | 'credit_used'
  | 'refund'
  | 'correction';

function postgresError(error: unknown): unknown {
  if (error instanceof Error && error.cause) return postgresError(error.cause);
  return error;
}

describe('S15.2 Customer Receivable allocation physical foundation', () => {
  jest.setTimeout(120_000);

  let database: InventoryTestDatabase | undefined;
  let client: PoolClient;
  let clientConnected = false;
  let migrationFiles: Awaited<ReturnType<typeof readMigrationFiles>> = [];

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('Customer allocation test database is unavailable.');
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
    saleId?: string | null;
    openingReceivableId?: string | null;
    customerLedgerEntryId?: string | null;
  }): Promise<string> {
    const id = randomUUID();
    await client.query(
      `insert into ledger.customer_payment_allocations(
         id,store_id,customer_payment_id,sale_id,amount_minor,
         customer_ledger_entry_id,opening_receivable_ledger_entry_id
       ) values($1,$2,$3,$4,100,$5,$6)`,
      [
        id,
        stores[0],
        input.paymentId,
        input.saleId ?? null,
        input.customerLedgerEntryId ?? null,
        input.openingReceivableId ?? null,
      ],
    );
    return id;
  }

  async function seedLedgerEntry(input: {
    id: string;
    storeId?: string;
    customerId?: string;
    periodId?: string;
    entryType: CustomerLedgerEntryType;
    receivableDeltaMinor: number;
    creditDeltaMinor?: number;
    sourceSaleId?: string | null;
    referenceType: string;
    referenceId: string;
    reversalOfId?: string | null;
  }): Promise<void> {
    await db().admin.query(
      `insert into ledger.customer_ledger_entries(
         id,store_id,customer_id,accounting_period_id,entry_type,
         receivable_delta_minor,credit_delta_minor,source_sale_id,
         reference_type,reference_id,transaction_group_id,occurred_at,
         reversal_of_id,operation_id
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'2026-01-08T10:00:00Z',$12,$13)`,
      [
        input.id,
        input.storeId ?? stores[0],
        input.customerId ?? customers[0],
        input.periodId ?? periods[0],
        input.entryType,
        input.receivableDeltaMinor,
        input.creditDeltaMinor ?? 0,
        input.sourceSaleId ?? null,
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
      `select attname as name,format_type(atttypid,atttypmod) as type,
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
      `select contype::text as type,array_agg(conname order by conname)::text[] as names
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
         ($1,'S15.2 store A'),($2,'S15.2 store B')`,
      [...stores],
    );
    await db().admin.query(
      `insert into ledger.customers(
         id,store_id,name,normalized_name,phone,normalized_phone,operation_id
       ) values
         ($1,$4,'Customer A','customer a',$1::uuid::text,$1::uuid::text,$6),
         ($2,$4,'Customer B','customer b',$2::uuid::text,$2::uuid::text,$7),
         ($3,$5,'Customer C','customer c',$3::uuid::text,$3::uuid::text,$8)`,
      [
        customers[0],
        customers[1],
        customers[2],
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
      `insert into ledger.money_accounts(
         id,store_id,name,normalized_name,account_type,availability,operation_id
       ) values
         ($1,$3,'Cash A','cash a','cash','available',$5),
         ($2,$4,'Cash B','cash b','cash','available',$6)`,
      [accounts[0], accounts[1], stores[0], stores[1], randomUUID(), randomUUID()],
    );

    const saleRows = [
      [sales.existing, stores[0], customers[0], 'S152-EXISTING', 0, 100],
      [sales.current, stores[0], customers[0], 'S152-CURRENT', 0, 100],
      [sales.otherCustomer, stores[0], customers[1], 'S152-OTHER-CUSTOMER', 0, 100],
      [sales.otherStore, stores[1], customers[2], 'S152-OTHER-STORE', 0, 100],
      [sales.anonymous, stores[0], null, 'S152-ANONYMOUS', 100, 0],
      [sales.withoutReceivable, stores[0], customers[0], 'S152-NO-RECEIVABLE', 100, 0],
    ] as const;
    for (const [id, storeId, customerId, displayNumber, paid, credit] of saleRows) {
      await db().admin.query(
        `insert into ledger.sales(
           id,store_id,customer_id,accounting_period_id,display_number,sale_at,
           items_subtotal_minor,total_minor,paid_total_minor,credit_total_minor,
           payment_status,status,operation_id
         ) values($1,$2,$3,$4,$5,'2026-01-05T10:00:00Z',100,100,$6,$7,$8,'posted',$9)`,
        [
          id,
          storeId,
          customerId,
          storeId === stores[0] ? periods[0] : periods[1],
          displayNumber,
          paid,
          credit,
          credit === 0 ? 'paid' : 'credit',
          randomUUID(),
        ],
      );
    }

    for (const [entryId, saleId, storeId, customerId, periodId] of [
      [ledgerEntries.saleExisting, sales.existing, stores[0], customers[0], periods[0]],
      [ledgerEntries.saleCurrent, sales.current, stores[0], customers[0], periods[0]],
      [ledgerEntries.saleOtherCustomer, sales.otherCustomer, stores[0], customers[1], periods[0]],
      [ledgerEntries.saleOtherStore, sales.otherStore, stores[1], customers[2], periods[1]],
    ] as const) {
      await seedLedgerEntry({
        id: entryId,
        storeId,
        customerId,
        periodId,
        entryType: 'sale_credit',
        receivableDeltaMinor: 100,
        sourceSaleId: saleId,
        referenceType: 'sale',
        referenceId: saleId,
      });
    }

    await seedLedgerEntry({
      id: ledgerEntries.opening,
      entryType: 'opening_balance',
      receivableDeltaMinor: 1200,
      referenceType: 'customer_opening_receivable',
      referenceId: ledgerEntries.opening,
    });
    await seedLedgerEntry({
      id: ledgerEntries.otherCustomerOpening,
      customerId: customers[1],
      entryType: 'opening_balance',
      receivableDeltaMinor: 800,
      referenceType: 'customer_opening_receivable',
      referenceId: ledgerEntries.otherCustomerOpening,
    });
    await seedLedgerEntry({
      id: ledgerEntries.otherStoreOpening,
      storeId: stores[1],
      customerId: customers[2],
      periodId: periods[1],
      entryType: 'opening_balance',
      receivableDeltaMinor: 600,
      referenceType: 'customer_opening_receivable',
      referenceId: ledgerEntries.otherStoreOpening,
    });
    await seedLedgerEntry({
      id: ledgerEntries.supersededOpening,
      entryType: 'opening_balance',
      receivableDeltaMinor: 500,
      referenceType: 'customer_opening_receivable',
      referenceId: ledgerEntries.supersededOpening,
    });
    await seedLedgerEntry({
      id: ledgerEntries.supersedingReversal,
      entryType: 'correction',
      receivableDeltaMinor: -500,
      referenceType: 'customer_opening_receivable_correction',
      referenceId: ledgerEntries.supersededOpening,
      reversalOfId: ledgerEntries.supersededOpening,
    });
    await seedLedgerEntry({
      id: ledgerEntries.payment,
      entryType: 'payment',
      receivableDeltaMinor: -100,
      sourceSaleId: sales.current,
      referenceType: 'customer_payment',
      referenceId: payments.sale,
    });
    await seedLedgerEntry({
      id: ledgerEntries.settlement,
      entryType: 'settlement',
      receivableDeltaMinor: -100,
      referenceType: 'customer_settlement',
      referenceId: ledgerEntries.settlement,
    });
    await seedLedgerEntry({
      id: ledgerEntries.creditCreated,
      entryType: 'credit_created',
      receivableDeltaMinor: 0,
      creditDeltaMinor: 100,
      referenceType: 'customer_payment',
      referenceId: payments.sale,
    });
    await seedLedgerEntry({
      id: ledgerEntries.creditUsed,
      entryType: 'credit_used',
      receivableDeltaMinor: 0,
      creditDeltaMinor: -100,
      referenceType: 'sale',
      referenceId: sales.current,
    });
    await seedLedgerEntry({
      id: ledgerEntries.refund,
      entryType: 'refund',
      receivableDeltaMinor: 0,
      creditDeltaMinor: -100,
      referenceType: 'customer_refund',
      referenceId: ledgerEntries.refund,
    });
    await seedLedgerEntry({
      id: ledgerEntries.malformedOpening,
      entryType: 'opening_balance',
      receivableDeltaMinor: 300,
      referenceType: 'fixture_not_an_opening_origin',
      referenceId: ledgerEntries.malformedOpening,
    });

    for (const [paymentId, customerId] of [
      [payments.existing, customers[0]],
      [payments.sale, customers[0]],
      [payments.opening, customers[0]],
      [payments.manyTargets, customers[0]],
      [payments.secondOpening, customers[0]],
      [payments.lineageOpening, customers[0]],
    ] as const) {
      await db().admin.query(
        `insert into ledger.customer_payments(
           id,store_id,customer_id,accounting_period_id,money_account_id,
           amount_minor,payment_at,status,operation_id
         ) values($1,$2,$3,$4,$5,2000,'2026-01-10T10:00:00Z','draft',$6)`,
        [paymentId, stores[0], customerId, periods[0], accounts[0], randomUUID()],
      );
    }

    await seedLedgerEntry({
      id: ledgerEntries.existingPaymentEffect,
      entryType: 'payment',
      receivableDeltaMinor: -100,
      sourceSaleId: sales.existing,
      referenceType: 'customer_payment',
      referenceId: payments.existing,
    });
    await seedLedgerEntry({
      id: ledgerEntries.openingPaymentEffect,
      entryType: 'payment',
      receivableDeltaMinor: -100,
      referenceType: 'customer_payment',
      referenceId: payments.lineageOpening,
    });
    await db().admin.query(
      `insert into ledger.customer_payment_allocations(
         id,store_id,customer_payment_id,sale_id,amount_minor,customer_ledger_entry_id
       ) values($1,$2,$3,$4,100,$5)`,
      [
        existingAllocationId,
        stores[0],
        payments.existing,
        sales.existing,
        ledgerEntries.existingPaymentEffect,
      ],
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
             where attrelid='ledger.customer_payment_allocations'::regclass
               and attname='opening_receivable_ledger_entry_id' and not attisdropped) as present`,
          )
        ).rows[0]?.present,
      ).toBe(true);
      await migrator.query('rollback');
      expect(
        (
          await migrator.query<{ absent: boolean }>(
            `select not exists(select 1 from pg_attribute
             where attrelid='ledger.customer_payment_allocations'::regclass
               and attname='opening_receivable_ledger_entry_id' and not attisdropped) as absent`,
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

  it('applies as migration 0014, preserves Sale history, and matches exact Drizzle mappings', async () => {
    const applied = await db().admin.query<{ filename: string; checksumSha256: string }>(
      `select filename,checksum_sha256 as "checksumSha256"
       from platform.schema_migrations order by filename`,
    );
    expect(applied.rows).toHaveLength(14);
    expect(applied.rows.at(-1)?.filename).toBe(migrationFilename);
    expect(() => verifyChecksums(migrationFiles, applied.rows)).not.toThrow();

    await expectTableMapping(customerPayments);
    await expectTableMapping(customerPaymentAllocations);
    expect(
      (
        await client.query(
          `select sale_id as "saleId",
                  opening_receivable_ledger_entry_id as "openingReceivableId",
                  customer_ledger_entry_id as "paymentEffectId",
                  amount_minor::text as "amountMinor"
           from ledger.customer_payment_allocations where store_id=$1 and id=$2`,
          [stores[0], existingAllocationId],
        )
      ).rows[0],
    ).toEqual({
      saleId: sales.existing,
      openingReceivableId: null,
      paymentEffectId: ledgerEntries.existingPaymentEffect,
      amountMinor: '100',
    });
  });

  it('accepts exactly one valid Sale or Opening Receivable origin and rejects invalid shapes', async () => {
    await insertAllocation({ paymentId: payments.sale, saleId: sales.current });
    await insertAllocation({
      paymentId: payments.opening,
      openingReceivableId: ledgerEntries.opening,
    });
    await rejectAtSavepoint(() => insertAllocation({ paymentId: payments.manyTargets }), '23514');
    await rejectAtSavepoint(
      () =>
        insertAllocation({
          paymentId: payments.manyTargets,
          saleId: sales.current,
          openingReceivableId: ledgerEntries.opening,
        }),
      '23514',
    );
  });

  it('enforces Sale target Customer identity, receivable identity, and per-payment uniqueness', async () => {
    await rejectAtSavepoint(
      () => insertAllocation({ paymentId: payments.sale, saleId: sales.otherCustomer }),
      '23514',
    );
    await rejectAtSavepoint(
      () => insertAllocation({ paymentId: payments.sale, saleId: sales.otherStore }),
      '23514',
    );
    await rejectAtSavepoint(
      () => insertAllocation({ paymentId: payments.sale, saleId: sales.anonymous }),
      '23514',
    );
    await rejectAtSavepoint(
      () => insertAllocation({ paymentId: payments.sale, saleId: sales.withoutReceivable }),
      '23514',
    );
    await insertAllocation({ paymentId: payments.sale, saleId: sales.current });
    await rejectAtSavepoint(
      () => insertAllocation({ paymentId: payments.sale, saleId: sales.current }),
      '23505',
    );
  });

  it('accepts only an exact active Opening Receivable origin and rejects arbitrary ledger rows', async () => {
    for (const invalidTarget of [
      ledgerEntries.saleCurrent,
      ledgerEntries.payment,
      ledgerEntries.settlement,
      ledgerEntries.creditCreated,
      ledgerEntries.creditUsed,
      ledgerEntries.refund,
      ledgerEntries.supersedingReversal,
      ledgerEntries.malformedOpening,
      ledgerEntries.supersededOpening,
    ]) {
      await rejectAtSavepoint(
        () =>
          insertAllocation({
            paymentId: payments.opening,
            openingReceivableId: invalidTarget,
          }),
        '23514',
      );
    }
    await rejectAtSavepoint(
      () =>
        insertAllocation({
          paymentId: payments.opening,
          openingReceivableId: ledgerEntries.otherCustomerOpening,
        }),
      '23514',
    );
    await rejectAtSavepoint(
      () =>
        insertAllocation({
          paymentId: payments.opening,
          openingReceivableId: ledgerEntries.otherStoreOpening,
        }),
      '23514',
    );
    await insertAllocation({
      paymentId: payments.opening,
      openingReceivableId: ledgerEntries.opening,
    });
    await rejectAtSavepoint(
      () =>
        insertAllocation({
          paymentId: payments.opening,
          openingReceivableId: ledgerEntries.opening,
        }),
      '23505',
    );
  });

  it('preserves many-to-many allocation shape and separates origin from payment-effect lineage', async () => {
    await insertAllocation({ paymentId: payments.manyTargets, saleId: sales.current });
    await insertAllocation({
      paymentId: payments.manyTargets,
      openingReceivableId: ledgerEntries.opening,
    });
    await insertAllocation({
      paymentId: payments.secondOpening,
      openingReceivableId: ledgerEntries.opening,
    });
    const lineageAllocationId = await insertAllocation({
      paymentId: payments.lineageOpening,
      openingReceivableId: ledgerEntries.opening,
      customerLedgerEntryId: ledgerEntries.openingPaymentEffect,
    });

    expect(
      (
        await client.query<{ targets: string; payments: string }>(
          `select
             (select count(*)::text from ledger.customer_payment_allocations
               where customer_payment_id=$1) as targets,
             (select count(*)::text from ledger.customer_payment_allocations
               where opening_receivable_ledger_entry_id=$2) as payments`,
          [payments.manyTargets, ledgerEntries.opening],
        )
      ).rows[0],
    ).toEqual({ targets: '2', payments: '3' });
    expect(
      (
        await client.query(
          `select allocation.opening_receivable_ledger_entry_id as "originId",
                  allocation.customer_ledger_entry_id as "paymentEffectId",
                  effect.entry_type as "effectType",
                  effect.source_sale_id as "effectSourceSaleId"
           from ledger.customer_payment_allocations allocation
           join ledger.customer_ledger_entries effect
             on effect.store_id=allocation.store_id
            and effect.id=allocation.customer_ledger_entry_id
           where allocation.id=$1`,
          [lineageAllocationId],
        )
      ).rows[0],
    ).toEqual({
      originId: ledgerEntries.opening,
      paymentEffectId: ledgerEntries.openingPaymentEffect,
      effectType: 'payment',
      effectSourceSaleId: null,
    });
  });

  it('preserves forced RLS, fail-closed access, owner/grants, and narrow trigger security', async () => {
    const relations = await db().admin.query<{
      name: string;
      owner: string;
      rls: boolean;
      forceRls: boolean;
    }>(
      `select relname as name,pg_get_userbyid(relowner) as owner,
              relrowsecurity as rls,relforcerowsecurity as "forceRls"
       from pg_class where oid=any($1::regclass[]) order by relname`,
      [['ledger.customer_payment_allocations', 'ledger.customer_payments']],
    );
    expect(relations.rows).toEqual([
      {
        name: 'customer_payment_allocations',
        owner: 'shop_app_migrator',
        rls: true,
        forceRls: true,
      },
      { name: 'customer_payments', owner: 'shop_app_migrator', rls: true, forceRls: true },
    ]);

    const validation = await db().admin.query<{
      owner: string;
      securityDefiner: boolean;
      config: string[];
      publicExecute: boolean;
      triggerCount: string;
      runtimePrivileges: boolean;
    }>(`select pg_get_userbyid(proowner) as owner,prosecdef as "securityDefiner",
       proconfig as config,
       exists(select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner)))
         where grantee=0 and privilege_type='EXECUTE') as "publicExecute",
       (select count(*)::text from pg_trigger where
         tgrelid='ledger.customer_payment_allocations'::regclass
         and tgname='trg_customer_allocations_target_validate' and not tgisinternal) as "triggerCount",
       has_table_privilege('shop_app_runtime','ledger.customer_payment_allocations',
         'SELECT,INSERT,UPDATE,DELETE') as "runtimePrivileges"
       from pg_proc where oid='ledger.validate_customer_payment_allocation_target()'::regprocedure`);
    expect(validation.rows[0]).toEqual({
      owner: 'shop_app_migrator',
      securityDefiner: false,
      config: ['search_path=pg_catalog, pg_temp'],
      publicExecute: false,
      triggerCount: '1',
      runtimePrivileges: true,
    });

    const withoutContext = await db().runtime.connect();
    try {
      await withoutContext.query('begin');
      expect(
        (
          await withoutContext.query<{ count: string }>(
            `select count(*) from ledger.customer_payment_allocations`,
          )
        ).rows[0]?.count,
      ).toBe('0');
      await expect(
        withoutContext.query(
          `insert into ledger.customer_payment_allocations(
             id,store_id,customer_payment_id,sale_id,amount_minor
           ) values($1,$2,$3,$4,100)`,
          [randomUUID(), stores[0], payments.sale, sales.current],
        ),
      ).rejects.toBeDefined();
    } finally {
      await withoutContext.query('rollback');
      withoutContext.release();
    }
  });

  it('preserves the S14 Sale dependency predicate and excludes Opening targets from it', async () => {
    await insertAllocation({
      paymentId: payments.opening,
      openingReceivableId: ledgerEntries.opening,
    });
    const result = await client.query<{ saleDependency: boolean; openingSaleDependency: boolean }>(
      `select
         exists(select 1 from ledger.customer_payment_allocations
                where store_id=$1 and sale_id=$2) as "saleDependency",
         exists(select 1 from ledger.customer_payment_allocations
                where store_id=$1 and customer_payment_id=$3 and sale_id is not null)
           as "openingSaleDependency"`,
      [stores[0], sales.existing, payments.opening],
    );
    expect(result.rows[0]).toEqual({ saleDependency: true, openingSaleDependency: false });
  });

  it('creates no Money, Inventory, Goods Receipt, Stock, or Expense effects', async () => {
    await insertAllocation({
      paymentId: payments.opening,
      openingReceivableId: ledgerEntries.opening,
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
