import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import type { TenantTransactionContext } from '../database/database.types';
import { ExpenseReadQueryError } from './expense-read-cursor';
import type {
  ExpenseListCriteria,
  ExpensePaymentReadRow,
  ExpenseReadRow,
} from './expense-read.types';

@Injectable()
export class ExpenseReadRepository {
  constructor(private readonly database: DatabaseService) {}

  list(
    context: TenantTransactionContext,
    criteria: ExpenseListCriteria,
  ): Promise<ExpenseReadRow[]> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      let continuation = sql``;
      if (criteria.anchor) {
        const anchor = await transaction.execute<{ expenseAt: string }>(sql`
          select expense_at::text as "expenseAt"
          from ledger.expenses
          where store_id=${context.storeId}::uuid
            and id=${criteria.anchor.id}::uuid
            and version=${criteria.anchor.version.toString()}::bigint
            and status='posted'
        `);
        const position = anchor.rows[0];
        if (!position) throw new ExpenseReadQueryError('cursor', 'expenseCursorAnchor');
        continuation = sql`
          and (
            e.expense_at < ${position.expenseAt}::timestamptz
            or (e.expense_at = ${position.expenseAt}::timestamptz
              and e.id < ${criteria.anchor.id}::uuid)
          )
        `;
      }
      const result = await transaction.execute<ExpenseReadRow>(sql`
        select e.id, e.category_id as "categoryId", c.name as "categoryName",
          c.status as "categoryStatus", e.accounting_period_id as "accountingPeriodId",
          e.description, e.amount_minor::text as "amountMinor",
          b.paid_minor::text as "paidMinor", b.due_minor::text as "outstandingMinor",
          e.expense_at as "expenseAt", e.due_at as "dueAt",
          e.payment_timing as "paymentTiming",
          recognition_payment.payment_source as "recognitionPaymentSource",
          recognition_payment.id as "recognitionPaymentId",
          recognition_payment.money_account_id as "recognitionMoneyAccountId",
          recognition_payment.money_movement_id as "recognitionMoneyMovementId",
          recognition_payment.owner_ledger_entry_id as "recognitionOwnerLedgerEntryId",
          e.status, e.notes, null::uuid as "correctionOperationId",
          null::text as "correctionType", null::text as "correctionReason",
          null::timestamptz as "correctedAt", null::uuid as "replacementId",
          e.id as "currentActiveId",
          e.created_at as "createdAt", e.updated_at as "updatedAt", e.version::text as version
        from ledger.expenses e
        join ledger.v_expense_balances b
          on b.store_id=e.store_id and b.expense_id=e.id
        left join ledger.expense_categories c
          on c.store_id=e.store_id and c.id=e.category_id
        left join lateral (
          select ep.id, ep.payment_source, ep.money_account_id,
            ep.money_movement_id, ep.owner_ledger_entry_id
          from ledger.expense_payments ep
          where ep.store_id=e.store_id and ep.expense_id=e.id and ep.status='posted'
          order by ep.created_at, ep.id
          limit 1
        ) recognition_payment on true
        where e.store_id=${context.storeId}::uuid and e.status='posted'
        ${continuation}
        order by e.expense_at desc, e.id desc
        limit ${criteria.limit + 1}
      `);
      return result.rows;
    });
  }

  findById(
    context: TenantTransactionContext,
    expenseId: string,
  ): Promise<{ expense: ExpenseReadRow; payments: ExpensePaymentReadRow[] } | null> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const result = await transaction.execute<ExpenseReadRow>(sql`
        select e.id, e.category_id as "categoryId", c.name as "categoryName",
          c.status as "categoryStatus", e.accounting_period_id as "accountingPeriodId",
          e.description, e.amount_minor::text as "amountMinor",
          coalesce(b.paid_minor,0)::text as "paidMinor",
          coalesce(b.due_minor,0)::text as "outstandingMinor",
          e.expense_at as "expenseAt", e.due_at as "dueAt",
          e.payment_timing as "paymentTiming",
          recognition_payment.payment_source as "recognitionPaymentSource",
          recognition_payment.id as "recognitionPaymentId",
          recognition_payment.money_account_id as "recognitionMoneyAccountId",
          recognition_payment.money_movement_id as "recognitionMoneyMovementId",
          recognition_payment.owner_ledger_entry_id as "recognitionOwnerLedgerEntryId",
          e.status, e.notes,
          correction.operation_id as "correctionOperationId",
          correction.correction_type as "correctionType",
          correction.reason as "correctionReason",
          correction.corrected_at as "correctedAt",
          correction.replacement_id as "replacementId",
          case when leaf.has_successor then null else leaf.entity_id end as "currentActiveId",
          e.created_at as "createdAt", e.updated_at as "updatedAt", e.version::text as version
        from ledger.expenses e
        left join ledger.v_expense_balances b
          on b.store_id=e.store_id and b.expense_id=e.id
        left join ledger.expense_categories c
          on c.store_id=e.store_id and c.id=e.category_id
        left join lateral (
          select ep.id, ep.payment_source, ep.money_account_id,
            ep.money_movement_id, ep.owner_ledger_entry_id
          from ledger.expense_payments ep
          where ep.store_id=e.store_id and ep.expense_id=e.id
          order by ep.created_at, ep.id
          limit 1
        ) recognition_payment on true
        left join lateral (
          select o.operation_id,
            case when o.action='expenses.edit' then 'replace' else 'cancel' end as correction_type,
            o.response_body ->> 'reason' as reason,
            (o.response_body ->> 'occurredAt')::timestamptz as corrected_at,
            nullif(o.response_body #>> '{replacement,expense,id}','')::uuid as replacement_id
          from sync.processed_operations o
          where o.store_id=e.store_id and o.status='applied'
            and o.action in ('expenses.cancel','expenses.edit')
            and o.response_body ->> 'targetOperationId'=e.operation_id::text
          order by o.completed_at, o.operation_id
          limit 1
        ) correction on true
        left join lateral (
          with recursive chain(operation_id,entity_id,depth) as (
            select e.operation_id,e.id,0
            union all
            select o.operation_id,
              (o.response_body #>> '{replacement,expense,id}')::uuid,c.depth+1
            from chain c
            join sync.processed_operations o
              on o.store_id=e.store_id and o.status='applied'
              and o.action='expenses.edit'
              and o.response_body ->> 'targetOperationId'=c.operation_id::text
            where o.response_body #>> '{replacement,expense,id}' is not null
          )
          select c.entity_id,
            exists(
              select 1 from sync.processed_operations o
              where o.store_id=e.store_id and o.status='applied'
                and o.action in ('expenses.cancel','expenses.edit')
                and o.response_body ->> 'targetOperationId'=c.operation_id::text
            ) as has_successor
          from chain c order by c.depth desc limit 1
        ) leaf on true
        where e.store_id=${context.storeId}::uuid and e.id=${expenseId}::uuid
          and e.status in ('posted','cancelled')
      `);
      const expense = result.rows[0];
      if (!expense) return null;

      const payments = await transaction.execute<ExpensePaymentReadRow>(sql`
        select ep.id, ep.accounting_period_id as "accountingPeriodId",
          ep.amount_minor::text as "amountMinor", ep.payment_source as "paymentSource",
          ep.money_account_id as "moneyAccountId", ma.name as "moneyAccountName",
          ma.status as "moneyAccountStatus", ep.money_movement_id as "moneyMovementId",
          ep.owner_ledger_entry_id as "ownerLedgerEntryId",
          coalesce(mm.transaction_group_id, ole.transaction_group_id) as "transactionGroupId",
          ep.payment_at as "paymentAt", ep.notes, ep.status,
          ep.operation_id as "operationId", ep.created_at as "createdAt",
          ep.version::text as version,
          case when recognition.operation_id is null then 'later_payment'
               else 'expense_recognition' end as "correctionScope",
          correction.operation_id as "correctionOperationId",
          correction.correction_type as "correctionType",
          correction.reason as "correctionReason",
          correction.corrected_at as "correctedAt",
          correction.replacement_id as "replacementId",
          case when recognition.operation_id is not null then
                 case when e.status='posted' then ep.id else null end
               when leaf.has_successor then null else leaf.entity_id end as "currentActiveId"
        from ledger.expense_payments ep
        inner join ledger.expenses e
          on e.store_id=ep.store_id and e.id=ep.expense_id
        left join ledger.money_accounts ma
          on ma.store_id=ep.store_id and ma.id=ep.money_account_id
        left join ledger.money_movements mm
          on mm.store_id=ep.store_id and mm.id=ep.money_movement_id
        left join ledger.owner_ledger_entries ole
          on ole.store_id=ep.store_id and ole.id=ep.owner_ledger_entry_id
        left join lateral (
          select o.operation_id
          from sync.processed_operations o
          where o.store_id=ep.store_id and o.status='applied'
            and (
              (o.action='expenses.edit'
                and o.response_body #>> '{replacement,payment,id}'=ep.id::text)
              or (o.action='expenses.recognize'
                and o.response_body #>> '{payment,id}'=ep.id::text)
            )
          limit 1
        ) recognition on true
        left join lateral (
          select o.operation_id,
            case when o.action='expense_payments.edit' then 'replace' else 'cancel' end
              as correction_type,
            o.response_body ->> 'reason' as reason,
            (o.response_body ->> 'occurredAt')::timestamptz as corrected_at,
            nullif(o.response_body #>> '{replacement,payment,id}','')::uuid as replacement_id
          from sync.processed_operations o
          where o.store_id=ep.store_id and o.status='applied'
            and o.action in ('expense_payments.cancel','expense_payments.edit')
            and o.response_body ->> 'targetOperationId'=ep.operation_id::text
          order by o.completed_at, o.operation_id
          limit 1
        ) correction on true
        left join lateral (
          with recursive chain(operation_id,entity_id,depth) as (
            select ep.operation_id,ep.id,0
            union all
            select o.operation_id,
              (o.response_body #>> '{replacement,payment,id}')::uuid,c.depth+1
            from chain c
            join sync.processed_operations o
              on o.store_id=ep.store_id and o.status='applied'
              and o.action='expense_payments.edit'
              and o.response_body ->> 'targetOperationId'=c.operation_id::text
            where o.response_body #>> '{replacement,payment,id}' is not null
          )
          select c.entity_id,
            exists(
              select 1 from sync.processed_operations o
              where o.store_id=ep.store_id and o.status='applied'
                and o.action in ('expense_payments.cancel','expense_payments.edit')
                and o.response_body ->> 'targetOperationId'=c.operation_id::text
            ) as has_successor
          from chain c order by c.depth desc limit 1
        ) leaf on true
        where ep.store_id=${context.storeId}::uuid and ep.expense_id=${expenseId}::uuid
        order by ep.payment_at, ep.id
      `);
      return { expense, payments: payments.rows };
    });
  }
}
