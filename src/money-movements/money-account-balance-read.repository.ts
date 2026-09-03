import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';

interface BalanceRow extends Record<string, unknown> {
  balanceMinor: string;
}

// Internal read of the authoritative derived balance projection
// (ledger.v_money_account_balances). Balances are never stored on money_accounts; they are
// always SUM(amount_delta_minor) over the immutable money_movements facts (D10-P1).
@Injectable()
export class MoneyAccountBalanceReadRepository {
  constructor(private readonly database: DatabaseService) {}

  readBalanceMinor(
    context: TenantTransactionContext,
    accountId: string,
  ): Promise<bigint | undefined> {
    return this.database.withTenantTransaction(context, (transaction) =>
      this.readWithinTransaction(transaction, context.storeId, accountId),
    );
  }

  async readWithinTransaction(
    transaction: DatabaseTransaction,
    storeId: string,
    accountId: string,
  ): Promise<bigint | undefined> {
    const result = await transaction.execute<BalanceRow>(sql`
      select coalesce(balance_minor, 0)::text as "balanceMinor"
      from ledger.v_money_account_balances
      where store_id = ${storeId}::uuid and account_id = ${accountId}::uuid
    `);
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    return BigInt(row.balanceMinor);
  }
}
