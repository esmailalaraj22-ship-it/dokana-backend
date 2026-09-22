import type { PostedMoneyMovement } from '../money-movements/money-movement.types';
import type { PostedOwnerLedgerEntry } from '../owner-ledger/owner-ledger.types';
import type { ExpensePaymentSource } from './expense-payment-command';

export interface ExpensePaymentPostingResponse {
  operationId: string;
  expenseId: string;
  businessDate: string;
  postingDate: string;
  accountingPeriodId: string;
  payment: {
    id: string;
    amountMinor: string;
    paymentSource: ExpensePaymentSource;
    moneyAccountId: string | null;
    moneyMovementId: string | null;
    ownerLedgerEntryId: string | null;
    transactionGroupId: string;
    paymentAt: string;
    notes: string | null;
    status: 'posted';
    operationId: string;
    version: string;
  };
  settlement: {
    recognizedAmountMinor: string;
    settledBeforeMinor: string;
    settledAfterMinor: string;
    outstandingBeforeMinor: string;
    outstandingAfterMinor: string;
  };
  moneyMovement: PostedMoneyMovement | null;
  ownerLedgerEntry: PostedOwnerLedgerEntry | null;
}

export type ExpensePaymentFailureCode =
  | 'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT'
  | 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE'
  | 'EXPENSE_ALREADY_SETTLED'
  | 'EXPENSE_NOT_FOUND'
  | 'EXPENSE_NOT_SETTLEMENT_ELIGIBLE'
  | 'EXPENSE_OUTSTANDING_INTEGRITY_CONFLICT'
  | 'EXPENSE_PAYMENT_EXCEEDS_OUTSTANDING'
  | 'MONEY_ACCOUNT_NOT_FOUND'
  | 'MONEY_ACCOUNT_UNAVAILABLE'
  | 'OPERATION_ID_CONFLICT'
  | 'OPERATION_IN_PROGRESS';

export interface ExpensePaymentFailure {
  code: ExpensePaymentFailureCode;
  message: string;
  statusCode: 404 | 409;
}

export type ExpensePaymentPostingResult =
  | { ok: true; response: ExpensePaymentPostingResponse }
  | { ok: false; error: ExpensePaymentFailure };
