import {
  inventoryBaseQuantity,
  inventoryCostResponse,
  inventoryUnitCost,
  INVENTORY_INT8_MAX,
  roundInventoryMoneyHalfUp,
} from './inventory-math';

describe('Exact inventory math', () => {
  it.each([
    ['piece', 1000n, 1, 1, 1000n],
    ['millimeter in meters', 1000n, 1, 1000, 1n],
    ['centimeter in meters', 1000n, 1, 100, 10n],
    ['meter', 1000n, 1, 1, 1000n],
    ['milligram in grams', 1000n, 1, 1000, 1n],
    ['gram', 1000n, 1, 1, 1000n],
    ['kilogram in grams', 1000n, 1000, 1, 1000000n],
    ['milliliter in liters', 1000n, 1, 1000, 1n],
    ['liter', 1000n, 1, 1, 1000n],
    ['configured alternative length', 5000n, 127, 5000, 127n],
  ] as const)(
    'represents %s through configured ProductUnit ratios',
    (_name, selected, num, den, expected) => {
      expect(inventoryBaseQuantity(selected, num, den)).toBe(expected);
    },
  );

  it('never assigns a global carton factor or independent package balance', () => {
    expect(inventoryBaseQuantity(5000n, 10, 1)).toBe(50000n);
    expect(inventoryBaseQuantity(5000n, 24, 1)).toBe(120000n);
    expect(inventoryBaseQuantity(5000n, 1, 1)).toBe(5000n);
  });

  it('accepts exact fractional selected quantities and widened intermediates', () => {
    expect(inventoryBaseQuantity(125n, 8, 1)).toBe(1000n);
    expect(inventoryBaseQuantity(0n, 1, 1)).toBe(0n);
    expect(inventoryBaseQuantity(INVENTORY_INT8_MAX, 2147483647, 2147483647)).toBe(
      INVENTORY_INT8_MAX,
    );
    expect(inventoryBaseQuantity(9007199254740993n, 1, 1).toString()).toBe('9007199254740993');
  });

  it.each([
    [1n, 1, 3],
    [1n, 1, 1000],
    [-1n, 1, 1],
    [-9223372036854775808n, 1, 1],
    [INVENTORY_INT8_MAX + 1n, 1, 1],
    [INVENTORY_INT8_MAX, 2, 1],
    [1000n, 0, 1],
    [1000n, 1, 0],
    [1000n, 1.5, 1],
    [1000n, 1, -1],
    [1000n, 2147483648, 1],
    [1000n, 1, Number.POSITIVE_INFINITY],
  ] as const)('rejects non-exact or out-of-domain input %s %s/%s', (selected, num, den) => {
    expect(() => inventoryBaseQuantity(selected, num, den)).toThrow();
  });

  it.each([
    [49n, 100n, 0n],
    [50n, 100n, 1n],
    [51n, 100n, 1n],
    [149n, 100n, 1n],
    [150n, 100n, 2n],
    [151n, 100n, 2n],
    [0n, 1n, 0n],
  ] as const)('rounds monetary %s/%s HALF UP to %s', (n, d, expected) =>
    expect(roundInventoryMoneyHalfUp(n, d)).toBe(expected),
  );

  it('derives average directly from authoritative total and exact quantity', () => {
    expect(inventoryUnitCost(1n, 2000n)).toBe(1n);
    expect(inventoryUnitCost(2n, 3000n)).toBe(1n);
    expect(inventoryUnitCost(9007199254740993n, 1000n)).toBe(9007199254740993n);
    expect(inventoryUnitCost(0n, 1000n)).toBe(0n);
  });

  it.each([
    [1n, 0n],
    [-1n, 1000n],
    [INVENTORY_INT8_MAX, 1n],
  ] as const)('rejects unsafe derived unit cost', (cost, quantity) => {
    expect(() => inventoryUnitCost(cost, quantity)).toThrow(RangeError);
  });

  it.each(['unknown', 'pending'] as const)('hides numeric compatibility values for %s', (state) => {
    expect(inventoryCostResponse(state, 0n, 0n)).toEqual({
      status: state,
      valueMinor: null,
      averageUnitCostMinor: null,
    });
  });

  it('keeps known zero and known positive cost distinct from unavailable cost', () => {
    expect(inventoryCostResponse('known', 0n, 0n)).toEqual({
      status: 'known',
      valueMinor: '0',
      averageUnitCostMinor: '0',
    });
    expect(inventoryCostResponse('known', 9007199254740993n, null)).toEqual({
      status: 'known',
      valueMinor: '9007199254740993',
      averageUnitCostMinor: null,
    });
  });
});
