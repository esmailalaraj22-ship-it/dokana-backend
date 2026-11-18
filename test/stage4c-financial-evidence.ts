import type { Pool } from 'pg';

export const supplierFinancialTables = [
  'ledger.purchase_invoices',
  'ledger.purchase_items',
  'ledger.supplier_ledger_entries',
  'ledger.supplier_payments',
  'ledger.supplier_payment_allocations',
  'ledger.money_movements',
  'ledger.owner_ledger_entries',
  'ledger.supplier_returns',
  'ledger.supplier_return_items',
  'ledger.supplier_return_settlements',
  'ledger.expenses',
  'ledger.expense_payments',
  'ledger.inventory_movements',
  'ledger.stock_balances',
];

export async function supplierBoundaries(
  pool: Pool,
  storeId: string,
): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  for (const table of [
    'expenses',
    'expense_payments',
    'inventory_movements',
    'stock_balances',
    'goods_receipts',
    'goods_receipt_items',
    'supplier_return_items',
    'supplier_return_settlements',
  ]) {
    result[table] = (
      await pool.query<{ row: string }>(
        `select to_jsonb(t)::text as row from ledger.${table} t where store_id=$1 order by row`,
        [storeId],
      )
    ).rows.map((row) => row.row);
  }
  return result;
}

export async function assertSupplierReversalFacts(pool: Pool, storeId: string): Promise<void> {
  for (const [table, fields] of [
    ['supplier_ledger_entries', ['payable_delta_minor', 'credit_delta_minor']],
    ['money_movements', ['amount_delta_minor']],
    ['owner_ledger_entries', ['owner_liability_delta_minor', 'equity_delta_minor']],
  ] as const) {
    const rows = (
      await pool.query<{ original: string | null; inverse: boolean }>(
        `select o.id as original,
      (${fields.map((field) => `r.${field}::numeric+o.${field}::numeric=0`).join(' and ')}) as inverse
      from ledger.${table} r left join ledger.${table} o on o.store_id=r.store_id and o.id=r.reversal_of_id
      where r.store_id=$1 and r.reversal_of_id is not null`,
        [storeId],
      )
    ).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.original).not.toBeNull();
      expect(row.inverse).toBe(true);
    }
    expect(
      (
        await pool.query(
          `select reversal_of_id from ledger.${table} where store_id=$1 and reversal_of_id is not null
      group by reversal_of_id having count(*)>1`,
          [storeId],
        )
      ).rows,
    ).toEqual([]);
  }
}

export async function assertSupplierDimensions(
  pool: Pool,
  storeId: string,
  supplierId: string,
  payable: string,
  credit: string,
): Promise<void> {
  const raw = (
    await pool.query<{ payable: string; credit: string }>(
      `select
    coalesce(sum(payable_delta_minor),0)::text as payable,coalesce(sum(credit_delta_minor),0)::text as credit
    from ledger.supplier_ledger_entries where store_id=$1 and supplier_id=$2`,
      [storeId, supplierId],
    )
  ).rows;
  expect(raw).toEqual([{ payable, credit }]);
  expect(
    (
      await pool.query(
        `select payable_minor::text as payable,credit_minor::text as credit,
    net_payable_minor::text as net from ledger.v_supplier_balances where store_id=$1 and supplier_id=$2`,
        [storeId, supplierId],
      )
    ).rows,
  ).toEqual([{ payable, credit, net: (BigInt(payable) - BigInt(credit)).toString() }]);
}

// Inspect funding facts independently of response objects and production calculation helpers.
export async function assertSupplierPaymentFacts(
  pool: Pool,
  storeId: string,
  supplierId: string,
): Promise<void> {
  const payments = (
    await pool.query<{
      id: string;
      amount: string;
      allocated: string;
      credit: string;
      source: string;
      account: string | null;
      money: string | null;
      owner: string | null;
      operation: string;
    }>(
      `select id,amount_minor::text as amount,allocated_total_minor::text as allocated,
    credit_created_minor::text as credit,payment_source as source,money_account_id as account,
    money_movement_id as money,owner_ledger_entry_id as owner,operation_id as operation
    from ledger.supplier_payments where store_id=$1 and supplier_id=$2 order by id`,
      [storeId, supplierId],
    )
  ).rows;
  for (const p of payments) {
    expect(p.allocated).toBe(p.amount);
    expect(p.credit).toBe('0');
    expect(
      (
        await pool.query(
          `select coalesce(sum(amount_minor),0)::text as amount
      from ledger.supplier_payment_allocations where store_id=$1 and supplier_payment_id=$2`,
          [storeId, p.id],
        )
      ).rows,
    ).toEqual([{ amount: p.amount }]);
    expect(
      (
        await pool.query(
          `select payable_delta_minor::text as payable,credit_delta_minor::text as credit,
      source_purchase_invoice_id as invoice,transaction_group_id as grp
      from ledger.supplier_ledger_entries where store_id=$1 and supplier_id=$2
      and entry_type='payment' and reference_type='supplier_payment' and reference_id=$3`,
          [storeId, supplierId, p.id],
        )
      ).rows,
    ).toEqual([
      { payable: (-BigInt(p.amount)).toString(), credit: '0', invoice: null, grp: p.operation },
    ]);
    if (p.source === 'money_account') {
      expect(p.owner).toBeNull();
      expect(p.money).not.toBeNull();
      expect(
        (
          await pool.query(
            `select amount_delta_minor::text as amount,account_id as account,
        reference_type as type,reference_id as ref,transaction_group_id as grp
        from ledger.money_movements where store_id=$1 and id=$2`,
            [storeId, p.money],
          )
        ).rows,
      ).toEqual([
        {
          amount: (-BigInt(p.amount)).toString(),
          account: p.account,
          type: 'supplier_payment',
          ref: p.id,
          grp: p.operation,
        },
      ]);
      expect(
        (
          await pool.query(
            `select id from ledger.owner_ledger_entries where store_id=$1
        and reference_type='supplier_payment' and reference_id=$2`,
            [storeId, p.id],
          )
        ).rows,
      ).toEqual([]);
    } else {
      expect(p.source).toBe('owner_pocket');
      expect(p.money).toBeNull();
      expect(p.account).toBeNull();
      expect(
        (
          await pool.query(
            `select owner_liability_delta_minor::text as liability,equity_delta_minor::text as equity,
        money_account_id as account,entry_type as type,reference_id as ref,transaction_group_id as grp
        from ledger.owner_ledger_entries where store_id=$1 and id=$2`,
            [storeId, p.owner],
          )
        ).rows,
      ).toEqual([
        {
          liability: p.amount,
          equity: '0',
          account: null,
          type: 'owner_paid_supplier',
          ref: p.id,
          grp: p.operation,
        },
      ]);
      expect(
        (
          await pool.query(
            `select id from ledger.money_movements where store_id=$1
        and reference_type='supplier_payment' and reference_id=$2`,
            [storeId, p.id],
          )
        ).rows,
      ).toEqual([]);
    }
  }
}
