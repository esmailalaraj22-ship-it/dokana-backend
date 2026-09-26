import type { SaleItemCostStatus } from '../database/schema';

export const CUSTOMER_RETURN_WINDOW_HOURS = 48;
export const CUSTOMER_RETURN_WINDOW_MS = CUSTOMER_RETURN_WINDOW_HOURS * 60 * 60 * 1000;

export type SaleReturnDisposition = 'RESTOCK_SALEABLE' | 'DAMAGED_NO_RESTOCK';
export type SaleReturnResidualChoice = 'REFUND' | 'KEEP_AS_CUSTOMER_CREDIT';

export interface SaleReturnRequestedLine {
  saleItemId: string;
  quantityMilli: bigint;
  disposition: SaleReturnDisposition;
}

export interface SaleReturnResidualSettlement {
  choice: SaleReturnResidualChoice;
  moneyAccountId: string | null;
}

export interface SaleReturnCommand {
  operationId: string;
  saleId: string;
  occurredAt: Date;
  reason: string;
  lines: SaleReturnRequestedLine[];
  residualSettlement: SaleReturnResidualSettlement | null;
  requestHash: string;
}

export interface SaleReturnLineAuthority {
  saleItemId: string;
  productId: string | null;
  productUnitId: string | null;
  isManualLine: boolean;
  productNameSnapshot: string;
  unitNameSnapshot: string | null;
  originalQuantityMilli: bigint;
  previousReturnedQuantityMilli: bigint;
  historicalNetValueMinor: bigint;
  conversionFactorNum: number;
  conversionFactorDen: number;
  historicalBaseQuantityMilli: bigint | null;
  costStatus: SaleItemCostStatus;
  historicalLineCostMinor: bigint | null;
  wasInventoryTracked: boolean;
  currentProductStatus: 'active' | 'archived' | null;
  currentProductTracksInventory: boolean | null;
  currentUnitStatus: 'active' | 'archived' | null;
}

export interface SaleReturnCalculatedLine {
  saleItemId: string;
  productId: string | null;
  productUnitId: string | null;
  isManualLine: boolean;
  productNameSnapshot: string;
  unitNameSnapshot: string | null;
  disposition: SaleReturnDisposition;
  physicalCondition: 'saleable' | 'damaged';
  originalQuantityMilli: bigint;
  previousReturnedQuantityMilli: bigint;
  requestedQuantityMilli: bigint;
  cumulativeReturnedQuantityMilli: bigint;
  remainingQuantityMilli: bigint;
  historicalNetValueMinor: bigint;
  previousReturnedValueMinor: bigint;
  returnValueMinor: bigint;
  remainingReturnableValueMinor: bigint;
  historicalBaseQuantityMilli: bigint | null;
  returnBaseQuantityMilli: bigint | null;
  inventoryQuantityDeltaMilli: bigint;
  costStatus: SaleItemCostStatus;
  historicalLineCostMinor: bigint | null;
  returnHistoricalCostMinor: bigint | null;
  cogsReversalMinor: bigint | null;
  wasInventoryTracked: boolean;
  currentRestockEligible: boolean;
}

export interface SaleReturnSettlementPlan {
  receivableReductionMinor: bigint;
  originalCustomerCreditRestorationMinor: bigint;
  refundMinor: bigint;
  newCustomerCreditMinor: bigint;
  residualChoice: SaleReturnResidualChoice | null;
  refundMoneyAccountId: string | null;
}

export interface SaleReturnPlan {
  operationId: string;
  requestHash: string;
  saleId: string;
  saleDisplayNumber: string;
  saleAt: Date;
  acceptedAt: Date;
  customerId: string | null;
  customerStatus: 'active' | 'archived' | null;
  occurredAt: Date;
  reason: string;
  lines: SaleReturnCalculatedLine[];
  totalReturnValueMinor: bigint;
  currentSaleReceivableMinor: bigint;
  historicalCustomerCreditTenderMinor: bigint;
  previouslyRestoredOriginalCreditMinor: bigint;
  settlement: SaleReturnSettlementPlan;
  postingInput: {
    operationId: string;
    occurredAt: Date;
  };
}

export type SaleReturnAuthorityFailureCode =
  | 'SALE_RETURN_AMOUNT_INVALID'
  | 'SALE_RETURN_CUSTOMER_CREDIT_NOT_ALLOWED'
  | 'SALE_RETURN_CUSTOMER_RESTORE_REQUIRED'
  | 'SALE_RETURN_INTEGRITY_CONFLICT'
  | 'SALE_RETURN_LINE_NOT_FOUND'
  | 'SALE_RETURN_OPERATION_CONFLICT'
  | 'SALE_RETURN_QUANTITY_EXCEEDED'
  | 'SALE_RETURN_REFUND_ACCOUNT_UNAVAILABLE'
  | 'SALE_RETURN_RESTOCK_UNAVAILABLE'
  | 'SALE_RETURN_RESIDUAL_CHOICE_INVALID'
  | 'SALE_RETURN_RESIDUAL_CHOICE_REQUIRED'
  | 'SALE_RETURN_SALE_INACTIVE'
  | 'SALE_RETURN_SALE_NOT_FOUND'
  | 'SALE_RETURN_WINDOW_EXPIRED';

export class SaleReturnAuthorityError extends Error {
  constructor(readonly code: SaleReturnAuthorityFailureCode) {
    super(code);
  }
}
