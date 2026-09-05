import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { products, productUnits } from '../database/schema';
import type {
  InventoryMovement,
  ManualInventoryEntry,
  StockBalance,
} from '../database/schema/inventory';
import type { InventoryCostResponse } from './inventory-math';

export type InventoryReadPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;
export type InventoryProduct = Pick<
  typeof products.$inferSelect,
  'id' | 'trackInventory' | 'measurementType'
>;
export type InventoryUnit = Pick<
  typeof productUnits.$inferSelect,
  | 'id'
  | 'unitName'
  | 'unitCode'
  | 'isBase'
  | 'factorNum'
  | 'factorDen'
  | 'status'
  | 'measurementType'
>;
export interface InventoryStockRecord {
  product: InventoryProduct;
  balance: StockBalance | null;
  units: InventoryUnit[];
}
export interface InventoryOperationRecord {
  entry: ManualInventoryEntry;
  movement: InventoryMovement;
}

export interface InventoryStockResponse {
  productId: string;
  trackingState: 'TRACKED' | 'NOT_TRACKED';
  projectionState: 'PRESENT' | 'MISSING' | 'NOT_TRACKED';
  baseUnit: InventoryUnit | null;
  units: InventoryUnit[];
  stock: {
    baseQuantityMilli: string;
    quantityState: 'POSITIVE' | 'ZERO' | 'NEGATIVE';
    version: string;
    lastMovementId: string | null;
    updatedAt: string;
    cost: InventoryCostResponse;
  } | null;
}

export interface InventoryOperationResponse {
  id: string;
  operationId: string;
  productId: string;
  productUnitId: string;
  selectedQuantityMilli: string;
  baseQuantityMilli: string;
  factorNum: number;
  factorDen: number;
  totalPurchaseCostMinor: string | null;
  costStatus: ManualInventoryEntry['costStatus'];
  occurredAt: string;
  businessDate: string;
  postingDate: string;
  accountingPeriodId: string;
  transactionGroupId: string;
  deviceId: string;
  reason: string | null;
  createdAt: string;
  movement: {
    id: string;
    operationId: string;
    movementType: InventoryMovement['movementType'];
    reversalOfId: string | null;
    quantityBeforeMilli: string;
    quantityDeltaMilli: string;
    quantityAfterMilli: string;
    costBefore: InventoryCostResponse;
    costAfter: InventoryCostResponse;
    valueDeltaMinor: string | null;
  };
}
