import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import type { TenantTransactionContext } from '../database/database.types';
import { escapeSearchPrefix } from './search-query';
import type {
  SearchRepositoryCriteria,
  SearchRepositoryRow,
  SearchResultType,
} from './search.types';

@Injectable()
export class SearchRepository {
  constructor(private readonly database: DatabaseService) {}

  search(
    context: TenantTransactionContext,
    criteria: SearchRepositoryCriteria,
  ): Promise<SearchRepositoryRow[]> {
    const branchLimit = criteria.limit + 1;
    const customerNamePrefix = `${escapeSearchPrefix(criteria.scope.customerNamePrefix)}%`;
    const supplierNamePrefix = `${escapeSearchPrefix(criteria.scope.supplierNamePrefix)}%`;
    const productNamePrefix = `${escapeSearchPrefix(criteria.scope.productNamePrefix)}%`;
    const moneyAccountNamePrefix = `${escapeSearchPrefix(criteria.scope.moneyAccountNamePrefix)}%`;
    const textPrefix = `${escapeSearchPrefix(criteria.scope.text)}%`;
    const anchor = criteria.anchor;
    const afterAnchor = (matchRank: SQL, sortAt: SQL, type: SearchResultType, id: SQL): SQL =>
      anchor
        ? sql`and (${matchRank} > ${anchor.matchRank}::integer
            or (${matchRank} = ${anchor.matchRank}::integer
              and (${sortAt} < ${anchor.sortAt}::timestamptz
                or (${sortAt} = ${anchor.sortAt}::timestamptz
                  and (${type}::text > ${anchor.type}::text
                    or (${type}::text = ${anchor.type}::text
                      and ${id} > ${anchor.id}::uuid))))))`
        : sql``;
    const customerRank = sql`case when c.id = ${criteria.scope.exactUuid}::uuid
      or c.normalized_phone = ${criteria.scope.canonicalPhone}::text
      or c.normalized_name = ${criteria.scope.customerNamePrefix} then 0 else 1 end::integer`;
    const supplierRank = sql`case when s.id = ${criteria.scope.exactUuid}::uuid
      or s.normalized_phone = ${criteria.scope.canonicalPhone}::text
      or s.normalized_name = ${criteria.scope.supplierNamePrefix} then 0 else 1 end::integer`;
    const productRank = sql`case when p.id = ${criteria.scope.exactUuid}::uuid
      or p.sku = ${criteria.scope.canonicalSku}
      or p.barcode = ${criteria.scope.canonicalBarcode}
      or p.normalized_name = ${criteria.scope.productNamePrefix} then 0 else 1 end::integer`;
    const accountRank = sql`case when a.id = ${criteria.scope.exactUuid}::uuid
      or a.normalized_name = ${criteria.scope.moneyAccountNamePrefix} then 0 else 1 end::integer`;
    const saleRank = sql`case when s.id = ${criteria.scope.exactUuid}::uuid
      or lower(s.display_number) = ${criteria.scope.text} then 0 else 1 end::integer`;
    const invoiceRank = sql`case when i.id = ${criteria.scope.exactUuid}::uuid
      or lower(i.display_number) = ${criteria.scope.text}
      or lower(i.invoice_number) = ${criteria.scope.text} then 0 else 1 end::integer`;
    const expenseRank = sql`case when e.id = ${criteria.scope.exactUuid}::uuid
      or lower(e.description) = ${criteria.scope.text} then 0 else 1 end::integer`;
    const customerPaymentRank = sql`case when cp.id = ${criteria.scope.exactUuid}::uuid
      or lower(cp.external_reference) = ${criteria.scope.text} then 0 else 1 end::integer`;
    const supplierPaymentRank = sql`case when sp.id = ${criteria.scope.exactUuid}::uuid
      or lower(sp.external_reference) = ${criteria.scope.text} then 0 else 1 end::integer`;
    const moneyMovementRank = sql`case when m.id = ${criteria.scope.exactUuid}::uuid
      or m.reference_id = ${criteria.scope.exactUuid}::uuid
      or lower(m.external_reference) = ${criteria.scope.text} then 0 else 1 end::integer`;
    const saleReturnRank = sql`case when r.id = ${criteria.scope.exactUuid}::uuid
      or lower(r.display_number) = ${criteria.scope.text} then 0 else 1 end::integer`;
    const supplierReturnRank = sql`case when r.id = ${criteria.scope.exactUuid}::uuid
      or lower(r.display_number) = ${criteria.scope.text} then 0 else 1 end::integer`;
    const inventoryMovementRank = sql`case when m.id = ${criteria.scope.exactUuid}::uuid
      or m.reference_id = ${criteria.scope.exactUuid}::uuid then 0 else 1 end::integer`;

    return this.database.withTenantTransaction(context, async (transaction) => {
      const result = await transaction.execute<SearchRepositoryRow>(sql`
        with candidates as (
          (select 'customer'::text as "type", c.id, c.name as "primaryLabel",
              c.phone as "secondaryLabel", c.status, null::text as "displayNumber",
              null::text as "amountMinor", null::text as "quantityMilli",
              null::text as "businessDate", null::timestamptz as "occurredAt",
              ${customerRank} as "matchRank",
              c.updated_at as "sortAt"
            from ledger.customers c
            where c.store_id = ${context.storeId}::uuid
              and (${criteria.resultType}::text is null or ${criteria.resultType}::text = 'customer')
              and (c.id = ${criteria.scope.exactUuid}::uuid
                or c.normalized_phone = ${criteria.scope.canonicalPhone}::text
                or c.normalized_name like ${customerNamePrefix} escape '\\')
              ${afterAnchor(customerRank, sql`c.updated_at`, 'customer', sql`c.id`)}
            order by "matchRank", c.updated_at desc, c.id
            limit ${branchLimit})
          union all
          (select 'supplier'::text, s.id, s.name, s.phone, s.status, null::text,
              null::text, null::text, null::text, null::timestamptz,
              ${supplierRank},
              s.updated_at
            from ledger.suppliers s
            where s.store_id = ${context.storeId}::uuid
              and (${criteria.resultType}::text is null or ${criteria.resultType}::text = 'supplier')
              and (s.id = ${criteria.scope.exactUuid}::uuid
                or s.normalized_phone = ${criteria.scope.canonicalPhone}::text
                or s.normalized_name like ${supplierNamePrefix} escape '\\')
              ${afterAnchor(supplierRank, sql`s.updated_at`, 'supplier', sql`s.id`)}
            order by 11, s.updated_at desc, s.id
            limit ${branchLimit})
          union all
          (select 'product'::text, p.id, p.name, coalesce(p.sku, p.barcode), p.status,
              null::text, null::text, null::text, null::text, null::timestamptz,
              ${productRank},
              p.updated_at
            from ledger.products p
            where p.store_id = ${context.storeId}::uuid
              and (${criteria.resultType}::text is null or ${criteria.resultType}::text = 'product')
              and (p.id = ${criteria.scope.exactUuid}::uuid
                or p.sku = ${criteria.scope.canonicalSku}
                or p.barcode = ${criteria.scope.canonicalBarcode}
                or p.normalized_name like ${productNamePrefix} escape '\\')
              ${afterAnchor(productRank, sql`p.updated_at`, 'product', sql`p.id`)}
            order by 11, p.updated_at desc, p.id
            limit ${branchLimit})
          union all
          (select 'money_account'::text, a.id, a.name, a.account_type, a.status,
              null::text, null::text, null::text, null::text, null::timestamptz,
              ${accountRank},
              a.updated_at
            from ledger.money_accounts a
            where a.store_id = ${context.storeId}::uuid
              and (${criteria.resultType}::text is null or ${criteria.resultType}::text = 'money_account')
              and (a.id = ${criteria.scope.exactUuid}::uuid
                or a.normalized_name like ${moneyAccountNamePrefix} escape '\\')
              ${afterAnchor(accountRank, sql`a.updated_at`, 'money_account', sql`a.id`)}
            order by 11, a.updated_at desc, a.id
            limit ${branchLimit})
          union all
          (select 'sale'::text, s.id, s.display_number, c.name, s.status,
              s.display_number, s.total_minor::text, null::text,
              (s.sale_at at time zone 'Asia/Hebron')::date::text, s.sale_at,
              ${saleRank},
              s.sale_at
            from ledger.sales s
            left join ledger.customers c on c.store_id = s.store_id and c.id = s.customer_id
            where s.store_id = ${context.storeId}::uuid
              and (${criteria.resultType}::text is null or ${criteria.resultType}::text = 'sale')
              and (s.id = ${criteria.scope.exactUuid}::uuid
                or lower(s.display_number) like ${textPrefix} escape '\\'
                or c.normalized_name like ${customerNamePrefix} escape '\\'
                or s.total_minor = ${criteria.scope.amountMinor}::bigint
                or (s.sale_at at time zone 'Asia/Hebron')::date = ${criteria.scope.exactDate}::date)
              ${afterAnchor(saleRank, sql`s.sale_at`, 'sale', sql`s.id`)}
            order by 11, s.sale_at desc, s.id
            limit ${branchLimit})
          union all
          (select 'supplier_invoice'::text, i.id, i.display_number, s.name, i.status,
              i.display_number, i.total_minor::text, null::text,
              coalesce(i.posting_date, (i.invoice_date_at at time zone 'Asia/Hebron')::date)::text,
              i.invoice_date_at,
              ${invoiceRank},
              i.invoice_date_at
            from ledger.purchase_invoices i
            join ledger.suppliers s on s.store_id = i.store_id and s.id = i.supplier_id
            where i.store_id = ${context.storeId}::uuid
              and (${criteria.resultType}::text is null or ${criteria.resultType}::text = 'supplier_invoice')
              and (i.id = ${criteria.scope.exactUuid}::uuid
                or lower(i.display_number) like ${textPrefix} escape '\\'
                or lower(i.invoice_number) like ${textPrefix} escape '\\'
                or s.normalized_name like ${supplierNamePrefix} escape '\\'
                or i.total_minor = ${criteria.scope.amountMinor}::bigint
                or coalesce(i.posting_date, (i.invoice_date_at at time zone 'Asia/Hebron')::date) = ${criteria.scope.exactDate}::date)
              ${afterAnchor(invoiceRank, sql`i.invoice_date_at`, 'supplier_invoice', sql`i.id`)}
            order by 11, i.invoice_date_at desc, i.id
            limit ${branchLimit})
          union all
          (select 'expense'::text, e.id, e.description, ec.name, e.status,
              null::text, e.amount_minor::text, null::text,
              (e.expense_at at time zone 'Asia/Hebron')::date::text, e.expense_at,
              ${expenseRank},
              e.expense_at
            from ledger.expenses e
            left join ledger.expense_categories ec
              on ec.store_id = e.store_id and ec.id = e.category_id
            where e.store_id = ${context.storeId}::uuid
              and (${criteria.resultType}::text is null or ${criteria.resultType}::text = 'expense')
              and (e.id = ${criteria.scope.exactUuid}::uuid
                or lower(e.description) like ${textPrefix} escape '\\'
                or ec.normalized_name like ${moneyAccountNamePrefix} escape '\\'
                or e.amount_minor = ${criteria.scope.amountMinor}::bigint
                or (e.expense_at at time zone 'Asia/Hebron')::date = ${criteria.scope.exactDate}::date)
              ${afterAnchor(expenseRank, sql`e.expense_at`, 'expense', sql`e.id`)}
            order by 11, e.expense_at desc, e.id
            limit ${branchLimit})
          union all
          (select 'customer_collection'::text, cp.id, c.name, cp.external_reference, cp.status,
              null::text, cp.amount_minor::text, null::text,
              (cp.payment_at at time zone 'Asia/Hebron')::date::text, cp.payment_at,
              ${customerPaymentRank},
              cp.payment_at
            from ledger.customer_payments cp
            join ledger.customers c on c.store_id = cp.store_id and c.id = cp.customer_id
            where cp.store_id = ${context.storeId}::uuid
              and (${criteria.resultType}::text is null or ${criteria.resultType}::text = 'customer_collection')
              and (cp.id = ${criteria.scope.exactUuid}::uuid
                or lower(cp.external_reference) like ${textPrefix} escape '\\'
                or c.normalized_name like ${customerNamePrefix} escape '\\'
                or cp.amount_minor = ${criteria.scope.amountMinor}::bigint
                or (cp.payment_at at time zone 'Asia/Hebron')::date = ${criteria.scope.exactDate}::date)
              ${afterAnchor(customerPaymentRank, sql`cp.payment_at`, 'customer_collection', sql`cp.id`)}
            order by 11, cp.payment_at desc, cp.id
            limit ${branchLimit})
          union all
          (select 'supplier_payment'::text, sp.id, s.name, sp.external_reference, sp.status,
              null::text, sp.amount_minor::text, null::text,
              (sp.payment_at at time zone 'Asia/Hebron')::date::text, sp.payment_at,
              ${supplierPaymentRank},
              sp.payment_at
            from ledger.supplier_payments sp
            join ledger.suppliers s on s.store_id = sp.store_id and s.id = sp.supplier_id
            where sp.store_id = ${context.storeId}::uuid
              and (${criteria.resultType}::text is null or ${criteria.resultType}::text = 'supplier_payment')
              and (sp.id = ${criteria.scope.exactUuid}::uuid
                or lower(sp.external_reference) like ${textPrefix} escape '\\'
                or s.normalized_name like ${supplierNamePrefix} escape '\\'
                or sp.amount_minor = ${criteria.scope.amountMinor}::bigint
                or (sp.payment_at at time zone 'Asia/Hebron')::date = ${criteria.scope.exactDate}::date)
              ${afterAnchor(supplierPaymentRank, sql`sp.payment_at`, 'supplier_payment', sql`sp.id`)}
            order by 11, sp.payment_at desc, sp.id
            limit ${branchLimit})
          union all
          (select 'money_movement'::text, m.id, a.name, m.movement_type,
              case when m.reversal_of_id is null then 'posted' else 'reversal' end,
              null::text, m.amount_delta_minor::text, null::text,
              (m.occurred_at at time zone 'Asia/Hebron')::date::text, m.occurred_at,
              ${moneyMovementRank},
              m.occurred_at
            from ledger.money_movements m
            join ledger.money_accounts a on a.store_id = m.store_id and a.id = m.account_id
            where m.store_id = ${context.storeId}::uuid
              and (${criteria.resultType}::text is null or ${criteria.resultType}::text = 'money_movement')
              and (m.id = ${criteria.scope.exactUuid}::uuid
                or m.reference_id = ${criteria.scope.exactUuid}::uuid
                or a.normalized_name like ${moneyAccountNamePrefix} escape '\\'
                or lower(m.movement_type) like ${textPrefix} escape '\\'
                or lower(m.external_reference) like ${textPrefix} escape '\\'
                or lower(m.counterparty_name) like ${textPrefix} escape '\\'
                or m.amount_delta_minor = ${criteria.scope.amountMinor}::bigint
                or (m.occurred_at at time zone 'Asia/Hebron')::date = ${criteria.scope.exactDate}::date)
              ${afterAnchor(moneyMovementRank, sql`m.occurred_at`, 'money_movement', sql`m.id`)}
            order by 11, m.occurred_at desc, m.id
            limit ${branchLimit})
          union all
          (select 'sale_return'::text, r.id, r.display_number, c.name, r.status,
              r.display_number, r.total_minor::text, null::text,
              (r.return_at at time zone 'Asia/Hebron')::date::text, r.return_at,
              ${saleReturnRank},
              r.return_at
            from ledger.sale_returns r
            left join ledger.customers c on c.store_id = r.store_id and c.id = r.customer_id
            where r.store_id = ${context.storeId}::uuid
              and (${criteria.resultType}::text is null or ${criteria.resultType}::text = 'sale_return')
              and (r.id = ${criteria.scope.exactUuid}::uuid
                or lower(r.display_number) like ${textPrefix} escape '\\'
                or c.normalized_name like ${customerNamePrefix} escape '\\'
                or r.total_minor = ${criteria.scope.amountMinor}::bigint
                or (r.return_at at time zone 'Asia/Hebron')::date = ${criteria.scope.exactDate}::date)
              ${afterAnchor(saleReturnRank, sql`r.return_at`, 'sale_return', sql`r.id`)}
            order by 11, r.return_at desc, r.id
            limit ${branchLimit})
          union all
          (select 'supplier_return'::text, r.id, r.display_number, s.name, r.status,
              r.display_number, r.total_minor::text, null::text,
              (r.return_at at time zone 'Asia/Hebron')::date::text, r.return_at,
              ${supplierReturnRank},
              r.return_at
            from ledger.supplier_returns r
            join ledger.suppliers s on s.store_id = r.store_id and s.id = r.supplier_id
            where r.store_id = ${context.storeId}::uuid
              and (${criteria.resultType}::text is null or ${criteria.resultType}::text = 'supplier_return')
              and (r.id = ${criteria.scope.exactUuid}::uuid
                or lower(r.display_number) like ${textPrefix} escape '\\'
                or s.normalized_name like ${supplierNamePrefix} escape '\\'
                or r.total_minor = ${criteria.scope.amountMinor}::bigint
                or (r.return_at at time zone 'Asia/Hebron')::date = ${criteria.scope.exactDate}::date)
              ${afterAnchor(supplierReturnRank, sql`r.return_at`, 'supplier_return', sql`r.id`)}
            order by 11, r.return_at desc, r.id
            limit ${branchLimit})
          union all
          (select 'inventory_movement'::text, m.id, p.name, m.movement_type,
              case when m.reversal_of_id is null then m.cost_state_after else 'reversal' end,
              null::text, m.value_delta_minor::text, m.quantity_delta_milli::text,
              m.business_date::text, m.occurred_at,
              ${inventoryMovementRank},
              m.occurred_at
            from ledger.inventory_movements m
            join ledger.products p on p.store_id = m.store_id and p.id = m.product_id
            where m.store_id = ${context.storeId}::uuid
              and (${criteria.resultType}::text is null or ${criteria.resultType}::text = 'inventory_movement')
              and (m.id = ${criteria.scope.exactUuid}::uuid
                or m.reference_id = ${criteria.scope.exactUuid}::uuid
                or p.normalized_name like ${productNamePrefix} escape '\\'
                or lower(m.movement_type) like ${textPrefix} escape '\\'
                or m.quantity_delta_milli = ${criteria.scope.amountMinor}::bigint
                or m.value_delta_minor = ${criteria.scope.amountMinor}::bigint
                or m.business_date = ${criteria.scope.exactDate}::date)
              ${afterAnchor(inventoryMovementRank, sql`m.occurred_at`, 'inventory_movement', sql`m.id`)}
            order by 11, m.occurred_at desc, m.id
            limit ${branchLimit})
        )
        select "type", id, "primaryLabel", "secondaryLabel", status,
          "displayNumber", "amountMinor", "quantityMilli", "businessDate",
          "occurredAt", "matchRank", "sortAt"
        from candidates
        where (${anchor?.matchRank ?? null}::integer is null
          or "matchRank" > ${anchor?.matchRank ?? null}::integer
          or ("matchRank" = ${anchor?.matchRank ?? null}::integer
            and ("sortAt" < ${anchor?.sortAt ?? null}::timestamptz
              or ("sortAt" = ${anchor?.sortAt ?? null}::timestamptz
                and ("type" > ${anchor?.type ?? null}::text
                  or ("type" = ${anchor?.type ?? null}::text
                    and id > ${anchor?.id ?? null}::uuid))))))
        order by "matchRank", "sortAt" desc, "type", id
        limit ${branchLimit}
      `);

      return result.rows;
    });
  }
}
