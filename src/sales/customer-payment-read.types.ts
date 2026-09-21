import type { CustomerPaymentStatus } from '../database/schema';
import type {
  MoneyAccountPhysicalType,
  MoneyAccountStatus,
} from '../money-accounts/money-account.types';
import type { CustomerFinancialCorrectionLineageResponse } from './customer-financial-correction-read.types';
import type { CustomerFinancialCorrectionResponse } from './customer-financial-correction.types';

export interface CustomerPaymentCursorAnchor {
  id: string;
  version: bigint;
}

export interface CustomerPaymentListPosition {
  id: string;
  paymentAt: Date;
}

export interface CustomerPaymentListCriteria {
  anchor: CustomerPaymentCursorAnchor | null;
  limit: number;
}

export interface CustomerPaymentCustomerRow {
  id: string;
  name: string;
  phone: string;
  status: 'active' | 'archived';
  archivedAt: Date | null;
  outstandingMinor: bigint;
  creditBalanceMinor: bigint;
}

export interface CustomerPaymentListRow {
  id: string;
  customerId: string;
  accountingPeriodId: string;
  operationId: string;
  collectionId: string;
  amountMinor: bigint;
  allocatedTotalMinor: bigint;
  creditCreatedMinor: bigint;
  moneyAccount: {
    id: string;
    name: string;
    accountType: MoneyAccountPhysicalType;
    status: MoneyAccountStatus;
  };
  paymentAt: Date;
  senderAccountName: string | null;
  externalReference: string | null;
  notes: string | null;
  status: Exclude<CustomerPaymentStatus, 'draft'>;
  moneyMovementId: string;
  cancelledAt: Date | null;
  allocationCount: number;
  createdAt: Date;
  updatedAt: Date;
  version: bigint;
  lineage: CustomerFinancialCorrectionLineageResponse;
}

export interface CustomerPaymentAllocationRow {
  id: string;
  targetType: 'sale_receivable' | 'opening_receivable';
  targetId: string;
  amountMinor: bigint;
  saleDisplayNumber: string | null;
  openingAmountMinor: bigint | null;
  originOccurredAt: Date;
  customerLedgerEntryId: string;
  paymentEffectOperationId: string;
  paymentEffectReceivableDeltaMinor: bigint;
  createdAt: Date;
}

export interface CustomerPaymentDetailRow extends CustomerPaymentListRow {
  customer: CustomerPaymentCustomerRow;
  allocations: CustomerPaymentAllocationRow[];
  corrections: CustomerFinancialCorrectionResponse[];
}

export interface CustomerPaymentCustomerResponse {
  id: string;
  name: string;
  phone: string;
  status: 'active' | 'archived';
  archivedAt: string | null;
}

export interface CustomerPaymentSummaryResponse {
  id: string;
  operationId: string;
  collectionId: string;
  customerId: string;
  accountingPeriodId: string;
  amountMinor: string;
  allocatedTotalMinor: string;
  creditCreatedMinor: string;
  occurredAt: string;
  businessDate: string;
  postingDate: string;
  senderAccountName: string | null;
  externalReference: string | null;
  notes: string | null;
  status: Exclude<CustomerPaymentStatus, 'draft'>;
  cancelledAt: string | null;
  moneyAccount: {
    id: string;
    name: string;
    accountType: MoneyAccountPhysicalType;
    status: MoneyAccountStatus;
  };
  moneyMovementId: string;
  allocationCount: number;
  createdAt: string;
  updatedAt: string;
  version: string;
  lineage: CustomerFinancialCorrectionLineageResponse;
}

export interface CustomerPaymentAllocationResponse {
  id: string;
  target:
    | {
        type: 'SALE_RECEIVABLE';
        id: string;
        displayNumber: string;
        occurredAt: string;
      }
    | {
        type: 'OPENING_RECEIVABLE';
        id: string;
        originalAmountMinor: string;
        occurredAt: string;
      };
  amountMinor: string;
  paymentEffect: {
    id: string;
    operationId: string;
    receivableDeltaMinor: string;
  };
  createdAt: string;
}

export interface CustomerPaymentListResponse {
  customer: CustomerPaymentCustomerResponse;
  outstandingMinor: string;
  creditBalanceMinor: string;
  payments: CustomerPaymentSummaryResponse[];
  nextCursor: string | null;
}

export interface CustomerPaymentDetailResponse {
  customer: CustomerPaymentCustomerResponse;
  outstandingMinor: string;
  creditBalanceMinor: string;
  payment: CustomerPaymentSummaryResponse;
  allocations: CustomerPaymentAllocationResponse[];
  corrections: CustomerFinancialCorrectionResponse[];
}
