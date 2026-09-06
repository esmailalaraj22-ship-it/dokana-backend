import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import {
  parseInventoryPostingCommand,
  type InventoryCommandKind,
} from './inventory-posting-command';
import { inventoryPostingEffect } from './inventory-posting-math';
import { INVENTORY_INT8_MAX, inventoryBaseQuantity } from './inventory-math';

const request = {
  operationId: randomUUID(),
  productId: randomUUID(),
  productUnitId: randomUUID(),
  selectedQuantityMilli: '1000',
  occurredAt: '2026-01-15T10:00:00Z',
  reason: 'damaged',
};
describe('S11.4 inventory command validation and canonical identity', () => {
  it.each(['opening', 'increase', 'decrease'] as const)(
    '%s accepts only positive exact magnitudes',
    (kind) => {
      expect(parseInventoryPostingCommand(kind, request).selectedQuantityMilli).toBe(1000n);
      for (const value of [
        '0',
        '-1',
        '-9223372036854775808',
        '9223372036854775808',
        '1.1',
        '1e3',
        '01',
        1000,
        null,
      ])
        expect(() =>
          parseInventoryPostingCommand(kind, { ...request, selectedQuantityMilli: value }),
        ).toThrow(BadRequestException);
    },
  );
  it('distinguishes omitted and explicit zero cost; rejects outbound cost and missing reason', () => {
    const missing = parseInventoryPostingCommand('increase', request);
    const zero = parseInventoryPostingCommand('increase', {
      ...request,
      totalPurchaseCostMinor: '0',
    });
    expect(missing.totalPurchaseCostMinor).toBeNull();
    expect(zero.totalPurchaseCostMinor).toBe(0n);
    expect(missing.requestHash).not.toBe(zero.requestHash);
    expect(() =>
      parseInventoryPostingCommand('decrease', { ...request, totalPurchaseCostMinor: '0' }),
    ).toThrow();
    expect(() => parseInventoryPostingCommand('decrease', { ...request, reason: ' ' })).toThrow();
  });
  it.each([
    'storeId',
    'quantityDeltaMilli',
    'baseQuantityMilli',
    'accountingPeriodId',
    'supplierInvoiceId',
    'costStatus',
    'movementId',
  ])('rejects client authority %s', (field) => {
    expect(() =>
      parseInventoryPostingCommand('increase', { ...request, [field]: randomUUID() }),
    ).toThrow();
  });
  it.each([
    '0001-01-01T10:00:00Z',
    '2026-02-30T10:00:00Z',
    '2026-01-15',
    '2026-01-15T10:00:00',
    '2026-01-15T10:00:00.1234Z',
  ])('rejects invalid/lossy timestamp %s', (occurredAt) => {
    expect(() => parseInventoryPostingCommand('opening', { ...request, occurredAt })).toThrow();
  });
  it('canonicalizes UUIDs, equivalent instants and reason, binding every semantic input', () => {
    const original = parseInventoryPostingCommand('increase', request);
    expect(
      parseInventoryPostingCommand('increase', {
        ...request,
        productId: request.productId.toUpperCase(),
        occurredAt: '2026-01-15T12:00:00+02:00',
        reason: ' damaged ',
      }).requestHash,
    ).toBe(original.requestHash);
    for (const change of [
      { productId: randomUUID() },
      { productUnitId: randomUUID() },
      { selectedQuantityMilli: '2000' },
      { occurredAt: '2026-01-16T10:00:00Z' },
      { reason: 'loss' },
      { totalPurchaseCostMinor: '1' },
    ])
      expect(
        parseInventoryPostingCommand('increase', { ...request, ...change }).requestHash,
      ).not.toBe(original.requestHash);
    for (const kind of ['opening', 'decrease'] as InventoryCommandKind[])
      expect(parseInventoryPostingCommand(kind, request).requestHash).not.toBe(
        original.requestHash,
      );
  });
});

describe('S11.4 quantity and cost transition matrix', () => {
  const known = { quantityMilli: 3000n, inventoryValueMinor: 10n, costState: 'known' as const };
  it.each([
    [1000n, 10, 1, 10000n],
    [1000n, 24, 1, 24000n],
    [15000n, 1000, 1, 15000000n],
    [1000n, 1, 1000, 1n],
    [1000n, 1, 100, 10n],
    [INVENTORY_INT8_MAX, 2, 2, INVENTORY_INT8_MAX],
  ] as const)('exact configured conversion %s * %s / %s', (q, n, d, expected) => {
    expect(inventoryBaseQuantity(q, n, d)).toBe(expected);
  });
  it('rejects conversion remainders and final overflow', () => {
    expect(() => inventoryBaseQuantity(1n, 1, 3)).toThrow();
    expect(() => inventoryBaseQuantity(INVENTORY_INT8_MAX, 2, 1)).toThrow();
  });
  it('adds known aggregate value and derives average only once', () => {
    expect(inventoryPostingEffect(known, 1000n, 4n)).toMatchObject({
      quantityAfterMilli: 4000n,
      inventoryValueAfterMinor: 14n,
      averageUnitCostAfterMinor: 4n,
      costStatus: 'known',
      costStateAfter: 'known',
    });
  });
  it('outbound cost uses aggregate ratio; full depletion leaves no rounding residue', () => {
    expect(inventoryPostingEffect(known, -1000n, null)).toMatchObject({
      valueDeltaMinor: -3n,
      inventoryValueAfterMinor: 7n,
    });
    expect(inventoryPostingEffect(known, -3000n, null)).toMatchObject({
      valueDeltaMinor: -10n,
      inventoryValueAfterMinor: 0n,
      averageUnitCostAfterMinor: 0n,
      costStateAfter: 'known',
    });
    expect(
      inventoryPostingEffect(
        { ...known, quantityMilli: 2000n, inventoryValueMinor: 1n },
        -1000n,
        null,
      ).valueDeltaMinor,
    ).toBe(-1n);
  });
  it.each(['known', 'unknown', 'pending'] as const)(
    'preserves unresolved valuation from %s',
    (costState) => {
      const before = { ...known, costState, inventoryValueMinor: costState === 'known' ? 10n : 0n };
      expect(inventoryPostingEffect(before, 1000n, null)).toMatchObject({
        costStatus: 'unknown',
        costStateAfter: costState === 'pending' ? 'pending' : 'unknown',
        inventoryValueAfterMinor: 0n,
      });
      if (costState !== 'known')
        expect(inventoryPostingEffect(before, 1000n, 5n)).toMatchObject({
          costStatus: 'known',
          costStateAfter: costState,
          inventoryValueAfterMinor: 0n,
        });
      expect(inventoryPostingEffect(before, -4000n, null)).toMatchObject({
        costStateAfter: 'pending',
        inventoryValueAfterMinor: 0n,
        quantityAfterMilli: -1000n,
      });
    },
  );
  it('does not backfill negative history with a later purchase', () => {
    expect(
      inventoryPostingEffect(
        { quantityMilli: -1000n, inventoryValueMinor: 0n, costState: 'pending' },
        2000n,
        10n,
      ),
    ).toMatchObject({
      quantityAfterMilli: 1000n,
      costStatus: 'known',
      costStateAfter: 'pending',
      inventoryValueAfterMinor: 0n,
    });
  });
  it('distinguishes initial missing cost and known zero; rejects signed overflow', () => {
    const empty = { quantityMilli: 0n, inventoryValueMinor: 0n, costState: 'known' as const };
    expect(inventoryPostingEffect(empty, 1000n, null).costStateAfter).toBe('unknown');
    expect(inventoryPostingEffect(empty, 1000n, 0n).costStateAfter).toBe('known');
    expect(() => inventoryPostingEffect(known, -INVENTORY_INT8_MAX - 1n, null)).toThrow();
    expect(() =>
      inventoryPostingEffect({ ...empty, quantityMilli: INVENTORY_INT8_MAX }, 1n, null),
    ).toThrow();
    expect(() =>
      inventoryPostingEffect({ ...known, inventoryValueMinor: INVENTORY_INT8_MAX }, 1000n, 1n),
    ).toThrow();
  });
});
