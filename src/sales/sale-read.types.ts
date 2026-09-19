import type { SaleItemCostStatus, SalePaymentStatus, SaleStatus } from '../database/schema';
import type {
  MoneyAccountPhysicalType,
  MoneyAccountStatus,
} from '../money-accounts/money-account.types';

export interface SaleReadCursorAnchor {
  id: string;
  version: bigint;
}

export interface SaleReadPosition {
  occurredAt: Date;
  id: string;
}

export interface SaleListCriteria {
  anchor: SaleReadCursorAnchor | null;
  limit: number;
}

export interface CustomerReceivableCursorAnchor {
  id: string;
}

export interface CustomerReceivablePosition {
  occurredAt: Date;
  id: string;
}

export interface CustomerReceivableListCriteria {
  anchor: CustomerReceivableCursorAnchor | null;
  limit: number;
}

export interface SaleReadCustomerRow {
  id: string;
  name: string;
  phone: string;
  status: 'active' | 'archived';
  archivedAt: Date | null;
}

export interface SaleSummaryRow {
  id: string;
  customer: SaleReadCustomerRow | null;
  accountingPeriodId: string;
  displayNumber: string;
  occurredAt: Date;
  totalMinor: bigint;
  moneyPaidTotalMinor: bigint;
  customerCreditUsedMinor: bigint;
  paidTotalMinor: bigint;
  creditTotalMinor: bigint;
  receivableOutstandingMinor: bigint;
  paymentStatus: SalePaymentStatus;
  status: Exclude<SaleStatus, 'draft'>;
  createdAt: Date;
  updatedAt: Date;
  version: bigint;
}

export interface SaleItemReadRow {
  id: string;
  productId: string | null;
  productUnitId: string | null;
  isManualLine: boolean;
  productNameSnapshot: string;
  unitNameSnapshot: string | null;
  quantityMilli: bigint;
  conversionFactorNum: number;
  conversionFactorDen: number;
  baseQuantityMilli: bigint | null;
  unitPriceMinor: bigint;
  lineGrossMinor: bigint;
  lineDiscountMinor: bigint;
  roundingMinor: bigint;
  lineTotalMinor: bigint;
  costStatus: SaleItemCostStatus;
  unitCostMinor: bigint | null;
  lineCostMinor: bigint | null;
  inventoryMovementId: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: bigint;
}

export interface SaleTenderReadRow {
  id: string;
  moneyAccountId: string;
  moneyAccountName: string;
  moneyAccountType: MoneyAccountPhysicalType;
  moneyAccountStatus: MoneyAccountStatus;
  amountMinor: bigint;
  paymentAt: Date;
  senderAccountName: string | null;
  externalReference: string | null;
  moneyMovementId: string;
  createdAt: Date;
  updatedAt: Date;
  version: bigint;
}

export interface SaleCustomerCreditTenderReadRow {
  id: string;
  customerId: string;
  amountMinor: bigint;
  customerLedgerEntryId: string;
  appliedAt: Date;
  createdAt: Date;
}

export interface CustomerReceivableRow {
  id: string;
  customerId: string;
  accountingPeriodId: string;
  entryType: 'sale_credit' | 'opening_balance';
  originalAmountMinor: bigint;
  outstandingMinor: bigint;
  saleId: string | null;
  saleDisplayNumber: string | null;
  occurredAt: Date;
  reason: string | null;
  createdAt: Date;
}

export interface CustomerReceivableCustomerRow extends SaleReadCustomerRow {
  outstandingMinor: bigint;
}

export interface SaleDetailRow extends SaleSummaryRow {
  itemsSubtotalMinor: bigint;
  lineDiscountTotalMinor: bigint;
  invoiceDiscountMinor: bigint;
  roundingMinor: bigint;
  knownCostTotalMinor: bigint;
  pendingCostLineCount: number;
  unknownCostLineCount: number;
  notes: string | null;
  correctionOfId: string | null;
  reversedById: string | null;
  cancelledAt: Date | null;
  items: SaleItemReadRow[];
  tenders: SaleTenderReadRow[];
  customerCreditTender: SaleCustomerCreditTenderReadRow | null;
  receivable: CustomerReceivableRow | null;
}

export interface SaleReadCustomerResponse {
  id: string;
  name: string;
  phone: string;
  status: 'active' | 'archived';
  archivedAt: string | null;
}

export interface SaleSummaryResponse {
  id: string;
  displayNumber: string;
  occurredAt: string;
  businessDate: string;
  postingDate: string;
  accountingPeriodId: string;
  customer: SaleReadCustomerResponse | null;
  isAnonymous: boolean;
  status: Exclude<SaleStatus, 'draft'>;
  paymentStatus: SalePaymentStatus;
  totalMinor: string;
  moneyPaidTotalMinor: string;
  customerCreditUsedMinor: string;
  paidTotalMinor: string;
  receivableOriginatedMinor: string;
  receivableOutstandingMinor: string;
  createdAt: string;
  updatedAt: string;
  version: string;
}

export interface SaleListResponse {
  items: SaleSummaryResponse[];
  nextCursor: string | null;
}

export interface SaleItemReadResponse {
  id: string;
  productId: string | null;
  productUnitId: string | null;
  isManualLine: boolean;
  productName: string;
  unitName: string | null;
  quantityMilli: string;
  conversionFactorNumerator: number;
  conversionFactorDenominator: number;
  baseQuantityMilli: string | null;
  unitPriceMinor: string;
  lineGrossMinor: string;
  lineDiscountMinor: string;
  roundingMinor: string;
  lineTotalMinor: string;
  costStatus: SaleItemCostStatus;
  unitCostMinor: string | null;
  lineCostMinor: string | null;
  inventoryMovementId: string | null;
  createdAt: string;
  updatedAt: string;
  version: string;
}

export interface SaleTenderReadResponse {
  id: string;
  moneyAccount: {
    id: string;
    name: string;
    accountType: MoneyAccountPhysicalType;
    status: MoneyAccountStatus;
  };
  amountMinor: string;
  paymentAt: string;
  senderAccountName: string | null;
  externalReference: string | null;
  moneyMovementId: string;
  createdAt: string;
  updatedAt: string;
  version: string;
}

export interface SaleCustomerCreditTenderReadResponse {
  id: string;
  customerId: string;
  amountMinor: string;
  customerLedgerEntryId: string;
  appliedAt: string;
  createdAt: string;
}

export interface CustomerReceivableResponse {
  id: string;
  customerId: string;
  accountingPeriodId: string;
  entryType: 'sale_credit' | 'opening_balance';
  originalAmountMinor: string;
  outstandingMinor: string;
  sale: { id: string; displayNumber: string } | null;
  occurredAt: string;
  businessDate: string;
  postingDate: string;
  reason: string | null;
  createdAt: string;
}

export interface SaleDetailResponse {
  sale: SaleSummaryResponse & {
    itemsSubtotalMinor: string;
    lineDiscountTotalMinor: string;
    invoiceDiscountMinor: string;
    roundingMinor: string;
    knownCostTotalMinor: string;
    pendingCostLineCount: number;
    unknownCostLineCount: number;
    notes: string | null;
    correctionOfId: string | null;
    reversedById: string | null;
    cancelledAt: string | null;
  };
  items: SaleItemReadResponse[];
  tenders: SaleTenderReadResponse[];
  customerCreditTender: SaleCustomerCreditTenderReadResponse | null;
  receivable: CustomerReceivableResponse | null;
}

export interface CustomerReceivableListResponse {
  customer: SaleReadCustomerResponse;
  outstandingMinor: string;
  receivables: CustomerReceivableResponse[];
  nextCursor: string | null;
}
