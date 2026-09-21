import { BadRequestException } from '@nestjs/common';

import {
  parseCustomerFinancialCancelCommand,
  parseCustomerFinancialEditCommand,
  type CustomerFinancialCorrectionFamily,
} from './customer-financial-correction-command';

const ids = {
  customer: '15550000-0000-4000-8000-000000000001',
  otherCustomer: '15550000-0000-4000-8000-000000000002',
  target: '15550000-0000-4000-8000-000000000003',
  otherTarget: '15550000-0000-4000-8000-000000000004',
  operation: '15550000-0000-4000-8000-000000000005',
  account: '15550000-0000-4000-8000-000000000006',
  sale: '15550000-0000-4000-8000-000000000007',
};

const families = [
  'customer_collection',
  'customer_credit_application',
  'customer_credit_refund',
  'customer_receivable_settlement',
] as const satisfies readonly CustomerFinancialCorrectionFamily[];

function cancelBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId: ids.operation,
    occurredAt: '2026-09-20T10:00:00Z',
    reason: 'Incorrect customer settlement',
    ...overrides,
  };
}

function replacement(family: CustomerFinancialCorrectionFamily): Record<string, unknown> {
  if (family === 'customer_collection') {
    return {
      intent: 'customer_advance',
      tenders: [{ moneyAccountId: ids.account, amountMinor: '9007199254740993' }],
    };
  }
  if (family === 'customer_credit_refund') {
    return { amountMinor: '9007199254740993', moneyAccountId: ids.account };
  }
  return {
    amountMinor: '9007199254740993',
    allocationMode: 'custom',
    allocations: [
      {
        targetType: 'sale_receivable',
        targetId: ids.sale,
        amountMinor: '9007199254740993',
      },
    ],
    ...(family === 'customer_receivable_settlement' ? { reason: 'Approved waiver' } : {}),
  };
}

function editBody(
  family: CustomerFinancialCorrectionFamily,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...cancelBody(),
    replacement: replacement(family),
    ...overrides,
  };
}

describe('S15.5 Customer financial correction commands', () => {
  it.each(families)('parses %s cancellation', (family) => {
    expect(
      parseCustomerFinancialCancelCommand(family, ids.customer, ids.target, cancelBody()),
    ).toMatchObject({
      kind: 'cancel',
      family,
      customerId: ids.customer,
      targetOperationId: ids.target,
      operationId: ids.operation,
      reason: 'Incorrect customer settlement',
    });
  });

  it.each(families)('parses %s replacement through its canonical engine', (family) => {
    const command = parseCustomerFinancialEditCommand(
      family,
      ids.customer,
      ids.target,
      editBody(family),
    );
    expect(command).toMatchObject({
      kind: 'edit',
      family,
      customerId: ids.customer,
      targetOperationId: ids.target,
      operationId: ids.operation,
    });
    expect(command.replacement.amountMinor).toBe(9_007_199_254_740_993n);
  });

  it('canonicalizes path UUIDs, command UUID, timestamp, and reason', () => {
    const command = parseCustomerFinancialCancelCommand(
      'customer_collection',
      ids.customer.toUpperCase(),
      ids.target.toUpperCase(),
      cancelBody({
        operationId: ids.operation.toUpperCase(),
        occurredAt: '2026-09-20T13:00:00+03:00',
        reason: '  Correct duplicate receipt  ',
      }),
    );
    expect(command).toMatchObject({
      customerId: ids.customer,
      targetOperationId: ids.target,
      operationId: ids.operation,
      occurredAt: new Date('2026-09-20T10:00:00.000Z'),
      reason: 'Correct duplicate receipt',
    });
  });

  it.each([
    ['family', 'customer_credit_refund' as const, ids.target, cancelBody()],
    ['target', 'customer_collection' as const, ids.otherTarget, cancelBody()],
    [
      'occurredAt',
      'customer_collection' as const,
      ids.target,
      cancelBody({ occurredAt: '2026-09-20T10:01:00Z' }),
    ],
    [
      'reason',
      'customer_collection' as const,
      ids.target,
      cancelBody({ reason: 'Different correction reason' }),
    ],
  ])('binds changed %s into cancellation request identity', (_field, family, target, body) => {
    const original = parseCustomerFinancialCancelCommand(
      'customer_collection',
      ids.customer,
      ids.target,
      cancelBody(),
    );
    const changed = parseCustomerFinancialCancelCommand(family, ids.customer, target, body);
    expect(changed.requestHash).not.toBe(original.requestHash);
  });

  it.each(families)('binds %s replacement data into request identity', (family) => {
    const original = parseCustomerFinancialEditCommand(
      family,
      ids.customer,
      ids.target,
      editBody(family),
    );
    const changedReplacement = replacement(family);
    if ('tenders' in changedReplacement) {
      changedReplacement.tenders = [
        { moneyAccountId: ids.account, amountMinor: '9007199254740992' },
      ];
    } else {
      changedReplacement.amountMinor = '9007199254740992';
    }
    if ('allocations' in changedReplacement) {
      changedReplacement.allocations = [
        {
          targetType: 'sale_receivable',
          targetId: ids.sale,
          amountMinor: '9007199254740992',
        },
      ];
    }
    const changed = parseCustomerFinancialEditCommand(
      family,
      ids.customer,
      ids.target,
      editBody(family, { replacement: changedReplacement }),
    );
    expect(changed.requestHash).not.toBe(original.requestHash);
  });

  it('produces the same cancellation identity for canonical UUID and instant equivalents', () => {
    const original = parseCustomerFinancialCancelCommand(
      'customer_collection',
      ids.customer,
      ids.target,
      cancelBody(),
    );
    const equivalent = parseCustomerFinancialCancelCommand(
      'customer_collection',
      ids.customer.toUpperCase(),
      ids.target.toUpperCase(),
      cancelBody({
        operationId: ids.operation.toUpperCase(),
        occurredAt: '2026-09-20T13:00:00+03:00',
      }),
    );
    expect(equivalent.requestHash).toBe(original.requestHash);
  });

  it('binds the path Customer identity into the request hash', () => {
    const original = parseCustomerFinancialCancelCommand(
      'customer_collection',
      ids.customer,
      ids.target,
      cancelBody(),
    );
    const changed = parseCustomerFinancialCancelCommand(
      'customer_collection',
      ids.otherCustomer,
      ids.target,
      cancelBody(),
    );
    expect(changed.requestHash).not.toBe(original.requestHash);
  });

  it.each([
    ['outer reason', { reason: 'Replacement reason changed' }],
    ['outer occurredAt', { occurredAt: '2026-09-20T10:01:00Z' }],
  ])('binds changed %s into replacement identity', (_name, change) => {
    const original = parseCustomerFinancialEditCommand(
      'customer_credit_refund',
      ids.customer,
      ids.target,
      editBody('customer_credit_refund'),
    );
    const changed = parseCustomerFinancialEditCommand(
      'customer_credit_refund',
      ids.customer,
      ids.target,
      editBody('customer_credit_refund', change),
    );
    expect(changed.requestHash).not.toBe(original.requestHash);
  });

  it.each([
    ['blank reason', cancelBody({ reason: '   ' })],
    ['missing reason', { operationId: ids.operation, occurredAt: '2026-09-20T10:00:00Z' }],
    ['overlong reason', cancelBody({ reason: 'x'.repeat(501) })],
    ['invalid operation UUID', cancelBody({ operationId: 'not-a-uuid' })],
    ['invalid timestamp', cancelBody({ occurredAt: '2026-09-20' })],
    ['unknown property', cancelBody({ amountMinor: '1' })],
    ['invalid customer UUID', cancelBody()],
    ['invalid target UUID', cancelBody()],
  ])('rejects cancellation with %s', (name, body) => {
    const customerId = name === 'invalid customer UUID' ? 'invalid' : ids.customer;
    const targetId = name === 'invalid target UUID' ? 'invalid' : ids.target;
    expect(() =>
      parseCustomerFinancialCancelCommand('customer_collection', customerId, targetId, body),
    ).toThrow(BadRequestException);
  });

  it.each([
    ['replacement operationId', { operationId: ids.otherTarget }],
    ['replacement occurredAt', { occurredAt: '2026-09-20T11:00:00Z' }],
    ['replacement customerId', { customerId: ids.otherCustomer }],
  ])('rejects %s override', (_name, forbidden) => {
    expect(() =>
      parseCustomerFinancialEditCommand(
        'customer_collection',
        ids.customer,
        ids.target,
        editBody('customer_collection', {
          replacement: { ...replacement('customer_collection'), ...forbidden },
        }),
      ),
    ).toThrow(BadRequestException);
  });

  it.each([
    ['collection missing tenders', 'customer_collection' as const, {}],
    [
      'credit application missing allocations',
      'customer_credit_application' as const,
      { amountMinor: '10', allocationMode: 'custom' },
    ],
    ['refund missing account', 'customer_credit_refund' as const, { amountMinor: '10' }],
    [
      'settlement missing reason',
      'customer_receivable_settlement' as const,
      { amountMinor: '10', allocationMode: 'fifo' },
    ],
  ])('rejects %s', (_name, family, invalidReplacement) => {
    expect(() =>
      parseCustomerFinancialEditCommand(
        family,
        ids.customer,
        ids.target,
        editBody(family, { replacement: invalidReplacement }),
      ),
    ).toThrow(BadRequestException);
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['decimal', '1.5'],
    ['overflow', '9223372036854775808'],
  ])('rejects %s replacement money', (_name, amountMinor) => {
    expect(() =>
      parseCustomerFinancialEditCommand(
        'customer_credit_refund',
        ids.customer,
        ids.target,
        editBody('customer_credit_refund', {
          replacement: { amountMinor, moneyAccountId: ids.account },
        }),
      ),
    ).toThrow(BadRequestException);
  });
});
