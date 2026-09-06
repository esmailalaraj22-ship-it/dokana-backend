import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { INVENTORY_INT8_MAX } from './inventory-math';
import { parseStockCountCommand } from './stock-count-command';
import { stockCountEffect } from './stock-count-math';

const firstProduct = '10000000-0000-4000-8000-000000000001';
const secondProduct = '20000000-0000-4000-8000-000000000001';
const firstUnit = '30000000-0000-4000-8000-000000000001';
const secondUnit = '40000000-0000-4000-8000-000000000001';
const request = {
  operationId: randomUUID(),
  countType: 'partial',
  occurredAt: '2026-01-15T10:00:00Z',
  items: [
    { productId: secondProduct, productUnitId: secondUnit, actualQuantityMilli: '0' },
    { productId: firstProduct, productUnitId: firstUnit, actualQuantityMilli: '1000' },
  ],
};

describe('S11.5 Stock Count command', () => {
  it('accepts physical zero, canonicalizes identity, and sorts Product items', () => {
    const parsed = parseStockCountCommand(request);
    expect(parsed.items).toEqual([
      { productId: firstProduct, productUnitId: firstUnit, actualQuantityMilli: 1000n },
      { productId: secondProduct, productUnitId: secondUnit, actualQuantityMilli: 0n },
    ]);
  });

  it('binds every semantic field while treating array reorder as the same request', () => {
    const original = parseStockCountCommand(request);
    expect(
      parseStockCountCommand({ ...request, items: [...request.items].reverse() }).requestHash,
    ).toBe(original.requestHash);
    for (const change of [
      { countType: 'full' },
      { occurredAt: '2026-01-16T10:00:00Z' },
      {
        items: request.items.map((item, index) =>
          index === 0 ? { ...item, actualQuantityMilli: '1' } : item,
        ),
      },
      {
        items: request.items.map((item, index) =>
          index === 0 ? { ...item, productUnitId: randomUUID() } : item,
        ),
      },
    ]) {
      expect(parseStockCountCommand({ ...request, ...change }).requestHash).not.toBe(
        original.requestHash,
      );
    }
  });

  it('rejects duplicate Products, negative/lossy quantities, overflow, and authority fields', () => {
    const invalid: unknown[] = [
      { ...request, items: [request.items[0], request.items[0]] },
      {
        ...request,
        items: [{ ...request.items[0], actualQuantityMilli: '-1' }],
      },
      {
        ...request,
        items: [{ ...request.items[0], actualQuantityMilli: '1.1' }],
      },
      {
        ...request,
        items: [{ ...request.items[0], actualQuantityMilli: '9223372036854775808' }],
      },
      { ...request, quantityDeltaMilli: '0' },
      { ...request, movementKind: 'count_zero_establishment' },
      { ...request, storeId: randomUUID() },
    ];
    for (const value of invalid) {
      expect(() => parseStockCountCommand(value)).toThrow(BadRequestException);
    }
  });

  it('keeps bigint above JavaScript Number precision lossless', () => {
    const parsed = parseStockCountCommand({
      ...request,
      items: [{ ...request.items[0], actualQuantityMilli: '9007199254740993' }],
    });
    expect(parsed.items[0]?.actualQuantityMilli).toBe(9007199254740993n);
  });
});

describe('S11.5 Stock Count cost transitions', () => {
  const known = { quantityMilli: 3000n, inventoryValueMinor: 10n, costState: 'known' as const };

  it.each([0n, 5000n])('establishes missing quantity %s with unknown cost provenance', (actual) => {
    expect(stockCountEffect(null, actual)).toMatchObject({
      quantityAfterMilli: actual,
      quantityDeltaMilli: actual,
      costStateBefore: 'unknown',
      costStateAfter: 'unknown',
      inventoryValueAfterMinor: 0n,
      averageUnitCostAfterMinor: 0n,
    });
  });

  it('preserves exact known outbound valuation and drains known depletion residue', () => {
    expect(stockCountEffect(known, 2000n)).toMatchObject({
      quantityDeltaMilli: -1000n,
      inventoryValueAfterMinor: 7n,
      averageUnitCostAfterMinor: 4n,
      costStateAfter: 'known',
    });
    expect(stockCountEffect(known, 0n)).toMatchObject({
      inventoryValueAfterMinor: 0n,
      averageUnitCostAfterMinor: 0n,
      costStateAfter: 'known',
    });
  });

  it.each(['unknown', 'pending'] as const)(
    'does not convert %s into known zero when the physical count is zero',
    (costState) => {
      expect(stockCountEffect({ ...known, inventoryValueMinor: 0n, costState }, 0n)).toMatchObject({
        quantityAfterMilli: 0n,
        inventoryValueAfterMinor: 0n,
        costStateAfter: costState,
      });
    },
  );

  it('makes an uncosted positive variance unknown without borrowing ProductUnit price', () => {
    expect(stockCountEffect(known, 4000n)).toMatchObject({
      quantityDeltaMilli: 1000n,
      costStateAfter: 'unknown',
      inventoryValueAfterMinor: 0n,
      costStatus: 'unknown',
    });
  });

  it('keeps negative-stock recovery pending and derives no historical value', () => {
    expect(
      stockCountEffect(
        { quantityMilli: -3000n, inventoryValueMinor: 0n, costState: 'pending' },
        4000n,
      ),
    ).toMatchObject({
      quantityDeltaMilli: 7000n,
      quantityAfterMilli: 4000n,
      costStateAfter: 'pending',
      inventoryValueAfterMinor: 0n,
    });
  });

  it('returns an exact no-op and rejects int8 overflow', () => {
    expect(stockCountEffect(known, 3000n)).toMatchObject({
      quantityDeltaMilli: 0n,
      quantityAfterMilli: 3000n,
      inventoryValueAfterMinor: 10n,
    });
    expect(() =>
      stockCountEffect(
        { quantityMilli: -1n, inventoryValueMinor: 0n, costState: 'pending' },
        INVENTORY_INT8_MAX,
      ),
    ).toThrow(RangeError);
  });
});
