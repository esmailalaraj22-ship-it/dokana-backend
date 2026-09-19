import { randomUUID } from 'node:crypto';

import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';

import { applyMigration, verifyChecksums, verifyMigrationSession } from '../scripts/migrate';
import { readMigrationFiles } from '../scripts/migrations/migration-files';
import { saleCustomerCreditApplications } from '../src/database/schema/sales';
import {
  createInventoryTestDatabase,
  setInventoryContext,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';

const migrationFilename = '0015_sale_customer_credit_tender.sql';
const stores = [randomUUID(), randomUUID()] as const;
const customers = [randomUUID(), randomUUID(), randomUUID()] as const;
const periods = [randomUUID(), randomUUID()] as const;
const devices = [randomUUID(), randomUUID()] as const;
const userId = randomUUID();
const occurredAt = '2026-09-15T10:00:00Z';

function postgresError(error: unknown): unknown {
  if (error instanceof Error && error.cause) return postgresError(error.cause);
  return error;
}

describe('S15.4A Sale Customer Credit tender physical foundation', () => {
  jest.setTimeout(180_000);

  let database: InventoryTestDatabase | undefined;
  let runtime: PoolClient;
  let runtimeConnected = false;
  let historicalSaleId: string;

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('S15.4A physical test database is unavailable.');
    return database;
  }

  async function expectRejected(work: () => Promise<unknown>, code: string): Promise<void> {
    await runtime.query('savepoint expected_rejection');
    try {
      await expect(
        work().catch((error: unknown) => {
          throw postgresError(error);
        }),
      ).rejects.toMatchObject({ code });
    } finally {
      await runtime.query('rollback to savepoint expected_rejection');
    }
  }

  async function seedSale(input: {
    storeId?: string;
    customerId?: string | null;
    paidTotalMinor?: number;
    creditTotalMinor?: number;
    status?: 'draft' | 'posted';
  }): Promise<{ id: string; operationId: string }> {
    const id = randomUUID();
    const operationId = randomUUID();
    const storeId = input.storeId ?? stores[0];
    const paidTotalMinor = input.paidTotalMinor ?? 100;
    const creditTotalMinor = input.creditTotalMinor ?? 0;
    const status = input.status ?? 'draft';
    const periodId = storeId === stores[0] ? periods[0] : periods[1];
    const deviceId = storeId === stores[0] ? devices[0] : devices[1];
    await db().admin.query(
      `insert into ledger.sales(
         id,store_id,customer_id,accounting_period_id,display_number,sale_at,
         items_subtotal_minor,total_minor,paid_total_minor,credit_total_minor,
         payment_status,status,device_id,operation_id
       ) values($1,$2,$3,case when $10='posted' then $4::uuid else null::uuid end,$5,$6,
         $7::bigint,$7::bigint,$8::bigint,$9::bigint,
         case when $9::bigint=0 then 'paid' when $8::bigint=0 then 'credit' else 'partial' end,
         $10,$11,$12)`,
      [
        id,
        storeId,
        input.customerId ?? null,
        periodId,
        `SALE-${id}`,
        occurredAt,
        paidTotalMinor + creditTotalMinor,
        paidTotalMinor,
        creditTotalMinor,
        status,
        deviceId,
        operationId,
      ],
    );
    await db().admin.query(
      `insert into ledger.sale_items(
         id,store_id,sale_id,is_manual_line,product_name_snapshot,unit_name_snapshot,
         quantity_milli,conversion_factor_num,conversion_factor_den,unit_price_minor,
         line_gross_minor,line_total_minor,cost_status
       ) values($1,$2,$3,true,'Manual line','unit',1000,1,1,$4,$4,$4,'unknown')`,
      [randomUUID(), storeId, id, paidTotalMinor + creditTotalMinor],
    );
    return { id, operationId };
  }

  async function seedCreditEffect(input: {
    saleId: string;
    saleOperationId: string;
    storeId?: string;
    customerId?: string;
    entryType?: 'credit_created' | 'credit_used' | 'refund' | 'settlement';
    receivableDeltaMinor?: number;
    creditDeltaMinor?: number;
    amountMinor?: number;
    referenceId?: string;
  }): Promise<string> {
    const id = randomUUID();
    const storeId = input.storeId ?? stores[0];
    const entryType = input.entryType ?? 'credit_used';
    const amountMinor = input.amountMinor ?? 100;
    const periodId = storeId === stores[0] ? periods[0] : periods[1];
    const deviceId = storeId === stores[0] ? devices[0] : devices[1];
    await db().admin.query(
      `insert into ledger.customer_ledger_entries(
         id,store_id,customer_id,accounting_period_id,entry_type,
         receivable_delta_minor,credit_delta_minor,source_sale_id,
         reference_type,reference_id,transaction_group_id,occurred_at,
         device_id,operation_id
       ) values($1,$2,$3,$4,$5,$6,$7,$8,'sale',$9,$10,$11,$12,$13)`,
      [
        id,
        storeId,
        input.customerId ?? customers[0],
        periodId,
        entryType,
        input.receivableDeltaMinor ?? 0,
        input.creditDeltaMinor ?? -amountMinor,
        input.saleId,
        input.referenceId ?? input.saleId,
        input.saleOperationId,
        occurredAt,
        deviceId,
        randomUUID(),
      ],
    );
    return id;
  }

  function insertApplication(input: {
    saleId: string;
    customerId: string;
    ledgerEntryId: string;
    storeId?: string;
    amountMinor?: number;
    id?: string;
  }): Promise<unknown> {
    return runtime.query(
      `insert into ledger.sale_customer_credit_applications(
         id,store_id,sale_id,customer_id,customer_ledger_entry_id,amount_minor,applied_at
       ) values($1,$2,$3,$4,$5,$6,$7)`,
      [
        input.id ?? randomUUID(),
        input.storeId ?? stores[0],
        input.saleId,
        input.customerId,
        input.ledgerEntryId,
        input.amountMinor ?? 100,
        occurredAt,
      ],
    );
  }

  beforeAll(async () => {
    database = await createInventoryTestDatabase(migrationFilename);
    await db().admin.query(
      `insert into platform.users(
         id,email,normalized_email,password_hash,full_name,status
       ) values($1,$2,$2,'test-only-hash','S15.4A fixture','active')`,
      [userId, `s154a-${userId}@example.test`],
    );
    await db().admin.query(
      `insert into ledger.stores(id,name) values($1,'S15.4A store A'),($2,'S15.4A store B')`,
      [...stores],
    );
    await db().admin.query(
      `insert into ledger.devices(
         id,store_id,device_name,platform,installation_id,device_prefix
       ) values
         ($1,$3,'S15.4A A','android',$5,'S154A'),
         ($2,$4,'S15.4A B','android',$6,'S154B')`,
      [devices[0], devices[1], stores[0], stores[1], randomUUID(), randomUUID()],
    );
    await db().admin.query(
      `insert into ledger.customers(
         id,store_id,name,normalized_name,phone,normalized_phone,device_id,operation_id
       ) values
         ($1,$4,'Customer A','customer a',$1::uuid::text,$1::uuid::text,$6,$8),
         ($2,$4,'Customer B','customer b',$2::uuid::text,$2::uuid::text,$6,$9),
         ($3,$5,'Customer C','customer c',$3::uuid::text,$3::uuid::text,$7,$10)`,
      [
        customers[0],
        customers[1],
        customers[2],
        stores[0],
        stores[1],
        devices[0],
        devices[1],
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ],
    );
    await db().admin.query(
      `insert into ledger.accounting_periods(
         id,store_id,period_year,period_month,starts_at,ends_at,status,device_id,operation_id
       ) values
         ($1,$3,2026,9,'2026-09-01T00:00:00Z','2026-10-01T00:00:00Z','open',$5,$7),
         ($2,$4,2026,9,'2026-09-01T00:00:00Z','2026-10-01T00:00:00Z','open',$6,$8)`,
      [
        periods[0],
        periods[1],
        stores[0],
        stores[1],
        devices[0],
        devices[1],
        randomUUID(),
        randomUUID(),
      ],
    );

    const accountId = randomUUID();
    await db().admin.query(
      `insert into ledger.money_accounts(
         id,store_id,name,normalized_name,account_type,device_id,operation_id
       ) values($1,$2,'Cash','cash','cash',$3,$4)`,
      [accountId, stores[0], devices[0], randomUUID()],
    );
    const historical = await seedSale({ paidTotalMinor: 100, status: 'posted' });
    historicalSaleId = historical.id;
    const movementId = randomUUID();
    await db().admin.query(
      `insert into ledger.money_movements(
         id,store_id,account_id,accounting_period_id,movement_type,amount_delta_minor,
         reference_type,reference_id,transaction_group_id,occurred_at,device_id,operation_id
       ) values($1,$2,$3,$4,'sale_payment',100,'sale_payment',$5,$6,$7,$8,$9)`,
      [
        movementId,
        stores[0],
        accountId,
        periods[0],
        randomUUID(),
        historical.operationId,
        occurredAt,
        devices[0],
        randomUUID(),
      ],
    );
    await db().admin.query(
      `insert into ledger.sale_payments(
         id,store_id,sale_id,money_account_id,amount_minor,payment_at,money_movement_id
       ) values($1,$2,$3,$4,100,$5,$6)`,
      [randomUUID(), stores[0], historical.id, accountId, occurredAt, movementId],
    );

    const appliedBefore = await db().admin.query<{ count: number }>(
      'select count(*)::int as count from platform.schema_migrations',
    );
    expect(appliedBefore.rows[0]).toEqual({ count: 14 });

    const migrator = await db().migration.connect();
    try {
      await verifyMigrationSession(migrator);
      await applyMigration(migrator, db().file);
    } finally {
      await migrator.query('reset role');
      migrator.release();
    }

    runtime = await db().runtime.connect();
    runtimeConnected = true;
    await runtime.query('begin');
    await setInventoryContext(runtime, stores[0], devices[0], userId);
  });

  afterAll(async () => {
    try {
      if (runtimeConnected) {
        await runtime.query('rollback');
        runtime.release();
      }
    } finally {
      await database?.close();
    }
  });

  it('applies 0015 from 14 migrations and preserves historical Money-only Sales', async () => {
    const files = await readMigrationFiles();
    const applied = await db().admin.query<{
      filename: string;
      checksumSha256: string;
    }>(
      `select filename,checksum_sha256 as "checksumSha256"
       from platform.schema_migrations order by filename`,
    );
    expect(applied.rows).toHaveLength(15);
    expect(applied.rows.at(-1)?.filename).toBe(migrationFilename);
    expect(() => verifyChecksums(files, applied.rows)).not.toThrow();

    const historical = await db().admin.query(
      `select status,paid_total_minor::text as paid,credit_total_minor::text as credit,
         (select count(*)::int from ledger.sale_customer_credit_applications application
          where application.store_id=sale.store_id and application.sale_id=sale.id)
          as applications
       from ledger.sales sale where id=$1`,
      [historicalSaleId],
    );
    expect(historical.rows[0]).toEqual({
      status: 'posted',
      paid: '100',
      credit: '0',
      applications: 0,
    });
  });

  it('matches the exact Drizzle table mapping, RLS, ownership, and least-privilege grants', async () => {
    const config = getTableConfig(saleCustomerCreditApplications);
    const columns = await db().admin.query<{ name: string; type: string; notNull: boolean }>(
      `select attname as name,format_type(atttypid,atttypmod) as type,
        attnotnull as "notNull"
       from pg_attribute
       where attrelid='ledger.sale_customer_credit_applications'::regclass
         and attnum>0 and not attisdropped order by attnum`,
    );
    expect(columns.rows).toEqual(
      config.columns.map((column) => ({
        name: column.name,
        type: column.getSQLType(),
        notNull: column.notNull,
      })),
    );

    const security = await db().admin.query(
      `select pg_get_userbyid(relowner) as owner,relrowsecurity,relforcerowsecurity
       from pg_class where oid='ledger.sale_customer_credit_applications'::regclass`,
    );
    expect(security.rows[0]).toEqual({
      owner: 'shop_app_migrator',
      relrowsecurity: true,
      relforcerowsecurity: true,
    });
    const grants = await db().admin.query<{ grantee: string; privileges: string[] }>(
      `select grantee,array_agg(privilege_type order by privilege_type)::text[] as privileges
       from information_schema.role_table_grants
       where table_schema='ledger' and table_name='sale_customer_credit_applications'
         and grantee in ('shop_app_runtime','shop_app_readonly')
       group by grantee order by grantee`,
    );
    expect(grants.rows).toEqual([
      { grantee: 'shop_app_readonly', privileges: ['SELECT'] },
      { grantee: 'shop_app_runtime', privileges: ['INSERT', 'SELECT'] },
    ]);
  });

  it('accepts exact same-Store/same-Customer credit_used lineage and finalizes the Sale', async () => {
    const sale = await seedSale({ customerId: customers[0] });
    const effectId = await seedCreditEffect({
      saleId: sale.id,
      saleOperationId: sale.operationId,
    });
    await insertApplication({
      saleId: sale.id,
      customerId: customers[0],
      ledgerEntryId: effectId,
    });
    await expect(
      runtime.query(
        `update ledger.sales set accounting_period_id=$1,status='posted'
         where store_id=$2 and id=$3 returning status`,
        [periods[0], stores[0], sale.id],
      ),
    ).resolves.toMatchObject({ rows: [{ status: 'posted' }] });

    const facts = await runtime.query(
      `select application.amount_minor::text as amount,
        effect.entry_type as "entryType",effect.receivable_delta_minor::text as receivable,
        effect.credit_delta_minor::text as credit,
        (select count(*)::int from ledger.money_movements movement
         where movement.store_id=application.store_id
           and movement.transaction_group_id=$2) as "moneyMovements"
       from ledger.sale_customer_credit_applications application
       join ledger.customer_ledger_entries effect
         on effect.store_id=application.store_id
         and effect.id=application.customer_ledger_entry_id
       where application.store_id=$1 and application.sale_id=$3`,
      [stores[0], sale.operationId, sale.id],
    );
    expect(facts.rows[0]).toEqual({
      amount: '100',
      entryType: 'credit_used',
      receivable: '0',
      credit: '-100',
      moneyMovements: 0,
    });
  });

  it.each([
    ['credit_created', 0, 100],
    ['refund', 0, -100],
    ['settlement', -100, 0],
  ] as const)(
    'rejects %s as forged Sale Credit consumption lineage',
    async (entryType, receivableDeltaMinor, creditDeltaMinor) => {
      const sale = await seedSale({ customerId: customers[0] });
      const effectId = await seedCreditEffect({
        saleId: sale.id,
        saleOperationId: sale.operationId,
        entryType,
        receivableDeltaMinor,
        creditDeltaMinor,
      });
      await expectRejected(
        () =>
          insertApplication({
            saleId: sale.id,
            customerId: customers[0],
            ledgerEntryId: effectId,
          }),
        '23514',
      );
    },
  );

  it('rejects wrong amount/sign, cross-Customer, anonymous, and duplicate applications', async () => {
    const wrongAmountSale = await seedSale({ customerId: customers[0] });
    const wrongAmountEffect = await seedCreditEffect({
      saleId: wrongAmountSale.id,
      saleOperationId: wrongAmountSale.operationId,
      creditDeltaMinor: -50,
    });
    await expectRejected(
      () =>
        insertApplication({
          saleId: wrongAmountSale.id,
          customerId: customers[0],
          ledgerEntryId: wrongAmountEffect,
        }),
      '23514',
    );

    const arbitrarySale = await seedSale({ customerId: customers[0] });
    const arbitraryEffect = await seedCreditEffect({
      saleId: arbitrarySale.id,
      saleOperationId: arbitrarySale.operationId,
      referenceId: randomUUID(),
    });
    await expectRejected(
      () =>
        insertApplication({
          saleId: arbitrarySale.id,
          customerId: customers[0],
          ledgerEntryId: arbitraryEffect,
        }),
      '23514',
    );

    const crossCustomerSale = await seedSale({ customerId: customers[0] });
    const crossCustomerEffect = await seedCreditEffect({
      saleId: crossCustomerSale.id,
      saleOperationId: crossCustomerSale.operationId,
      customerId: customers[1],
    });
    await expectRejected(
      () =>
        insertApplication({
          saleId: crossCustomerSale.id,
          customerId: customers[1],
          ledgerEntryId: crossCustomerEffect,
        }),
      '23514',
    );

    const anonymousSale = await seedSale({ customerId: null });
    const anonymousEffect = await seedCreditEffect({
      saleId: anonymousSale.id,
      saleOperationId: anonymousSale.operationId,
    });
    await expectRejected(
      () =>
        insertApplication({
          saleId: anonymousSale.id,
          customerId: customers[0],
          ledgerEntryId: anonymousEffect,
        }),
      '23514',
    );

    const duplicateSale = await seedSale({ customerId: customers[0] });
    const duplicateEffect = await seedCreditEffect({
      saleId: duplicateSale.id,
      saleOperationId: duplicateSale.operationId,
    });
    await insertApplication({
      saleId: duplicateSale.id,
      customerId: customers[0],
      ledgerEntryId: duplicateEffect,
    });
    await expectRejected(
      () =>
        insertApplication({
          saleId: duplicateSale.id,
          customerId: customers[0],
          ledgerEntryId: duplicateEffect,
        }),
      '23505',
    );
  });

  it('rejects cross-Store lineage and fails closed without tenant context', async () => {
    const foreignSale = await seedSale({ storeId: stores[1], customerId: customers[2] });
    const foreignEffect = await seedCreditEffect({
      saleId: foreignSale.id,
      saleOperationId: foreignSale.operationId,
      storeId: stores[1],
      customerId: customers[2],
    });
    await expectRejected(
      () =>
        insertApplication({
          storeId: stores[1],
          saleId: foreignSale.id,
          customerId: customers[2],
          ledgerEntryId: foreignEffect,
        }),
      '42501',
    );

    const noContext = await db().runtime.connect();
    try {
      const visible = await noContext.query(
        'select count(*)::int as count from ledger.sale_customer_credit_applications',
      );
      expect(visible.rows[0]).toEqual({ count: 0 });
    } finally {
      noContext.release();
    }
  });

  it('keeps Money-backed Sale Payment validation strict', async () => {
    const account = (
      await db().admin.query<{ id: string }>(
        `select id from ledger.money_accounts where store_id=$1 limit 1`,
        [stores[0]],
      )
    ).rows[0];
    if (!account) throw new Error('Money Account fixture is missing.');
    const sale = await seedSale({ customerId: null });
    await db().admin.query(
      `insert into ledger.sale_payments(
         id,store_id,sale_id,money_account_id,amount_minor,payment_at,money_movement_id
       ) values($1,$2,$3,$4,100,$5,null)`,
      [randomUUID(), stores[0], sale.id, account.id, occurredAt],
    );
    await expectRejected(
      () =>
        runtime.query(
          `update ledger.sales set accounting_period_id=$1,status='posted'
           where store_id=$2 and id=$3`,
          [periods[0], stores[0], sale.id],
        ),
      '23514',
    );
  });
});
