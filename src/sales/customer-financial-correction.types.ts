import type { PostedMoneyMovement } from '../money-movements/money-movement.types';
import type { CustomerFinancialCorrectionFamily } from './customer-financial-correction-command';
import type {
  CustomerFinancialFailureCode,
  CustomerFinancialResponse,
} from './customer-credit.types';
import type {
  CustomerCollectionFailureCode,
  CustomerCollectionPostingResponse,
} from './customer-payment-posting.types';

export interface CustomerFinancialLedgerReversal {
  id: string;
  operationId: string;
  entryType: 'correction';
  receivableDeltaMinor: string;
  creditDeltaMinor: string;
  targetType: 'sale_receivable' | 'opening_receivable' | null;
  targetId: string | null;
  reversalOfId: string;
  reason: string;
  occurredAt: string;
  createdAt: string;
}

export interface CustomerFinancialMoneyReversal extends PostedMoneyMovement {
  movementType: 'correction';
  reversalOfId: string;
}

export interface CancelledCustomerPayment {
  id: string;
  status: 'cancelled';
  cancelledAt: string;
  version: string;
}

export interface CustomerFinancialCorrectionResponse {
  operationId: string;
  targetOperationId: string;
  customerId: string;
  family: CustomerFinancialCorrectionFamily;
  intent: 'cancel' | 'edit';
  reason: string;
  occurredAt: string;
  businessDate: string;
  postingDate: string;
  accountingPeriodId: string;
  transactionGroupId: string;
  activeOperationId: string | null;
  target: {
    operationId: string;
    transactionGroupId: string;
    payments: CancelledCustomerPayment[];
  };
  reversal: {
    ledgerEffects: CustomerFinancialLedgerReversal[];
    moneyMovements: CustomerFinancialMoneyReversal[];
  };
  replacement: CustomerCollectionPostingResponse | CustomerFinancialResponse | null;
}

export type CustomerFinancialCorrectionFailureCode =
  | CustomerCollectionFailureCode
  | CustomerFinancialFailureCode
  | 'CUSTOMER_FINANCIAL_CORRECTION_CREDIT_DEPENDENCY'
  | 'CUSTOMER_FINANCIAL_CORRECTION_CUSTOMER_MISMATCH'
  | 'CUSTOMER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT'
  | 'CUSTOMER_FINANCIAL_CORRECTION_TARGET_NOT_ACTIVE'
  | 'CUSTOMER_FINANCIAL_CORRECTION_TARGET_NOT_FOUND'
  | 'CUSTOMER_FINANCIAL_CORRECTION_TARGET_TYPE_MISMATCH';

export interface CustomerFinancialCorrectionFailure {
  code: CustomerFinancialCorrectionFailureCode;
  message: string;
  statusCode: 404 | 409;
}

export type CustomerFinancialCorrectionResult =
  | { ok: true; response: CustomerFinancialCorrectionResponse }
  | { ok: false; error: CustomerFinancialCorrectionFailure };
