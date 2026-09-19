export type SaleCostStatus = 'known' | 'pending' | 'unknown';

export interface PostedSaleItem {
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
  costStatus: SaleCostStatus;
  unitCostMinor: string | null;
  lineCostMinor: string | null;
  inventoryMovementId: string | null;
}

export interface PostedSalePayment {
  id: string;
  moneyAccountId: string;
  amountMinor: string;
  senderAccountName: string | null;
  externalReference: string | null;
  moneyMovementId: string;
}

export interface PostedSaleCustomerCreditTender {
  id: string;
  customerId: string;
  amountMinor: string;
  customerLedgerEntryId: string;
  appliedAt: string;
  createdAt: string;
}

export interface PostedCustomerReceivable {
  id: string;
  customerId: string;
  entryType: 'sale_credit' | 'opening_balance';
  receivableDeltaMinor: string;
  creditDeltaMinor: string;
  sourceSaleId: string | null;
  transactionGroupId: string;
  occurredAt: string;
  operationId: string;
  createdAt: string;
}

export interface SalePostingResponse {
  operationId: string;
  businessDate: string;
  postingDate: string;
  accountingPeriodId: string;
  sale: {
    id: string;
    customerId: string | null;
    displayNumber: string;
    occurredAt: string;
    status: 'posted';
    paymentStatus: 'paid' | 'partial' | 'credit';
    itemsSubtotalMinor: string;
    lineDiscountTotalMinor: string;
    invoiceDiscountMinor: string;
    roundingMinor: string;
    totalMinor: string;
    paidTotalMinor: string;
    creditTotalMinor: string;
    knownCostTotalMinor: string;
    pendingCostLineCount: number;
    unknownCostLineCount: number;
    notes: string | null;
    version: string;
  };
  items: PostedSaleItem[];
  payments: PostedSalePayment[];
  customerCreditTender: PostedSaleCustomerCreditTender | null;
  receivable: PostedCustomerReceivable | null;
}

export interface CustomerOpeningReceivableResponse {
  operationId: string;
  customerId: string;
  businessDate: string;
  postingDate: string;
  accountingPeriodId: string;
  receivable: PostedCustomerReceivable;
}

export type SalePostingStoredResponse = SalePostingResponse | CustomerOpeningReceivableResponse;

export type SalePostingFailureCode =
  | 'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT'
  | 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE'
  | 'CUSTOMER_CREDIT_LIMIT_EXCEEDED'
  | 'CUSTOMER_CREDIT_INSUFFICIENT'
  | 'CUSTOMER_NOT_FOUND'
  | 'CUSTOMER_UNAVAILABLE'
  | 'MONEY_ACCOUNT_NOT_FOUND'
  | 'MONEY_ACCOUNT_UNAVAILABLE'
  | 'OPERATION_ID_CONFLICT'
  | 'OPERATION_IN_PROGRESS'
  | 'PRODUCT_NOT_FOUND'
  | 'PRODUCT_UNAVAILABLE'
  | 'PRODUCT_UNIT_NOT_FOUND'
  | 'PRODUCT_UNIT_UNAVAILABLE'
  | 'SALE_AMOUNT_INVALID'
  | 'SALE_NEGATIVE_STOCK_NOT_ALLOWED';

export interface SalePostingFailure {
  code: SalePostingFailureCode;
  message: string;
  statusCode: 400 | 404 | 409;
}

export type SalePostingResult =
  { ok: true; response: SalePostingResponse } | { ok: false; error: SalePostingFailure };

export type CustomerOpeningReceivableResult =
  | { ok: true; response: CustomerOpeningReceivableResponse }
  | { ok: false; error: SalePostingFailure };
