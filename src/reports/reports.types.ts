export interface ReportDateRange {
  fromDate: string;
  toDate: string;
  accountingPeriodId?: string;
}

export interface ReportPageInput extends ReportDateRange {
  limit: number;
  cursorId: string | null;
}

export interface ReportPageData<Item, Totals> {
  asOf: Date;
  items: Item[];
  hasMore: boolean;
  pageTotals: Totals;
  filteredTotals: Totals;
}

export interface ReportPageResponse<Item, Totals, Filters> {
  asOf: string;
  timezoneName: 'Asia/Hebron';
  dateAuthority: 'businessDate' | 'postingDate' | 'occurredAt' | 'currentState';
  filters: Filters;
  items: Item[];
  totals: {
    page: Totals;
    filtered: Totals;
  };
  pagination: {
    limit: number;
    nextCursor: string | null;
  };
}

export interface OperationalSummaryRow {
  period: string;
  salesMinor: string;
  immediateSaleCollectionsMinor: string;
  customerCollectionsMinor: string;
  customerReceivableAllocationsMinor: string;
  creditSalesMinor: string;
  expensesRecognizedMinor: string;
  expensePaymentsMinor: string;
  supplierInvoicesMinor: string;
  supplierPaymentsMinor: string;
  saleReturnsMinor: string;
  supplierReturnsMinor: string;
}

export type OperationalSummaryTotals = Omit<OperationalSummaryRow, 'period'>;

export interface OperationalSummaryResponse {
  asOf: string;
  timezoneName: 'Asia/Hebron';
  granularity: 'day' | 'month';
  dateAuthority: 'businessDate';
  filters: ReportDateRange;
  rows: OperationalSummaryRow[];
  totals: OperationalSummaryTotals;
}

export interface ProfitReportResponse {
  asOf: string;
  timezoneName: 'Asia/Hebron';
  dateAuthority: 'postingDate';
  filters: ReportDateRange;
  netSalesMinor: string;
  grossSalesMinor: string;
  saleReturnsMinor: string;
  knownCogsMinor: string;
  restoredReturnCostMinor: string;
  netKnownCogsMinor: string;
  expensesMinor: string;
  knownInventoryLossesMinor: string;
  profitMinor: string | null;
  profitCostComplete: boolean;
  unknownReturnCostMovementCount: number;
  unknownLossCostMovementCount: number;
  costCoverage: {
    knownLineCount: number;
    unknownLineCount: number;
    knownPercentage: string;
    complete: boolean;
  };
}

export interface SalesReportRow {
  id: string;
  displayNumber: string;
  customerId: string | null;
  customerName: string | null;
  status: 'posted' | 'cancelled' | 'corrected';
  paymentStatus: 'paid' | 'partial' | 'credit';
  totalMinor: string;
  paidTotalMinor: string;
  creditTotalMinor: string;
  returnedTotalMinor: string;
  knownCostTotalMinor: string;
  pendingCostLineCount: number;
  unknownCostLineCount: number;
  businessDate: string;
  postingDate: string;
  accountingPeriodId: string | null;
  occurredAt: string;
  correctionOfId: string | null;
  reversedById: string | null;
}

export interface SalesReportTotals {
  rowCount: number;
  postedTotalMinor: string;
  cancelledTotalMinor: string;
  correctedTotalMinor: string;
  paidTotalMinor: string;
  creditTotalMinor: string;
  returnedTotalMinor: string;
  netPostedSalesMinor: string;
}

export interface ExpenseReportRow {
  id: string;
  categoryId: string | null;
  categoryName: string | null;
  description: string;
  status: 'posted' | 'cancelled';
  paymentTiming: 'paid_now' | 'due_later';
  amountMinor: string;
  paidMinor: string;
  outstandingMinor: string;
  businessDate: string;
  postingDate: string;
  accountingPeriodId: string | null;
  occurredAt: string;
}

export interface ExpenseReportTotals {
  rowCount: number;
  recognizedMinor: string;
  cancelledMinor: string;
  paidMinor: string;
  outstandingMinor: string;
}

export interface MoneyMovementReportRow {
  id: string;
  moneyAccountId: string;
  moneyAccountName: string;
  movementType: string;
  amountDeltaMinor: string;
  referenceType: string;
  referenceId: string;
  transactionGroupId: string;
  reversalOfId: string | null;
  businessDate: string;
  postingDate: string;
  accountingPeriodId: string;
  occurredAt: string;
}

export interface MoneyMovementReportTotals {
  rowCount: number;
  inflowMinor: string;
  outflowMinor: string;
  netMinor: string;
}

export interface LiquidityReportRow {
  id: string;
  name: string;
  accountType: 'cash' | 'transfer';
  isDefault: boolean;
  balanceMinor: string;
}

export interface LiquidityReportTotals {
  rowCount: number;
  balanceMinor: string;
}

export interface CustomerReceivableReportRow {
  id: string;
  name: string;
  phone: string;
  status: 'active' | 'archived';
  receivableMinor: string;
  creditMinor: string;
  netDueMinor: string;
}

export interface CustomerReceivableReportTotals {
  rowCount: number;
  receivableMinor: string;
  creditMinor: string;
  netDueMinor: string;
}

export interface SupplierPayableReportRow {
  id: string;
  name: string;
  phone: string | null;
  status: 'active' | 'archived';
  payableMinor: string;
  creditMinor: string;
  netPayableMinor: string;
}

export interface SupplierPayableReportTotals {
  rowCount: number;
  payableMinor: string;
  creditMinor: string;
  netPayableMinor: string;
}

export interface InventoryStockReportRow {
  productId: string;
  productName: string;
  productStatus: 'active' | 'archived';
  quantityMilli: string;
  averageUnitCostMinor: string | null;
  inventoryValueMinor: string | null;
  costState: 'known' | 'unknown' | 'pending';
  hasPendingCost: boolean;
  version: string | null;
}

export interface InventoryStockReportTotals {
  rowCount: number;
  knownValueMinor: string;
  uncertainProductCount: number;
  totalValueMinor: string | null;
}

export interface InventoryMovementReportRow {
  id: string;
  productId: string;
  productName: string;
  movementType: string;
  quantityDeltaMilli: string;
  quantityAfterMilli: string;
  valueDeltaMinor: string | null;
  costStateBefore: 'known' | 'unknown' | 'pending';
  costStateAfter: 'known' | 'unknown' | 'pending';
  referenceType: string;
  referenceId: string;
  reversalOfId: string | null;
  businessDate: string;
  postingDate: string;
  accountingPeriodId: string;
  occurredAt: string;
}

export interface InventoryMovementReportTotals {
  rowCount: number;
  knownValueDeltaMinor: string;
  unknownCostMovementCount: number;
}

export interface ReturnCorrectionReportRow {
  id: string;
  sourceType: string;
  subtype: string;
  status: string | null;
  displayNumber: string | null;
  amountMinor: string | null;
  quantityDeltaMilli: string | null;
  reversalOfId: string | null;
  replacementId: string | null;
  businessDate: string;
  postingDate: string;
  accountingPeriodId: string | null;
  occurredAt: string;
}

export interface ReturnCorrectionReportTotals {
  rowCount: number;
  saleReturnCount: number;
  supplierReturnCount: number;
  correctionCount: number;
}

export interface OwnerLedgerReportRow {
  id: string;
  entryType: string;
  ownerLiabilityDeltaMinor: string;
  equityDeltaMinor: string;
  moneyAccountId: string | null;
  moneyAccountName: string | null;
  referenceType: string | null;
  referenceId: string | null;
  reversalOfId: string | null;
  businessDate: string;
  postingDate: string;
  accountingPeriodId: string;
  occurredAt: string;
}

export interface OwnerLedgerReportTotals {
  rowCount: number;
  ownerLiabilityDeltaMinor: string;
  equityDeltaMinor: string;
}

export interface OwnerLedgerReportExtra {
  currentPosition: {
    storeOwesOwnerMinor: string;
    ownerEquityMovementMinor: string;
  };
}
