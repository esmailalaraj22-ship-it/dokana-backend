import type {
  MoneyAccountPhysicalType,
  MoneyAccountStatus,
} from '../money-accounts/money-account.types';
import type { SupplierPaymentSource, SupplierPaymentStatus } from '../database/schema';
import type {
  SupplierFinancialSupplierResponse,
  SupplierFinancialSupplierRow,
} from './supplier-financial-read.types';

export interface SupplierPaymentCursorAnchor {
  id: string;
  version: bigint;
}

export interface SupplierPaymentListPosition {
  id: string;
  paymentAt: Date;
}

export type SupplierPaymentTargetFilter =
  { type: 'purchase_invoice'; id: string } | { type: 'opening_payable'; id: string } | null;

export interface SupplierPaymentListCriteria {
  anchor: SupplierPaymentCursorAnchor | null;
  limit: number;
  target: SupplierPaymentTargetFilter;
}

export interface SupplierPaymentMoneyAccountRow {
  id: string;
  name: string;
  accountType: MoneyAccountPhysicalType;
  status: MoneyAccountStatus;
}

export interface SupplierPaymentListRow {
  id: string;
  supplierId: string;
  accountingPeriodId: string | null;
  operationId: string;
  amountMinor: bigint;
  allocatedTotalMinor: bigint;
  creditCreatedMinor: bigint;
  paymentSource: SupplierPaymentSource;
  moneyAccount: SupplierPaymentMoneyAccountRow | null;
  paymentAt: Date;
  externalReference: string | null;
  notes: string | null;
  status: Exclude<SupplierPaymentStatus, 'draft'>;
  cancelledAt: Date | null;
  allocationCount: number;
  targetAllocationMinor: bigint | null;
  createdAt: Date;
  updatedAt: Date;
  version: bigint;
}

export interface SupplierPaymentPageRow {
  supplier: SupplierFinancialSupplierRow;
  payments: SupplierPaymentListRow[];
}

export interface SupplierPaymentAllocationRow {
  id: string;
  targetType: 'purchase_invoice' | 'opening_payable';
  targetId: string;
  amountMinor: bigint;
  invoiceNumber: string | null;
  invoiceDisplayNumber: string | null;
  invoiceDateAt: Date | null;
  openingAmountMinor: bigint | null;
  openingOccurredAt: Date | null;
  createdAt: Date;
}

export interface SupplierPaymentDetailRow extends SupplierPaymentListRow {
  supplier: SupplierFinancialSupplierRow;
  allocations: SupplierPaymentAllocationRow[];
}

export type SupplierPaymentSourceResponse =
  | {
      type: 'MONEY_ACCOUNT';
      moneyAccount: {
        id: string;
        name: string;
        accountType: MoneyAccountPhysicalType;
        status: MoneyAccountStatus;
      };
    }
  | { type: 'OWNER'; moneyAccount: null };

export interface SupplierPaymentSummaryResponse {
  id: string;
  operationId: string;
  supplierId: string;
  accountingPeriodId: string | null;
  amountMinor: string;
  allocatedTotalMinor: string;
  creditCreatedMinor: string;
  occurredAt: string;
  externalReference: string | null;
  notes: string | null;
  status: Exclude<SupplierPaymentStatus, 'draft'>;
  cancelledAt: string | null;
  source: SupplierPaymentSourceResponse;
  allocationCount: number;
  targetAllocationMinor: string | null;
  createdAt: string;
  updatedAt: string;
  version: string;
}

export interface SupplierPaymentAllocationResponse {
  id: string;
  target:
    | {
        type: 'SUPPLIER_INVOICE';
        id: string;
        invoiceNumber: string | null;
        displayNumber: string;
        invoiceDateAt: string;
      }
    | {
        type: 'OPENING_PAYABLE';
        id: string;
        amountMinor: string;
        occurredAt: string;
      };
  amountMinor: string;
  createdAt: string;
}

export interface SupplierPaymentListResponse {
  supplier: SupplierFinancialSupplierResponse;
  payments: SupplierPaymentSummaryResponse[];
  nextCursor: string | null;
}

export interface SupplierPaymentDetailResponse {
  supplier: SupplierFinancialSupplierResponse;
  payment: SupplierPaymentSummaryResponse;
  allocations: SupplierPaymentAllocationResponse[];
}
