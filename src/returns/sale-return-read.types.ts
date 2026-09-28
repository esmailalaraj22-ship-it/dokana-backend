import type {
  InventoryCostState,
  ReturnStatus,
  SaleItemCostStatus,
  SaleStatus,
} from '../database/schema';
import type {
  MoneyAccountPhysicalType,
  MoneyAccountStatus,
} from '../money-accounts/money-account.types';
import type { SaleReturnPostingResponse } from './sale-return-posting.types';
import type { SaleReturnSettlementKind } from './sale-return-posting.types';
import type { SaleReturnDisposition } from './sale-return.types';

export interface SaleReturnReadCursorAnchor {
  id: string;
  version: bigint;
}

export interface SaleReturnReadPosition {
  returnAt: Date;
  id: string;
}

export interface SaleReturnListCriteria {
  anchor: SaleReturnReadCursorAnchor | null;
  limit: number;
  saleId: string | null;
}

export interface SaleReturnReadCustomerRow {
  id: string;
  name: string;
  phone: string;
  status: 'active' | 'archived';
  archivedAt: Date | null;
}

export interface SaleReturnSettlementSummaryRow {
  receivableReductionMinor: bigint;
  originalCustomerCreditRestorationMinor: bigint;
  newCustomerCreditMinor: bigint;
  refundMinor: bigint;
}

export interface SaleReturnDispositionSummaryRow {
  restockSaleableLineCount: number;
  damagedNoRestockLineCount: number;
  noInventoryEffectLineCount: number;
}

export interface SaleReturnCorrectionLineageRow {
  predecessorReturnId: string | null;
  successorReturnId: string | null;
  activeLeaf: boolean;
  correction: {
    type: 'CANCEL' | 'REPLACE';
    reason: string;
    correctedAt: Date;
    businessDate: string;
    postingDate: string;
    accountingPeriodId: string;
  } | null;
}

export interface SaleReturnSummaryRow {
  id: string;
  saleId: string;
  saleDisplayNumber: string;
  saleAt: Date;
  saleStatus: SaleStatus;
  saleCorrectionOfId: string | null;
  saleReversedById: string | null;
  customer: SaleReturnReadCustomerRow | null;
  accountingPeriodId: string;
  displayNumber: string;
  returnAt: Date;
  totalMinor: bigint;
  status: ReturnStatus;
  reason: string | null;
  cancelledAt: Date | null;
  operationId: string;
  createdAt: Date;
  updatedAt: Date;
  version: bigint;
  postingSnapshot: SaleReturnPostingResponse;
  settlementSummary: SaleReturnSettlementSummaryRow;
  dispositionSummary: SaleReturnDispositionSummaryRow;
  correctionLineage: SaleReturnCorrectionLineageRow;
}

export interface SaleReturnInventoryEffectRow {
  id: string;
  operationId: string;
  productId: string;
  productUnitId: string;
  movementType: 'customer_return_saleable';
  quantityDeltaMilli: bigint;
  valueDeltaMinor: bigint;
  costStatus: InventoryCostState;
  referenceType: 'sale_return';
  referenceId: string;
  transactionGroupId: string;
  occurredAt: Date;
  businessDate: string;
  postingDate: string;
}

export interface SaleReturnLineReadRow {
  id: string;
  saleItemId: string;
  productId: string | null;
  productUnitId: string | null;
  isManualLine: boolean;
  productNameSnapshot: string;
  unitNameSnapshot: string | null;
  productStatus: 'active' | 'archived' | null;
  productUnitStatus: 'active' | 'archived' | null;
  quantityMilli: bigint;
  baseQuantityMilli: bigint | null;
  lineRefundMinor: bigint;
  disposition: SaleReturnDisposition;
  costStatus: SaleItemCostStatus;
  historicalCostMinor: bigint | null;
  cogsReversalMinor: bigint | null;
  inventoryEffect: SaleReturnInventoryEffectRow | null;
}

export interface SaleReturnCustomerLedgerEffectRow {
  id: string;
  operationId: string;
  entryType: 'return' | 'credit_created';
  receivableDeltaMinor: bigint;
  creditDeltaMinor: bigint;
  sourceSaleId: string;
  referenceType: 'sale_return' | 'sale_return_original_credit_restoration';
  referenceId: string;
  transactionGroupId: string;
  occurredAt: Date;
}

export interface SaleReturnMoneyRefundEffectRow {
  id: string;
  operationId: string;
  amountDeltaMinor: bigint;
  movementType: 'customer_refund';
  referenceType: 'sale_return';
  referenceId: string;
  transactionGroupId: string;
  occurredAt: Date;
}

export interface SaleReturnMoneyAccountRow {
  id: string;
  name: string;
  accountType: MoneyAccountPhysicalType;
  status: MoneyAccountStatus;
}

export interface SaleReturnSettlementReadRow {
  id: string;
  kind: SaleReturnSettlementKind;
  amountMinor: bigint;
  customerLedgerEffect: SaleReturnCustomerLedgerEffectRow | null;
  moneyAccount: SaleReturnMoneyAccountRow | null;
  moneyRefundEffect: SaleReturnMoneyRefundEffectRow | null;
}

export interface SaleReturnDetailRow extends SaleReturnSummaryRow {
  lines: SaleReturnLineReadRow[];
  settlements: SaleReturnSettlementReadRow[];
}

export interface SaleReturnEligibilityLineRow {
  saleItemId: string;
  productId: string | null;
  productUnitId: string | null;
  isManualLine: boolean;
  productNameSnapshot: string;
  unitNameSnapshot: string | null;
  originalQuantityMilli: bigint;
  returnedQuantityMilli: bigint;
  remainingQuantityMilli: bigint;
  historicalNetValueMinor: bigint;
  returnedHistoricalValueMinor: bigint;
  remainingHistoricalValueMinor: bigint;
  wasInventoryTracked: boolean;
  currentRestockSaleableAllowed: boolean;
}

export interface SaleReturnEligibilityRow {
  saleId: string;
  saleDisplayNumber: string;
  saleAt: Date;
  saleStatus: SaleStatus;
  saleReversedById: string | null;
  customer: SaleReturnReadCustomerRow | null;
  acceptedAt: Date;
  lines: SaleReturnEligibilityLineRow[];
}

export interface SaleReturnCustomerResponse {
  id: string;
  name: string;
  phone: string;
  status: 'active' | 'archived';
  archivedAt: string | null;
}

export interface SaleReturnSettlementSummaryResponse {
  receivableReductionMinor: string;
  restoredHistoricalCustomerCreditMinor: string;
  newCustomerCreditMinor: string;
  moneyRefundMinor: string;
}

export interface SaleReturnSummaryResponse {
  id: string;
  displayNumber: string;
  originalSale: { id: string; displayNumber: string };
  customer: SaleReturnCustomerResponse | null;
  isAnonymous: boolean;
  occurredAt: string;
  businessDate: string;
  postingDate: string;
  accountingPeriodId: string;
  totalMinor: string;
  reason: string | null;
  lifecycle: {
    status: ReturnStatus;
    effective: boolean;
    activeLeaf: boolean;
    cancelledAt: string | null;
    version: string;
    correction: {
      type: 'CANCEL' | 'REPLACE';
      reason: string;
      correctedAt: string;
      businessDate: string;
      postingDate: string;
      accountingPeriodId: string;
    } | null;
  };
  lineage: {
    predecessorReturnId: string | null;
    successorReturnId: string | null;
  };
  settlementSummary: SaleReturnSettlementSummaryResponse;
  dispositionSummary: SaleReturnDispositionSummaryRow;
  createdAt: string;
  updatedAt: string;
}

export interface SaleReturnListResponse {
  items: SaleReturnSummaryResponse[];
  nextCursor: string | null;
}

export interface SaleReturnLineReadResponse {
  id: string;
  originalSaleLineId: string;
  productId: string | null;
  productUnitId: string | null;
  isManualLine: boolean;
  historicalProductName: string;
  historicalUnitName: string | null;
  currentProductStatus: 'active' | 'archived' | null;
  currentProductUnitStatus: 'active' | 'archived' | null;
  quantityMilli: string;
  baseQuantityMilli: string | null;
  historicalReturnValueMinor: string;
  disposition: SaleReturnDisposition;
  inventoryQuantityEffectMilli: string;
  inventoryMovement: {
    id: string;
    operationId: string;
    valueDeltaMinor: string;
    costStatus: InventoryCostState;
    occurredAt: string;
    businessDate: string;
    postingDate: string;
  } | null;
  historicalCost: {
    state: SaleItemCostStatus;
    returnedCostMinor: string | null;
    cogsReversalMinor: string | null;
  };
}

export interface SaleReturnSettlementEffectResponse {
  settlementId: string;
  amountMinor: string;
  customerLedgerEntryId: string;
  customerLedgerOperationId: string;
}

export interface SaleReturnRefundResponse {
  settlementId: string;
  amountMinor: string;
  moneyAccount: SaleReturnMoneyAccountRow;
  moneyMovement: {
    id: string;
    operationId: string;
    amountDeltaMinor: string;
    occurredAt: string;
  };
}

export interface SaleReturnDetailResponse {
  return: SaleReturnSummaryResponse;
  originalSale: {
    id: string;
    displayNumber: string;
    occurredAt: string;
    customer: SaleReturnCustomerResponse | null;
    isAnonymous: boolean;
    status: SaleStatus;
    correctionOfId: string | null;
    reversedById: string | null;
  };
  lines: SaleReturnLineReadResponse[];
  settlementTrace: {
    receivableReduction: SaleReturnSettlementEffectResponse | null;
    restoredHistoricalCustomerCredit: SaleReturnSettlementEffectResponse | null;
    newCustomerCredit: SaleReturnSettlementEffectResponse | null;
    moneyRefund: SaleReturnRefundResponse | null;
    reconciliation: {
      returnTotalMinor: string;
      settlementTotalMinor: string;
      reconciled: true;
    };
  };
  lineage: {
    operationId: string;
    transactionGroupId: string;
    predecessorReturnId: string | null;
    successorReturnId: string | null;
    activeLeaf: boolean;
  };
}

export interface SaleReturnEligibilityResponse {
  sale: {
    id: string;
    displayNumber: string;
    occurredAt: string;
    customer: SaleReturnCustomerResponse | null;
    isAnonymous: boolean;
    activeLeaf: boolean;
  };
  returnableUntil: string;
  returnWindowOpen: boolean;
  currentlyReturnable: boolean;
  totalRemainingReturnableValueMinor: string;
  lines: {
    saleItemId: string;
    productId: string | null;
    productUnitId: string | null;
    isManualLine: boolean;
    historicalProductName: string;
    historicalUnitName: string | null;
    originalQuantityMilli: string;
    returnedQuantityMilli: string;
    remainingQuantityMilli: string;
    historicalNetValueMinor: string;
    returnedHistoricalValueMinor: string;
    remainingHistoricalValueMinor: string;
    wasInventoryTracked: boolean;
    currentRestockSaleableAllowed: boolean;
  }[];
}
