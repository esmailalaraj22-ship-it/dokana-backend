import type { InventoryCostState } from '../database/schema/inventory';
import { INVENTORY_INT8_MAX, inventoryUnitCost, roundInventoryMoneyHalfUp } from './inventory-math';

export interface InventoryValuation {
  quantityMilli: bigint;
  inventoryValueMinor: bigint;
  costState: InventoryCostState;
}

export function inventoryPostingEffect(
  before: InventoryValuation,
  delta: bigint,
  purchaseCost: bigint | null,
) {
  const afterQuantity = before.quantityMilli + delta;
  if (
    delta === 0n ||
    delta < -INVENTORY_INT8_MAX ||
    delta > INVENTORY_INT8_MAX ||
    afterQuantity < -INVENTORY_INT8_MAX - 1n ||
    afterQuantity > INVENTORY_INT8_MAX ||
    (purchaseCost !== null &&
      (delta < 0n || purchaseCost < 0n || purchaseCost > INVENTORY_INT8_MAX))
  ) {
    throw new RangeError('Inventory effect is outside accepted bounds.');
  }
  let state: InventoryCostState;
  let value = 0n;
  const contribution: InventoryCostState =
    delta > 0n
      ? purchaseCost === null
        ? 'unknown'
        : 'known'
      : afterQuantity < 0n
        ? 'pending'
        : before.costState;

  // Empty stock carries no residual valuation. Negative history is never recosted;
  // a positive remainder crossing from negative stays pending even with known input.
  if (afterQuantity === 0n) {
    state = 'known';
  } else if (afterQuantity < 0n || before.quantityMilli < 0n || before.costState === 'pending') {
    state = 'pending';
  } else if (delta > 0n) {
    state =
      purchaseCost === null || (before.quantityMilli > 0n && before.costState === 'unknown')
        ? 'unknown'
        : 'known';
    if (state === 'known') value = before.inventoryValueMinor + (purchaseCost ?? 0n);
  } else {
    state = before.costState;
    if (state === 'known') {
      value =
        before.inventoryValueMinor -
        roundInventoryMoneyHalfUp(before.inventoryValueMinor * -delta, before.quantityMilli);
    }
  }
  if (value < 0n || value > INVENTORY_INT8_MAX)
    throw new RangeError('Inventory value exceeds int8.');
  const average =
    state === 'known' && afterQuantity > 0n ? inventoryUnitCost(value, afterQuantity) : 0n;
  return {
    quantityAfterMilli: afterQuantity,
    inventoryValueAfterMinor: value,
    averageUnitCostAfterMinor: average,
    valueDeltaMinor: value - before.inventoryValueMinor,
    costStateAfter: state,
    costStatus: contribution,
    hasPendingCostAfter: state === 'pending',
  };
}
