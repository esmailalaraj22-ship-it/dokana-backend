import { BadRequestException } from '@nestjs/common';

import {
  parseExpenseCancelCommand,
  parseExpenseEditCommand,
  parseExpensePaymentCancelCommand,
  parseExpensePaymentEditCommand,
} from './expense-correction-command';

const ids = {
  target: '9f97bb10-b68a-4474-888e-7244fc581bcb',
  operation: 'a417fabd-b3c8-409c-9db3-2d62fdce21fd',
  expense: '59e90f52-05aa-4bf4-af84-242686f712a8',
  category: '18dcbf0a-acbe-48d6-88ed-cd1b078ddf41',
  account: '5d791456-eeb5-4e8a-9f21-f76cb0b26a11',
  alternate: 'c3b4524e-0f87-46f2-8115-06bb9933d46b',
} as const;
const occurredAt = '2026-09-20T10:00:00Z';

function cancelBody(overrides: Record<string, unknown> = {}) {
  return { operationId: ids.operation, occurredAt, reason: 'Correct entry', ...overrides };
}

function recognitionReplacement(
  mode: 'DUE' | 'MONEY_PAID' | 'OWNER_FUNDED',
): Record<string, unknown> {
  return {
    id: ids.expense,
    categoryId: ids.category,
    description: 'Corrected expense',
    amountMinor: '500',
    occurredAt: '2026-09-21T10:00:00Z',
    ...(mode === 'DUE' ? { dueAt: '2026-10-01T10:00:00Z' } : {}),
    mode,
    ...(mode === 'MONEY_PAID' ? { moneyAccountId: ids.account } : {}),
    notes: 'Replacement',
  };
}

function paymentReplacement(source: 'money_account' | 'owner_pocket'): Record<string, unknown> {
  return {
    expenseId: ids.expense,
    paymentSource: source,
    ...(source === 'money_account' ? { moneyAccountId: ids.account } : {}),
    amountMinor: '200',
    occurredAt: '2026-09-21T10:00:00Z',
    notes: 'Replacement',
  };
}

describe('Expense correction commands', () => {
  it('parses an Expense cancellation with a required reason', () => {
    expect(parseExpenseCancelCommand(ids.target, cancelBody())).toMatchObject({
      aggregate: 'expense',
      kind: 'cancel',
      targetOperationId: ids.target,
      reason: 'Correct entry',
    });
  });

  it('parses an Expense Payment cancellation with a required reason', () => {
    expect(parseExpensePaymentCancelCommand(ids.target, cancelBody())).toMatchObject({
      aggregate: 'expense_payment',
      kind: 'cancel',
      targetOperationId: ids.target,
    });
  });

  it.each([
    ['DUE to DUE', 'DUE'],
    ['DUE to MONEY_PAID', 'MONEY_PAID'],
    ['DUE to OWNER_FUNDED', 'OWNER_FUNDED'],
    ['MONEY_PAID to DUE', 'DUE'],
    ['OWNER_FUNDED to MONEY_PAID', 'MONEY_PAID'],
  ] as const)('parses recognition-mode replacement: %s', (_label, mode) => {
    const command = parseExpenseEditCommand(ids.target, {
      ...cancelBody(),
      replacement: recognitionReplacement(mode),
    });
    expect(command.replacement.mode).toBe(mode);
    expect(command.replacement.operationId).toBe(ids.operation);
  });

  it.each(['money_account', 'owner_pocket'] as const)(
    'parses %s Expense Payment replacement',
    (source) => {
      const command = parseExpensePaymentEditCommand(ids.target, {
        ...cancelBody(),
        replacement: paymentReplacement(source),
      });
      expect(command.replacement.paymentSource).toBe(source);
      expect(command.replacement.expenseId).toBe(ids.expense);
    },
  );

  it('canonicalizes target, operation, Expense, Category, and Money Account UUIDs', () => {
    const command = parseExpenseEditCommand(ids.target.toUpperCase(), {
      ...cancelBody({ operationId: ids.operation.toUpperCase() }),
      replacement: Object.fromEntries(
        Object.entries(recognitionReplacement('MONEY_PAID')).map(([key, value]) => [
          key,
          typeof value === 'string' &&
          [ids.expense, ids.category, ids.account].includes(value as never)
            ? value.toUpperCase()
            : value,
        ]),
      ),
    });
    expect(command.targetOperationId).toBe(ids.target);
    expect(command.operationId).toBe(ids.operation);
    expect(command.replacement.expenseId).toBe(ids.expense);
    expect(command.replacement.categoryId).toBe(ids.category);
    expect(command.replacement.moneyAccountId).toBe(ids.account);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['NUL', 'bad\0reason'],
  ])('rejects %s correction reason', (_label, value) => {
    const body: Record<string, unknown> = cancelBody();
    if (value === undefined) delete body.reason;
    else body.reason = value;
    expect(() => parseExpenseCancelCommand(ids.target, body)).toThrow(BadRequestException);
  });

  it.each([
    ['invalid target UUID', 'invalid', cancelBody()],
    ['invalid operation UUID', ids.target, cancelBody({ operationId: 'invalid' })],
    ['invalid occurrence instant', ids.target, cancelBody({ occurredAt: '2026-09-20' })],
    ['unexpected cancellation field', ids.target, cancelBody({ amountMinor: '1' })],
    ['non-object body', ids.target, null],
  ])('rejects %s', (_label, target, body) => {
    expect(() => parseExpenseCancelCommand(target, body)).toThrow(BadRequestException);
  });

  it.each([
    ['Expense', parseExpenseEditCommand, recognitionReplacement('DUE')],
    ['Expense Payment', parseExpensePaymentEditCommand, paymentReplacement('money_account')],
  ] as const)('rejects embedded replacement operationId for %s', (_label, parser, replacement) => {
    expect(() =>
      parser(ids.target, {
        ...cancelBody(),
        replacement: { ...replacement, operationId: ids.alternate },
      }),
    ).toThrow(BadRequestException);
  });

  it.each([
    ['missing Expense replacement', { ...cancelBody() }],
    [
      'missing replacement Expense ID',
      { ...cancelBody(), replacement: { ...recognitionReplacement('DUE'), id: undefined } },
    ],
    [
      'archival-style zero amount',
      { ...cancelBody(), replacement: { ...recognitionReplacement('DUE'), amountMinor: '0' } },
    ],
    [
      'MONEY_PAID without account',
      {
        ...cancelBody(),
        replacement: { ...recognitionReplacement('MONEY_PAID'), moneyAccountId: undefined },
      },
    ],
    [
      'OWNER_FUNDED with account',
      {
        ...cancelBody(),
        replacement: { ...recognitionReplacement('OWNER_FUNDED'), moneyAccountId: ids.account },
      },
    ],
    [
      'DUE without a valid due instant',
      { ...cancelBody(), replacement: { ...recognitionReplacement('DUE'), dueAt: 'later' } },
    ],
  ])('rejects malformed Expense replacement: %s', (_label, body) => {
    expect(() => parseExpenseEditCommand(ids.target, body)).toThrow(BadRequestException);
  });

  it.each([
    [
      'missing replacement Expense ID',
      { ...paymentReplacement('money_account'), expenseId: undefined },
    ],
    [
      'money payment without account',
      { ...paymentReplacement('money_account'), moneyAccountId: undefined },
    ],
    [
      'owner payment with account',
      { ...paymentReplacement('owner_pocket'), moneyAccountId: ids.account },
    ],
    ['zero amount', { ...paymentReplacement('money_account'), amountMinor: '0' }],
    ['numeric amount', { ...paymentReplacement('money_account'), amountMinor: 200 }],
    ['unexpected field', { ...paymentReplacement('money_account'), split: true }],
  ])('rejects malformed Expense Payment replacement: %s', (_label, replacement) => {
    expect(() =>
      parseExpensePaymentEditCommand(ids.target, { ...cancelBody(), replacement }),
    ).toThrow(BadRequestException);
  });

  it.each([
    ['target', ids.alternate, undefined],
    ['reason', ids.target, { reason: 'Different reason' }],
    ['correction occurrence', ids.target, { occurredAt: '2026-09-22T10:00:00Z' }],
    ['replacement amount', ids.target, { replacement: { amountMinor: '501' } }],
    ['replacement category', ids.target, { replacement: { categoryId: ids.alternate } }],
    [
      'replacement mode',
      ids.target,
      { replacement: { mode: 'OWNER_FUNDED', moneyAccountId: undefined } },
    ],
    ['replacement account', ids.target, { replacement: { moneyAccountId: ids.alternate } }],
    ['replacement description', ids.target, { replacement: { description: 'Different' } }],
    ['replacement occurrence', ids.target, { replacement: { occurredAt: '2026-09-23T10:00:00Z' } }],
  ])('fingerprints material Expense correction change: %s', (_label, target, change) => {
    const baseReplacement = recognitionReplacement('MONEY_PAID');
    const base = parseExpenseEditCommand(ids.target, {
      ...cancelBody(),
      replacement: baseReplacement,
    });
    const bodyChange = change ?? {};
    const replacementChange =
      'replacement' in bodyChange && typeof bodyChange.replacement === 'object'
        ? bodyChange.replacement
        : {};
    const changed = parseExpenseEditCommand(target, {
      ...cancelBody(bodyChange),
      replacement: { ...baseReplacement, ...replacementChange },
    });
    expect(changed.requestHash).not.toBe(base.requestHash);
  });

  it('produces a stable hash for the same canonical correction', () => {
    const body = { ...cancelBody(), replacement: paymentReplacement('money_account') };
    expect(parseExpensePaymentEditCommand(ids.target, body).requestHash).toBe(
      parseExpensePaymentEditCommand(ids.target, body).requestHash,
    );
  });

  it('preserves a replacement amount beyond the JavaScript safe integer range', () => {
    const replacement = { ...paymentReplacement('money_account'), amountMinor: '9007199254740993' };
    expect(
      parseExpensePaymentEditCommand(ids.target, { ...cancelBody(), replacement }).replacement
        .amountMinor,
    ).toBe(9_007_199_254_740_993n);
  });
});
