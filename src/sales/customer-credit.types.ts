import type { PostedMoneyMovement } from '../money-movements/money-movement.types';
import type { CustomerFinancialAction } from './customer-credit-command';
import type { CustomerReceivableTargetType } from './customer-payment-posting-command';

export interface CustomerFinancialLedgerEffect {
  id: string;
  operationId: string;
  entryType: 'credit_used' | 'refund' | 'settlement';
  receivableDeltaMinor: string;
  creditDeltaMinor: string;
  targetType: CustomerReceivableTargetType | null;
  targetId: string | null;
  reason: string | null;
  occurredAt: string;
  createdAt: string;
}

export interface CustomerFinancialResponse {
  operationId: string;
  action: CustomerFinancialAction;
  customerId: string;
  amountMinor: string;
  businessDate: string;
  postingDate: string;
  accountingPeriodId: string;
  transactionGroupId: string;
  ledgerEffects: CustomerFinancialLedgerEffect[];
  moneyMovement: PostedMoneyMovement | null;
}

export type CustomerFinancialFailureCode =
  | 'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT'
  | 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE'
  | 'CUSTOMER_COLLECTION_ALLOCATION_EXCEEDS_OUTSTANDING'
  | 'CUSTOMER_COLLECTION_EXCEEDS_OUTSTANDING'
  | 'CUSTOMER_COLLECTION_TARGET_CUSTOMER_MISMATCH'
  | 'CUSTOMER_COLLECTION_TARGET_INTEGRITY_CONFLICT'
  | 'CUSTOMER_COLLECTION_TARGET_NOT_ACTIVE'
  | 'CUSTOMER_COLLECTION_TARGET_NOT_FOUND'
  | 'CUSTOMER_CREDIT_INSUFFICIENT'
  | 'CUSTOMER_NOT_FOUND'
  | 'CUSTOMER_UNAVAILABLE'
  | 'MONEY_ACCOUNT_NOT_FOUND'
  | 'MONEY_ACCOUNT_UNAVAILABLE'
  | 'OPERATION_ID_CONFLICT'
  | 'OPERATION_IN_PROGRESS';

export interface CustomerFinancialFailure {
  code: CustomerFinancialFailureCode;
  message: string;
  statusCode: 404 | 409;
}

export type CustomerFinancialResult =
  | { ok: true; response: CustomerFinancialResponse }
  | { ok: false; error: CustomerFinancialFailure };

export interface CustomerCreditHistoryEntryResponse {
  id: string;
  operationId: string;
  entryType: 'credit_created' | 'credit_used' | 'refund' | 'settlement';
  receivableDeltaMinor: string;
  creditDeltaMinor: string;
  targetType: CustomerReceivableTargetType | null;
  targetId: string | null;
  moneyAccount: {
    id: string;
    name: string;
  } | null;
  reason: string | null;
  occurredAt: string;
  createdAt: string;
}

export interface CustomerCreditHistoryResponse {
  customerId: string;
  customerStatus: 'active' | 'archived';
  receivableOutstandingMinor: string;
  creditBalanceMinor: string;
  entries: CustomerCreditHistoryEntryResponse[];
  nextCursor: string | null;
}
