import type {
  SupplierInvoicePostingResponse,
  SupplierOpeningPayableResponse,
  SupplierPostingFailureCode,
} from './supplier-invoice-posting.types';

export interface SupplierPayableCorrectionEntry {
  id: string;
  entryType: 'correction';
  payableDeltaMinor: string;
  creditDeltaMinor: string;
  sourcePurchaseInvoiceId: string | null;
  transactionGroupId: string;
  occurredAt: string;
  reversalOfId: string;
  operationId: string;
  createdAt: string;
}

interface SupplierCorrectionResponseBase {
  operationId: string;
  targetOperationId: string;
  occurredAt: string;
  businessDate: string;
  postingDate: string;
  accountingPeriodId: string;
  reversal: SupplierPayableCorrectionEntry;
}

export interface SupplierInvoiceCorrectionResponse extends SupplierCorrectionResponseBase {
  family: 'invoice';
  intent: 'cancel' | 'edit';
  target: {
    invoiceId: string;
    supplierId: string;
    status: 'cancelled';
    cancelledAt: string;
    version: string;
  };
  replacement: SupplierInvoicePostingResponse | null;
}

export interface SupplierOpeningPayableCorrectionResponse extends SupplierCorrectionResponseBase {
  family: 'opening_payable';
  intent: 'cancel' | 'edit';
  target: {
    payableId: string;
    supplierId: string;
    amountMinor: string;
  };
  replacement: SupplierOpeningPayableResponse | null;
}

export type SupplierFinancialCorrectionResponse =
  SupplierInvoiceCorrectionResponse | SupplierOpeningPayableCorrectionResponse;

export type SupplierCorrectionFailureCode =
  | SupplierPostingFailureCode
  | 'SUPPLIER_CORRECTION_TARGET_INTEGRITY_CONFLICT'
  | 'SUPPLIER_CORRECTION_TARGET_HAS_ACTIVE_ALLOCATIONS'
  | 'SUPPLIER_CORRECTION_TARGET_NOT_ACTIVE'
  | 'SUPPLIER_CORRECTION_TARGET_NOT_FOUND';

export interface SupplierCorrectionFailure {
  code: SupplierCorrectionFailureCode;
  message: string;
  statusCode: 400 | 404 | 409;
}

export type SupplierFinancialCorrectionResult =
  | { ok: true; response: SupplierFinancialCorrectionResponse }
  | { ok: false; error: SupplierCorrectionFailure };
