import type {
  CustomerCollectionAllocationMode,
  CustomerOverpaymentHandling,
  CustomerPaymentIntent,
  CustomerReceivableTargetType,
} from './customer-payment-posting-command';
import type { PostedMoneyMovement } from '../money-movements/money-movement.types';

export interface PostedCustomerCollectionPayment {
  id: string;
  operationId: string;
  moneyAccountId: string;
  amountMinor: string;
  allocatedTotalMinor: string;
  creditCreatedMinor: string;
  paymentAt: string;
  senderAccountName: string | null;
  externalReference: string | null;
  notes: string | null;
  status: 'posted';
  moneyMovementId: string;
  version: string;
}

export interface PostedCustomerCollectionAllocation {
  id: string;
  customerPaymentId: string;
  targetType: CustomerReceivableTargetType;
  targetId: string;
  amountMinor: string;
  customerLedgerEntryId: string;
  paymentEffectOperationId: string;
  createdAt: string;
}

export interface CustomerCollectionPostingResponse {
  operationId: string;
  collectionId: string;
  customerId: string;
  intent?: CustomerPaymentIntent;
  allocationMode: CustomerCollectionAllocationMode;
  overpaymentHandling?: CustomerOverpaymentHandling | null;
  amountMinor: string;
  excessMinor?: string;
  businessDate: string;
  postingDate: string;
  accountingPeriodId: string;
  payments: PostedCustomerCollectionPayment[];
  allocations: PostedCustomerCollectionAllocation[];
  moneyMovements: PostedMoneyMovement[];
  refundMovement?: PostedMoneyMovement | null;
}

export type CustomerCollectionFailureCode =
  | 'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT'
  | 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE'
  | 'CUSTOMER_COLLECTION_ALLOCATION_EXCEEDS_OUTSTANDING'
  | 'CUSTOMER_COLLECTION_EXCEEDS_OUTSTANDING'
  | 'CUSTOMER_COLLECTION_TARGET_CUSTOMER_MISMATCH'
  | 'CUSTOMER_COLLECTION_TARGET_INTEGRITY_CONFLICT'
  | 'CUSTOMER_COLLECTION_TARGET_NOT_ACTIVE'
  | 'CUSTOMER_COLLECTION_TARGET_NOT_FOUND'
  | 'CUSTOMER_OVERPAYMENT_CHOICE_REQUIRED'
  | 'CUSTOMER_OVERPAYMENT_NOT_PRESENT'
  | 'CUSTOMER_NOT_FOUND'
  | 'CUSTOMER_UNAVAILABLE'
  | 'MONEY_ACCOUNT_NOT_FOUND'
  | 'MONEY_ACCOUNT_UNAVAILABLE'
  | 'OPERATION_ID_CONFLICT'
  | 'OPERATION_IN_PROGRESS';

export interface CustomerCollectionFailure {
  code: CustomerCollectionFailureCode;
  message: string;
  statusCode: 404 | 409;
}

export type CustomerCollectionPostingResult =
  | { ok: true; response: CustomerCollectionPostingResponse }
  | { ok: false; error: CustomerCollectionFailure };
