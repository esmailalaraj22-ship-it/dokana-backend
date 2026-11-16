import type { Pool } from 'pg';

// Independent reconciliation of persisted movement arithmetic and projection.
// Legacy change cursors order INSERTs even when transaction timestamps are equal.
export async function assertInventoryReconciles(
  pool: Pool,
  storeId: string,
  productId: string,
): Promise<void> {
  const movements = (
    await pool.query<{
      id: string;
      beforeQuantity: string;
      deltaQuantity: string;
      afterQuantity: string;
      beforeValue: string;
      deltaValue: string;
      afterValue: string;
      average: string;
      beforeState: string;
      afterState: string;
      pending: boolean;
      events: number;
    }>(
      `select m.id, m.quantity_before_milli::text as "beforeQuantity",
    m.quantity_delta_milli::text as "deltaQuantity",m.quantity_after_milli::text as "afterQuantity",
    m.inventory_value_before_minor::text as "beforeValue",m.value_delta_minor::text as "deltaValue",
    m.inventory_value_after_minor::text as "afterValue",m.average_unit_cost_after_minor::text as average,
    m.cost_state_before as "beforeState",m.cost_state_after as "afterState",m.has_pending_cost_after as pending,
    e.events from ledger.inventory_movements m left join lateral (
      select min(cursor) as cursor,count(*)::int as events from sync.change_events
      where store_id=m.store_id and entity_type='inventory_movements' and entity_id=m.id
    ) e on true where m.store_id=$1 and m.product_id=$2 order by e.cursor`,
      [storeId, productId],
    )
  ).rows;
  const projection = (
    await pool.query<{
      quantity: string;
      value: string;
      state: string;
      average: string;
      pending: boolean;
      last: string;
    }>(
      `select quantity_milli::text as quantity,inventory_value_minor::text as value,
    cost_state as state,average_unit_cost_minor::text as average,has_pending_cost as pending,
    last_movement_id as last from ledger.stock_balances where store_id=$1 and product_id=$2`,
      [storeId, productId],
    )
  ).rows;
  if (!movements.length) {
    expect(projection).toEqual([]);
    return;
  }
  let quantity = 0n;
  let value = 0n;
  let state: string | undefined;
  for (const movement of movements) {
    expect(movement.events).toBe(1);
    expect(BigInt(movement.beforeQuantity)).toBe(quantity);
    expect(BigInt(movement.beforeValue)).toBe(value);
    if (state !== undefined) expect(movement.beforeState).toBe(state);
    quantity += BigInt(movement.deltaQuantity);
    value += BigInt(movement.deltaValue);
    expect(BigInt(movement.afterQuantity)).toBe(quantity);
    expect(BigInt(movement.afterValue)).toBe(value);
    state = movement.afterState;
  }
  const last = movements.at(-1);
  if (!last) throw new Error('Missing terminal movement');
  expect(projection).toEqual([
    {
      quantity: quantity.toString(),
      value: value.toString(),
      state,
      average: last.average,
      pending: last.pending,
      last: last.id,
    },
  ]);
}

export async function inventoryFinancialEvidence(
  pool: Pool,
  storeId: string,
): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  for (const table of [
    'supplier_ledger_entries',
    'customer_ledger_entries',
    'money_movements',
    'expenses',
    'purchase_invoices',
    'supplier_payments',
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
