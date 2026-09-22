import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { parseExpenseRecognitionCommand } from './expense-recognition-command';

const base = {
  id: randomUUID(),
  operationId: randomUUID(),
  categoryId: randomUUID(),
  description: 'Electricity',
  amountMinor: '500',
  occurredAt: '2026-09-15T10:00:00Z',
  mode: 'DUE' as const,
  dueAt: '2026-10-01T10:00:00Z',
  notes: 'September bill',
};

describe('Expense recognition command', () => {
  it('parses DUE intent without a funding effect', () => {
    expect(parseExpenseRecognitionCommand(base)).toMatchObject({
      expenseId: base.id,
      categoryId: base.categoryId,
      amountMinor: 500n,
      mode: 'DUE',
      moneyAccountId: null,
    });
  });

  it('accepts exactly one Money Account for MONEY_PAID', () => {
    const moneyAccountId = randomUUID();
    const parsed = parseExpenseRecognitionCommand({
      ...base,
      mode: 'MONEY_PAID',
      dueAt: undefined,
      moneyAccountId,
    });
    expect(parsed).toMatchObject({ mode: 'MONEY_PAID', moneyAccountId });
  });

  it('accepts OWNER_FUNDED without a fake Money Account', () => {
    const parsed = parseExpenseRecognitionCommand({
      ...base,
      mode: 'OWNER_FUNDED',
      dueAt: undefined,
    });
    expect(parsed).toMatchObject({ mode: 'OWNER_FUNDED', moneyAccountId: null });
  });

  it('rejects partial, mixed, missing, and incompatible funding input', () => {
    for (const body of [
      { ...base, paidMinor: '200' },
      { ...base, mode: 'MONEY_PAID', dueAt: undefined },
      { ...base, moneyAccountId: randomUUID() },
      { ...base, mode: 'OWNER_FUNDED', dueAt: undefined, moneyAccountId: randomUUID() },
      { ...base, mode: 'MONEY_PAID', dueAt: base.dueAt, moneyAccountId: randomUUID() },
    ]) {
      expect(() => parseExpenseRecognitionCommand(body)).toThrow(BadRequestException);
    }
  });

  it('rejects zero, negative, floating, and PostgreSQL bigint overflow amounts', () => {
    for (const amountMinor of ['0', '-1', '1.5', '9223372036854775808']) {
      expect(() => parseExpenseRecognitionCommand({ ...base, amountMinor })).toThrow(
        BadRequestException,
      );
    }
  });

  it('preserves bigint values beyond JavaScript safe integer range', () => {
    expect(
      parseExpenseRecognitionCommand({ ...base, amountMinor: '9007199254740993' }).amountMinor,
    ).toBe(9_007_199_254_740_993n);
  });

  it('canonicalizes semantic equivalents and fingerprints material changes', () => {
    const original = parseExpenseRecognitionCommand(base);
    const equivalent = parseExpenseRecognitionCommand({
      ...base,
      id: base.id.toUpperCase(),
      operationId: base.operationId.toUpperCase(),
      categoryId: base.categoryId.toUpperCase(),
      description: ' Electricity ',
      occurredAt: '2026-09-15T12:00:00+02:00',
      dueAt: '2026-10-01T12:00:00+02:00',
      notes: ' September bill ',
    });
    expect(equivalent.requestHash).toBe(original.requestHash);
    for (const change of [
      { amountMinor: '501' },
      { categoryId: randomUUID() },
      { description: 'Rent' },
      { dueAt: null },
    ]) {
      expect(parseExpenseRecognitionCommand({ ...base, ...change }).requestHash).not.toBe(
        original.requestHash,
      );
    }
  });
});
