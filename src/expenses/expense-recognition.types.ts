import type {
  ExpenseRecognitionCommand,
  ExpenseRecognitionMode,
} from './expense-recognition-command';
import type { PostedMoneyMovement } from '../money-movements/money-movement.types';
import type { PostedOwnerLedgerEntry } from '../owner-ledger/owner-ledger.types';

export interface PostedExpensePayment {
  id: string;
  amountMinor: string;
  paymentSource: 'money_account' | 'owner_pocket';
  moneyAccountId: string | null;
  moneyMovementId: string | null;
  ownerLedgerEntryId: string | null;
  paymentAt: string;
  status: 'posted';
  operationId: string;
  version: string;
}

export interface PostedExpense {
  id: string;
  categoryId: string | null;
  description: string;
  amountMinor: string;
  paidTotalMinor: string;
  outstandingMinor: string;
  expenseAt: string;
  dueAt: string | null;
  paymentTiming: 'paid_now' | 'due_later';
  status: 'posted';
  notes: string | null;
  version: string;
}

export interface ExpenseRecognitionResponse {
  operationId: string;
  mode: ExpenseRecognitionMode;
  businessDate: string;
  postingDate: string;
  accountingPeriodId: string;
  expense: PostedExpense;
  payment: PostedExpensePayment | null;
  moneyMovement: PostedMoneyMovement | null;
  ownerLedgerEntry: PostedOwnerLedgerEntry | null;
}

export type ExpenseRecognitionFailureCode =
  | 'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT'
  | 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE'
  | 'EXPENSE_CATEGORY_NOT_FOUND'
  | 'EXPENSE_CATEGORY_UNAVAILABLE'
  | 'EXPENSE_ID_CONFLICT'
  | 'MONEY_ACCOUNT_NOT_FOUND'
  | 'MONEY_ACCOUNT_UNAVAILABLE'
  | 'OPERATION_ID_CONFLICT'
  | 'OPERATION_IN_PROGRESS';

export interface ExpenseRecognitionFailure {
  code: ExpenseRecognitionFailureCode;
  message: string;
  statusCode: 404 | 409;
}

export type ExpenseRecognitionResult =
  | { ok: true; response: ExpenseRecognitionResponse }
  | { ok: false; error: ExpenseRecognitionFailure };

export type ExpenseRecognitionInsertCommand = ExpenseRecognitionCommand;
