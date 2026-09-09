import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import { purchaseInvoices } from '../database/schema';
import type { PurchaseInvoiceStatus } from '../database/schema';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { SupplierReadQueryError } from './supplier-read-query-error';
import type {
  SupplierFinancialPageRow,
  SupplierFinancialSupplierRow,
  SupplierInvoiceDetailRow,
  SupplierInvoiceListCriteria,
  SupplierInvoiceListPosition,
  SupplierInvoiceListRow,
} from './supplier-financial-read.types';

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
  outstandingMinor: string;
  accountingPeriodId: string | null;
  updatedAt: string;
  version: string;
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
          coalesce(o.outstanding_minor, 0)::text as "outstandingMinor",
          p.accounting_period_id as "accountingPeriodId",
          p.updated_at as "updatedAt",
          p.version::text as version,
          p.notes,
          p.items_subtotal_minor::text as "itemsSubtotalMinor",
          p.line_discount_total_minor::text as "lineDiscountTotalMinor",
          p.invoice_discount_minor::text as "invoiceDiscountMinor",
          p.rounding_minor::text as "roundingMinor",
          p.correction_of_id as "correctionOfId",
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
        coalesce(o.outstanding_minor, 0)::text as "outstandingMinor",
        p.accounting_period_id as "accountingPeriodId",
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
    return {
      id: row.id,
      invoiceNumber: row.invoiceNumber,
      displayNumber: row.displayNumber,
      invoiceDateAt: new Date(row.invoiceDateAt),
      postingDate: row.postingDate,
      dueAt: row.dueAt === null ? null : new Date(row.dueAt),
      status: row.status,
      totalMinor: BigInt(row.totalMinor),
      outstandingMinor: BigInt(row.outstandingMinor),
      accountingPeriodId: row.accountingPeriodId,
      updatedAt: new Date(row.updatedAt),
      version: BigInt(row.version),
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
