import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import {
  DASHBOARD_RECENT_ACTIVITY_LIMIT,
  type DashboardActivity,
  type DashboardActivityType,
  type DashboardInventoryIndicators,
  type DashboardInventoryValuationStatus,
  type DashboardMoneyAccount,
  type DashboardSnapshot,
} from './dashboard.types';

interface TodayQueryRow extends Record<string, unknown> {
  asOf: Date | string;
  businessDate: string;
  salesMinor: string;
  immediateSaleCollectionsMinor: string;
  customerCollectionsMinor: string;
  customerReceivableAllocationsMinor: string;
  totalCollectedMinor: string;
  creditSalesMinor: string;
  expensesRecognizedMinor: string;
  supplierPaymentsMinor: string;
}

interface MoneyQueryRow extends Record<string, unknown> {
  id: string;
  name: string;
  accountType: 'cash' | 'transfer';
  isDefault: boolean;
  balanceMinor: string;
  totalMinor: string;
}

interface PositionQueryRow extends Record<string, unknown> {
  customerReceivablesMinor: string;
  supplierPayablesMinor: string;
  trackedProductCount: number;
  projectedProductCount: number;
  missingProjectionCount: number;
  positiveStockProductCount: number;
  zeroStockProductCount: number;
  negativeStockProductCount: number;
  knownCostProductCount: number;
  unknownCostProductCount: number;
  pendingCostProductCount: number;
  uncertainValueProductCount: number;
  knownValueMinor: string;
  totalValueMinor: string | null;
}

interface ActivityQueryRow extends Record<string, unknown> {
  activityType: DashboardActivityType;
  resourceId: string;
  subtype: string | null;
  status: string | null;
  displayNumber: string | null;
  amountMinor: string | null;
  quantityDeltaMilli: string | null;
  businessDate: string;
  postingDate: string | null;
  accountingPeriodId: string | null;
  occurredAt: Date | string;
}

@Injectable()
export class DashboardRepository {
  constructor(private readonly database: DatabaseService) {}

  read(context: TenantTransactionContext): Promise<DashboardSnapshot> {
    return this.database.withTenantSnapshotTransaction(context, async (transaction) => {
      const today = await this.readToday(transaction, context.storeId);
      const money = await this.readMoney(transaction, context.storeId);
      const position = await this.readPosition(transaction, context.storeId);
      const recentActivity = await this.readRecentActivity(transaction, context.storeId);

      return {
        asOf: today.asOf,
        timezoneName: 'Asia/Hebron',
        businessDate: today.businessDate,
        today: {
          salesMinor: today.salesMinor,
          immediateSaleCollectionsMinor: today.immediateSaleCollectionsMinor,
          customerCollectionsMinor: today.customerCollectionsMinor,
          customerReceivableAllocationsMinor: today.customerReceivableAllocationsMinor,
          totalCollectedMinor: today.totalCollectedMinor,
          creditSalesMinor: today.creditSalesMinor,
          expensesRecognizedMinor: today.expensesRecognizedMinor,
          supplierPaymentsMinor: today.supplierPaymentsMinor,
        },
        money,
        obligations: {
          customerReceivablesMinor: position.customerReceivablesMinor,
          supplierPayablesMinor: position.supplierPayablesMinor,
        },
        inventory: this.inventoryIndicators(position),
        recentActivity,
      };
    });
  }

  private async readToday(
    transaction: DatabaseTransaction,
    storeId: string,
  ): Promise<TodayQueryRow & { asOf: Date }> {
    const result = await transaction.execute<TodayQueryRow>(sql`
      with boundary as (
        select
          transaction_timestamp() as as_of,
          (transaction_timestamp() at time zone 'Asia/Hebron')::date as business_date
      ), totals as (
        select
          coalesce((
            select sum(s.total_minor)
            from ledger.sales s, boundary b
            where s.store_id = ${storeId}::uuid
              and s.status = 'posted'
              and (s.sale_at at time zone 'Asia/Hebron')::date = b.business_date
          ), 0)::bigint as sales_minor,
          coalesce((
            select sum(sp.amount_minor)
            from ledger.sale_payments sp
            inner join ledger.sales s
              on s.store_id = sp.store_id and s.id = sp.sale_id
            cross join boundary b
            where sp.store_id = ${storeId}::uuid
              and s.status = 'posted'
              and (sp.payment_at at time zone 'Asia/Hebron')::date = b.business_date
          ), 0)::bigint as immediate_sale_collections_minor,
          coalesce((
            select sum(cp.amount_minor)
            from ledger.customer_payments cp, boundary b
            where cp.store_id = ${storeId}::uuid
              and cp.status = 'posted'
              and (cp.payment_at at time zone 'Asia/Hebron')::date = b.business_date
          ), 0)::bigint as customer_collections_minor,
          coalesce((
            select sum(cp.allocated_total_minor)
            from ledger.customer_payments cp, boundary b
            where cp.store_id = ${storeId}::uuid
              and cp.status = 'posted'
              and (cp.payment_at at time zone 'Asia/Hebron')::date = b.business_date
          ), 0)::bigint as customer_receivable_allocations_minor,
          coalesce((
            select sum(s.credit_total_minor)
            from ledger.sales s, boundary b
            where s.store_id = ${storeId}::uuid
              and s.status = 'posted'
              and (s.sale_at at time zone 'Asia/Hebron')::date = b.business_date
          ), 0)::bigint as credit_sales_minor,
          coalesce((
            select sum(e.amount_minor)
            from ledger.expenses e, boundary b
            where e.store_id = ${storeId}::uuid
              and e.status = 'posted'
              and (e.expense_at at time zone 'Asia/Hebron')::date = b.business_date
          ), 0)::bigint as expenses_recognized_minor,
          coalesce((
            select sum(sp.amount_minor)
            from ledger.supplier_payments sp, boundary b
            where sp.store_id = ${storeId}::uuid
              and sp.status = 'posted'
              and (sp.payment_at at time zone 'Asia/Hebron')::date = b.business_date
          ), 0)::bigint as supplier_payments_minor
      )
      select
        b.as_of as "asOf",
        b.business_date::text as "businessDate",
        t.sales_minor::text as "salesMinor",
        t.immediate_sale_collections_minor::text as "immediateSaleCollectionsMinor",
        t.customer_collections_minor::text as "customerCollectionsMinor",
        t.customer_receivable_allocations_minor::text
          as "customerReceivableAllocationsMinor",
        (t.immediate_sale_collections_minor + t.customer_collections_minor)::text
          as "totalCollectedMinor",
        t.credit_sales_minor::text as "creditSalesMinor",
        t.expenses_recognized_minor::text as "expensesRecognizedMinor",
        t.supplier_payments_minor::text as "supplierPaymentsMinor"
      from boundary b cross join totals t
    `);
    const row = this.requiredRow(result.rows[0], 'today metrics');
    return { ...row, asOf: this.databaseDate(row.asOf, 'snapshot timestamp') };
  }

  private async readMoney(
    transaction: DatabaseTransaction,
    storeId: string,
  ): Promise<DashboardSnapshot['money']> {
    const result = await transaction.execute<MoneyQueryRow>(sql`
      select
        a.id,
        a.name,
        a.account_type as "accountType",
        a.is_default as "isDefault",
        b.balance_minor::text as "balanceMinor",
        sum(b.balance_minor) over ()::text as "totalMinor"
      from ledger.money_accounts a
      inner join ledger.v_money_account_balances b
        on b.store_id = a.store_id and b.account_id = a.id
      where a.store_id = ${storeId}::uuid
        and a.status = 'active'
        and a.availability = 'available'
        and a.account_type in ('cash', 'transfer')
      order by (a.account_type = 'cash') desc, a.normalized_name, a.id
    `);
    const accounts: DashboardMoneyAccount[] = result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      accountType: row.accountType,
      isDefault: row.isDefault,
      balanceMinor: row.balanceMinor,
    }));
    return { accounts, totalMinor: result.rows[0]?.totalMinor ?? '0' };
  }

  private async readPosition(
    transaction: DatabaseTransaction,
    storeId: string,
  ): Promise<PositionQueryRow> {
    const result = await transaction.execute<PositionQueryRow>(sql`
      with tracked as (
        select p.id
        from ledger.products p
        where p.store_id = ${storeId}::uuid
          and p.status = 'active'
          and p.track_inventory = true
      ), inventory as (
        select
          count(*)::integer as tracked_product_count,
          count(sb.product_id)::integer as projected_product_count,
          count(*) filter (where sb.product_id is null)::integer as missing_projection_count,
          count(*) filter (where sb.quantity_milli > 0)::integer
            as positive_stock_product_count,
          count(*) filter (where sb.quantity_milli = 0)::integer
            as zero_stock_product_count,
          count(*) filter (where sb.quantity_milli < 0)::integer
            as negative_stock_product_count,
          count(*) filter (where sb.cost_state = 'known')::integer
            as known_cost_product_count,
          count(*) filter (where sb.cost_state = 'unknown')::integer
            as unknown_cost_product_count,
          count(*) filter (where sb.cost_state = 'pending')::integer
            as pending_cost_product_count,
          (
            count(*) filter (where sb.product_id is null)
            + count(*) filter (
                where sb.product_id is not null
                  and sb.quantity_milli <> 0
                  and sb.cost_state <> 'known'
              )
          )::integer as uncertain_value_product_count,
          coalesce(sum(sb.inventory_value_minor) filter (where sb.cost_state = 'known'), 0)::bigint
            as known_value_minor
        from tracked t
        left join ledger.stock_balances sb
          on sb.store_id = ${storeId}::uuid and sb.product_id = t.id
      )
      select
        coalesce((
          select sum(greatest(c.net_due_minor, 0))
          from ledger.v_customer_balances c
          where c.store_id = ${storeId}::uuid
        ), 0)::bigint::text as "customerReceivablesMinor",
        coalesce((
          select sum(greatest(s.net_payable_minor, 0))
          from ledger.v_supplier_balances s
          where s.store_id = ${storeId}::uuid
        ), 0)::bigint::text as "supplierPayablesMinor",
        i.tracked_product_count as "trackedProductCount",
        i.projected_product_count as "projectedProductCount",
        i.missing_projection_count as "missingProjectionCount",
        i.positive_stock_product_count as "positiveStockProductCount",
        i.zero_stock_product_count as "zeroStockProductCount",
        i.negative_stock_product_count as "negativeStockProductCount",
        i.known_cost_product_count as "knownCostProductCount",
        i.unknown_cost_product_count as "unknownCostProductCount",
        i.pending_cost_product_count as "pendingCostProductCount",
        i.uncertain_value_product_count as "uncertainValueProductCount",
        i.known_value_minor::text as "knownValueMinor",
        case when i.uncertain_value_product_count = 0
          then i.known_value_minor::text else null end as "totalValueMinor"
      from inventory i
    `);
    return this.requiredRow(result.rows[0], 'financial and inventory position');
  }

  private async readRecentActivity(
    transaction: DatabaseTransaction,
    storeId: string,
  ): Promise<DashboardActivity[]> {
    const result = await transaction.execute<ActivityQueryRow>(sql`
      select
        activity_type as "activityType",
        resource_id as "resourceId",
        subtype,
        status,
        display_number as "displayNumber",
        amount_minor as "amountMinor",
        quantity_delta_milli as "quantityDeltaMilli",
        business_date as "businessDate",
        posting_date as "postingDate",
        accounting_period_id as "accountingPeriodId",
        occurred_at as "occurredAt"
      from (
        select
          'sale'::text as activity_type,
          s.id as resource_id,
          s.payment_status::text as subtype,
          s.status::text as status,
          s.display_number::text as display_number,
          s.total_minor::text as amount_minor,
          null::text as quantity_delta_milli,
          (s.sale_at at time zone 'Asia/Hebron')::date::text as business_date,
          (s.sale_at at time zone 'Asia/Hebron')::date::text as posting_date,
          s.accounting_period_id,
          s.sale_at as occurred_at
        from ledger.sales s
        where s.store_id = ${storeId}::uuid and s.status = 'posted'

        union all

        select
          'customer_collection', cp.id, null, cp.status, null,
          cp.amount_minor::text, null,
          (cp.payment_at at time zone 'Asia/Hebron')::date::text,
          (cp.payment_at at time zone 'Asia/Hebron')::date::text,
          cp.accounting_period_id, cp.payment_at
        from ledger.customer_payments cp
        where cp.store_id = ${storeId}::uuid and cp.status = 'posted'

        union all

        select
          'supplier_invoice', pi.id, null, pi.status, pi.display_number,
          pi.total_minor::text, null,
          (pi.invoice_date_at at time zone 'Asia/Hebron')::date::text,
          pi.posting_date::text, pi.accounting_period_id, pi.invoice_date_at
        from ledger.purchase_invoices pi
        where pi.store_id = ${storeId}::uuid and pi.status in ('open', 'closed')

        union all

        select
          'supplier_payment', sp.id, sp.payment_source, sp.status, null,
          sp.amount_minor::text, null,
          (sp.payment_at at time zone 'Asia/Hebron')::date::text,
          (sp.payment_at at time zone 'Asia/Hebron')::date::text,
          sp.accounting_period_id, sp.payment_at
        from ledger.supplier_payments sp
        where sp.store_id = ${storeId}::uuid and sp.status = 'posted'

        union all

        select
          'expense', e.id, e.payment_timing, e.status, null,
          e.amount_minor::text, null,
          (e.expense_at at time zone 'Asia/Hebron')::date::text,
          (e.expense_at at time zone 'Asia/Hebron')::date::text,
          e.accounting_period_id, e.expense_at
        from ledger.expenses e
        where e.store_id = ${storeId}::uuid and e.status = 'posted'

        union all

        select
          'inventory_movement', im.id, im.movement_type, null, null,
          case when im.cost_state_after = 'known' then im.value_delta_minor::text else null end,
          im.quantity_delta_milli::text, im.business_date::text, im.posting_date::text,
          im.accounting_period_id, im.occurred_at
        from ledger.inventory_movements im
        where im.store_id = ${storeId}::uuid

        union all

        select
          'sale_return', sr.id, null, sr.status, sr.display_number,
          sr.total_minor::text, null,
          (sr.return_at at time zone 'Asia/Hebron')::date::text,
          (sr.return_at at time zone 'Asia/Hebron')::date::text,
          sr.accounting_period_id, sr.return_at
        from ledger.sale_returns sr
        where sr.store_id = ${storeId}::uuid and sr.status = 'posted'

        union all

        select
          'supplier_return', sr.id, null, sr.status, sr.display_number,
          sr.total_minor::text, null,
          (sr.return_at at time zone 'Asia/Hebron')::date::text,
          (sr.return_at at time zone 'Asia/Hebron')::date::text,
          sr.accounting_period_id, sr.return_at
        from ledger.supplier_returns sr
        where sr.store_id = ${storeId}::uuid and sr.status = 'posted'
      ) activity
      order by occurred_at desc, activity_type, resource_id
      limit ${DASHBOARD_RECENT_ACTIVITY_LIMIT}
    `);
    return result.rows.map((row) => ({
      ...row,
      occurredAt: this.databaseDate(row.occurredAt, 'activity timestamp'),
    }));
  }

  private inventoryIndicators(position: PositionQueryRow): DashboardInventoryIndicators {
    let valuationStatus: DashboardInventoryValuationStatus = 'known';
    if (position.uncertainValueProductCount > 0) {
      valuationStatus =
        position.knownCostProductCount > 0 || position.knownValueMinor !== '0'
          ? 'partial'
          : 'unknown';
    }
    return {
      trackedProductCount: position.trackedProductCount,
      projectedProductCount: position.projectedProductCount,
      missingProjectionCount: position.missingProjectionCount,
      positiveStockProductCount: position.positiveStockProductCount,
      zeroStockProductCount: position.zeroStockProductCount,
      negativeStockProductCount: position.negativeStockProductCount,
      knownCostProductCount: position.knownCostProductCount,
      unknownCostProductCount: position.unknownCostProductCount,
      pendingCostProductCount: position.pendingCostProductCount,
      knownValueMinor: position.knownValueMinor,
      totalValueMinor: position.totalValueMinor,
      valuationStatus,
    };
  }

  private requiredRow<T>(row: T | undefined, label: string): T {
    if (!row) throw new Error(`Dashboard ${label} are unavailable.`);
    return row;
  }

  private databaseDate(value: Date | string, label: string): Date {
    const result = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(result.getTime())) {
      throw new Error(`Dashboard ${label} is invalid.`);
    }
    return result;
  }
}
