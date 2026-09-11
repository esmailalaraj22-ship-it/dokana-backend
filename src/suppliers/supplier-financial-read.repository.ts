import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import { purchaseInvoices } from '../database/schema';
import type { PurchaseInvoiceStatus } from '../database/schema';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { SupplierReadQueryError } from './supplier-read-query-error';
import { deriveSupplierSettlement } from './supplier-settlement';
import type {
  SupplierFinancialPageRow,
  SupplierFinancialSupplierRow,
  SupplierInvoiceDetailRow,
  SupplierInvoiceListCriteria,
  SupplierInvoiceListPosition,
  SupplierInvoiceListRow,
  SupplierOpeningPayableRow,
} from './supplier-financial-read.types';
import type {
  SupplierPaymentAllocationRow,
  SupplierPaymentDetailRow,
  SupplierPaymentListCriteria,
  SupplierPaymentListPosition,
  SupplierPaymentListRow,
  SupplierPaymentPageRow,
  SupplierPaymentTargetFilter,
} from './supplier-payment-read.types';

interface SupplierFinancialPhysicalRow extends Record<string, unknown> {
  id: string;
  name: string;
  phone: string | null;
  status: 'active' | 'archived';
  archivedAt: string | null;
  version: string;
  totalOutstandingMinor: string;
}

interface SupplierInvoicePhysicalRow extends Record<string, unknown> {
  id: string;
  invoiceNumber: string | null;
  displayNumber: string;
  invoiceDateAt: string;
  postingDate: string | null;
  dueAt: string | null;
  status: PurchaseInvoiceStatus;
  totalMinor: string;
  obligationMinor: string;
  activeAllocatedMinor: string;
  accountingPeriodId: string | null;
  correctionOfId: string | null;
  replacedById: string | null;
  replacedBySupplierId: string | null;
  updatedAt: string;
  version: string;
}

interface SupplierOpeningPayablePhysicalRow extends Record<string, unknown> {
  id: string;
  accountingPeriodId: string | null;
  amountMinor: string;
  activeAllocatedMinor: string;
  occurredAt: string;
  createdAt: string;
}

interface SupplierInvoiceDetailPhysicalRow extends SupplierInvoicePhysicalRow {
  supplierId: string;
  supplierName: string;
  supplierPhone: string | null;
  supplierStatus: 'active' | 'archived';
  supplierArchivedAt: string | null;
  supplierVersion: string;
  notes: string | null;
  itemsSubtotalMinor: string;
  lineDiscountTotalMinor: string;
  invoiceDiscountMinor: string;
  roundingMinor: string;
  correctionOfId: string | null;
  cancelledAt: string | null;
  createdAt: string;
}

interface SupplierInvoiceItemPhysicalRow extends Record<string, unknown> {
  id: string;
  productId: string | null;
  productUnitId: string | null;
  productNameSnapshot: string;
  unitNameSnapshot: string;
  quantityMilli: string;
  conversionFactorNum: number;
  conversionFactorDen: number;
  baseQuantityMilli: string;
  unitCostMinor: string;
  lineGrossMinor: string;
  lineDiscountMinor: string;
  roundingMinor: string;
  lineTotalMinor: string;
  createdAt: string;
  updatedAt: string;
  version: string;
}

interface SupplierPaymentAnchorPhysicalRow extends Record<string, unknown> {
  id: string;
  paymentAt: string;
}

interface SupplierPaymentPhysicalRow extends Record<string, unknown> {
  id: string;
  supplierId: string;
  accountingPeriodId: string;
  operationId: string;
  amountMinor: string;
  allocatedTotalMinor: string;
  creditCreatedMinor: string;
  paymentSource: 'money_account' | 'owner_pocket';
  moneyAccountId: string | null;
  moneyAccountName: string | null;
  moneyAccountType: 'cash' | 'transfer' | 'external_party' | null;
  moneyAccountStatus: 'active' | 'archived' | null;
  paymentAt: string;
  externalReference: string | null;
  notes: string | null;
  status: 'posted' | 'cancelled';
  cancelledAt: string | null;
  allocationCount: number;
  targetAllocationMinor: string | null;
  createdAt: string;
  updatedAt: string;
  version: string;
}

interface SupplierPaymentAllocationPhysicalRow extends Record<string, unknown> {
  id: string;
  purchaseInvoiceId: string | null;
  openingPayableId: string | null;
  amountMinor: string;
  invoiceNumber: string | null;
  invoiceDisplayNumber: string | null;
  invoiceDateAt: string | null;
  openingAmountMinor: string | null;
  openingOccurredAt: string | null;
  createdAt: string;
}

@Injectable()
export class SupplierFinancialReadRepository {
  constructor(private readonly database: DatabaseService) {}

  readSupplierFinancialPage(
    context: TenantTransactionContext,
    supplierId: string,
    criteria: SupplierInvoiceListCriteria,
  ): Promise<SupplierFinancialPageRow | undefined> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const supplier = await this.readSupplier(transaction, context.storeId, supplierId);
      if (!supplier) {
        return undefined;
      }

      let position: SupplierInvoiceListPosition | null = null;
      if (criteria.anchor) {
        const anchorRows = await transaction
          .select({
            id: purchaseInvoices.id,
            invoiceDateAt: purchaseInvoices.invoiceDateAt,
          })
          .from(purchaseInvoices)
          .where(
            and(
              eq(purchaseInvoices.storeId, context.storeId),
              eq(purchaseInvoices.supplierId, supplierId),
              eq(purchaseInvoices.id, criteria.anchor.id),
              eq(purchaseInvoices.version, criteria.anchor.version),
            ),
          )
          .limit(1)
          .for('share');
        const anchor = anchorRows[0];
        if (!anchor) {
          throw new SupplierReadQueryError('cursor', 'supplierInvoiceCursorAnchor');
        }
        position = anchor;
      }

      return {
        supplier: supplier.supplier,
        totalOutstandingMinor: supplier.totalOutstandingMinor,
        invoices: await this.readInvoices(
          transaction,
          context.storeId,
          supplierId,
          position,
          criteria.limit + 1,
        ),
        openingPayable: await this.readOpeningPayable(transaction, context.storeId, supplierId),
      };
    });
  }

  findSupplierInvoice(
    context: TenantTransactionContext,
    supplierId: string,
    invoiceId: string,
  ): Promise<SupplierInvoiceDetailRow | undefined> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const headerResult = await transaction.execute<SupplierInvoiceDetailPhysicalRow>(sql`
        select
          p.id,
          p.invoice_number as "invoiceNumber",
          p.display_number as "displayNumber",
          p.invoice_date_at as "invoiceDateAt",
          p.posting_date as "postingDate",
          p.due_at as "dueAt",
          p.status,
          p.total_minor::text as "totalMinor",
          coalesce(o.outstanding_minor, 0)::text as "obligationMinor",
          coalesce((
            select sum(allocation.amount_minor)
            from ledger.supplier_payment_allocations allocation
            inner join ledger.supplier_payments payment
              on payment.store_id=allocation.store_id
              and payment.id=allocation.supplier_payment_id
            where allocation.store_id=p.store_id
              and allocation.purchase_invoice_id=p.id
              and payment.status='posted'
          ), 0)::text as "activeAllocatedMinor",
          p.accounting_period_id as "accountingPeriodId",
          p.updated_at as "updatedAt",
          p.version::text as version,
          p.notes,
          p.items_subtotal_minor::text as "itemsSubtotalMinor",
          p.line_discount_total_minor::text as "lineDiscountTotalMinor",
          p.invoice_discount_minor::text as "invoiceDiscountMinor",
          p.rounding_minor::text as "roundingMinor",
          p.correction_of_id as "correctionOfId",
          (select child.id from ledger.purchase_invoices child
            where child.store_id=p.store_id and child.correction_of_id=p.id
            order by child.created_at asc, child.id asc limit 1) as "replacedById",
          (select child.supplier_id from ledger.purchase_invoices child
            where child.store_id=p.store_id and child.correction_of_id=p.id
            order by child.created_at asc, child.id asc limit 1) as "replacedBySupplierId",
          p.cancelled_at as "cancelledAt",
          p.created_at as "createdAt",
          s.id as "supplierId",
          s.name as "supplierName",
          s.phone as "supplierPhone",
          s.status as "supplierStatus",
          s.archived_at as "supplierArchivedAt",
          s.version::text as "supplierVersion"
        from ledger.purchase_invoices p
        inner join ledger.suppliers s
          on s.store_id = p.store_id and s.id = p.supplier_id
        left join ledger.v_supplier_invoice_outstanding o
          on o.store_id = p.store_id and o.purchase_invoice_id = p.id
        where p.store_id = ${context.storeId}::uuid
          and p.supplier_id = ${supplierId}::uuid
          and p.id = ${invoiceId}::uuid
        limit 1
      `);
      const header = headerResult.rows[0];
      if (!header) {
        return undefined;
      }

      const itemResult = await transaction.execute<SupplierInvoiceItemPhysicalRow>(sql`
        select
          i.id,
          i.product_id as "productId",
          i.product_unit_id as "productUnitId",
          i.product_name_snapshot as "productNameSnapshot",
          i.unit_name_snapshot as "unitNameSnapshot",
          i.quantity_milli::text as "quantityMilli",
          i.conversion_factor_num as "conversionFactorNum",
          i.conversion_factor_den as "conversionFactorDen",
          i.base_quantity_milli::text as "baseQuantityMilli",
          i.unit_cost_minor::text as "unitCostMinor",
          i.line_gross_minor::text as "lineGrossMinor",
          i.line_discount_minor::text as "lineDiscountMinor",
          i.rounding_minor::text as "roundingMinor",
          i.line_total_minor::text as "lineTotalMinor",
          i.created_at as "createdAt",
          i.updated_at as "updatedAt",
          i.version::text as version
        from ledger.purchase_items i
        where i.store_id = ${context.storeId}::uuid
          and i.purchase_invoice_id = ${invoiceId}::uuid
        order by i.created_at asc, i.id asc
      `);

      return this.mapDetail(header, itemResult.rows);
    });
  }

  readSupplierPaymentPage(
    context: TenantTransactionContext,
    supplierId: string,
    criteria: SupplierPaymentListCriteria,
  ): Promise<SupplierPaymentPageRow | undefined> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const supplier = await this.readSupplier(transaction, context.storeId, supplierId);
      if (!supplier) return undefined;

      let position: SupplierPaymentListPosition | null = null;
      if (criteria.anchor) {
        const targetPredicate = this.paymentTargetPredicate(criteria.target);
        const anchorResult = await transaction.execute<SupplierPaymentAnchorPhysicalRow>(sql`
          select p.id, p.payment_at as "paymentAt"
          from ledger.supplier_payments p
          where p.store_id=${context.storeId}::uuid
            and p.supplier_id=${supplierId}::uuid
            and p.id=${criteria.anchor.id}::uuid
            and p.version=${criteria.anchor.version}::bigint
            and p.status in ('posted', 'cancelled')
            ${targetPredicate}
          limit 1
          for share
        `);
        const anchor = anchorResult.rows[0];
        if (!anchor) {
          throw new SupplierReadQueryError('cursor', 'supplierPaymentCursorAnchor');
        }
        position = { id: anchor.id, paymentAt: new Date(anchor.paymentAt) };
      }

      return {
        supplier: supplier.supplier,
        payments: await this.readPayments(
          transaction,
          context.storeId,
          supplierId,
          position,
          criteria.target,
          criteria.limit + 1,
        ),
      };
    });
  }

  findSupplierPayment(
    context: TenantTransactionContext,
    supplierId: string,
    paymentId: string,
  ): Promise<SupplierPaymentDetailRow | undefined> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const supplier = await this.readSupplier(transaction, context.storeId, supplierId);
      if (!supplier) return undefined;

      const paymentResult = await transaction.execute<SupplierPaymentPhysicalRow>(sql`
        ${this.paymentSelect()}
        where p.store_id=${context.storeId}::uuid
          and p.supplier_id=${supplierId}::uuid
          and p.id=${paymentId}::uuid
          and p.status in ('posted', 'cancelled')
        limit 1
      `);
      const payment = paymentResult.rows[0];
      if (!payment) return undefined;

      const allocations = await transaction.execute<SupplierPaymentAllocationPhysicalRow>(sql`
        select
          allocation.id,
          allocation.purchase_invoice_id as "purchaseInvoiceId",
          allocation.opening_payable_ledger_entry_id as "openingPayableId",
          allocation.amount_minor::text as "amountMinor",
          invoice.invoice_number as "invoiceNumber",
          invoice.display_number as "invoiceDisplayNumber",
          invoice.invoice_date_at as "invoiceDateAt",
          opening.payable_delta_minor::text as "openingAmountMinor",
          opening.occurred_at as "openingOccurredAt",
          allocation.created_at as "createdAt"
        from ledger.supplier_payment_allocations allocation
        left join ledger.purchase_invoices invoice
          on invoice.store_id=allocation.store_id
          and invoice.id=allocation.purchase_invoice_id
        left join ledger.supplier_ledger_entries opening
          on opening.store_id=allocation.store_id
          and opening.id=allocation.opening_payable_ledger_entry_id
        where allocation.store_id=${context.storeId}::uuid
          and allocation.supplier_payment_id=${paymentId}::uuid
        order by allocation.created_at asc, allocation.id asc
      `);

      return {
        ...this.mapPayment(payment),
        supplier: supplier.supplier,
        allocations: allocations.rows.map((row) => this.mapPaymentAllocation(row)),
      };
    });
  }

  private async readSupplier(
    transaction: DatabaseTransaction,
    storeId: string,
    supplierId: string,
  ): Promise<
    { supplier: SupplierFinancialSupplierRow; totalOutstandingMinor: bigint } | undefined
  > {
    const result = await transaction.execute<SupplierFinancialPhysicalRow>(sql`
      select
        s.id,
        s.name,
        s.phone,
        s.status,
        s.archived_at as "archivedAt",
        s.version::text as version,
        coalesce(b.net_payable_minor, 0)::text as "totalOutstandingMinor"
      from ledger.suppliers s
      left join ledger.v_supplier_balances b
        on b.store_id = s.store_id and b.supplier_id = s.id
      where s.store_id = ${storeId}::uuid and s.id = ${supplierId}::uuid
      limit 1
    `);
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    return {
      supplier: {
        id: row.id,
        name: row.name,
        phone: row.phone,
        status: row.status,
        archivedAt: row.archivedAt === null ? null : new Date(row.archivedAt),
        version: BigInt(row.version),
      },
      totalOutstandingMinor: BigInt(row.totalOutstandingMinor),
    };
  }

  private async readPayments(
    transaction: DatabaseTransaction,
    storeId: string,
    supplierId: string,
    position: SupplierPaymentListPosition | null,
    target: SupplierPaymentTargetFilter,
    limit: number,
  ): Promise<SupplierPaymentListRow[]> {
    const continuation = position
      ? sql`and (
          p.payment_at < ${position.paymentAt}
          or (p.payment_at = ${position.paymentAt} and p.id < ${position.id}::uuid)
        )`
      : sql``;
    const targetPredicate = this.paymentTargetPredicate(target);
    const targetAllocation = this.paymentTargetAllocation(target);
    const result = await transaction.execute<SupplierPaymentPhysicalRow>(sql`
      ${this.paymentSelect(targetAllocation)}
      where p.store_id=${storeId}::uuid
        and p.supplier_id=${supplierId}::uuid
        and p.status in ('posted', 'cancelled')
        ${targetPredicate}
        ${continuation}
      order by p.payment_at desc, p.id desc
      limit ${limit}
    `);
    return result.rows.map((row) => this.mapPayment(row));
  }

  private paymentSelect(targetAllocation = sql`null`): ReturnType<typeof sql> {
    return sql`
      select
        p.id,
        p.supplier_id as "supplierId",
        p.accounting_period_id as "accountingPeriodId",
        p.operation_id as "operationId",
        p.amount_minor::text as "amountMinor",
        p.allocated_total_minor::text as "allocatedTotalMinor",
        p.credit_created_minor::text as "creditCreatedMinor",
        p.payment_source as "paymentSource",
        p.money_account_id as "moneyAccountId",
        account.name as "moneyAccountName",
        account.account_type as "moneyAccountType",
        account.status as "moneyAccountStatus",
        p.payment_at as "paymentAt",
        p.external_reference as "externalReference",
        p.notes,
        p.status,
        p.cancelled_at as "cancelledAt",
        (select count(*)::integer
          from ledger.supplier_payment_allocations allocation
          where allocation.store_id=p.store_id
            and allocation.supplier_payment_id=p.id) as "allocationCount",
        (${targetAllocation})::text as "targetAllocationMinor",
        p.created_at as "createdAt",
        p.updated_at as "updatedAt",
        p.version::text as version
      from ledger.supplier_payments p
      left join ledger.money_accounts account
        on account.store_id=p.store_id and account.id=p.money_account_id
    `;
  }

  private paymentTargetPredicate(target: SupplierPaymentTargetFilter): ReturnType<typeof sql> {
    if (target?.type === 'purchase_invoice') {
      return sql`and exists (
        select 1 from ledger.supplier_payment_allocations allocation
        where allocation.store_id=p.store_id
          and allocation.supplier_payment_id=p.id
          and allocation.purchase_invoice_id=${target.id}::uuid
      )`;
    }
    if (target?.type === 'opening_payable') {
      return sql`and exists (
        select 1 from ledger.supplier_payment_allocations allocation
        where allocation.store_id=p.store_id
          and allocation.supplier_payment_id=p.id
          and allocation.opening_payable_ledger_entry_id=${target.id}::uuid
      )`;
    }
    return sql``;
  }

  private paymentTargetAllocation(target: SupplierPaymentTargetFilter): ReturnType<typeof sql> {
    if (target?.type === 'purchase_invoice') {
      return sql`(
        select allocation.amount_minor
        from ledger.supplier_payment_allocations allocation
        where allocation.store_id=p.store_id
          and allocation.supplier_payment_id=p.id
          and allocation.purchase_invoice_id=${target.id}::uuid
        limit 1
      )`;
    }
    if (target?.type === 'opening_payable') {
      return sql`(
        select allocation.amount_minor
        from ledger.supplier_payment_allocations allocation
        where allocation.store_id=p.store_id
          and allocation.supplier_payment_id=p.id
          and allocation.opening_payable_ledger_entry_id=${target.id}::uuid
        limit 1
      )`;
    }
    return sql`null`;
  }

  private mapPayment(row: SupplierPaymentPhysicalRow): SupplierPaymentListRow {
    let moneyAccount: SupplierPaymentListRow['moneyAccount'] = null;
    if (row.paymentSource === 'money_account') {
      if (
        row.moneyAccountId === null ||
        row.moneyAccountName === null ||
        row.moneyAccountType === null ||
        row.moneyAccountStatus === null
      ) {
        throw new Error('Supplier Payment Money Account source is inconsistent.');
      }
      moneyAccount = {
        id: row.moneyAccountId,
        name: row.moneyAccountName,
        accountType: row.moneyAccountType,
        status: row.moneyAccountStatus,
      };
    } else if (row.moneyAccountId !== null) {
      throw new Error('Owner-funded Supplier Payment has an unexpected Money Account.');
    }

    return {
      id: row.id,
      supplierId: row.supplierId,
      accountingPeriodId: row.accountingPeriodId,
      operationId: row.operationId,
      amountMinor: BigInt(row.amountMinor),
      allocatedTotalMinor: BigInt(row.allocatedTotalMinor),
      creditCreatedMinor: BigInt(row.creditCreatedMinor),
      paymentSource: row.paymentSource,
      moneyAccount,
      paymentAt: new Date(row.paymentAt),
      externalReference: row.externalReference,
      notes: row.notes,
      status: row.status,
      cancelledAt: row.cancelledAt === null ? null : new Date(row.cancelledAt),
      allocationCount: row.allocationCount,
      targetAllocationMinor:
        row.targetAllocationMinor === null ? null : BigInt(row.targetAllocationMinor),
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
      version: BigInt(row.version),
    };
  }

  private mapPaymentAllocation(
    row: SupplierPaymentAllocationPhysicalRow,
  ): SupplierPaymentAllocationRow {
    if (
      row.purchaseInvoiceId !== null &&
      row.openingPayableId === null &&
      row.invoiceDisplayNumber !== null &&
      row.invoiceDateAt !== null &&
      row.openingAmountMinor === null &&
      row.openingOccurredAt === null
    ) {
      return {
        id: row.id,
        targetType: 'purchase_invoice',
        targetId: row.purchaseInvoiceId,
        amountMinor: BigInt(row.amountMinor),
        invoiceNumber: row.invoiceNumber,
        invoiceDisplayNumber: row.invoiceDisplayNumber,
        invoiceDateAt: new Date(row.invoiceDateAt),
        openingAmountMinor: null,
        openingOccurredAt: null,
        createdAt: new Date(row.createdAt),
      };
    }
    if (
      row.purchaseInvoiceId === null &&
      row.openingPayableId !== null &&
      row.invoiceNumber === null &&
      row.invoiceDisplayNumber === null &&
      row.invoiceDateAt === null &&
      row.openingAmountMinor !== null &&
      row.openingOccurredAt !== null
    ) {
      return {
        id: row.id,
        targetType: 'opening_payable',
        targetId: row.openingPayableId,
        amountMinor: BigInt(row.amountMinor),
        invoiceNumber: null,
        invoiceDisplayNumber: null,
        invoiceDateAt: null,
        openingAmountMinor: BigInt(row.openingAmountMinor),
        openingOccurredAt: new Date(row.openingOccurredAt),
        createdAt: new Date(row.createdAt),
      };
    }
    throw new Error('Supplier Payment allocation target is inconsistent.');
  }

  private async readInvoices(
    transaction: DatabaseTransaction,
    storeId: string,
    supplierId: string,
    position: SupplierInvoiceListPosition | null,
    limit: number,
  ): Promise<SupplierInvoiceListRow[]> {
    const continuation = position
      ? sql`and (
          p.invoice_date_at < ${position.invoiceDateAt}
          or (p.invoice_date_at = ${position.invoiceDateAt} and p.id < ${position.id}::uuid)
        )`
      : sql``;
    const result = await transaction.execute<SupplierInvoicePhysicalRow>(sql`
      select
        p.id,
        p.invoice_number as "invoiceNumber",
        p.display_number as "displayNumber",
        p.invoice_date_at as "invoiceDateAt",
        p.posting_date as "postingDate",
        p.due_at as "dueAt",
        p.status,
        p.total_minor::text as "totalMinor",
        coalesce(o.outstanding_minor, 0)::text as "obligationMinor",
        coalesce((
          select sum(allocation.amount_minor)
          from ledger.supplier_payment_allocations allocation
          inner join ledger.supplier_payments payment
            on payment.store_id=allocation.store_id
            and payment.id=allocation.supplier_payment_id
          where allocation.store_id=p.store_id
            and allocation.purchase_invoice_id=p.id
            and payment.status='posted'
        ), 0)::text as "activeAllocatedMinor",
        p.accounting_period_id as "accountingPeriodId",
        p.correction_of_id as "correctionOfId",
        (select child.id from ledger.purchase_invoices child
          where child.store_id=p.store_id and child.correction_of_id=p.id
          order by child.created_at asc, child.id asc limit 1) as "replacedById",
        (select child.supplier_id from ledger.purchase_invoices child
          where child.store_id=p.store_id and child.correction_of_id=p.id
          order by child.created_at asc, child.id asc limit 1) as "replacedBySupplierId",
        p.updated_at as "updatedAt",
        p.version::text as version
      from ledger.purchase_invoices p
      left join ledger.v_supplier_invoice_outstanding o
        on o.store_id = p.store_id and o.purchase_invoice_id = p.id
      where p.store_id = ${storeId}::uuid
        and p.supplier_id = ${supplierId}::uuid
        ${continuation}
      order by p.invoice_date_at desc, p.id desc
      limit ${limit}
    `);
    return result.rows.map((row) => this.mapInvoice(row));
  }

  private mapInvoice(row: SupplierInvoicePhysicalRow): SupplierInvoiceListRow {
    const settlement = deriveSupplierSettlement(
      BigInt(row.obligationMinor),
      BigInt(row.activeAllocatedMinor),
    );
    return {
      id: row.id,
      invoiceNumber: row.invoiceNumber,
      displayNumber: row.displayNumber,
      invoiceDateAt: new Date(row.invoiceDateAt),
      postingDate: row.postingDate,
      dueAt: row.dueAt === null ? null : new Date(row.dueAt),
      status: row.status,
      totalMinor: BigInt(row.totalMinor),
      paidAmountMinor: settlement.paidAmountMinor,
      outstandingMinor: settlement.outstandingMinor,
      settlementState: settlement.settlementState,
      accountingPeriodId: row.accountingPeriodId,
      correctionOfId: row.correctionOfId,
      replacedById: row.replacedById,
      replacedBySupplierId: row.replacedBySupplierId,
      updatedAt: new Date(row.updatedAt),
      version: BigInt(row.version),
    };
  }

  private async readOpeningPayable(
    transaction: DatabaseTransaction,
    storeId: string,
    supplierId: string,
  ): Promise<SupplierOpeningPayableRow | null> {
    const result = await transaction.execute<SupplierOpeningPayablePhysicalRow>(sql`
      select
        opening.id,
        opening.accounting_period_id as "accountingPeriodId",
        opening.payable_delta_minor::text as "amountMinor",
        coalesce((
          select sum(allocation.amount_minor)
          from ledger.supplier_payment_allocations allocation
          inner join ledger.supplier_payments payment
            on payment.store_id=allocation.store_id
            and payment.id=allocation.supplier_payment_id
          where allocation.store_id=opening.store_id
            and allocation.opening_payable_ledger_entry_id=opening.id
            and payment.status='posted'
        ), 0)::text as "activeAllocatedMinor",
        opening.occurred_at as "occurredAt",
        opening.created_at as "createdAt"
      from ledger.supplier_ledger_entries opening
      where opening.store_id=${storeId}::uuid
        and opening.supplier_id=${supplierId}::uuid
        and opening.entry_type='opening_balance'
        and opening.payable_delta_minor > 0
        and opening.credit_delta_minor=0
        and opening.source_purchase_invoice_id is null
        and opening.reversal_of_id is null
        and opening.reference_type='opening_balance'
        and opening.reference_id=opening.id
        and not exists (
          select 1 from ledger.supplier_ledger_entries reversal
          where reversal.store_id=opening.store_id
            and reversal.reversal_of_id=opening.id
        )
      order by opening.occurred_at desc, opening.id desc
      limit 2
    `);
    if (result.rows.length > 1) {
      throw new Error('Supplier has multiple active Opening Payables.');
    }
    const row = result.rows[0];
    if (!row) return null;
    const settlement = deriveSupplierSettlement(
      BigInt(row.amountMinor),
      BigInt(row.activeAllocatedMinor),
    );
    if (settlement.settlementState === null) {
      throw new Error('Active Opening Payable has no obligation amount.');
    }
    if (row.accountingPeriodId === null) {
      throw new Error('Active Opening Payable has no Accounting Period.');
    }
    return {
      id: row.id,
      accountingPeriodId: row.accountingPeriodId,
      amountMinor: BigInt(row.amountMinor),
      paidAmountMinor: settlement.paidAmountMinor,
      outstandingMinor: settlement.outstandingMinor,
      settlementState: settlement.settlementState,
      occurredAt: new Date(row.occurredAt),
      createdAt: new Date(row.createdAt),
    };
  }

  private mapDetail(
    row: SupplierInvoiceDetailPhysicalRow,
    items: SupplierInvoiceItemPhysicalRow[],
  ): SupplierInvoiceDetailRow {
    return {
      ...this.mapInvoice(row),
      supplier: {
        id: row.supplierId,
        name: row.supplierName,
        phone: row.supplierPhone,
        status: row.supplierStatus,
        archivedAt: row.supplierArchivedAt === null ? null : new Date(row.supplierArchivedAt),
        version: BigInt(row.supplierVersion),
      },
      notes: row.notes,
      itemsSubtotalMinor: BigInt(row.itemsSubtotalMinor),
      lineDiscountTotalMinor: BigInt(row.lineDiscountTotalMinor),
      invoiceDiscountMinor: BigInt(row.invoiceDiscountMinor),
      roundingMinor: BigInt(row.roundingMinor),
      correctionOfId: row.correctionOfId,
      cancelledAt: row.cancelledAt === null ? null : new Date(row.cancelledAt),
      createdAt: new Date(row.createdAt),
      items: items.map((item) => ({
        id: item.id,
        productId: item.productId,
        productUnitId: item.productUnitId,
        productNameSnapshot: item.productNameSnapshot,
        unitNameSnapshot: item.unitNameSnapshot,
        quantityMilli: BigInt(item.quantityMilli),
        conversionFactorNum: item.conversionFactorNum,
        conversionFactorDen: item.conversionFactorDen,
        baseQuantityMilli: BigInt(item.baseQuantityMilli),
        unitCostMinor: BigInt(item.unitCostMinor),
        lineGrossMinor: BigInt(item.lineGrossMinor),
        lineDiscountMinor: BigInt(item.lineDiscountMinor),
        roundingMinor: BigInt(item.roundingMinor),
        lineTotalMinor: BigInt(item.lineTotalMinor),
        createdAt: new Date(item.createdAt),
        updatedAt: new Date(item.updatedAt),
        version: BigInt(item.version),
      })),
    };
  }
}
