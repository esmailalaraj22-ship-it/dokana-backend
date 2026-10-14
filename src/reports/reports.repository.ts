import { BadRequestException, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import type {
  CustomerReceivableReportRow,
  CustomerReceivableReportTotals,
  ExpenseReportRow,
  ExpenseReportTotals,
  InventoryMovementReportRow,
  InventoryMovementReportTotals,
  InventoryStockReportRow,
  InventoryStockReportTotals,
  LiquidityReportRow,
  LiquidityReportTotals,
  MoneyMovementReportRow,
  MoneyMovementReportTotals,
  OperationalSummaryResponse,
  OperationalSummaryRow,
  OwnerLedgerReportExtra,
  OwnerLedgerReportRow,
  OwnerLedgerReportTotals,
  ProfitReportResponse,
  ReportDateRange,
  ReportPageData,
  ReportPageInput,
  ReturnCorrectionReportRow,
  ReturnCorrectionReportTotals,
  SalesReportRow,
  SalesReportTotals,
  SupplierPayableReportRow,
  SupplierPayableReportTotals,
} from './reports.types';

interface AsOfRow extends Record<string, unknown> {
  asOf: Date | string;
}

interface HistoricalAnchorRow extends Record<string, unknown> {
  occurredAt: Date | string;
}

interface NamedAnchorRow extends Record<string, unknown> {
  normalizedName: string;
}

interface ReturnAnchorRow extends HistoricalAnchorRow {
  sourceType: string;
}

type SalesPhysicalRow = Omit<SalesReportRow, 'occurredAt'> &
  Record<string, unknown> & { occurredAt: Date | string };
type ExpensePhysicalRow = Omit<ExpenseReportRow, 'occurredAt'> &
  Record<string, unknown> & { occurredAt: Date | string };
type MoneyPhysicalRow = Omit<MoneyMovementReportRow, 'occurredAt'> &
  Record<string, unknown> & { occurredAt: Date | string };
type InventoryMovementPhysicalRow = Omit<InventoryMovementReportRow, 'occurredAt'> &
  Record<string, unknown> & { occurredAt: Date | string };
type ReturnCorrectionPhysicalRow = Omit<ReturnCorrectionReportRow, 'occurredAt'> &
  Record<string, unknown> & { occurredAt: Date | string };
type OwnerLedgerPhysicalRow = Omit<OwnerLedgerReportRow, 'occurredAt'> &
  Record<string, unknown> & { occurredAt: Date | string };

interface OperationalInput extends ReportDateRange {
  granularity: 'day' | 'month';
}

interface ProfitPhysicalRow extends Record<string, unknown> {
  netSalesMinor: string;
  grossSalesMinor: string;
  saleReturnsMinor: string;
  knownCogsMinor: string;
  restoredReturnCostMinor: string;
  netKnownCogsMinor: string;
  expensesMinor: string;
  knownInventoryLossesMinor: string;
  profitMinor: string | null;
  profitCostComplete: boolean;
  unknownReturnCostMovementCount: number;
  unknownLossCostMovementCount: number;
  knownLineCount: number;
  unknownLineCount: number;
  knownPercentage: string;
  complete: boolean;
}

interface SalesInput extends ReportPageInput {
  customerId?: string;
  status: 'posted' | 'cancelled' | 'corrected' | 'all';
}

interface ExpenseInput extends ReportPageInput {
  categoryId?: string;
  status: 'posted' | 'cancelled' | 'all';
}

interface MoneyInput extends ReportPageInput {
  moneyAccountId?: string;
  movementType?: string;
}

interface CurrentPageInput {
  limit: number;
  cursorId: string | null;
}

interface CustomerInput extends CurrentPageInput {
  customerId?: string;
}

interface SupplierInput extends CurrentPageInput {
  supplierId?: string;
}

interface LiquidityInput extends CurrentPageInput {
  accountType?: 'cash' | 'transfer';
}

interface InventoryStockInput extends CurrentPageInput {
  productId?: string;
}

interface InventoryMovementInput extends ReportPageInput {
  productId?: string;
  movementType?: string;
}

interface ReturnCorrectionInput extends ReportPageInput {
  sourceType: string;
  cursorSourceType: string | null;
}

interface OwnerLedgerInput extends ReportPageInput {
  entryType?: string;
}

@Injectable()
export class ReportsRepository {
  constructor(private readonly database: DatabaseService) {}

  readOperationalSummary(
    context: TenantTransactionContext,
    input: OperationalInput,
  ): Promise<Omit<OperationalSummaryResponse, 'asOf'> & { asOf: Date }> {
    return this.database.withTenantSnapshotTransaction(context, async (transaction) => {
      const period = input.granularity === 'day' ? sql`'day'` : sql`'month'`;
      const periodFormat = input.granularity === 'day' ? sql`'YYYY-MM-DD'` : sql`'YYYY-MM'`;
      const step = input.granularity === 'day' ? sql`interval '1 day'` : sql`interval '1 month'`;
      const periodFilter = input.accountingPeriodId
        ? sql`and accounting_period_id = ${input.accountingPeriodId}::uuid`
        : sql``;
      const result = await transaction.execute<OperationalSummaryRow & Record<string, unknown>>(sql`
        with bounds as (
          select date_trunc(${period}, ${input.fromDate}::date)::date as from_date,
            date_trunc(${period}, ${input.toDate}::date)::date as to_date
        ), buckets as (
          select generate_series(from_date, to_date, ${step})::date as bucket from bounds
        ), events as (
          select date_trunc(${period}, sale_at at time zone 'Asia/Hebron')::date as bucket,
            sum(total_minor)::bigint as sales_minor, 0::bigint as immediate_minor,
            0::bigint as customer_minor, 0::bigint as allocated_minor,
            sum(credit_total_minor)::bigint as credit_minor, 0::bigint as expense_minor,
            0::bigint as expense_payment_minor, 0::bigint as invoice_minor,
            0::bigint as supplier_payment_minor, 0::bigint as sale_return_minor,
            0::bigint as supplier_return_minor
          from ledger.sales
          where store_id=${context.storeId}::uuid and status='posted'
            and (sale_at at time zone 'Asia/Hebron')::date between ${input.fromDate}::date and ${input.toDate}::date
            ${periodFilter}
          group by 1
          union all
          select date_trunc(${period}, sp.payment_at at time zone 'Asia/Hebron')::date,
            0, sum(sp.amount_minor), 0, 0, 0, 0, 0, 0, 0, 0, 0
          from ledger.sale_payments sp
          inner join ledger.sales s on s.store_id=sp.store_id and s.id=sp.sale_id
          where sp.store_id=${context.storeId}::uuid and s.status='posted'
            and (sp.payment_at at time zone 'Asia/Hebron')::date between ${input.fromDate}::date and ${input.toDate}::date
            ${input.accountingPeriodId ? sql`and s.accounting_period_id=${input.accountingPeriodId}::uuid` : sql``}
          group by 1
          union all
          select date_trunc(${period}, payment_at at time zone 'Asia/Hebron')::date,
            0, 0, sum(amount_minor), sum(allocated_total_minor), 0, 0, 0, 0, 0, 0, 0
          from ledger.customer_payments
          where store_id=${context.storeId}::uuid and status='posted'
            and (payment_at at time zone 'Asia/Hebron')::date between ${input.fromDate}::date and ${input.toDate}::date
            ${periodFilter}
          group by 1
          union all
          select date_trunc(${period}, expense_at at time zone 'Asia/Hebron')::date,
            0, 0, 0, 0, 0, sum(amount_minor), 0, 0, 0, 0, 0
          from ledger.expenses
          where store_id=${context.storeId}::uuid and status='posted'
            and (expense_at at time zone 'Asia/Hebron')::date between ${input.fromDate}::date and ${input.toDate}::date
            ${periodFilter}
          group by 1
          union all
          select date_trunc(${period}, payment_at at time zone 'Asia/Hebron')::date,
            0, 0, 0, 0, 0, 0, sum(amount_minor), 0, 0, 0, 0
          from ledger.expense_payments
          where store_id=${context.storeId}::uuid and status='posted'
            and (payment_at at time zone 'Asia/Hebron')::date between ${input.fromDate}::date and ${input.toDate}::date
            ${periodFilter}
          group by 1
          union all
          select date_trunc(${period}, invoice_date_at at time zone 'Asia/Hebron')::date,
            0, 0, 0, 0, 0, 0, 0, sum(total_minor), 0, 0, 0
          from ledger.purchase_invoices
          where store_id=${context.storeId}::uuid and status in ('open','closed')
            and (invoice_date_at at time zone 'Asia/Hebron')::date between ${input.fromDate}::date and ${input.toDate}::date
            ${periodFilter}
          group by 1
          union all
          select date_trunc(${period}, payment_at at time zone 'Asia/Hebron')::date,
            0, 0, 0, 0, 0, 0, 0, 0, sum(amount_minor), 0, 0
          from ledger.supplier_payments
          where store_id=${context.storeId}::uuid and status='posted'
            and (payment_at at time zone 'Asia/Hebron')::date between ${input.fromDate}::date and ${input.toDate}::date
            ${periodFilter}
          group by 1
          union all
          select date_trunc(${period}, return_at at time zone 'Asia/Hebron')::date,
            0, 0, 0, 0, 0, 0, 0, 0, 0, sum(total_minor), 0
          from ledger.sale_returns
          where store_id=${context.storeId}::uuid and status='posted'
            and (return_at at time zone 'Asia/Hebron')::date between ${input.fromDate}::date and ${input.toDate}::date
            ${periodFilter}
          group by 1
          union all
          select date_trunc(${period}, return_at at time zone 'Asia/Hebron')::date,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sum(total_minor)
          from ledger.supplier_returns
          where store_id=${context.storeId}::uuid and status='posted'
            and (return_at at time zone 'Asia/Hebron')::date between ${input.fromDate}::date and ${input.toDate}::date
            ${periodFilter}
          group by 1
        ), summarized as (
          select bucket, sum(sales_minor)::bigint as sales_minor,
            sum(immediate_minor)::bigint as immediate_minor,
            sum(customer_minor)::bigint as customer_minor,
            sum(allocated_minor)::bigint as allocated_minor,
            sum(credit_minor)::bigint as credit_minor,
            sum(expense_minor)::bigint as expense_minor,
            sum(expense_payment_minor)::bigint as expense_payment_minor,
            sum(invoice_minor)::bigint as invoice_minor,
            sum(supplier_payment_minor)::bigint as supplier_payment_minor,
            sum(sale_return_minor)::bigint as sale_return_minor,
            sum(supplier_return_minor)::bigint as supplier_return_minor
          from events group by bucket
        )
        select to_char(b.bucket, ${periodFormat}) as period,
          coalesce(s.sales_minor,0)::text as "salesMinor",
          coalesce(s.immediate_minor,0)::text as "immediateSaleCollectionsMinor",
          coalesce(s.customer_minor,0)::text as "customerCollectionsMinor",
          coalesce(s.allocated_minor,0)::text as "customerReceivableAllocationsMinor",
          coalesce(s.credit_minor,0)::text as "creditSalesMinor",
          coalesce(s.expense_minor,0)::text as "expensesRecognizedMinor",
          coalesce(s.expense_payment_minor,0)::text as "expensePaymentsMinor",
          coalesce(s.invoice_minor,0)::text as "supplierInvoicesMinor",
          coalesce(s.supplier_payment_minor,0)::text as "supplierPaymentsMinor",
          coalesce(s.sale_return_minor,0)::text as "saleReturnsMinor",
          coalesce(s.supplier_return_minor,0)::text as "supplierReturnsMinor"
        from buckets b left join summarized s on s.bucket=b.bucket order by b.bucket
      `);
      return {
        asOf: await this.readAsOf(transaction),
        timezoneName: 'Asia/Hebron',
        granularity: input.granularity,
        dateAuthority: 'businessDate',
        filters: this.dateFilters(input),
        rows: result.rows,
        totals: this.sumOperational(result.rows),
      };
    });
  }

  readProfit(
    context: TenantTransactionContext,
    input: ReportDateRange,
  ): Promise<Omit<ProfitReportResponse, 'asOf'> & { asOf: Date }> {
    return this.database.withTenantSnapshotTransaction(context, async (transaction) => {
      const periodFilter = input.accountingPeriodId
        ? sql`and accounting_period_id=${input.accountingPeriodId}::uuid`
        : sql``;
      const result = await transaction.execute<ProfitPhysicalRow>(sql`
        with sales_summary as (
          select coalesce(sum(total_minor),0)::bigint as gross_sales,
            coalesce(sum(known_cost_total_minor),0)::bigint as known_cogs,
            coalesce(sum(pending_cost_line_count + unknown_cost_line_count),0)::integer as unknown_lines
          from ledger.sales
          where store_id=${context.storeId}::uuid and status='posted'
            and (sale_at at time zone 'Asia/Hebron')::date between ${input.fromDate}::date and ${input.toDate}::date
            ${periodFilter}
        ), sale_line_summary as (
          select count(*) filter (where si.line_cost_minor is not null)::integer as known_lines,
            count(*) filter (where si.line_cost_minor is null)::integer as unknown_lines
          from ledger.sale_items si inner join ledger.sales s
            on s.store_id=si.store_id and s.id=si.sale_id
          where s.store_id=${context.storeId}::uuid and s.status='posted'
            and (s.sale_at at time zone 'Asia/Hebron')::date between ${input.fromDate}::date and ${input.toDate}::date
            ${input.accountingPeriodId ? sql`and s.accounting_period_id=${input.accountingPeriodId}::uuid` : sql``}
        ), returns_summary as (
          select coalesce(sum(total_minor),0)::bigint as returns_minor
          from ledger.sale_returns
          where store_id=${context.storeId}::uuid and status='posted'
            and (return_at at time zone 'Asia/Hebron')::date between ${input.fromDate}::date and ${input.toDate}::date
            ${periodFilter}
        ), restored_cost as (
          select coalesce(sum(im.value_delta_minor) filter (where im.cost_status='known'),0)::bigint as restored_minor,
            count(*) filter (where im.cost_status<>'known')::integer as unknown_count
          from ledger.inventory_movements im
          where im.store_id=${context.storeId}::uuid
            and im.movement_type='customer_return_saleable'
            and im.posting_date between ${input.fromDate}::date and ${input.toDate}::date
            ${periodFilter}
        ), expenses_summary as (
          select coalesce(sum(amount_minor),0)::bigint as expenses_minor
          from ledger.expenses
          where store_id=${context.storeId}::uuid and status='posted'
            and (expense_at at time zone 'Asia/Hebron')::date between ${input.fromDate}::date and ${input.toDate}::date
            ${periodFilter}
        ), losses_summary as (
          select coalesce(sum(-value_delta_minor) filter (where cost_status='known'),0)::bigint as losses_minor,
            count(*) filter (where cost_status<>'known')::integer as unknown_count
          from ledger.inventory_movements
          where store_id=${context.storeId}::uuid and movement_type in ('damage','loss','expiry')
            and posting_date between ${input.fromDate}::date and ${input.toDate}::date
            ${periodFilter}
        )
        select s.gross_sales::text as "grossSalesMinor", r.returns_minor::text as "saleReturnsMinor",
          (s.gross_sales-r.returns_minor)::text as "netSalesMinor",
          s.known_cogs::text as "knownCogsMinor", rc.restored_minor::text as "restoredReturnCostMinor",
          (s.known_cogs-rc.restored_minor)::text as "netKnownCogsMinor",
          e.expenses_minor::text as "expensesMinor", l.losses_minor::text as "knownInventoryLossesMinor",
          case when greatest(sl.unknown_lines,s.unknown_lines)+rc.unknown_count+l.unknown_count=0
            then (s.gross_sales-r.returns_minor-(s.known_cogs-rc.restored_minor)-e.expenses_minor-l.losses_minor)::text
            else null end as "profitMinor",
          sl.known_lines as "knownLineCount",
          greatest(sl.unknown_lines,s.unknown_lines)::integer as "unknownLineCount",
          case when sl.known_lines+greatest(sl.unknown_lines,s.unknown_lines)=0 then '100.00'
            else to_char(sl.known_lines::numeric*100/
              (sl.known_lines+greatest(sl.unknown_lines,s.unknown_lines)), 'FM990.00') end
            as "knownPercentage",
          (greatest(sl.unknown_lines,s.unknown_lines)=0) as complete,
          (greatest(sl.unknown_lines,s.unknown_lines)+rc.unknown_count+l.unknown_count=0)
            as "profitCostComplete",
          rc.unknown_count as "unknownReturnCostMovementCount",
          l.unknown_count as "unknownLossCostMovementCount"
        from sales_summary s cross join sale_line_summary sl cross join returns_summary r
          cross join restored_cost rc cross join expenses_summary e cross join losses_summary l
      `);
      const row = this.requiredRow(result.rows[0], 'profit');
      return {
        asOf: await this.readAsOf(transaction),
        timezoneName: 'Asia/Hebron',
        dateAuthority: 'postingDate',
        filters: this.dateFilters(input),
        netSalesMinor: row.netSalesMinor,
        grossSalesMinor: row.grossSalesMinor,
        saleReturnsMinor: row.saleReturnsMinor,
        knownCogsMinor: row.knownCogsMinor,
        restoredReturnCostMinor: row.restoredReturnCostMinor,
        netKnownCogsMinor: row.netKnownCogsMinor,
        expensesMinor: row.expensesMinor,
        knownInventoryLossesMinor: row.knownInventoryLossesMinor,
        profitMinor: row.profitMinor,
        profitCostComplete: row.profitCostComplete,
        unknownReturnCostMovementCount: row.unknownReturnCostMovementCount,
        unknownLossCostMovementCount: row.unknownLossCostMovementCount,
        costCoverage: {
          knownLineCount: row.knownLineCount,
          unknownLineCount: row.unknownLineCount,
          knownPercentage: row.knownPercentage,
          complete: row.complete,
        },
      };
    });
  }

  readSales(
    context: TenantTransactionContext,
    input: SalesInput,
  ): Promise<ReportPageData<SalesReportRow, SalesReportTotals>> {
    return this.database.withTenantSnapshotTransaction(context, async (transaction) => {
      const filter = sql`
        s.store_id=${context.storeId}::uuid
        and s.status in ('posted','cancelled','corrected')
        and (s.sale_at at time zone 'Asia/Hebron')::date between ${input.fromDate}::date and ${input.toDate}::date
        ${input.accountingPeriodId ? sql`and s.accounting_period_id=${input.accountingPeriodId}::uuid` : sql``}
        ${input.customerId ? sql`and s.customer_id=${input.customerId}::uuid` : sql``}
        ${input.status === 'all' ? sql`` : sql`and s.status=${input.status}`}
      `;
      const anchor = input.cursorId
        ? await this.historicalAnchor(
            transaction,
            sql`
            select s.sale_at as "occurredAt" from ledger.sales s
            where ${filter} and s.id=${input.cursorId}::uuid limit 1
          `,
          )
        : null;
      const continuation = anchor
        ? sql`and (s.sale_at < ${anchor} or (s.sale_at=${anchor} and s.id<${input.cursorId}::uuid))`
        : sql``;
      const rows = await transaction.execute<SalesPhysicalRow>(sql`
        select s.id, s.display_number as "displayNumber", s.customer_id as "customerId",
          c.name as "customerName", s.status, s.payment_status as "paymentStatus",
          s.total_minor::text as "totalMinor", s.paid_total_minor::text as "paidTotalMinor",
          s.credit_total_minor::text as "creditTotalMinor",
          coalesce((select sum(sr.total_minor) from ledger.sale_returns sr
            where sr.store_id=s.store_id and sr.sale_id=s.id and sr.status='posted'),0)::text
            as "returnedTotalMinor",
          s.known_cost_total_minor::text as "knownCostTotalMinor",
          s.pending_cost_line_count as "pendingCostLineCount",
          s.unknown_cost_line_count as "unknownCostLineCount",
          (s.sale_at at time zone 'Asia/Hebron')::date::text as "businessDate",
          (s.sale_at at time zone 'Asia/Hebron')::date::text as "postingDate",
          s.accounting_period_id as "accountingPeriodId", s.sale_at as "occurredAt",
          s.correction_of_id as "correctionOfId", s.reversed_by_id as "reversedById"
        from ledger.sales s left join ledger.customers c
          on c.store_id=s.store_id and c.id=s.customer_id
        where ${filter} ${continuation}
        order by s.sale_at desc, s.id desc limit ${input.limit + 1}
      `);
      const totals = await transaction.execute<SalesReportTotals & Record<string, unknown>>(sql`
        select count(*)::integer as "rowCount",
          coalesce(sum(s.total_minor) filter (where s.status='posted'),0)::text as "postedTotalMinor",
          coalesce(sum(s.total_minor) filter (where s.status='cancelled'),0)::text as "cancelledTotalMinor",
          coalesce(sum(s.total_minor) filter (where s.status='corrected'),0)::text as "correctedTotalMinor",
          coalesce(sum(s.paid_total_minor) filter (where s.status='posted'),0)::text as "paidTotalMinor",
          coalesce(sum(s.credit_total_minor) filter (where s.status='posted'),0)::text as "creditTotalMinor",
          coalesce(sum((select coalesce(sum(sr.total_minor),0) from ledger.sale_returns sr
            where sr.store_id=s.store_id and sr.sale_id=s.id and sr.status='posted'))
            filter (where s.status='posted'),0)::text as "returnedTotalMinor",
          (coalesce(sum(s.total_minor) filter (where s.status='posted'),0)-
            coalesce(sum((select coalesce(sum(sr.total_minor),0) from ledger.sale_returns sr
              where sr.store_id=s.store_id and sr.sale_id=s.id and sr.status='posted'))
              filter (where s.status='posted'),0))::text as "netPostedSalesMinor"
        from ledger.sales s where ${filter}
      `);
      const page = this.takePage(
        rows.rows.map((row) => ({ ...row, occurredAt: this.iso(row.occurredAt) })),
        input.limit,
      );
      return {
        asOf: await this.readAsOf(transaction),
        ...page,
        pageTotals: this.salesTotals(page.items),
        filteredTotals: this.requiredRow(totals.rows[0], 'Sales totals'),
      };
    });
  }

  readExpenses(
    context: TenantTransactionContext,
    input: ExpenseInput,
  ): Promise<ReportPageData<ExpenseReportRow, ExpenseReportTotals>> {
    return this.database.withTenantSnapshotTransaction(context, async (transaction) => {
      const filter = sql`
        e.store_id=${context.storeId}::uuid and e.status in ('posted','cancelled')
        and (e.expense_at at time zone 'Asia/Hebron')::date between ${input.fromDate}::date and ${input.toDate}::date
        ${input.accountingPeriodId ? sql`and e.accounting_period_id=${input.accountingPeriodId}::uuid` : sql``}
        ${input.categoryId ? sql`and e.category_id=${input.categoryId}::uuid` : sql``}
        ${input.status === 'all' ? sql`` : sql`and e.status=${input.status}`}
      `;
      const anchor = input.cursorId
        ? await this.historicalAnchor(
            transaction,
            sql`
            select e.expense_at as "occurredAt" from ledger.expenses e
            where ${filter} and e.id=${input.cursorId}::uuid limit 1
          `,
          )
        : null;
      const continuation = anchor
        ? sql`and (e.expense_at<${anchor} or (e.expense_at=${anchor} and e.id<${input.cursorId}::uuid))`
        : sql``;
      const rows = await transaction.execute<ExpensePhysicalRow>(sql`
        select e.id, e.category_id as "categoryId", c.name as "categoryName", e.description,
          e.status, e.payment_timing as "paymentTiming", e.amount_minor::text as "amountMinor",
          coalesce(b.paid_minor,0)::text as "paidMinor",
          coalesce(b.due_minor,0)::text as "outstandingMinor",
          (e.expense_at at time zone 'Asia/Hebron')::date::text as "businessDate",
          (e.expense_at at time zone 'Asia/Hebron')::date::text as "postingDate",
          e.accounting_period_id as "accountingPeriodId", e.expense_at as "occurredAt"
        from ledger.expenses e
        left join ledger.expense_categories c on c.store_id=e.store_id and c.id=e.category_id
        left join ledger.v_expense_balances b on b.store_id=e.store_id and b.expense_id=e.id
        where ${filter} ${continuation}
        order by e.expense_at desc, e.id desc limit ${input.limit + 1}
      `);
      const totals = await transaction.execute<ExpenseReportTotals & Record<string, unknown>>(sql`
        select count(*)::integer as "rowCount",
          coalesce(sum(e.amount_minor) filter (where e.status='posted'),0)::text as "recognizedMinor",
          coalesce(sum(e.amount_minor) filter (where e.status='cancelled'),0)::text as "cancelledMinor",
          coalesce(sum(b.paid_minor) filter (where e.status='posted'),0)::text as "paidMinor",
          coalesce(sum(b.due_minor) filter (where e.status='posted'),0)::text as "outstandingMinor"
        from ledger.expenses e left join ledger.v_expense_balances b
          on b.store_id=e.store_id and b.expense_id=e.id
        where ${filter}
      `);
      const page = this.takePage(
        rows.rows.map((row) => ({ ...row, occurredAt: this.iso(row.occurredAt) })),
        input.limit,
      );
      return {
        asOf: await this.readAsOf(transaction),
        ...page,
        pageTotals: this.expenseTotals(page.items),
        filteredTotals: this.requiredRow(totals.rows[0], 'Expense totals'),
      };
    });
  }

  readMoneyMovements(
    context: TenantTransactionContext,
    input: MoneyInput,
  ): Promise<ReportPageData<MoneyMovementReportRow, MoneyMovementReportTotals>> {
    return this.database.withTenantSnapshotTransaction(context, async (transaction) => {
      const filter = sql`
        m.store_id=${context.storeId}::uuid
        and (m.occurred_at at time zone 'Asia/Hebron')::date between ${input.fromDate}::date and ${input.toDate}::date
        ${input.accountingPeriodId ? sql`and m.accounting_period_id=${input.accountingPeriodId}::uuid` : sql``}
        ${input.moneyAccountId ? sql`and m.account_id=${input.moneyAccountId}::uuid` : sql``}
        ${input.movementType ? sql`and m.movement_type=${input.movementType}` : sql``}
      `;
      const anchor = input.cursorId
        ? await this.historicalAnchor(
            transaction,
            sql`
            select m.occurred_at as "occurredAt" from ledger.money_movements m
            where ${filter} and m.id=${input.cursorId}::uuid limit 1
          `,
          )
        : null;
      const continuation = anchor
        ? sql`and (m.occurred_at<${anchor} or (m.occurred_at=${anchor} and m.id<${input.cursorId}::uuid))`
        : sql``;
      const rows = await transaction.execute<MoneyPhysicalRow>(sql`
        select m.id, m.account_id as "moneyAccountId", a.name as "moneyAccountName",
          m.movement_type as "movementType", m.amount_delta_minor::text as "amountDeltaMinor",
          m.reference_type as "referenceType", m.reference_id as "referenceId",
          m.transaction_group_id as "transactionGroupId", m.reversal_of_id as "reversalOfId",
          (m.occurred_at at time zone 'Asia/Hebron')::date::text as "businessDate",
          (m.occurred_at at time zone 'Asia/Hebron')::date::text as "postingDate",
          m.accounting_period_id as "accountingPeriodId", m.occurred_at as "occurredAt"
        from ledger.money_movements m inner join ledger.money_accounts a
          on a.store_id=m.store_id and a.id=m.account_id
        where ${filter} ${continuation}
        order by m.occurred_at desc, m.id desc limit ${input.limit + 1}
      `);
      const totals = await transaction.execute<
        MoneyMovementReportTotals & Record<string, unknown>
      >(sql`
        select count(*)::integer as "rowCount",
          coalesce(sum(m.amount_delta_minor) filter (where m.amount_delta_minor>0),0)::text as "inflowMinor",
          coalesce(sum(-m.amount_delta_minor) filter (where m.amount_delta_minor<0),0)::text as "outflowMinor",
          coalesce(sum(m.amount_delta_minor),0)::text as "netMinor"
        from ledger.money_movements m where ${filter}
      `);
      const page = this.takePage(
        rows.rows.map((row) => ({ ...row, occurredAt: this.iso(row.occurredAt) })),
        input.limit,
      );
      return {
        asOf: await this.readAsOf(transaction),
        ...page,
        pageTotals: this.moneyTotals(page.items),
        filteredTotals: this.requiredRow(totals.rows[0], 'Money Movement totals'),
      };
    });
  }

  readLiquidity(
    context: TenantTransactionContext,
    input: LiquidityInput,
  ): Promise<ReportPageData<LiquidityReportRow, LiquidityReportTotals>> {
    return this.database.withTenantSnapshotTransaction(context, async (transaction) => {
      const filter = sql`
        a.store_id=${context.storeId}::uuid and a.status='active'
        and a.availability='available' and a.account_type in ('cash','transfer')
        ${input.accountType ? sql`and a.account_type=${input.accountType}` : sql``}
      `;
      const anchor = input.cursorId
        ? await this.namedAnchor(
            transaction,
            sql`
            select a.normalized_name as "normalizedName" from ledger.money_accounts a
            where ${filter} and a.id=${input.cursorId}::uuid limit 1
          `,
          )
        : null;
      const continuation = anchor
        ? sql`and (a.normalized_name>${anchor} or (a.normalized_name=${anchor} and a.id>${input.cursorId}::uuid))`
        : sql``;
      const rows = await transaction.execute<LiquidityReportRow & Record<string, unknown>>(sql`
        select a.id, a.name, a.account_type as "accountType", a.is_default as "isDefault",
          b.balance_minor::text as "balanceMinor"
        from ledger.money_accounts a inner join ledger.v_money_account_balances b
          on b.store_id=a.store_id and b.account_id=a.id
        where ${filter} ${continuation}
        order by a.normalized_name, a.id limit ${input.limit + 1}
      `);
      const totals = await transaction.execute<LiquidityReportTotals & Record<string, unknown>>(sql`
        select count(*)::integer as "rowCount", coalesce(sum(b.balance_minor),0)::text as "balanceMinor"
        from ledger.money_accounts a inner join ledger.v_money_account_balances b
          on b.store_id=a.store_id and b.account_id=a.id where ${filter}
      `);
      const page = this.takePage(rows.rows, input.limit);
      return {
        asOf: await this.readAsOf(transaction),
        ...page,
        pageTotals: {
          rowCount: page.items.length,
          balanceMinor: this.sum(page.items.map((item) => item.balanceMinor)),
        },
        filteredTotals: this.requiredRow(totals.rows[0], 'Liquidity totals'),
      };
    });
  }

  readCustomerReceivables(
    context: TenantTransactionContext,
    input: CustomerInput,
  ): Promise<ReportPageData<CustomerReceivableReportRow, CustomerReceivableReportTotals>> {
    return this.database.withTenantSnapshotTransaction(context, async (transaction) => {
      const filter = sql`
        c.store_id=${context.storeId}::uuid
        ${input.customerId ? sql`and c.id=${input.customerId}::uuid` : sql``}
      `;
      const anchor = input.cursorId
        ? await this.namedAnchor(
            transaction,
            sql`
            select c.normalized_name as "normalizedName" from ledger.customers c
            where ${filter} and c.id=${input.cursorId}::uuid limit 1
          `,
          )
        : null;
      const continuation = anchor
        ? sql`and (c.normalized_name>${anchor} or (c.normalized_name=${anchor} and c.id>${input.cursorId}::uuid))`
        : sql``;
      const rows = await transaction.execute<
        CustomerReceivableReportRow & Record<string, unknown>
      >(sql`
        select c.id, c.name, c.phone, c.status,
          greatest(coalesce(b.receivable_minor,0),0)::text as "receivableMinor",
          greatest(coalesce(b.credit_minor,0),0)::text as "creditMinor",
          greatest(coalesce(b.net_due_minor,0),0)::text as "netDueMinor"
        from ledger.customers c left join ledger.v_customer_balances b
          on b.store_id=c.store_id and b.customer_id=c.id
        where ${filter} ${continuation}
        order by c.normalized_name, c.id limit ${input.limit + 1}
      `);
      const totals = await transaction.execute<
        CustomerReceivableReportTotals & Record<string, unknown>
      >(sql`
        select count(*)::integer as "rowCount",
          coalesce(sum(greatest(coalesce(b.receivable_minor,0),0)),0)::text as "receivableMinor",
          coalesce(sum(greatest(coalesce(b.credit_minor,0),0)),0)::text as "creditMinor",
          coalesce(sum(greatest(coalesce(b.net_due_minor,0),0)),0)::text as "netDueMinor"
        from ledger.customers c left join ledger.v_customer_balances b
          on b.store_id=c.store_id and b.customer_id=c.id where ${filter}
      `);
      const page = this.takePage(rows.rows, input.limit);
      return {
        asOf: await this.readAsOf(transaction),
        ...page,
        pageTotals: this.customerTotals(page.items),
        filteredTotals: this.requiredRow(totals.rows[0], 'Customer Receivable totals'),
      };
    });
  }

  readSupplierPayables(
    context: TenantTransactionContext,
    input: SupplierInput,
  ): Promise<ReportPageData<SupplierPayableReportRow, SupplierPayableReportTotals>> {
    return this.database.withTenantSnapshotTransaction(context, async (transaction) => {
      const filter = sql`
        s.store_id=${context.storeId}::uuid
        ${input.supplierId ? sql`and s.id=${input.supplierId}::uuid` : sql``}
      `;
      const anchor = input.cursorId
        ? await this.namedAnchor(
            transaction,
            sql`
            select s.normalized_name as "normalizedName" from ledger.suppliers s
            where ${filter} and s.id=${input.cursorId}::uuid limit 1
          `,
          )
        : null;
      const continuation = anchor
        ? sql`and (s.normalized_name>${anchor} or (s.normalized_name=${anchor} and s.id>${input.cursorId}::uuid))`
        : sql``;
      const rows = await transaction.execute<
        SupplierPayableReportRow & Record<string, unknown>
      >(sql`
        select s.id, s.name, s.phone, s.status,
          greatest(coalesce(b.payable_minor,0),0)::text as "payableMinor",
          greatest(coalesce(b.credit_minor,0),0)::text as "creditMinor",
          greatest(coalesce(b.net_payable_minor,0),0)::text as "netPayableMinor"
        from ledger.suppliers s left join ledger.v_supplier_balances b
          on b.store_id=s.store_id and b.supplier_id=s.id
        where ${filter} ${continuation}
        order by s.normalized_name, s.id limit ${input.limit + 1}
      `);
      const totals = await transaction.execute<
        SupplierPayableReportTotals & Record<string, unknown>
      >(sql`
        select count(*)::integer as "rowCount",
          coalesce(sum(greatest(coalesce(b.payable_minor,0),0)),0)::text as "payableMinor",
          coalesce(sum(greatest(coalesce(b.credit_minor,0),0)),0)::text as "creditMinor",
          coalesce(sum(greatest(coalesce(b.net_payable_minor,0),0)),0)::text as "netPayableMinor"
        from ledger.suppliers s left join ledger.v_supplier_balances b
          on b.store_id=s.store_id and b.supplier_id=s.id where ${filter}
      `);
      const page = this.takePage(rows.rows, input.limit);
      return {
        asOf: await this.readAsOf(transaction),
        ...page,
        pageTotals: this.supplierTotals(page.items),
        filteredTotals: this.requiredRow(totals.rows[0], 'Supplier Payable totals'),
      };
    });
  }

  readInventoryStock(
    context: TenantTransactionContext,
    input: InventoryStockInput,
  ): Promise<ReportPageData<InventoryStockReportRow, InventoryStockReportTotals>> {
    return this.database.withTenantSnapshotTransaction(context, async (transaction) => {
      const filter = sql`
        p.store_id=${context.storeId}::uuid and p.track_inventory=true
        ${input.productId ? sql`and p.id=${input.productId}::uuid` : sql``}
      `;
      const anchor = input.cursorId
        ? await this.namedAnchor(
            transaction,
            sql`
            select p.normalized_name as "normalizedName" from ledger.products p
            where ${filter} and p.id=${input.cursorId}::uuid limit 1
          `,
          )
        : null;
      const continuation = anchor
        ? sql`and (p.normalized_name>${anchor} or (p.normalized_name=${anchor} and p.id>${input.cursorId}::uuid))`
        : sql``;
      const rows = await transaction.execute<InventoryStockReportRow & Record<string, unknown>>(sql`
        select p.id as "productId", p.name as "productName", p.status as "productStatus",
          coalesce(sb.quantity_milli,0)::text as "quantityMilli",
          case when sb.cost_state='known' then sb.average_unit_cost_minor::text else null end
            as "averageUnitCostMinor",
          case when sb.cost_state='known' then sb.inventory_value_minor::text else null end
            as "inventoryValueMinor",
          coalesce(sb.cost_state,'unknown') as "costState",
          coalesce(sb.has_pending_cost,false) as "hasPendingCost", sb.version::text as version
        from ledger.products p left join ledger.stock_balances sb
          on sb.store_id=p.store_id and sb.product_id=p.id
        where ${filter} ${continuation}
        order by p.normalized_name, p.id limit ${input.limit + 1}
      `);
      const totals = await transaction.execute<
        InventoryStockReportTotals & Record<string, unknown>
      >(sql`
        select count(*)::integer as "rowCount",
          coalesce(sum(sb.inventory_value_minor) filter (where sb.cost_state='known'),0)::text
            as "knownValueMinor",
          count(*) filter (where sb.product_id is null or
            (sb.quantity_milli<>0 and sb.cost_state<>'known'))::integer as "uncertainProductCount",
          case when count(*) filter (where sb.product_id is null or
            (sb.quantity_milli<>0 and sb.cost_state<>'known'))=0
            then coalesce(sum(sb.inventory_value_minor),0)::text else null end as "totalValueMinor"
        from ledger.products p left join ledger.stock_balances sb
          on sb.store_id=p.store_id and sb.product_id=p.id where ${filter}
      `);
      const page = this.takePage(rows.rows, input.limit);
      return {
        asOf: await this.readAsOf(transaction),
        ...page,
        pageTotals: this.inventoryStockTotals(page.items),
        filteredTotals: this.requiredRow(totals.rows[0], 'Inventory Stock totals'),
      };
    });
  }

  readInventoryMovements(
    context: TenantTransactionContext,
    input: InventoryMovementInput,
  ): Promise<ReportPageData<InventoryMovementReportRow, InventoryMovementReportTotals>> {
    return this.database.withTenantSnapshotTransaction(context, async (transaction) => {
      const filter = sql`
        m.store_id=${context.storeId}::uuid
        and m.posting_date between ${input.fromDate}::date and ${input.toDate}::date
        ${input.accountingPeriodId ? sql`and m.accounting_period_id=${input.accountingPeriodId}::uuid` : sql``}
        ${input.productId ? sql`and m.product_id=${input.productId}::uuid` : sql``}
        ${input.movementType ? sql`and m.movement_type=${input.movementType}` : sql``}
      `;
      const anchor = input.cursorId
        ? await this.historicalAnchor(
            transaction,
            sql`
            select m.occurred_at as "occurredAt" from ledger.inventory_movements m
            where ${filter} and m.id=${input.cursorId}::uuid limit 1
          `,
          )
        : null;
      const continuation = anchor
        ? sql`and (m.occurred_at<${anchor} or (m.occurred_at=${anchor} and m.id<${input.cursorId}::uuid))`
        : sql``;
      const rows = await transaction.execute<InventoryMovementPhysicalRow>(sql`
        select m.id, m.product_id as "productId", p.name as "productName",
          m.movement_type as "movementType", m.quantity_delta_milli::text as "quantityDeltaMilli",
          m.quantity_after_milli::text as "quantityAfterMilli",
          case when m.cost_status='known' then m.value_delta_minor::text else null end as "valueDeltaMinor",
          m.cost_state_before as "costStateBefore", m.cost_state_after as "costStateAfter",
          m.reference_type as "referenceType", m.reference_id as "referenceId",
          m.reversal_of_id as "reversalOfId", m.business_date::text as "businessDate",
          m.posting_date::text as "postingDate", m.accounting_period_id as "accountingPeriodId",
          m.occurred_at as "occurredAt"
        from ledger.inventory_movements m inner join ledger.products p
          on p.store_id=m.store_id and p.id=m.product_id
        where ${filter} ${continuation}
        order by m.occurred_at desc, m.id desc limit ${input.limit + 1}
      `);
      const totals = await transaction.execute<
        InventoryMovementReportTotals & Record<string, unknown>
      >(sql`
        select count(*)::integer as "rowCount",
          coalesce(sum(m.value_delta_minor) filter (where m.cost_status='known'),0)::text
            as "knownValueDeltaMinor",
          count(*) filter (where m.cost_status<>'known')::integer as "unknownCostMovementCount"
        from ledger.inventory_movements m where ${filter}
      `);
      const page = this.takePage(
        rows.rows.map((row) => ({ ...row, occurredAt: this.iso(row.occurredAt) })),
        input.limit,
      );
      return {
        asOf: await this.readAsOf(transaction),
        ...page,
        pageTotals: this.inventoryMovementTotals(page.items),
        filteredTotals: this.requiredRow(totals.rows[0], 'Inventory Movement totals'),
      };
    });
  }

  readReturnsCorrections(
    context: TenantTransactionContext,
    input: ReturnCorrectionInput,
  ): Promise<ReportPageData<ReturnCorrectionReportRow, ReturnCorrectionReportTotals>> {
    return this.database.withTenantSnapshotTransaction(context, async (transaction) => {
      const union = this.returnCorrectionUnion(context.storeId);
      const filter = sql`
        posting_date between ${input.fromDate}::date and ${input.toDate}::date
        ${input.accountingPeriodId ? sql`and accounting_period_id=${input.accountingPeriodId}::uuid` : sql``}
        ${input.sourceType === 'all' ? sql`` : sql`and source_type=${input.sourceType}`}
      `;
      const anchorResult = input.cursorId
        ? await transaction.execute<ReturnAnchorRow>(sql`
            with report_rows as (${union}) select occurred_at as "occurredAt",
              source_type as "sourceType"
            from report_rows where ${filter} and id=${input.cursorId}::uuid
              and source_type=${input.cursorSourceType} limit 1
          `)
        : null;
      if (anchorResult && !anchorResult.rows[0]) throw this.invalidCursorAnchor();
      const anchor = anchorResult?.rows[0] ?? null;
      const continuation = anchor
        ? sql`and (occurred_at<${this.date(anchor.occurredAt)} or
            (occurred_at=${this.date(anchor.occurredAt)} and
              (source_type>${anchor.sourceType} or
                (source_type=${anchor.sourceType} and id<${input.cursorId}::uuid))))`
        : sql``;
      const rows = await transaction.execute<ReturnCorrectionPhysicalRow>(sql`
        with report_rows as (${union})
        select id, source_type as "sourceType", subtype, status, display_number as "displayNumber",
          amount_minor as "amountMinor", quantity_delta_milli as "quantityDeltaMilli",
          reversal_of_id as "reversalOfId", replacement_id as "replacementId",
          business_date as "businessDate", posting_date as "postingDate",
          accounting_period_id as "accountingPeriodId", occurred_at as "occurredAt"
        from report_rows where ${filter} ${continuation}
        order by occurred_at desc, source_type, id desc limit ${input.limit + 1}
      `);
      const totals = await transaction.execute<
        ReturnCorrectionReportTotals & Record<string, unknown>
      >(sql`
        with report_rows as (${union})
        select count(*)::integer as "rowCount",
          count(*) filter (where source_type='sale_return')::integer as "saleReturnCount",
          count(*) filter (where source_type='supplier_return')::integer as "supplierReturnCount",
          count(*) filter (where source_type not in ('sale_return','supplier_return'))::integer
            as "correctionCount"
        from report_rows where ${filter}
      `);
      const page = this.takePage(
        rows.rows.map((row) => ({ ...row, occurredAt: this.iso(row.occurredAt) })),
        input.limit,
      );
      return {
        asOf: await this.readAsOf(transaction),
        ...page,
        pageTotals: this.returnCorrectionTotals(page.items),
        filteredTotals: this.requiredRow(totals.rows[0], 'Return and Correction totals'),
      };
    });
  }

  readOwnerLedger(
    context: TenantTransactionContext,
    input: OwnerLedgerInput,
  ): Promise<
    ReportPageData<OwnerLedgerReportRow, OwnerLedgerReportTotals> & OwnerLedgerReportExtra
  > {
    return this.database.withTenantSnapshotTransaction(context, async (transaction) => {
      const filter = sql`
        o.store_id=${context.storeId}::uuid
        and (o.occurred_at at time zone 'Asia/Hebron')::date between ${input.fromDate}::date and ${input.toDate}::date
        ${input.accountingPeriodId ? sql`and o.accounting_period_id=${input.accountingPeriodId}::uuid` : sql``}
        ${input.entryType ? sql`and o.entry_type=${input.entryType}` : sql``}
      `;
      const anchor = input.cursorId
        ? await this.historicalAnchor(
            transaction,
            sql`
            select o.occurred_at as "occurredAt" from ledger.owner_ledger_entries o
            where ${filter} and o.id=${input.cursorId}::uuid limit 1
          `,
          )
        : null;
      const continuation = anchor
        ? sql`and (o.occurred_at<${anchor} or (o.occurred_at=${anchor} and o.id<${input.cursorId}::uuid))`
        : sql``;
      const rows = await transaction.execute<OwnerLedgerPhysicalRow>(sql`
        select o.id, o.entry_type as "entryType",
          o.owner_liability_delta_minor::text as "ownerLiabilityDeltaMinor",
          o.equity_delta_minor::text as "equityDeltaMinor", o.money_account_id as "moneyAccountId",
          a.name as "moneyAccountName", o.reference_type as "referenceType",
          o.reference_id as "referenceId", o.reversal_of_id as "reversalOfId",
          (o.occurred_at at time zone 'Asia/Hebron')::date::text as "businessDate",
          (o.occurred_at at time zone 'Asia/Hebron')::date::text as "postingDate",
          o.accounting_period_id as "accountingPeriodId", o.occurred_at as "occurredAt"
        from ledger.owner_ledger_entries o left join ledger.money_accounts a
          on a.store_id=o.store_id and a.id=o.money_account_id
        where ${filter} ${continuation}
        order by o.occurred_at desc, o.id desc limit ${input.limit + 1}
      `);
      const totals = await transaction.execute<
        OwnerLedgerReportTotals & Record<string, unknown>
      >(sql`
        select count(*)::integer as "rowCount",
          coalesce(sum(o.owner_liability_delta_minor),0)::text as "ownerLiabilityDeltaMinor",
          coalesce(sum(o.equity_delta_minor),0)::text as "equityDeltaMinor"
        from ledger.owner_ledger_entries o where ${filter}
      `);
      const position = await transaction.execute<
        OwnerLedgerReportExtra['currentPosition'] & Record<string, unknown>
      >(sql`
        select store_owes_owner_minor::text as "storeOwesOwnerMinor",
          owner_equity_movement_minor::text as "ownerEquityMovementMinor"
        from ledger.v_owner_position where store_id=${context.storeId}::uuid
      `);
      const page = this.takePage(
        rows.rows.map((row) => ({ ...row, occurredAt: this.iso(row.occurredAt) })),
        input.limit,
      );
      return {
        asOf: await this.readAsOf(transaction),
        ...page,
        pageTotals: this.ownerTotals(page.items),
        filteredTotals: this.requiredRow(totals.rows[0], 'Owner Ledger totals'),
        currentPosition: position.rows[0] ?? {
          storeOwesOwnerMinor: '0',
          ownerEquityMovementMinor: '0',
        },
      };
    });
  }

  private returnCorrectionUnion(storeId: string): ReturnType<typeof sql> {
    return sql`
      select sr.id, 'sale_return'::text as source_type, 'sale_return'::text as subtype,
        sr.status::text as status, sr.display_number::text as display_number,
        sr.total_minor::text as amount_minor, null::text as quantity_delta_milli,
        null::uuid as reversal_of_id, null::uuid as replacement_id,
        (sr.return_at at time zone 'Asia/Hebron')::date::text as business_date,
        (sr.return_at at time zone 'Asia/Hebron')::date as posting_date,
        sr.accounting_period_id, sr.return_at as occurred_at
      from ledger.sale_returns sr where sr.store_id=${storeId}::uuid

      union all

      select sr.id, 'supplier_return', 'supplier_return', sr.status::text,
        sr.display_number::text, sr.total_minor::text, null::text, null::uuid, null::uuid,
        (sr.return_at at time zone 'Asia/Hebron')::date::text,
        (sr.return_at at time zone 'Asia/Hebron')::date,
        sr.accounting_period_id, sr.return_at
      from ledger.supplier_returns sr where sr.store_id=${storeId}::uuid

      union all

      select s.id, 'sale_correction', s.status::text, s.status::text,
        s.display_number::text, s.total_minor::text, null::text, s.correction_of_id,
        coalesce(s.reversed_by_id, (select child.id from ledger.sales child
          where child.store_id=s.store_id and child.correction_of_id=s.id
          order by child.created_at, child.id limit 1)),
        (s.sale_at at time zone 'Asia/Hebron')::date::text,
        (s.sale_at at time zone 'Asia/Hebron')::date, s.accounting_period_id,
        coalesce(s.cancelled_at,s.updated_at)
      from ledger.sales s where s.store_id=${storeId}::uuid
        and s.status in ('cancelled','corrected')

      union all

      select e.id, 'expense_correction', 'cancelled', e.status::text, null::text,
        e.amount_minor::text, null::text, null::uuid, null::uuid,
        (e.expense_at at time zone 'Asia/Hebron')::date::text,
        (e.expense_at at time zone 'Asia/Hebron')::date, e.accounting_period_id,
        coalesce(e.cancelled_at,e.updated_at)
      from ledger.expenses e where e.store_id=${storeId}::uuid and e.status='cancelled'

      union all

      select p.id, 'supplier_invoice_correction', 'cancelled', p.status::text,
        p.display_number::text, p.total_minor::text, null::text, p.correction_of_id,
        (select child.id from ledger.purchase_invoices child
          where child.store_id=p.store_id and child.correction_of_id=p.id
          order by child.created_at, child.id limit 1),
        (p.invoice_date_at at time zone 'Asia/Hebron')::date::text,
        coalesce(p.posting_date,(p.invoice_date_at at time zone 'Asia/Hebron')::date),
        p.accounting_period_id, coalesce(p.cancelled_at,p.updated_at)
      from ledger.purchase_invoices p where p.store_id=${storeId}::uuid and p.status='cancelled'

      union all

      select p.id, 'customer_payment_correction', 'cancelled', p.status::text, null::text,
        p.amount_minor::text, null::text, null::uuid, null::uuid,
        (p.payment_at at time zone 'Asia/Hebron')::date::text,
        (p.payment_at at time zone 'Asia/Hebron')::date, p.accounting_period_id,
        coalesce(p.cancelled_at,p.updated_at)
      from ledger.customer_payments p where p.store_id=${storeId}::uuid and p.status='cancelled'

      union all

      select p.id, 'supplier_payment_correction', 'cancelled', p.status::text, null::text,
        p.amount_minor::text, null::text, null::uuid, null::uuid,
        (p.payment_at at time zone 'Asia/Hebron')::date::text,
        (p.payment_at at time zone 'Asia/Hebron')::date, p.accounting_period_id,
        coalesce(p.cancelled_at,p.updated_at)
      from ledger.supplier_payments p where p.store_id=${storeId}::uuid and p.status='cancelled'

      union all

      select p.id, 'expense_payment_correction', 'cancelled', p.status::text, null::text,
        p.amount_minor::text, null::text, null::uuid, null::uuid,
        (p.payment_at at time zone 'Asia/Hebron')::date::text,
        (p.payment_at at time zone 'Asia/Hebron')::date, p.accounting_period_id,
        coalesce(p.cancelled_at,p.updated_at)
      from ledger.expense_payments p where p.store_id=${storeId}::uuid and p.status='cancelled'

      union all

      select m.id, 'money_correction', m.movement_type::text, null::text, null::text,
        m.amount_delta_minor::text, null::text, m.reversal_of_id, null::uuid,
        (m.occurred_at at time zone 'Asia/Hebron')::date::text,
        (m.occurred_at at time zone 'Asia/Hebron')::date, m.accounting_period_id, m.occurred_at
      from ledger.money_movements m where m.store_id=${storeId}::uuid
        and (m.movement_type='correction' or m.reversal_of_id is not null)

      union all

      select m.id, 'inventory_correction', m.movement_type::text, null::text, null::text,
        case when m.cost_status='known' then m.value_delta_minor::text else null end,
        m.quantity_delta_milli::text, m.reversal_of_id, null::uuid,
        m.business_date::text, m.posting_date, m.accounting_period_id, m.occurred_at
      from ledger.inventory_movements m where m.store_id=${storeId}::uuid
        and (m.movement_type='correction' or m.reversal_of_id is not null)

      union all

      select o.id, 'owner_correction', o.entry_type::text, null::text, null::text,
        null::text, null::text, o.reversal_of_id, null::uuid,
        (o.occurred_at at time zone 'Asia/Hebron')::date::text,
        (o.occurred_at at time zone 'Asia/Hebron')::date, o.accounting_period_id, o.occurred_at
      from ledger.owner_ledger_entries o where o.store_id=${storeId}::uuid
        and (o.entry_type='correction' or o.reversal_of_id is not null)
    `;
  }

  private async historicalAnchor(
    transaction: DatabaseTransaction,
    query: ReturnType<typeof sql>,
  ): Promise<Date> {
    const result = await transaction.execute<HistoricalAnchorRow>(query);
    const row = result.rows[0];
    if (!row) throw this.invalidCursorAnchor();
    return this.date(row.occurredAt);
  }

  private async namedAnchor(
    transaction: DatabaseTransaction,
    query: ReturnType<typeof sql>,
  ): Promise<string> {
    const result = await transaction.execute<NamedAnchorRow>(query);
    const row = result.rows[0];
    if (!row) throw this.invalidCursorAnchor();
    return row.normalizedName;
  }

  private invalidCursorAnchor(): BadRequestException {
    return new BadRequestException({
      code: 'REPORT_QUERY_INVALID',
      message: 'Report query is invalid.',
      details: [{ field: 'cursor', constraint: 'reportCursorAnchor' }],
    });
  }

  private async readAsOf(transaction: DatabaseTransaction): Promise<Date> {
    const result = await transaction.execute<AsOfRow>(sql`
      select transaction_timestamp() as "asOf"
    `);
    return this.date(this.requiredRow(result.rows[0], 'Report timestamp').asOf);
  }

  private takePage<T>(rows: T[], limit: number): { items: T[]; hasMore: boolean } {
    return { items: rows.slice(0, limit), hasMore: rows.length > limit };
  }

  private dateFilters(input: ReportDateRange): ReportDateRange {
    return {
      fromDate: input.fromDate,
      toDate: input.toDate,
      ...(input.accountingPeriodId ? { accountingPeriodId: input.accountingPeriodId } : {}),
    };
  }

  private sumOperational(rows: OperationalSummaryRow[]): OperationalSummaryResponse['totals'] {
    return {
      salesMinor: this.sum(rows.map((row) => row.salesMinor)),
      immediateSaleCollectionsMinor: this.sum(rows.map((row) => row.immediateSaleCollectionsMinor)),
      customerCollectionsMinor: this.sum(rows.map((row) => row.customerCollectionsMinor)),
      customerReceivableAllocationsMinor: this.sum(
        rows.map((row) => row.customerReceivableAllocationsMinor),
      ),
      creditSalesMinor: this.sum(rows.map((row) => row.creditSalesMinor)),
      expensesRecognizedMinor: this.sum(rows.map((row) => row.expensesRecognizedMinor)),
      expensePaymentsMinor: this.sum(rows.map((row) => row.expensePaymentsMinor)),
      supplierInvoicesMinor: this.sum(rows.map((row) => row.supplierInvoicesMinor)),
      supplierPaymentsMinor: this.sum(rows.map((row) => row.supplierPaymentsMinor)),
      saleReturnsMinor: this.sum(rows.map((row) => row.saleReturnsMinor)),
      supplierReturnsMinor: this.sum(rows.map((row) => row.supplierReturnsMinor)),
    };
  }

  private salesTotals(rows: SalesReportRow[]): SalesReportTotals {
    const posted = rows.filter((row) => row.status === 'posted');
    const returned = this.sum(posted.map((row) => row.returnedTotalMinor));
    return {
      rowCount: rows.length,
      postedTotalMinor: this.sum(posted.map((row) => row.totalMinor)),
      cancelledTotalMinor: this.sum(
        rows.filter((row) => row.status === 'cancelled').map((row) => row.totalMinor),
      ),
      correctedTotalMinor: this.sum(
        rows.filter((row) => row.status === 'corrected').map((row) => row.totalMinor),
      ),
      paidTotalMinor: this.sum(posted.map((row) => row.paidTotalMinor)),
      creditTotalMinor: this.sum(posted.map((row) => row.creditTotalMinor)),
      returnedTotalMinor: returned,
      netPostedSalesMinor: (
        BigInt(this.sum(posted.map((row) => row.totalMinor))) - BigInt(returned)
      ).toString(),
    };
  }

  private expenseTotals(rows: ExpenseReportRow[]): ExpenseReportTotals {
    const posted = rows.filter((row) => row.status === 'posted');
    return {
      rowCount: rows.length,
      recognizedMinor: this.sum(posted.map((row) => row.amountMinor)),
      cancelledMinor: this.sum(
        rows.filter((row) => row.status === 'cancelled').map((row) => row.amountMinor),
      ),
      paidMinor: this.sum(posted.map((row) => row.paidMinor)),
      outstandingMinor: this.sum(posted.map((row) => row.outstandingMinor)),
    };
  }

  private moneyTotals(rows: MoneyMovementReportRow[]): MoneyMovementReportTotals {
    const deltas = rows.map((row) => BigInt(row.amountDeltaMinor));
    return {
      rowCount: rows.length,
      inflowMinor: deltas
        .filter((value) => value > 0n)
        .reduce((sum, value) => sum + value, 0n)
        .toString(),
      outflowMinor: deltas
        .filter((value) => value < 0n)
        .reduce((sum, value) => sum - value, 0n)
        .toString(),
      netMinor: deltas.reduce((sum, value) => sum + value, 0n).toString(),
    };
  }

  private customerTotals(rows: CustomerReceivableReportRow[]): CustomerReceivableReportTotals {
    return {
      rowCount: rows.length,
      receivableMinor: this.sum(rows.map((row) => row.receivableMinor)),
      creditMinor: this.sum(rows.map((row) => row.creditMinor)),
      netDueMinor: this.sum(rows.map((row) => row.netDueMinor)),
    };
  }

  private supplierTotals(rows: SupplierPayableReportRow[]): SupplierPayableReportTotals {
    return {
      rowCount: rows.length,
      payableMinor: this.sum(rows.map((row) => row.payableMinor)),
      creditMinor: this.sum(rows.map((row) => row.creditMinor)),
      netPayableMinor: this.sum(rows.map((row) => row.netPayableMinor)),
    };
  }

  private inventoryStockTotals(rows: InventoryStockReportRow[]): InventoryStockReportTotals {
    const uncertainProductCount = rows.filter(
      (row) => row.version === null || (row.quantityMilli !== '0' && row.costState !== 'known'),
    ).length;
    const knownValueMinor = this.sum(
      rows.map((row) => row.inventoryValueMinor).filter((value): value is string => value !== null),
    );
    return {
      rowCount: rows.length,
      knownValueMinor,
      uncertainProductCount,
      totalValueMinor: uncertainProductCount === 0 ? knownValueMinor : null,
    };
  }

  private inventoryMovementTotals(
    rows: InventoryMovementReportRow[],
  ): InventoryMovementReportTotals {
    return {
      rowCount: rows.length,
      knownValueDeltaMinor: this.sum(
        rows.map((row) => row.valueDeltaMinor).filter((value): value is string => value !== null),
      ),
      unknownCostMovementCount: rows.filter((row) => row.valueDeltaMinor === null).length,
    };
  }

  private returnCorrectionTotals(rows: ReturnCorrectionReportRow[]): ReturnCorrectionReportTotals {
    return {
      rowCount: rows.length,
      saleReturnCount: rows.filter((row) => row.sourceType === 'sale_return').length,
      supplierReturnCount: rows.filter((row) => row.sourceType === 'supplier_return').length,
      correctionCount: rows.filter(
        (row) => !['sale_return', 'supplier_return'].includes(row.sourceType),
      ).length,
    };
  }

  private ownerTotals(rows: OwnerLedgerReportRow[]): OwnerLedgerReportTotals {
    return {
      rowCount: rows.length,
      ownerLiabilityDeltaMinor: this.sum(rows.map((row) => row.ownerLiabilityDeltaMinor)),
      equityDeltaMinor: this.sum(rows.map((row) => row.equityDeltaMinor)),
    };
  }

  private sum(values: string[]): string {
    return values.reduce((sum, value) => sum + BigInt(value), 0n).toString();
  }

  private requiredRow<T>(row: T | undefined, label: string): T {
    if (!row) throw new Error(`${label} are unavailable.`);
    return row;
  }

  private date(value: Date | string): Date {
    const result = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(result.getTime())) throw new Error('Report timestamp is invalid.');
    return result;
  }

  private iso(value: Date | string): string {
    return this.date(value).toISOString();
  }
}
