import { sql } from 'drizzle-orm';

import type { DatabaseTransaction } from '../database/database.types';

interface CustomerBalanceRow extends Record<string, unknown> {
  receivableMinor: string;
  creditMinor: string;
}

export async function customerHasNoFinancialBalance(
  transaction: DatabaseTransaction,
  storeId: string,
  customerId: string,
): Promise<boolean> {
  const result = await transaction.execute<CustomerBalanceRow>(sql`
    select
      coalesce(sum(receivable_delta_minor), 0)::text as "receivableMinor",
      coalesce(sum(credit_delta_minor), 0)::text as "creditMinor"
    from ledger.customer_ledger_entries
    where store_id = ${storeId}::uuid
      and customer_id = ${customerId}::uuid
  `);
  const balance = result.rows[0];
  if (!balance) throw new Error('Customer financial balance query did not return a row.');
  return BigInt(balance.receivableMinor) === 0n && BigInt(balance.creditMinor) === 0n;
}
