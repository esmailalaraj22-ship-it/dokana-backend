import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import type { SaleItemCostStatus, SalePaymentStatus, SaleStatus } from '../database/schema';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import type {
  MoneyAccountPhysicalType,
  MoneyAccountStatus,
} from '../money-accounts/money-account.types';
import { SaleReadQueryError } from './sale-read-query-error';
import type {
  CustomerReceivableCustomerRow,
  CustomerReceivableListCriteria,
  CustomerReceivablePosition,
  CustomerReceivableRow,
  SaleDetailRow,
  SaleItemReadRow,
  SaleListCriteria,
  SaleReadCustomerRow,
  SaleReadPosition,
  SaleSummaryRow,
  SaleTenderReadRow,
} from './sale-read.types';

interface SaleSummaryPhysicalRow extends Record<string, unknown> {
  id: string;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerStatus: 'active' | 'archived' | null;
  customerArchivedAt: string | null;
  accountingPeriodId: string | null;
  displayNumber: string;
  occurredAt: string;
  totalMinor: string;
  paidTotalMinor: string;
  creditTotalMinor: string;
  receivableOutstandingMinor: string;
  paymentStatus: SalePaymentStatus;
  status: SaleStatus;
  createdAt: string;
  updatedAt: string;
  version: string;
}

interface SaleDetailPhysicalRow extends SaleSummaryPhysicalRow {
  itemsSubtotalMinor: string;
  lineDiscountTotalMinor: string;
  invoiceDiscountMinor: string;
  roundingMinor: string;
  knownCostTotalMinor: string;
  pendingCostLineCount: number;
  unknownCostLineCount: number;
  notes: string | null;
  correctionOfId: string | null;
  reversedById: string | null;
  cancelledAt: string | null;
}

interface SaleItemPhysicalRow extends Record<string, unknown> {
  id: string;
  productId: string | null;
  productUnitId: string | null;
  isManualLine: boolean;
  productNameSnapshot: string;
  unitNameSnapshot: string | null;
  quantityMilli: string;
  conversionFactorNum: number;
  conversionFactorDen: number;
  baseQuantityMilli: string | null;
  unitPriceMinor: string;
  lineGrossMinor: string;
  lineDiscountMinor: string;
  roundingMinor: string;
  lineTotalMinor: string;
  costStatus: SaleItemCostStatus;
  unitCostMinor: string | null;
  lineCostMinor: string | null;
  inventoryMovementId: string | null;
  createdAt: string;
  updatedAt: string;
  version: string;
}

interface SaleTenderPhysicalRow extends Record<string, unknown> {
  id: string;
  moneyAccountId: string;
  moneyAccountName: string | null;
  moneyAccountType: MoneyAccountPhysicalType | null;
  moneyAccountStatus: MoneyAccountStatus | null;
  amountMinor: string;
  paymentAt: string;
  senderAccountName: string | null;
  externalReference: string | null;
  moneyMovementId: string | null;
  createdAt: string;
  updatedAt: string;
  version: string;
}

interface CustomerReceivablePhysicalRow extends Record<string, unknown> {
  id: string;
  customerId: string;
  accountingPeriodId: string;
  entryType: 'sale_credit' | 'opening_balance';
  originalAmountMinor: string;
  outstandingMinor: string;
  saleId: string | null;
  saleDisplayNumber: string | null;
  occurredAt: string;
  reason: string | null;
  createdAt: string;
}

interface CustomerFinancialPhysicalRow extends Record<string, unknown> {
  id: string;
  name: string;
  phone: string;
  status: 'active' | 'archived';
  archivedAt: string | null;
  receivableMinor: string;
}

interface SalePositionPhysicalRow extends Record<string, unknown> {
  id: string;
  occurredAt: string;
}

interface ReceivablePositionPhysicalRow extends Record<string, unknown> {
  id: string;
  occurredAt: string;
}

@Injectable()
export class SaleReadRepository {
  constructor(private readonly database: DatabaseService) {}

  list(context: TenantTransactionContext, criteria: SaleListCriteria): Promise<SaleSummaryRow[]> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const position = criteria.anchor
        ? await this.resolveSalePosition(transaction, context.storeId, criteria.anchor)
        : null;
      const continuation = position
        ? sql`and (
            s.sale_at < ${position.occurredAt}
            or (s.sale_at = ${position.occurredAt} and s.id < ${position.id}::uuid)
          )`
        : sql``;
      const result = await transaction.execute<SaleSummaryPhysicalRow>(sql`
        select
          s.id,
          s.customer_id as "customerId",
          customer.name as "customerName",
          customer.phone as "customerPhone",
          customer.status as "customerStatus",
          customer.archived_at as "customerArchivedAt",
          s.accounting_period_id as "accountingPeriodId",
          s.display_number as "displayNumber",
          s.sale_at as "occurredAt",
          s.total_minor::text as "totalMinor",
          s.paid_total_minor::text as "paidTotalMinor",
          s.credit_total_minor::text as "creditTotalMinor",
          coalesce(outstanding.outstanding_minor, 0)::text as "receivableOutstandingMinor",
          s.payment_status as "paymentStatus",
          s.status,
          s.created_at as "createdAt",
          s.updated_at as "updatedAt",
          s.version::text as version
        from ledger.sales s
        left join ledger.customers customer
          on customer.store_id=s.store_id and customer.id=s.customer_id
        left join ledger.v_customer_invoice_outstanding outstanding
          on outstanding.store_id=s.store_id and outstanding.sale_id=s.id
        where s.store_id=${context.storeId}::uuid
          and s.status <> 'draft'
          ${continuation}
        order by s.sale_at desc, s.id desc
        limit ${criteria.limit + 1}
      `);
      return result.rows.map((row) => this.mapSaleSummary(row));
    });
  }

  findById(context: TenantTransactionContext, saleId: string): Promise<SaleDetailRow | undefined> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const headerResult = await transaction.execute<SaleDetailPhysicalRow>(sql`
        select
          s.id,
          s.customer_id as "customerId",
          customer.name as "customerName",
          customer.phone as "customerPhone",
          customer.status as "customerStatus",
          customer.archived_at as "customerArchivedAt",
          s.accounting_period_id as "accountingPeriodId",
          s.display_number as "displayNumber",
          s.sale_at as "occurredAt",
          s.items_subtotal_minor::text as "itemsSubtotalMinor",
          s.line_discount_total_minor::text as "lineDiscountTotalMinor",
          s.invoice_discount_minor::text as "invoiceDiscountMinor",
          s.rounding_minor::text as "roundingMinor",
          s.total_minor::text as "totalMinor",
          s.paid_total_minor::text as "paidTotalMinor",
          s.credit_total_minor::text as "creditTotalMinor",
          coalesce(outstanding.outstanding_minor, 0)::text as "receivableOutstandingMinor",
          s.known_cost_total_minor::text as "knownCostTotalMinor",
          s.pending_cost_line_count as "pendingCostLineCount",
          s.unknown_cost_line_count as "unknownCostLineCount",
          s.payment_status as "paymentStatus",
          s.status,
          s.notes,
          s.correction_of_id as "correctionOfId",
          s.reversed_by_id as "reversedById",
          s.cancelled_at as "cancelledAt",
          s.created_at as "createdAt",
          s.updated_at as "updatedAt",
          s.version::text as version
        from ledger.sales s
        left join ledger.customers customer
          on customer.store_id=s.store_id and customer.id=s.customer_id
        left join ledger.v_customer_invoice_outstanding outstanding
          on outstanding.store_id=s.store_id and outstanding.sale_id=s.id
        where s.store_id=${context.storeId}::uuid
          and s.id=${saleId}::uuid
          and s.status <> 'draft'
        limit 1
      `);
      const header = headerResult.rows[0];
      if (!header) return undefined;

      const itemResult = await transaction.execute<SaleItemPhysicalRow>(sql`
        select
          item.id,
          item.product_id as "productId",
          item.product_unit_id as "productUnitId",
          item.is_manual_line as "isManualLine",
          item.product_name_snapshot as "productNameSnapshot",
          item.unit_name_snapshot as "unitNameSnapshot",
          item.quantity_milli::text as "quantityMilli",
          item.conversion_factor_num as "conversionFactorNum",
          item.conversion_factor_den as "conversionFactorDen",
          item.base_quantity_milli::text as "baseQuantityMilli",
          item.unit_price_minor::text as "unitPriceMinor",
          item.line_gross_minor::text as "lineGrossMinor",
          item.line_discount_minor::text as "lineDiscountMinor",
          item.rounding_minor::text as "roundingMinor",
          item.line_total_minor::text as "lineTotalMinor",
          item.cost_status as "costStatus",
          item.unit_cost_minor::text as "unitCostMinor",
          item.line_cost_minor::text as "lineCostMinor",
          item.inventory_movement_id as "inventoryMovementId",
          item.created_at as "createdAt",
          item.updated_at as "updatedAt",
          item.version::text as version
        from ledger.sale_items item
        where item.store_id=${context.storeId}::uuid
          and item.sale_id=${saleId}::uuid
        order by item.created_at asc, item.id asc
      `);
      const tenderResult = await transaction.execute<SaleTenderPhysicalRow>(sql`
        select
          payment.id,
          payment.money_account_id as "moneyAccountId",
          account.name as "moneyAccountName",
          account.account_type as "moneyAccountType",
          account.status as "moneyAccountStatus",
          payment.amount_minor::text as "amountMinor",
          payment.payment_at as "paymentAt",
          payment.sender_account_name as "senderAccountName",
          payment.external_reference as "externalReference",
          payment.money_movement_id as "moneyMovementId",
          payment.created_at as "createdAt",
          payment.updated_at as "updatedAt",
          payment.version::text as version
        from ledger.sale_payments payment
        left join ledger.money_accounts account
          on account.store_id=payment.store_id and account.id=payment.money_account_id
        where payment.store_id=${context.storeId}::uuid
          and payment.sale_id=${saleId}::uuid
        order by payment.money_account_id asc, payment.id asc
      `);
      const receivableResult = await transaction.execute<CustomerReceivablePhysicalRow>(sql`
        select
          origin.id,
          origin.customer_id as "customerId",
          origin.accounting_period_id as "accountingPeriodId",
          origin.entry_type as "entryType",
          (origin.receivable_delta_minor - origin.credit_delta_minor)::text
            as "originalAmountMinor",
          coalesce(outstanding.outstanding_minor, 0)::text as "outstandingMinor",
          sale.id as "saleId",
          sale.display_number as "saleDisplayNumber",
          origin.occurred_at as "occurredAt",
          origin.reason,
          origin.created_at as "createdAt"
        from ledger.customer_ledger_entries origin
        inner join ledger.sales sale
          on sale.store_id=origin.store_id and sale.id=origin.source_sale_id
        left join ledger.v_customer_invoice_outstanding outstanding
          on outstanding.store_id=sale.store_id and outstanding.sale_id=sale.id
        where origin.store_id=${context.storeId}::uuid
          and origin.source_sale_id=${saleId}::uuid
          and origin.entry_type='sale_credit'
          and origin.reversal_of_id is null
          and origin.receivable_delta_minor - origin.credit_delta_minor > 0
        order by origin.created_at asc, origin.id asc
        limit 2
      `);

      return this.mapSaleDetail(header, itemResult.rows, tenderResult.rows, receivableResult.rows);
    });
  }

  readCustomerReceivables(
    context: TenantTransactionContext,
    customerId: string,
    criteria: CustomerReceivableListCriteria,
  ): Promise<
    { customer: CustomerReceivableCustomerRow; receivables: CustomerReceivableRow[] } | undefined
  > {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const customerResult = await transaction.execute<CustomerFinancialPhysicalRow>(sql`
        select
          customer.id,
          customer.name,
          customer.phone,
          customer.status,
          customer.archived_at as "archivedAt",
          coalesce(balance.receivable_minor, 0)::text as "receivableMinor"
        from ledger.customers customer
        left join ledger.v_customer_balances balance
          on balance.store_id=customer.store_id and balance.customer_id=customer.id
        where customer.store_id=${context.storeId}::uuid
          and customer.id=${customerId}::uuid
        limit 1
      `);
      const customer = customerResult.rows[0];
      if (!customer) return undefined;

      const position = criteria.anchor
        ? await this.resolveReceivablePosition(
            transaction,
            context.storeId,
            customerId,
            criteria.anchor.id,
          )
        : null;
      const continuation = position
        ? sql`and (
            origin.occurred_at < ${position.occurredAt}
            or (origin.occurred_at = ${position.occurredAt} and origin.id < ${position.id}::uuid)
          )`
        : sql``;
      const result = await transaction.execute<CustomerReceivablePhysicalRow>(sql`
        select
          origin.id,
          origin.customer_id as "customerId",
          origin.accounting_period_id as "accountingPeriodId",
          origin.entry_type as "entryType",
          (origin.receivable_delta_minor - origin.credit_delta_minor)::text
            as "originalAmountMinor",
          case
            when origin.entry_type='sale_credit'
              then coalesce(invoice_outstanding.outstanding_minor, 0)
            else origin.receivable_delta_minor - origin.credit_delta_minor + coalesce((
              select sum(adjustment.receivable_delta_minor - adjustment.credit_delta_minor)
              from ledger.customer_ledger_entries adjustment
              where adjustment.store_id=origin.store_id
                and adjustment.reversal_of_id=origin.id
            ), 0) + coalesce((
              select sum(adjustment.receivable_delta_minor)
              from ledger.customer_ledger_entries adjustment
              where adjustment.store_id=origin.store_id
                and adjustment.customer_id=origin.customer_id
                and adjustment.entry_type in ('credit_used','settlement')
                and adjustment.reference_type='customer_opening_receivable'
                and adjustment.reference_id=origin.id
            ), 0) - coalesce((
              select sum(allocation.amount_minor)
              from ledger.customer_payment_allocations allocation
              inner join ledger.customer_payments payment
                on payment.store_id=allocation.store_id
                and payment.id=allocation.customer_payment_id
              where allocation.store_id=origin.store_id
                and allocation.opening_receivable_ledger_entry_id=origin.id
                and payment.status='posted'
            ), 0)
          end::text as "outstandingMinor",
          sale.id as "saleId",
          sale.display_number as "saleDisplayNumber",
          origin.occurred_at as "occurredAt",
          origin.reason,
          origin.created_at as "createdAt"
        from ledger.customer_ledger_entries origin
        left join ledger.sales sale
          on sale.store_id=origin.store_id and sale.id=origin.source_sale_id
        left join ledger.v_customer_invoice_outstanding invoice_outstanding
          on invoice_outstanding.store_id=origin.store_id
          and invoice_outstanding.sale_id=origin.source_sale_id
        where origin.store_id=${context.storeId}::uuid
          and origin.customer_id=${customerId}::uuid
          and origin.entry_type in ('sale_credit', 'opening_balance')
          and origin.reversal_of_id is null
          and origin.receivable_delta_minor - origin.credit_delta_minor > 0
          ${continuation}
        order by origin.occurred_at desc, origin.id desc
        limit ${criteria.limit + 1}
      `);
      const receivableMinor = BigInt(customer.receivableMinor);
      return {
        customer: {
          id: customer.id,
          name: customer.name,
          phone: customer.phone,
          status: customer.status,
          archivedAt: customer.archivedAt === null ? null : new Date(customer.archivedAt),
          outstandingMinor: receivableMinor > 0n ? receivableMinor : 0n,
        },
        receivables: result.rows.map((row) => this.mapReceivable(row)),
      };
    });
  }

  private async resolveSalePosition(
    transaction: DatabaseTransaction,
    storeId: string,
    anchor: { id: string; version: bigint },
  ): Promise<SaleReadPosition> {
    const result = await transaction.execute<SalePositionPhysicalRow>(sql`
      select id, sale_at as "occurredAt"
      from ledger.sales
      where store_id=${storeId}::uuid
        and id=${anchor.id}::uuid
        and version=${anchor.version}::bigint
        and status <> 'draft'
      limit 1
    `);
    const row = result.rows[0];
    if (!row) throw new SaleReadQueryError('cursor', 'saleCursorAnchor');
    return { id: row.id, occurredAt: new Date(row.occurredAt) };
  }

  private async resolveReceivablePosition(
    transaction: DatabaseTransaction,
    storeId: string,
    customerId: string,
    anchorId: string,
  ): Promise<CustomerReceivablePosition> {
    const result = await transaction.execute<ReceivablePositionPhysicalRow>(sql`
      select id, occurred_at as "occurredAt"
      from ledger.customer_ledger_entries
      where store_id=${storeId}::uuid
        and customer_id=${customerId}::uuid
        and id=${anchorId}::uuid
        and entry_type in ('sale_credit', 'opening_balance')
        and reversal_of_id is null
        and receivable_delta_minor - credit_delta_minor > 0
      limit 1
    `);
    const row = result.rows[0];
    if (!row) throw new SaleReadQueryError('cursor', 'customerReceivableCursorAnchor');
    return { id: row.id, occurredAt: new Date(row.occurredAt) };
  }

  private mapSaleSummary(row: SaleSummaryPhysicalRow): SaleSummaryRow {
    if (row.status === 'draft' || row.accountingPeriodId === null) {
      throw new Error('Operational Sale has an invalid status or Accounting Period.');
    }
    const customer = this.mapCustomer(row);
    const creditTotalMinor = BigInt(row.creditTotalMinor);
    const outstandingMinor = BigInt(row.receivableOutstandingMinor);
    if (outstandingMinor < 0n || outstandingMinor > creditTotalMinor) {
      throw new Error('Sale receivable outstanding amount is inconsistent.');
    }
    return {
      id: row.id,
      customer,
      accountingPeriodId: row.accountingPeriodId,
      displayNumber: row.displayNumber,
      occurredAt: new Date(row.occurredAt),
      totalMinor: BigInt(row.totalMinor),
      paidTotalMinor: BigInt(row.paidTotalMinor),
      creditTotalMinor,
      receivableOutstandingMinor: outstandingMinor,
      paymentStatus: row.paymentStatus,
      status: row.status,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
      version: BigInt(row.version),
    };
  }

  private mapCustomer(row: SaleSummaryPhysicalRow): SaleReadCustomerRow | null {
    if (row.customerId === null) {
      if (
        row.customerName !== null ||
        row.customerPhone !== null ||
        row.customerStatus !== null ||
        row.customerArchivedAt !== null
      ) {
        throw new Error('Anonymous Sale has unexpected Customer data.');
      }
      return null;
    }
    if (row.customerName === null || row.customerPhone === null || row.customerStatus === null) {
      throw new Error('Customer Sale has incomplete Customer data.');
    }
    return {
      id: row.customerId,
      name: row.customerName,
      phone: row.customerPhone,
      status: row.customerStatus,
      archivedAt: row.customerArchivedAt === null ? null : new Date(row.customerArchivedAt),
    };
  }

  private mapSaleDetail(
    header: SaleDetailPhysicalRow,
    items: SaleItemPhysicalRow[],
    tenders: SaleTenderPhysicalRow[],
    receivables: CustomerReceivablePhysicalRow[],
  ): SaleDetailRow {
    const summary = this.mapSaleSummary(header);
    if (items.length === 0) throw new Error('Operational Sale has no items.');
    if (receivables.length > 1) throw new Error('Sale has multiple receivable origin facts.');
    const receivable = receivables[0] ? this.mapReceivable(receivables[0]) : null;
    if (summary.creditTotalMinor > 0n !== (receivable !== null)) {
      throw new Error('Sale receivable origin is inconsistent.');
    }
    return {
      ...summary,
      itemsSubtotalMinor: BigInt(header.itemsSubtotalMinor),
      lineDiscountTotalMinor: BigInt(header.lineDiscountTotalMinor),
      invoiceDiscountMinor: BigInt(header.invoiceDiscountMinor),
      roundingMinor: BigInt(header.roundingMinor),
      knownCostTotalMinor: BigInt(header.knownCostTotalMinor),
      pendingCostLineCount: header.pendingCostLineCount,
      unknownCostLineCount: header.unknownCostLineCount,
      notes: header.notes,
      correctionOfId: header.correctionOfId,
      reversedById: header.reversedById,
      cancelledAt: header.cancelledAt === null ? null : new Date(header.cancelledAt),
      items: items.map((item) => this.mapItem(item)),
      tenders: tenders.map((tender) => this.mapTender(tender)),
      receivable,
    };
  }

  private mapItem(row: SaleItemPhysicalRow): SaleItemReadRow {
    return {
      id: row.id,
      productId: row.productId,
      productUnitId: row.productUnitId,
      isManualLine: row.isManualLine,
      productNameSnapshot: row.productNameSnapshot,
      unitNameSnapshot: row.unitNameSnapshot,
      quantityMilli: BigInt(row.quantityMilli),
      conversionFactorNum: row.conversionFactorNum,
      conversionFactorDen: row.conversionFactorDen,
      baseQuantityMilli: row.baseQuantityMilli === null ? null : BigInt(row.baseQuantityMilli),
      unitPriceMinor: BigInt(row.unitPriceMinor),
      lineGrossMinor: BigInt(row.lineGrossMinor),
      lineDiscountMinor: BigInt(row.lineDiscountMinor),
      roundingMinor: BigInt(row.roundingMinor),
      lineTotalMinor: BigInt(row.lineTotalMinor),
      costStatus: row.costStatus,
      unitCostMinor: row.unitCostMinor === null ? null : BigInt(row.unitCostMinor),
      lineCostMinor: row.lineCostMinor === null ? null : BigInt(row.lineCostMinor),
      inventoryMovementId: row.inventoryMovementId,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
      version: BigInt(row.version),
    };
  }

  private mapTender(row: SaleTenderPhysicalRow): SaleTenderReadRow {
    if (
      row.moneyAccountName === null ||
      row.moneyAccountType === null ||
      row.moneyAccountStatus === null ||
      row.moneyMovementId === null
    ) {
      throw new Error('Sale tender has incomplete Money Account or movement data.');
    }
    return {
      id: row.id,
      moneyAccountId: row.moneyAccountId,
      moneyAccountName: row.moneyAccountName,
      moneyAccountType: row.moneyAccountType,
      moneyAccountStatus: row.moneyAccountStatus,
      amountMinor: BigInt(row.amountMinor),
      paymentAt: new Date(row.paymentAt),
      senderAccountName: row.senderAccountName,
      externalReference: row.externalReference,
      moneyMovementId: row.moneyMovementId,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
      version: BigInt(row.version),
    };
  }

  private mapReceivable(row: CustomerReceivablePhysicalRow): CustomerReceivableRow {
    const originalAmountMinor = BigInt(row.originalAmountMinor);
    const outstandingMinor = BigInt(row.outstandingMinor);
    if (
      originalAmountMinor <= 0n ||
      outstandingMinor < 0n ||
      outstandingMinor > originalAmountMinor
    ) {
      throw new Error('Customer Receivable amount is inconsistent.');
    }
    if (
      (row.entryType === 'sale_credit' &&
        (row.saleId === null || row.saleDisplayNumber === null)) ||
      (row.entryType === 'opening_balance' &&
        (row.saleId !== null || row.saleDisplayNumber !== null))
    ) {
      throw new Error('Customer Receivable source is inconsistent.');
    }
    return {
      id: row.id,
      customerId: row.customerId,
      accountingPeriodId: row.accountingPeriodId,
      entryType: row.entryType,
      originalAmountMinor,
      outstandingMinor,
      saleId: row.saleId,
      saleDisplayNumber: row.saleDisplayNumber,
      occurredAt: new Date(row.occurredAt),
      reason: row.reason,
      createdAt: new Date(row.createdAt),
    };
  }
}
