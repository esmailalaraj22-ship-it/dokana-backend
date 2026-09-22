import { isUUID } from 'class-validator';

import type {
  ExpenseCategoryMutationResponse,
  ExpenseCategoryResponse,
  ExpenseCategoryRow,
} from './expense-category.types';

const positiveInteger = /^[1-9]\d*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mapExpenseCategory(row: ExpenseCategoryRow): ExpenseCategoryResponse {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version.toString(),
  };
}

export function mapExpenseCategoryMutation(
  row: ExpenseCategoryRow,
  operationId: string,
): ExpenseCategoryMutationResponse {
  return { ...mapExpenseCategory(row), operationId };
}

export function parseStoredExpenseCategoryMutation(
  value: unknown,
): ExpenseCategoryMutationResponse {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !isUUID(value.id) ||
    typeof value.name !== 'string' ||
    (value.status !== 'active' && value.status !== 'archived') ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    typeof value.version !== 'string' ||
    !positiveInteger.test(value.version) ||
    typeof value.operationId !== 'string' ||
    !isUUID(value.operationId)
  ) {
    throw new Error('Stored Expense Category response is invalid.');
  }
  return {
    id: value.id,
    name: value.name,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    version: value.version,
    operationId: value.operationId,
  };
}
