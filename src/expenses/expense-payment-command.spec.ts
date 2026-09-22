import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { parseExpensePaymentCommand } from './expense-payment-command';

const expenseId = randomUUID();
const base = {
  operationId: randomUUID(),
  paymentSource: 'money_account' as const,
  moneyAccountId: randomUUID(),
  amountMinor: '200',
  occurredAt: '2026-10-15T10:00:00Z',
  notes: 'Partial settlement',
};

describe('Expense Payment command', () => {
  it('parses one Money Account-funded payment with exact bigint money', () => {
    expect(parseExpensePaymentCommand(expenseId, base)).toMatchObject({
      expenseId,
      paymentSource: 'money_account',
      moneyAccountId: base.moneyAccountId,
      amountMinor: 200n,
    });
  });

  it('parses one Owner-funded payment without a fake Money Account', () => {
    expect(
      parseExpensePaymentCommand(expenseId, {
        ...base,
        paymentSource: 'owner_pocket',
        moneyAccountId: undefined,
      }),
    ).toMatchObject({ paymentSource: 'owner_pocket', moneyAccountId: null });
  });

  it('rejects zero, negative, floating, and PostgreSQL bigint overflow amounts', () => {
    for (const amountMinor of ['0', '-1', '1.5', '9223372036854775808']) {
      expect(() => parseExpensePaymentCommand(expenseId, { ...base, amountMinor })).toThrow(
        BadRequestException,
      );
    }
  });

  it('preserves amounts beyond the JavaScript safe integer range', () => {
    expect(
      parseExpensePaymentCommand(expenseId, {
        ...base,
        amountMinor: '9007199254740993',
      }).amountMinor,
    ).toBe(9_007_199_254_740_993n);
  });

  it('rejects missing, incompatible, split, and mixed funding intent', () => {
    for (const body of [
      { ...base, moneyAccountId: undefined },
      { ...base, paymentSource: 'owner_pocket' },
      { ...base, funding: [{ moneyAccountId: base.moneyAccountId, amountMinor: '200' }] },
      { ...base, ownerAmountMinor: '100' },
      { ...base, expenseIds: [expenseId] },
    ]) {
      expect(() => parseExpensePaymentCommand(expenseId, body)).toThrow(BadRequestException);
    }
  });

  it('canonicalizes semantic equivalents and fingerprints every material change', () => {
    const original = parseExpensePaymentCommand(expenseId, base);
    const equivalent = parseExpensePaymentCommand(expenseId.toUpperCase(), {
      ...base,
      operationId: base.operationId.toUpperCase(),
      moneyAccountId: base.moneyAccountId.toUpperCase(),
      occurredAt: '2026-10-15T12:00:00+02:00',
      notes: ' Partial settlement ',
    });
    expect(equivalent.requestHash).toBe(original.requestHash);

    for (const change of [
      { amountMinor: '201' },
      { moneyAccountId: randomUUID() },
      { occurredAt: '2026-10-16T10:00:00Z' },
      { notes: 'Different' },
    ]) {
      expect(parseExpensePaymentCommand(expenseId, { ...base, ...change }).requestHash).not.toBe(
        original.requestHash,
      );
    }
    expect(parseExpensePaymentCommand(randomUUID(), base).requestHash).not.toBe(
      original.requestHash,
    );
  });
});
