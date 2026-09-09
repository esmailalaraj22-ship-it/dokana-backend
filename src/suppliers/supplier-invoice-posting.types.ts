export interface PostedSupplierPayableEntry {
  id: string;
  entryType: 'supplier_invoice' | 'opening_balance';
  payableDeltaMinor: string;
  creditDeltaMinor: string;
  sourcePurchaseInvoiceId: string | null;
  transactionGroupId: string;
  occurredAt: string;
  operationId: string;
  createdAt: string;
}

export interface PostedSupplierInvoiceItem {
  id: string;
  productId: string | null;
  productUnitId: string | null;
  description: string;
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
}

export interface SupplierInvoicePostingResponse {
  operationId: string;
  supplierId: string;
  businessDate: string;
  postingDate: string;
  accountingPeriodId: string;
  invoice: {
    id: string;
    invoiceNumber: string | null;
    displayNumber: string;
    occurredAt: string;
    dueAt: string | null;
    status: 'open';
    itemsSubtotalMinor: string;
    lineDiscountTotalMinor: string;
    invoiceDiscountMinor: string;
    roundingMinor: string;
    totalMinor: string;
    notes: string | null;
    version: string;
  };
  items: PostedSupplierInvoiceItem[];
  payable: PostedSupplierPayableEntry;
}

export interface SupplierOpeningPayableResponse {
  operationId: string;
  supplierId: string;
  businessDate: string;
  postingDate: string;
  accountingPeriodId: string;
  payable: PostedSupplierPayableEntry;
}

export type SupplierPostingResponse =
  SupplierInvoicePostingResponse | SupplierOpeningPayableResponse;

export type SupplierPostingFailureCode =
  | 'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT'
  | 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE'
  | 'OPENING_PAYABLE_ALREADY_EXISTS'
  | 'OPERATION_ID_CONFLICT'
  | 'OPERATION_IN_PROGRESS'
  | 'SUPPLIER_INVOICE_AMOUNT_INVALID'
  | 'SUPPLIER_INVOICE_PRODUCT_LINK_NOT_FOUND'
  | 'SUPPLIER_NOT_FOUND';

export interface SupplierPostingFailure {
  code: SupplierPostingFailureCode;
  message: string;
  statusCode: 400 | 404 | 409;
}

export type SupplierInvoicePostingResult =
  | { ok: true; response: SupplierInvoicePostingResponse }
  | { ok: false; error: SupplierPostingFailure };

export type SupplierOpeningPayableResult =
  | { ok: true; response: SupplierOpeningPayableResponse }
  | { ok: false; error: SupplierPostingFailure };
