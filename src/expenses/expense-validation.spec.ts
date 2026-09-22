import { randomUUID } from 'node:crypto';

import {
  canonicalizeExpenseCategoryName,
  canonicalizeExpenseUuid,
  ExpenseValidationError,
} from './expense-validation';

describe('Expense Category validation', () => {
  it('uses the established deterministic catalog-name normalization', () => {
    expect(canonicalizeExpenseCategoryName('  Office\u00a0  Supplies  ')).toEqual({
      name: 'Office Supplies',
      normalizedName: 'office supplies',
    });
  });

  it('rejects empty and PostgreSQL-unrepresentable names', () => {
    expect(() => canonicalizeExpenseCategoryName(' \t ')).toThrow(ExpenseValidationError);
    expect(() => canonicalizeExpenseCategoryName('bad\0name')).toThrow(ExpenseValidationError);
  });

  it('canonicalizes UUIDs without replacing accepted client identity', () => {
    const value = randomUUID();
    expect(canonicalizeExpenseUuid(value.toUpperCase(), 'id')).toBe(value);
  });
});
