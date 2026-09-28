import { randomUUID } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';

import {
  parseSupplierCreditApplicationCommand,
  parseSupplierFinancialCorrectionCommand,
  parseSupplierRefundCommand,
  parseSupplierReturnPostingCommand,
} from './supplier-return-command';
import {
  assertSupplierCreditApplication,
  assertSupplierCreditConsumption,
  assertSupplierReturnCapacity,
  calculateSupplierReturnWaterfall,
  deriveInvoiceOutstanding,
  SupplierReturnPolicyError,
} from './supplier-return-policy';

const supplierId = 'a1700000-0000-4000-8000-000000000001';
const invoiceId = 'a1700000-0000-4000-8000-000000000002';
const accountId = 'a1700000-0000-4000-8000-000000000003';
const targetOperationId = 'a1700000-0000-4000-8000-000000000004';
const historicalInstant = '2020-01-15T10:00:00Z';

function returnBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId: randomUUID(),
    purchaseInvoiceId: invoiceId,
    amountMinor: '300',
    occurredAt: historicalInstant,
    reason: 'Supplier accepted the financial return',
    ...overrides,
  };
}

function expectPolicyError(work: () => void, code: string): void {
  try {
    work();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(SupplierReturnPolicyError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected Supplier Return policy error ${code}.`);
}

describe('Supplier financial Return policy', () => {
  it.each([
    { outstanding: 1000n, returned: 300n, payable: 300n, credit: 0n },
    { outstanding: 300n, returned: 500n, payable: 300n, credit: 200n },
    { outstanding: 0n, returned: 250n, payable: 0n, credit: 250n },
  ])('applies the payable-first waterfall without negative Payable', (example) => {
    expect(calculateSupplierReturnWaterfall(example.returned, example.outstanding)).toEqual({
      payableReductionMinor: example.payable,
      supplierCreditCreatedMinor: example.credit,
    });
  });

  it('derives exact Invoice outstanding after historical allocations', () => {
    expect(deriveInvoiceOutstanding(1000n, 700n)).toBe(300n);
    expect(() => deriveInvoiceOutstanding(500n, 501n)).toThrow(SupplierReturnPolicyError);
  });

  it('permits multiple Returns only within the historical Invoice value', () => {
    expect(() => assertSupplierReturnCapacity(1000n, 600n, 400n)).not.toThrow();
    expectPolicyError(
      () => assertSupplierReturnCapacity(1000n, 600n, 401n),
      'SUPPLIER_RETURN_EXCEEDS_CREDITABLE_VALUE',
    );
  });

  it('prevents Supplier Credit from being over-consumed or over-applied', () => {
    expect(() => assertSupplierCreditConsumption(200n, 200n)).not.toThrow();
    expectPolicyError(
      () => assertSupplierCreditConsumption(200n, 201n),
      'SUPPLIER_CREDIT_INSUFFICIENT',
    );
    expectPolicyError(
      () => assertSupplierCreditApplication(500n, 300n, 301n),
      'SUPPLIER_CREDIT_APPLICATION_EXCEEDS_OUTSTANDING',
    );
  });

  it.each([0n, -1n])('rejects non-positive financial amounts (%s)', (amount) => {
    expect(() => calculateSupplierReturnWaterfall(amount, 100n)).toThrow(SupplierReturnPolicyError);
  });
});

describe('Supplier financial Return command contract', () => {
  it('accepts a historical Supplier Return without a global commercial time window', () => {
    const command = parseSupplierReturnPostingCommand(supplierId.toUpperCase(), returnBody());
    expect(command.supplierId).toBe(supplierId);
    expect(command.occurredAt.toISOString()).toBe('2020-01-15T10:00:00.000Z');
    expect(command.amountMinor).toBe(300n);
  });

  it.each(['0', '-1', '1.5', '900719925474099300000000'])(
    'rejects an invalid exact bigint amount (%s)',
    (amountMinor) => {
      expect(() =>
        parseSupplierReturnPostingCommand(supplierId, returnBody({ amountMinor })),
      ).toThrow(BadRequestException);
    },
  );

  it('canonicalizes semantic identity and detects material changes', () => {
    const operationId = randomUUID();
    const first = parseSupplierReturnPostingCommand(supplierId, returnBody({ operationId }));
    const equivalent = parseSupplierReturnPostingCommand(
      supplierId.toUpperCase(),
      returnBody({ operationId: operationId.toUpperCase() }),
    );
    const changed = parseSupplierReturnPostingCommand(
      supplierId,
      returnBody({ operationId, amountMinor: '301' }),
    );
    expect(equivalent.requestHash).toBe(first.requestHash);
    expect(changed.requestHash).not.toBe(first.requestHash);
  });

  it('parses distinct Credit Application and actual Refund commands losslessly', () => {
    const application = parseSupplierCreditApplicationCommand(supplierId, {
      operationId: randomUUID(),
      purchaseInvoiceId: invoiceId,
      amountMinor: '9007199254740993',
      occurredAt: historicalInstant,
      notes: null,
    });
    const refund = parseSupplierRefundCommand(supplierId, {
      operationId: randomUUID(),
      moneyAccountId: accountId,
      amountMinor: '700',
      occurredAt: historicalInstant,
      notes: 'Received from Supplier',
    });
    expect(application.amountMinor).toBe(9007199254740993n);
    expect(application.family).toBe('supplier_credit_application');
    expect(refund.amountMinor).toBe(700n);
    expect(refund.family).toBe('supplier_refund');
  });

  it.each(['supplier_return', 'supplier_credit_application', 'supplier_refund'] as const)(
    'requires a correction reason for %s',
    (family) => {
      expect(() =>
        parseSupplierFinancialCorrectionCommand(family, 'cancel', targetOperationId, {
          operationId: randomUUID(),
          occurredAt: historicalInstant,
          reason: '   ',
        }),
      ).toThrow(BadRequestException);
    },
  );

  it('keeps Supplier Return replacement on its target Invoice by contract', () => {
    const command = parseSupplierFinancialCorrectionCommand(
      'supplier_return',
      'replace',
      targetOperationId,
      {
        operationId: randomUUID(),
        occurredAt: historicalInstant,
        reason: 'Correct amount',
        replacement: { amountMinor: '325', reason: 'Corrected supplier agreement' },
      },
    );
    expect(command).toMatchObject({
      family: 'supplier_return',
      kind: 'replace',
      targetOperationId,
      replacement: { amountMinor: 325n },
    });
    if (command.family !== 'supplier_return' || command.kind !== 'replace') {
      throw new Error('Expected Supplier Return replacement command.');
    }
    expect('purchaseInvoiceId' in command.replacement).toBe(false);
  });

  it('rejects unknown request fields instead of hashing ambiguous input', () => {
    expect(() =>
      parseSupplierReturnPostingCommand(supplierId, returnBody({ storeId: randomUUID() })),
    ).toThrow(BadRequestException);
  });
});
