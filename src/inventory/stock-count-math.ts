import type { InventoryCostState } from '../database/schema/inventory';
import { INVENTORY_INT8_MAX, inventoryUnitCost, roundInventoryMoneyHalfUp } from './inventory-math';

const INVENTORY_INT8_MIN = -INVENTORY_INT8_MAX - 1n;

export interface StockCountValuation {
  quantityMilli: bigint;
  inventoryValueMinor: bigint;
  costState: InventoryCostState;
}

export interface StockCountEffect {
  quantityAfterMilli: bigint;
  quantityDeltaMilli: bigint;
  inventoryValueAfterMinor: bigint;
  averageUnitCostAfterMinor: bigint;
  valueDeltaMinor: bigint;
  costStateBefore: InventoryCostState;
  costStateAfter: InventoryCostState;
  costStatus: InventoryCostState;
  hasPendingCostAfter: boolean;
}

export function stockCountEffect(
  before: StockCountValuation | null,
  actualQuantityMilli: bigint,
): StockCountEffect {
  if (
    typeof actualQuantityMilli !== 'bigint' ||
    actualQuantityMilli < 0n ||
    actualQuantityMilli > INVENTORY_INT8_MAX
  ) {
    throw new RangeError('Counted inventory quantity is outside PostgreSQL int8.');
  }
  if (!before) {
    return {
      quantityAfterMilli: actualQuantityMilli,
      quantityDeltaMilli: actualQuantityMilli,
      inventoryValueAfterMinor: 0n,
      averageUnitCostAfterMinor: 0n,
      valueDeltaMinor: 0n,
      costStateBefore: 'unknown',
      costStateAfter: 'unknown',
      costStatus: 'unknown',
      hasPendingCostAfter: false,
    };
  }
  const delta = actualQuantityMilli - before.quantityMilli;
  if (delta < INVENTORY_INT8_MIN || delta > INVENTORY_INT8_MAX) {
    throw new RangeError('Stock Count variance is outside PostgreSQL int8.');
  }
  let state = before.costState;
  let value = before.inventoryValueMinor;
  if (delta > 0n) {
    state = before.quantityMilli < 0n || before.costState === 'pending' ? 'pending' : 'unknown';
    value = 0n;
  } else if (delta < 0n) {
    if (actualQuantityMilli === 0n) {
      value = 0n;
    } else if (before.costState === 'known') {
      value =
        before.inventoryValueMinor -
        roundInventoryMoneyHalfUp(before.inventoryValueMinor * -delta, before.quantityMilli);
    } else {
      value = 0n;
    }
  }
  if (value < 0n || value > INVENTORY_INT8_MAX) {
    throw new RangeError('Stock Count inventory value is outside PostgreSQL int8.');
  }
  const average =
    state === 'known' && actualQuantityMilli > 0n
      ? inventoryUnitCost(value, actualQuantityMilli)
      : 0n;
  return {
    quantityAfterMilli: actualQuantityMilli,
    quantityDeltaMilli: delta,
    inventoryValueAfterMinor: value,
    averageUnitCostAfterMinor: average,
    valueDeltaMinor: value - before.inventoryValueMinor,
    costStateBefore: before.costState,
    costStateAfter: state,
    costStatus: delta > 0n ? 'unknown' : before.costState,
    hasPendingCostAfter: state === 'pending',
  };
}
