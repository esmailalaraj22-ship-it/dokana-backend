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
  status: 'posted';
  notes: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  version: string;
}

export interface ExpensePaymentReadRow extends Record<string, unknown> {
  id: string;
  amountMinor: string;
  paymentSource: 'money_account' | 'owner_pocket';
  moneyAccountId: string | null;
  moneyMovementId: string | null;
  ownerLedgerEntryId: string | null;
  paymentAt: Date | string;
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
  status: 'posted';
  createdAt: string;
  updatedAt: string;
  version: string;
}

export interface ExpensePaymentReadItem {
  id: string;
  amountMinor: string;
  paymentSource: 'money_account' | 'owner_pocket';
  moneyAccountId: string | null;
  moneyMovementId: string | null;
  ownerLedgerEntryId: string | null;
  paymentAt: string;
  operationId: string;
  createdAt: string;
  version: string;
}

export interface ExpenseDetailResponse extends ExpenseReadItem {
  notes: string | null;
  payments: ExpensePaymentReadItem[];
}

export interface ExpenseListResponse {
  items: ExpenseReadItem[];
  nextCursor: string | null;
}
