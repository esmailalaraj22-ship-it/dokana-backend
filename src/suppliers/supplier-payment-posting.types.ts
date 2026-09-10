import type {
  SupplierPaymentAllocationTargetType,
  SupplierPaymentSource,
} from './supplier-payment-posting-command';
import type { PostedMoneyMovement } from '../money-movements/money-movement.types';
import type { PostedOwnerLedgerEntry } from '../owner-ledger/owner-ledger.types';

export interface PostedSupplierPaymentAllocation {
  id: string;
  targetType: SupplierPaymentAllocationTargetType;
  targetId: string;
  amountMinor: string;
  createdAt: string;
}

export interface PostedSupplierPaymentPayableEntry {
  id: string;
  payableDeltaMinor: string;
  transactionGroupId: string;
  operationId: string;
  occurredAt: string;
  createdAt: string;
}

export interface SupplierPaymentPostingResponse {
  operationId: string;
  supplierId: string;
  businessDate: string;
  postingDate: string;
  accountingPeriodId: string;
  payment: {
    id: string;
    paymentSource: SupplierPaymentSource;
    moneyAccountId: string | null;
    amountMinor: string;
    allocatedTotalMinor: string;
    creditCreatedMinor: string;
    paymentAt: string;
    externalReference: string | null;
    notes: string | null;
    status: 'posted';
    moneyMovementId: string | null;
    ownerLedgerEntryId: string | null;
    version: string;
  };
  allocations: PostedSupplierPaymentAllocation[];
  payable: PostedSupplierPaymentPayableEntry;
  moneyMovement: PostedMoneyMovement | null;
  ownerLedgerEntry: PostedOwnerLedgerEntry | null;
}

export type SupplierPaymentFailureCode =
  | 'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT'
  | 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE'
  | 'MONEY_ACCOUNT_NOT_FOUND'
  | 'MONEY_ACCOUNT_UNAVAILABLE'
  | 'OPERATION_ID_CONFLICT'
  | 'OPERATION_IN_PROGRESS'
  | 'SUPPLIER_NOT_FOUND'
  | 'SUPPLIER_PAYMENT_ALLOCATION_EXCEEDS_OUTSTANDING'
  | 'SUPPLIER_PAYMENT_TARGET_INTEGRITY_CONFLICT'
  | 'SUPPLIER_PAYMENT_TARGET_NOT_ACTIVE'
  | 'SUPPLIER_PAYMENT_TARGET_NOT_FOUND'
  | 'SUPPLIER_PAYMENT_TARGET_SUPPLIER_MISMATCH';

export interface SupplierPaymentFailure {
  code: SupplierPaymentFailureCode;
  message: string;
  statusCode: 404 | 409;
}

export type SupplierPaymentPostingResult =
  | { ok: true; response: SupplierPaymentPostingResponse }
  | { ok: false; error: SupplierPaymentFailure };
