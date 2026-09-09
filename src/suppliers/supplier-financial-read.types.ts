import type { PurchaseInvoiceStatus } from '../database/schema';

export interface SupplierInvoiceCursorAnchor {
  id: string;
  version: bigint;
}

export interface SupplierInvoiceListPosition {
  invoiceDateAt: Date;
  id: string;
}

export interface SupplierInvoiceListCriteria {
  anchor: SupplierInvoiceCursorAnchor | null;
  limit: number;
}

export interface SupplierFinancialSupplierRow {
  id: string;
  name: string;
  phone: string | null;
  status: 'active' | 'archived';
  archivedAt: Date | null;
  version: bigint;
}

export interface SupplierInvoiceListRow {
  id: string;
  invoiceNumber: string | null;
  displayNumber: string;
  invoiceDateAt: Date;
  postingDate: string | null;
  dueAt: Date | null;
  status: PurchaseInvoiceStatus;
  totalMinor: bigint;
  outstandingMinor: bigint;
  accountingPeriodId: string | null;
  updatedAt: Date;
  version: bigint;
}

export interface SupplierFinancialPageRow {
  supplier: SupplierFinancialSupplierRow;
  totalOutstandingMinor: bigint;
  invoices: SupplierInvoiceListRow[];
}

export interface SupplierInvoiceDetailRow extends SupplierInvoiceListRow {
  supplier: SupplierFinancialSupplierRow;
  notes: string | null;
  itemsSubtotalMinor: bigint;
  lineDiscountTotalMinor: bigint;
  invoiceDiscountMinor: bigint;
  roundingMinor: bigint;
  correctionOfId: string | null;
  cancelledAt: Date | null;
  createdAt: Date;
  items: SupplierInvoiceItemRow[];
}

export interface SupplierInvoiceItemRow {
  id: string;
  productId: string | null;
  productUnitId: string | null;
  productNameSnapshot: string;
  unitNameSnapshot: string;
  quantityMilli: bigint;
  conversionFactorNum: number;
  conversionFactorDen: number;
  baseQuantityMilli: bigint;
  unitCostMinor: bigint;
  lineGrossMinor: bigint;
  lineDiscountMinor: bigint;
  roundingMinor: bigint;
  lineTotalMinor: bigint;
  createdAt: Date;
  updatedAt: Date;
  version: bigint;
}

export interface SupplierFinancialSupplierResponse {
  id: string;
  name: string;
  phone: string | null;
  status: 'active' | 'archived';
  archivedAt: string | null;
  version: string;
}

export interface SupplierInvoiceSummaryResponse {
  id: string;
  invoiceNumber: string | null;
  displayNumber: string;
  invoiceDateAt: string;
  postingDate: string | null;
  dueAt: string | null;
  status: PurchaseInvoiceStatus;
  totalMinor: string;
  outstandingMinor: string;
  paidAmountMinor: null;
  accountingPeriodId: string | null;
  updatedAt: string;
  version: string;
}

export interface SupplierFinancialResponse {
  supplier: SupplierFinancialSupplierResponse;
  totalOutstandingMinor: string;
  invoices: SupplierInvoiceSummaryResponse[];
  nextCursor: string | null;
}

export interface SupplierInvoiceItemResponse {
  id: string;
  productId: string | null;
  productUnitId: string | null;
  productName: string;
  unitName: string;
  quantityMilli: string;
  conversionFactorNumerator: number;
  conversionFactorDenominator: number;
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

export interface SupplierInvoiceDetailResponse {
  supplier: SupplierFinancialSupplierResponse;
  invoice: SupplierInvoiceSummaryResponse & {
    notes: string | null;
    itemsSubtotalMinor: string;
    lineDiscountTotalMinor: string;
    invoiceDiscountMinor: string;
    roundingMinor: string;
    correctionOfId: string | null;
    cancelledAt: string | null;
    createdAt: string;
  };
  items: SupplierInvoiceItemResponse[];
}
