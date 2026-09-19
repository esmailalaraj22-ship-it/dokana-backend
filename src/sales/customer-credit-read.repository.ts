import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import type { TenantTransactionContext } from '../database/database.types';
import type { CustomerCreditHistoryCursor } from './customer-credit-history-cursor';
import { SaleReadQueryError } from './sale-read-query-error';

interface CustomerRow extends Record<string, unknown> {
  id: string;
  status: 'active' | 'archived';
  receivableMinor: string;
  creditMinor: string;
}

export interface CustomerCreditHistoryRow extends Record<string, unknown> {
  id: string;
  operationId: string;
  entryType: 'credit_created' | 'credit_used' | 'refund' | 'settlement';
  receivableDeltaMinor: string;
  creditDeltaMinor: string;
  sourceSaleId: string | null;
  referenceType: string;
  referenceId: string;
  reason: string | null;
  occurredAt: string;
  createdAt: string;
  moneyAccountId: string | null;
  moneyAccountName: string | null;
  saleCreditApplicationId: string | null;
}

@Injectable()
export class CustomerCreditReadRepository {
  constructor(private readonly database: DatabaseService) {}

  read(
    context: TenantTransactionContext,
    customerId: string,
    cursor: CustomerCreditHistoryCursor | null,
    limit: number,
  ): Promise<
    | {
        customer: CustomerRow;
        entries: CustomerCreditHistoryRow[];
      }
    | undefined
  > {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const customerResult = await transaction.execute<CustomerRow>(sql`
        select customer.id, customer.status,
          greatest(coalesce(balance.receivable_minor,0),0)::text as "receivableMinor",
          greatest(coalesce(balance.credit_minor,0),0)::text as "creditMinor"
        from ledger.customers customer
        left join ledger.v_customer_balances balance
          on balance.store_id=customer.store_id and balance.customer_id=customer.id
        where customer.store_id=${context.storeId}::uuid and customer.id=${customerId}::uuid
        limit 1
      `);
      const customer = customerResult.rows[0];
      if (!customer) return undefined;

      if (cursor) {
        const anchor = await transaction.execute<{ occurredAt: string }>(sql`
          select occurred_at as "occurredAt"
          from ledger.customer_ledger_entries
          where store_id=${context.storeId}::uuid and customer_id=${customerId}::uuid
            and id=${cursor.anchor.id}::uuid
            and entry_type in ('credit_created','credit_used','refund','settlement')
          limit 1
        `);
        if (
          !anchor.rows[0] ||
          new Date(anchor.rows[0].occurredAt).toISOString() !== cursor.anchor.occurredAt
        ) {
          throw new SaleReadQueryError('cursor', 'customerCreditHistoryCursorAnchor');
        }
      }

      const continuation = cursor
        ? sql`and (entry.occurred_at < ${new Date(cursor.anchor.occurredAt)}
            or (entry.occurred_at=${new Date(cursor.anchor.occurredAt)}
              and entry.id < ${cursor.anchor.id}::uuid))`
        : sql``;
      const result = await transaction.execute<CustomerCreditHistoryRow>(sql`
        select entry.id, entry.operation_id as "operationId", entry.entry_type as "entryType",
          entry.receivable_delta_minor::text as "receivableDeltaMinor",
          entry.credit_delta_minor::text as "creditDeltaMinor",
          entry.source_sale_id as "sourceSaleId", entry.reference_type as "referenceType",
          entry.reference_id as "referenceId", entry.reason,
          entry.occurred_at as "occurredAt", entry.created_at as "createdAt",
          movement.account_id as "moneyAccountId", account.name as "moneyAccountName",
          sale_credit.id as "saleCreditApplicationId"
        from ledger.customer_ledger_entries entry
        left join ledger.money_movements movement
          on movement.store_id=entry.store_id and movement.movement_type='customer_refund'
          and movement.reference_type='customer_credit_refund'
          and movement.reference_id=entry.id
        left join ledger.money_accounts account
          on account.store_id=movement.store_id and account.id=movement.account_id
        left join ledger.sale_customer_credit_applications sale_credit
          on sale_credit.store_id=entry.store_id
          and sale_credit.customer_ledger_entry_id=entry.id
        where entry.store_id=${context.storeId}::uuid and entry.customer_id=${customerId}::uuid
          and entry.entry_type in ('credit_created','credit_used','refund','settlement')
          ${continuation}
        order by entry.occurred_at desc, entry.id desc
        limit ${limit + 1}
      `);
      return { customer, entries: result.rows };
    });
  }
}
