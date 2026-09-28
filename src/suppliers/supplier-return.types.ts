import type { PostedMoneyMovement } from '../money-movements/money-movement.types';

export type SupplierFinancialFamily =
  'supplier_return' | 'supplier_credit_application' | 'supplier_refund';

export interface SupplierFinancialPostingContextResponse {
  businessDate: string;
  postingDate: string;
  accountingPeriodId: string;
  occurredAt: string;
}

interface SupplierFinancialPostingResponseBase {
  family: SupplierFinancialFamily;
  operationId: string;
  transactionGroupId: string;
  supplierId: string;
  posting: SupplierFinancialPostingContextResponse;
}

export interface SupplierReturnPostingResponse extends SupplierFinancialPostingResponseBase {
  family: 'supplier_return';
  return: {
    id: string;
    purchaseInvoiceId: string;
    amountMinor: string;
    payableReductionMinor: string;
    supplierCreditCreatedMinor: string;
    reason: string;
    status: 'posted';
    version: string;
    createdAt: string;
  };
  effects: {
    payableLedgerEntryId: string | null;
    supplierCreditLedgerEntryId: string | null;
  };
  inventoryEffectMinor: '0';
}

export interface SupplierCreditApplicationResponse extends SupplierFinancialPostingResponseBase {
  family: 'supplier_credit_application';
  application: {
    id: string;
    purchaseInvoiceId: string;
    amountMinor: string;
    notes: string | null;
    supplierCreditBeforeMinor: string;
    supplierCreditAfterMinor: string;
    invoiceOutstandingBeforeMinor: string;
    invoiceOutstandingAfterMinor: string;
    createdAt: string;
  };
}

export interface SupplierRefundResponse extends SupplierFinancialPostingResponseBase {
  family: 'supplier_refund';
  refund: {
    id: string;
    moneyAccountId: string;
    amountMinor: string;
    notes: string | null;
    supplierCreditBeforeMinor: string;
    supplierCreditAfterMinor: string;
    moneyMovement: PostedMoneyMovement;
    createdAt: string;
  };
}

export type SupplierFinancialPostingResponse =
  SupplierReturnPostingResponse | SupplierCreditApplicationResponse | SupplierRefundResponse;

export interface SupplierFinancialCorrectionResponse {
  family: SupplierFinancialFamily;
  operationId: string;
  targetOperationId: string;
  transactionGroupId: string;
  intent: 'cancel' | 'replace';
  correctionReason: string;
  supplierId: string;
  posting: SupplierFinancialPostingContextResponse;
  target: {
    id: string;
    status: 'cancelled' | 'reversed';
  };
  reversal: {
    supplierLedgerEntryIds: string[];
    moneyMovement: PostedMoneyMovement | null;
  };
  replacement: SupplierFinancialPostingResponse | null;
}

export type SupplierFinancialMutationResponse =
  SupplierFinancialPostingResponse | SupplierFinancialCorrectionResponse;

export interface SupplierFinancialLineageResponse {
  predecessorId: string | null;
  successorId: string | null;
  active: boolean;
  correction: {
    intent: 'cancel' | 'replace';
    reason: string;
    correctedAt: string;
    accountingPeriodId: string;
  } | null;
}

export interface SupplierFinancialReturnReadResponse {
  supplier: {
    id: string;
    status: 'active' | 'archived';
  };
  balances: {
    payableMinor: string;
    supplierCreditAvailableMinor: string;
  };
  returns: {
    id: string;
    operationId: string;
    purchaseInvoiceId: string;
    amountMinor: string;
    payableReductionMinor: string;
    supplierCreditCreatedMinor: string;
    reason: string;
    status: 'posted' | 'cancelled';
    returnAt: string;
    postingDate: string;
    accountingPeriodId: string;
    inventoryEffectMinor: '0';
    lineage: SupplierFinancialLineageResponse;
  }[];
  creditApplications: {
    id: string;
    operationId: string;
    purchaseInvoiceId: string;
    amountMinor: string;
    occurredAt: string;
    accountingPeriodId: string;
    notes: string | null;
    lineage: SupplierFinancialLineageResponse;
  }[];
  refunds: {
    id: string;
    operationId: string;
    moneyAccountId: string;
    moneyMovementId: string;
    amountMinor: string;
    occurredAt: string;
    accountingPeriodId: string;
    notes: string | null;
    lineage: SupplierFinancialLineageResponse;
  }[];
}

export type SupplierFinancialFailureCode =
  | 'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT'
  | 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE'
  | 'MONEY_ACCOUNT_NOT_FOUND'
  | 'MONEY_ACCOUNT_UNAVAILABLE'
  | 'OPERATION_ID_CONFLICT'
  | 'OPERATION_IN_PROGRESS'
  | 'SUPPLIER_CREDIT_APPLICATION_EXCEEDS_OUTSTANDING'
  | 'SUPPLIER_CREDIT_INSUFFICIENT'
  | 'SUPPLIER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT'
  | 'SUPPLIER_FINANCIAL_CORRECTION_TARGET_NOT_ACTIVE'
  | 'SUPPLIER_FINANCIAL_CORRECTION_TARGET_NOT_FOUND'
  | 'SUPPLIER_FINANCIAL_STATE_INTEGRITY_CONFLICT'
  | 'SUPPLIER_INACTIVE'
  | 'SUPPLIER_INVOICE_NOT_ACTIVE'
  | 'SUPPLIER_INVOICE_NOT_FOUND'
  | 'SUPPLIER_INVOICE_SUPPLIER_MISMATCH'
  | 'SUPPLIER_NOT_FOUND'
  | 'SUPPLIER_RETURN_CREDIT_DEPENDENCY'
  | 'SUPPLIER_RETURN_EXCEEDS_CREDITABLE_VALUE';

export interface SupplierFinancialFailure {
  code: SupplierFinancialFailureCode;
  message: string;
  statusCode: 404 | 409;
}

export type SupplierFinancialMutationResult =
  | { ok: true; response: SupplierFinancialMutationResponse }
  | { ok: false; error: SupplierFinancialFailure };
