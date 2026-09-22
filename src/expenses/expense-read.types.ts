import type { ExpenseRecognitionMode } from './expense-recognition-command';
import type { ExpenseCursorAnchor } from './expense-read-cursor';

export interface ExpenseListCriteria {
  anchor: ExpenseCursorAnchor | null;
  limit: number;
}

export interface ExpenseReadRow extends Record<string, unknown> {
  id: string;
  categoryId: string | null;
  categoryName: string | null;
  categoryStatus: 'active' | 'archived' | null;
  accountingPeriodId: string;
  description: string;
  amountMinor: string;
  paidMinor: string;
  outstandingMinor: string;
  expenseAt: Date | string;
  dueAt: Date | string | null;
  paymentTiming: 'paid_now' | 'due_later';
  recognitionPaymentSource: 'money_account' | 'owner_pocket' | null;
  recognitionPaymentId: string | null;
  recognitionMoneyAccountId: string | null;
  recognitionMoneyMovementId: string | null;
  recognitionOwnerLedgerEntryId: string | null;
  status: 'posted' | 'cancelled';
  correctionOperationId: string | null;
  correctionType: 'cancel' | 'replace' | null;
  correctionReason: string | null;
  correctedAt: Date | string | null;
  replacementId: string | null;
  currentActiveId: string | null;
  notes: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  version: string;
}

export interface ExpensePaymentReadRow extends Record<string, unknown> {
  id: string;
  accountingPeriodId: string;
  amountMinor: string;
  paymentSource: 'money_account' | 'owner_pocket';
  moneyAccountId: string | null;
  moneyAccountName: string | null;
  moneyAccountStatus: 'active' | 'archived' | null;
  moneyMovementId: string | null;
  ownerLedgerEntryId: string | null;
  transactionGroupId: string | null;
  paymentAt: Date | string;
  notes: string | null;
  status: 'posted' | 'cancelled';
  correctionScope: 'expense_recognition' | 'later_payment';
  correctionOperationId: string | null;
  correctionType: 'cancel' | 'replace' | null;
  correctionReason: string | null;
  correctedAt: Date | string | null;
  replacementId: string | null;
  currentActiveId: string | null;
  operationId: string;
  createdAt: Date | string;
  version: string;
}

export interface ExpenseReadItem {
  id: string;
  category: {
    id: string;
    name: string;
    status: 'active' | 'archived';
  } | null;
  accountingPeriodId: string;
  description: string;
  amountMinor: string;
  paidMinor: string;
  outstandingMinor: string;
  expenseAt: string;
  dueAt: string | null;
  recognitionMode: ExpenseRecognitionMode;
  recognitionFunding: {
    paymentId: string;
    source: 'money_account' | 'owner_pocket';
    moneyAccountId: string | null;
    moneyMovementId: string | null;
    ownerLedgerEntryId: string | null;
  } | null;
  status: 'posted' | 'cancelled';
  correction: {
    operationId: string;
    type: 'cancel' | 'replace';
    reason: string;
    occurredAt: string;
    replacementId: string | null;
  } | null;
  currentActiveId: string | null;
  createdAt: string;
  updatedAt: string;
  version: string;
}

export interface ExpensePaymentReadItem {
  id: string;
  accountingPeriodId: string;
  amountMinor: string;
  paymentSource: 'money_account' | 'owner_pocket';
  moneyAccountId: string | null;
  moneyAccount: {
    id: string;
    name: string;
    status: 'active' | 'archived';
  } | null;
  moneyMovementId: string | null;
  ownerLedgerEntryId: string | null;
  transactionGroupId: string;
  paymentAt: string;
  notes: string | null;
  status: 'posted' | 'cancelled';
  correctionScope: 'expense_recognition' | 'later_payment';
  correction: {
    operationId: string;
    type: 'cancel' | 'replace';
    reason: string;
    occurredAt: string;
    replacementId: string | null;
  } | null;
  currentActiveId: string | null;
  operationId: string;
  createdAt: string;
  version: string;
}

export interface ExpenseDetailResponse extends ExpenseReadItem {
  notes: string | null;
  payments: ExpensePaymentReadItem[];
}

export interface ExpensePaymentHistoryResponse {
  expenseId: string;
  recognizedAmountMinor: string;
  settledMinor: string;
  outstandingMinor: string;
  items: ExpensePaymentReadItem[];
}

export interface ExpenseListResponse {
  items: ExpenseReadItem[];
  nextCursor: string | null;
}
