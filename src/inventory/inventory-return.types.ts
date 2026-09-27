import type { AccountingPeriodPostingContext } from '../accounting-periods/accounting-period-posting-context.types';
import type { InventoryCostState } from '../database/schema';

export interface CustomerReturnRestockLine {
  saleItemId: string;
  returnItemId: string;
  productId: string;
  productUnitId: string;
  selectedQuantityMilli: bigint;
  expectedBaseQuantityMilli: bigint;
  factorNum: number;
  factorDen: number;
  historicalCostState: InventoryCostState;
  historicalCostMinor: bigint | null;
}

export interface CustomerReturnRestockInput {
  operationId: string;
  returnId: string;
  occurredAt: Date;
  reason: string;
  posting: AccountingPeriodPostingContext;
  lines: CustomerReturnRestockLine[];
}

export interface PostedCustomerReturnRestock {
  saleItemId: string;
  returnItemId: string;
  movementId: string;
  movementOperationId: string;
  productId: string;
  productUnitId: string;
  quantityDeltaMilli: string;
  valueDeltaMinor: string | null;
  costStatus: InventoryCostState;
}
