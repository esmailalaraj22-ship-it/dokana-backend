export const DASHBOARD_RECENT_ACTIVITY_LIMIT = 20;

export type DashboardInventoryValuationStatus = 'known' | 'partial' | 'unknown';

export type DashboardActivityType =
  | 'sale'
  | 'customer_collection'
  | 'supplier_invoice'
  | 'supplier_payment'
  | 'expense'
  | 'inventory_movement'
  | 'sale_return'
  | 'supplier_return';

export interface DashboardTodayMetrics {
  salesMinor: string;
  immediateSaleCollectionsMinor: string;
  customerCollectionsMinor: string;
  customerReceivableAllocationsMinor: string;
  totalCollectedMinor: string;
  creditSalesMinor: string;
  expensesRecognizedMinor: string;
  supplierPaymentsMinor: string;
}

export interface DashboardMoneyAccount {
  id: string;
  name: string;
  accountType: 'cash' | 'transfer';
  isDefault: boolean;
  balanceMinor: string;
}

export interface DashboardMoneyPosition {
  accounts: DashboardMoneyAccount[];
  totalMinor: string;
}

export interface DashboardObligations {
  customerReceivablesMinor: string;
  supplierPayablesMinor: string;
}

export interface DashboardInventoryIndicators {
  trackedProductCount: number;
  projectedProductCount: number;
  missingProjectionCount: number;
  positiveStockProductCount: number;
  zeroStockProductCount: number;
  negativeStockProductCount: number;
  knownCostProductCount: number;
  unknownCostProductCount: number;
  pendingCostProductCount: number;
  knownValueMinor: string;
  totalValueMinor: string | null;
  valuationStatus: DashboardInventoryValuationStatus;
}

export interface DashboardActivity {
  activityType: DashboardActivityType;
  resourceId: string;
  subtype: string | null;
  status: string | null;
  displayNumber: string | null;
  amountMinor: string | null;
  quantityDeltaMilli: string | null;
  businessDate: string;
  postingDate: string | null;
  accountingPeriodId: string | null;
  occurredAt: Date;
}

export interface DashboardSnapshot {
  asOf: Date;
  timezoneName: 'Asia/Hebron';
  businessDate: string;
  today: DashboardTodayMetrics;
  money: DashboardMoneyPosition;
  obligations: DashboardObligations;
  inventory: DashboardInventoryIndicators;
  recentActivity: DashboardActivity[];
}

export interface DashboardResponse extends Omit<DashboardSnapshot, 'asOf' | 'recentActivity'> {
  asOf: string;
  recentActivity: {
    limit: number;
    items: (Omit<DashboardActivity, 'occurredAt'> & { occurredAt: string })[];
  };
}
