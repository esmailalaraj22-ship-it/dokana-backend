import type { PostedMoneyMovement } from '../money-movements/money-movement.types';
import type { PostedOwnerLedgerEntry } from '../owner-ledger/owner-ledger.types';
import type { ExpensePaymentPostingResponse } from './expense-payment.types';
import type { ExpenseRecognitionResponse } from './expense-recognition.types';

export interface ExpenseMoneyReversal extends PostedMoneyMovement {
  movementType: 'correction';
  reversalOfId: string;
}

export interface ExpenseOwnerReversal extends PostedOwnerLedgerEntry {
  entryType: 'correction';
  reversalOfId: string;
}

export interface ExpenseRecognitionCorrectionResponse {
  operationId: string;
  targetOperationId: string;
  aggregate: 'expense';
  intent: 'cancel' | 'edit';
  reason: string;
  occurredAt: string;
  businessDate: string;
  postingDate: string;
  accountingPeriodId: string;
  target: {
    expenseId: string;
    status: 'cancelled';
    cancelledAt: string;
    version: string;
  };
  reversal: {
    originalAmountMinor: string;
    amountDeltaMinor: string;
    internalPaymentId: string | null;
    moneyMovement: ExpenseMoneyReversal | null;
    ownerLedgerEntry: ExpenseOwnerReversal | null;
  };
  replacement: ExpenseRecognitionResponse | null;
}

export interface ExpensePaymentCorrectionResponse {
  operationId: string;
  targetOperationId: string;
  aggregate: 'expense_payment';
  intent: 'cancel' | 'edit';
  reason: string;
  occurredAt: string;
  businessDate: string;
  postingDate: string;
  accountingPeriodId: string;
  target: {
    expenseId: string;
    paymentId: string;
    status: 'cancelled';
    cancelledAt: string;
    version: string;
  };
  reversal: {
    expenseRecognitionDeltaMinor: '0';
    moneyMovement: ExpenseMoneyReversal | null;
    ownerLedgerEntry: ExpenseOwnerReversal | null;
  };
  replacement: ExpensePaymentPostingResponse | null;
}

export type ExpenseCorrectionResponse =
  ExpenseRecognitionCorrectionResponse | ExpensePaymentCorrectionResponse;

export type ExpenseCorrectionFailureCode =
  | 'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT'
  | 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE'
  | 'EXPENSE_ALREADY_SETTLED'
  | 'EXPENSE_CATEGORY_NOT_FOUND'
  | 'EXPENSE_CATEGORY_UNAVAILABLE'
  | 'EXPENSE_CORRECTION_ACTIVE_PAYMENT_DEPENDENCY'
  | 'EXPENSE_CORRECTION_TARGET_INTEGRITY_CONFLICT'
  | 'EXPENSE_CORRECTION_TARGET_NOT_ACTIVE'
  | 'EXPENSE_CORRECTION_TARGET_NOT_FOUND'
  | 'EXPENSE_ID_CONFLICT'
  | 'EXPENSE_NOT_FOUND'
  | 'EXPENSE_NOT_SETTLEMENT_ELIGIBLE'
  | 'EXPENSE_OUTSTANDING_INTEGRITY_CONFLICT'
  | 'EXPENSE_PAYMENT_CORRECTION_TARGET_EXPENSE_MISMATCH'
  | 'EXPENSE_PAYMENT_EXCEEDS_OUTSTANDING'
  | 'MONEY_ACCOUNT_NOT_FOUND'
  | 'MONEY_ACCOUNT_UNAVAILABLE'
  | 'OPERATION_ID_CONFLICT'
  | 'OPERATION_IN_PROGRESS';

export interface ExpenseCorrectionFailure {
  code: ExpenseCorrectionFailureCode;
  message: string;
  statusCode: 404 | 409;
}

export type ExpenseCorrectionResult =
  | { ok: true; response: ExpenseCorrectionResponse }
  | { ok: false; error: ExpenseCorrectionFailure };
