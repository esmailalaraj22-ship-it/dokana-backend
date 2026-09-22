import { isUUID } from 'class-validator';

import {
  canonicalizeMoneyAccountNameV1,
  MoneyAccountNameValidationError,
} from '../money-accounts/money-account-normalization';

export type ExpenseValidationField =
  'id' | 'expenseId' | 'expenseCategoryId' | 'operationId' | 'name' | 'description' | 'notes';

export type ExpenseValidationErrorCode =
  'EXPENSE_UUID_INVALID' | 'EXPENSE_TEXT_INVALID' | 'EXPENSE_TEXT_EMPTY';

export class ExpenseValidationError extends Error {
  constructor(
    readonly code: ExpenseValidationErrorCode,
    readonly field: ExpenseValidationField,
  ) {
    super('Expense input is invalid.');
    this.name = 'ExpenseValidationError';
  }
}

export function canonicalizeExpenseUuid(
  value: unknown,
  field: Extract<ExpenseValidationField, 'id' | 'expenseId' | 'expenseCategoryId' | 'operationId'>,
): string {
  if (typeof value !== 'string' || !isUUID(value)) {
    throw new ExpenseValidationError('EXPENSE_UUID_INVALID', field);
  }
  return value.toLowerCase();
}

export function canonicalizeExpenseCategoryName(value: unknown): {
  name: string;
  normalizedName: string;
} {
  try {
    return canonicalizeMoneyAccountNameV1(value);
  } catch (error) {
    if (error instanceof MoneyAccountNameValidationError) {
      throw new ExpenseValidationError(
        error.code.endsWith('_EMPTY') ? 'EXPENSE_TEXT_EMPTY' : 'EXPENSE_TEXT_INVALID',
        'name',
      );
    }
    throw error;
  }
}

export function canonicalizeExpenseText(
  value: unknown,
  field: Extract<ExpenseValidationField, 'description' | 'notes'>,
  options: { nullable: boolean; maximum: number },
): string | null {
  if (value === null && options.nullable) return null;
  if (typeof value !== 'string' || value.includes('\0') || !isWellFormedUnicode(value)) {
    throw new ExpenseValidationError('EXPENSE_TEXT_INVALID', field);
  }
  const text = value.trim();
  if (text.length === 0 || text.length > options.maximum) {
    throw new ExpenseValidationError('EXPENSE_TEXT_EMPTY', field);
  }
  return text;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
