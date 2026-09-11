import type { PostedMoneyMovement } from '../money-movements/money-movement.types';
import type { PostedOwnerLedgerEntry } from '../owner-ledger/owner-ledger.types';
import type {
  PostedSupplierPaymentPayableEntry,
  SupplierPaymentFailureCode,
  SupplierPaymentPostingResponse,
} from './supplier-payment-posting.types';

export interface SupplierPaymentPayableReversal extends PostedSupplierPaymentPayableEntry {
  entryType: 'correction';
  reversalOfId: string;
}

export interface SupplierPaymentMoneyReversal extends PostedMoneyMovement {
  reversalOfId: string;
}

export interface SupplierPaymentOwnerReversal extends PostedOwnerLedgerEntry {
  reversalOfId: string;
}

export interface SupplierPaymentCorrectionResponse {
  operationId: string;
  targetOperationId: string;
  intent: 'cancel' | 'edit';
  occurredAt: string;
  businessDate: string;
  postingDate: string;
  accountingPeriodId: string;
  target: {
    paymentId: string;
    supplierId: string;
    status: 'cancelled';
    cancelledAt: string;
    version: string;
  };
  reversal: {
    payable: SupplierPaymentPayableReversal;
    moneyMovement: SupplierPaymentMoneyReversal | null;
    ownerLedgerEntry: SupplierPaymentOwnerReversal | null;
  };
  replacement: SupplierPaymentPostingResponse | null;
}

export type SupplierPaymentCorrectionFailureCode =
  | SupplierPaymentFailureCode
  | 'SUPPLIER_PAYMENT_CORRECTION_TARGET_INTEGRITY_CONFLICT'
  | 'SUPPLIER_PAYMENT_CORRECTION_TARGET_NOT_ACTIVE'
  | 'SUPPLIER_PAYMENT_CORRECTION_TARGET_NOT_FOUND'
  | 'SUPPLIER_PAYMENT_CORRECTION_TARGET_SUPPLIER_MISMATCH';

export interface SupplierPaymentCorrectionFailure {
  code: SupplierPaymentCorrectionFailureCode;
  message: string;
  statusCode: 404 | 409;
}

export type SupplierPaymentCorrectionResult =
  | { ok: true; response: SupplierPaymentCorrectionResponse }
  | { ok: false; error: SupplierPaymentCorrectionFailure };
