import { validateProductUnitRatio } from '../products/product-validation';
import type { InventoryCostState } from '../database/schema/inventory';

export const INVENTORY_INT8_MAX = 9223372036854775807n;

function nonnegativeInt8(value: bigint): void {
  if (typeof value !== 'bigint' || value < 0n || value > INVENTORY_INT8_MAX) {
    throw new RangeError('Inventory value must be a nonnegative PostgreSQL int8.');
  }
}

export function inventoryBaseQuantity(
  selectedQuantityMilli: bigint,
  factorNum: number,
  factorDen: number,
): bigint {
  nonnegativeInt8(selectedQuantityMilli);
  validateProductUnitRatio({ isBase: false, factorNum, factorDen });
  // BigInt is a widened exact intermediate, matching migration 0007's NUMERIC.
  const numerator = selectedQuantityMilli * BigInt(factorNum);
  const denominator = BigInt(factorDen);
  if (numerator % denominator !== 0n) {
    throw new RangeError('Inventory quantity is not exactly representable.');
  }
  const result = numerator / denominator;
  nonnegativeInt8(result);
  return result;
}

export function roundInventoryMoneyHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (
    typeof numerator !== 'bigint' ||
    typeof denominator !== 'bigint' ||
    numerator < 0n ||
    denominator <= 0n
  ) {
    throw new RangeError(
      'Inventory monetary rational must be nonnegative with a positive denominator.',
    );
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const result = quotient + (remainder * 2n >= denominator ? 1n : 0n);
  nonnegativeInt8(result);
  return result;
}

export function inventoryUnitCost(totalCostMinor: bigint, baseQuantityMilli: bigint): bigint {
  nonnegativeInt8(totalCostMinor);
  nonnegativeInt8(baseQuantityMilli);
  return roundInventoryMoneyHalfUp(totalCostMinor * 1000n, baseQuantityMilli);
}

export function inventoryCostResponse(
  status: InventoryCostState,
  valueMinor: bigint,
  averageUnitCostMinor: bigint | null,
): InventoryCostResponse {
  if (status === 'unknown' || status === 'pending') {
    return { status, valueMinor: null, averageUnitCostMinor: null };
  }
  nonnegativeInt8(valueMinor);
  if (averageUnitCostMinor !== null) nonnegativeInt8(averageUnitCostMinor);
  return {
    status,
    valueMinor: valueMinor.toString(),
    averageUnitCostMinor: averageUnitCostMinor?.toString() ?? null,
  };
}

export interface InventoryCostResponse {
  status: InventoryCostState;
  valueMinor: string | null;
  averageUnitCostMinor: string | null;
}
