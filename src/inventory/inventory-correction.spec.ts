import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { parseInventoryCorrectionCommand } from './inventory-correction-command';

const targetOperationId = '10000000-0000-4000-8000-000000000001';
const operationId = '20000000-0000-4000-8000-000000000001';
const productId = '30000000-0000-4000-8000-000000000001';
const productUnitId = '40000000-0000-4000-8000-000000000001';
const secondProductId = '50000000-0000-4000-8000-000000000001';
const secondUnitId = '60000000-0000-4000-8000-000000000001';
const occurredAt = '2026-01-15T10:00:00Z';

function reversal(overrides: Record<string, unknown> = {}) {
  return {
    operationId,
    targetOperationId,
    correctionType: 'REVERSAL',
    occurredAt,
    ...overrides,
  };
}

function increaseReplacement(overrides: Record<string, unknown> = {}) {
  return {
    operationId,
    targetOperationId,
    correctionType: 'REPLACEMENT',
    occurredAt,
    replacement: {
      family: 'increase',
      productId,
      productUnitId,
      selectedQuantityMilli: '1000',
      reason: 'correct accepted quantity',
    },
    ...overrides,
  };
}

describe('S11.6 inventory correction command', () => {
  it('accepts a whole-operation reversal and canonicalizes identifiers and time', () => {
    const command = parseInventoryCorrectionCommand(
      reversal({
        operationId: operationId.toUpperCase(),
        targetOperationId: targetOperationId.toUpperCase(),
        occurredAt: '2026-01-15T12:00:00+02:00',
      }),
    );
    expect(command).toMatchObject({
      operationId,
      targetOperationId,
      kind: 'reversal',
      occurredAt: new Date(occurredAt),
      replacement: null,
    });
  });

  it.each([
    ['opening', {}],
    ['increase', { totalPurchaseCostMinor: '0' }],
    ['decrease', { reason: 'correct inventory decrease' }],
  ] as const)('accepts one complete %s replacement', (family, fields) => {
    const command = parseInventoryCorrectionCommand({
      ...increaseReplacement(),
      replacement: {
        family,
        productId,
        productUnitId,
        selectedQuantityMilli: '1000',
        ...fields,
      },
    });
    expect(command.kind).toBe('replacement');
    expect(command.replacement).toMatchObject({
      family,
      command: {
        kind: family,
        operationId,
        productId,
        productUnitId,
        occurredAt: new Date(occurredAt),
      },
    });
  });

  it('accepts and canonically sorts one complete Stock Count replacement', () => {
    const command = parseInventoryCorrectionCommand({
      ...increaseReplacement(),
      replacement: {
        family: 'stock_count',
        countType: 'partial',
        items: [
          { productId: secondProductId, productUnitId: secondUnitId, actualQuantityMilli: '0' },
          { productId, productUnitId, actualQuantityMilli: '1000' },
        ],
      },
    });
    expect(command.replacement).toMatchObject({
      family: 'stock_count',
      command: {
        operationId,
        countType: 'partial',
        items: [
          { productId, productUnitId, actualQuantityMilli: 1000n },
          { productId: secondProductId, productUnitId: secondUnitId, actualQuantityMilli: 0n },
        ],
      },
    });
  });

  it('uses one canonical fingerprint and binds every semantic correction field', () => {
    const original = parseInventoryCorrectionCommand(increaseReplacement());
    expect(
      parseInventoryCorrectionCommand({
        ...increaseReplacement(),
        targetOperationId: targetOperationId.toUpperCase(),
        occurredAt: '2026-01-15T12:00:00+02:00',
        replacement: {
          ...(increaseReplacement().replacement as Record<string, unknown>),
          productId: productId.toUpperCase(),
          reason: ' correct accepted quantity ',
        },
      }).requestHash,
    ).toBe(original.requestHash);

    const changedRequests = [
      increaseReplacement({ targetOperationId: randomUUID() }),
      increaseReplacement({ occurredAt: '2026-01-16T10:00:00Z' }),
      {
        ...increaseReplacement(),
        replacement: {
          ...(increaseReplacement().replacement as Record<string, unknown>),
          productId: randomUUID(),
        },
      },
      {
        ...increaseReplacement(),
        replacement: {
          ...(increaseReplacement().replacement as Record<string, unknown>),
          productUnitId: randomUUID(),
        },
      },
      {
        ...increaseReplacement(),
        replacement: {
          ...(increaseReplacement().replacement as Record<string, unknown>),
          selectedQuantityMilli: '2000',
        },
      },
      {
        ...increaseReplacement(),
        replacement: {
          ...(increaseReplacement().replacement as Record<string, unknown>),
          reason: 'different reason',
        },
      },
      reversal(),
    ];
    for (const request of changedRequests) {
      expect(parseInventoryCorrectionCommand(request).requestHash).not.toBe(original.requestHash);
    }
  });

  it('distinguishes omitted purchase cost from explicit known zero', () => {
    const omitted = parseInventoryCorrectionCommand(increaseReplacement());
    const zero = parseInventoryCorrectionCommand({
      ...increaseReplacement(),
      replacement: {
        ...(increaseReplacement().replacement as Record<string, unknown>),
        totalPurchaseCostMinor: '0',
      },
    });
    expect(omitted.replacement).toMatchObject({
      command: { totalPurchaseCostMinor: null },
    });
    expect(zero.replacement).toMatchObject({
      command: { totalPurchaseCostMinor: 0n },
    });
    expect(omitted.requestHash).not.toBe(zero.requestHash);
  });

  it.each([
    { replacement: { family: 'increase' } },
    { correctionType: 'REPLACEMENT' },
    { correctionType: 'DELETE' },
    { movementId: randomUUID() },
    { stockCountItemId: randomUUID() },
    { storeId: randomUUID() },
  ])('rejects an invalid or client-authoritative top-level field %j', (change) => {
    expect(() => parseInventoryCorrectionCommand({ ...reversal(), ...change })).toThrow(
      BadRequestException,
    );
  });

  it.each([
    { operationId: randomUUID() },
    { occurredAt },
    { quantityDeltaMilli: '1000' },
    { baseQuantityMilli: '1000' },
    { accountingPeriodId: randomUUID() },
    { movementId: randomUUID() },
    { factorNum: 1 },
    { costStatus: 'known' },
    { supplierInvoiceId: randomUUID() },
  ])('rejects nested authority %j', (field) => {
    expect(() =>
      parseInventoryCorrectionCommand({
        ...increaseReplacement(),
        replacement: {
          ...(increaseReplacement().replacement as Record<string, unknown>),
          ...field,
        },
      }),
    ).toThrow(BadRequestException);
  });
});
