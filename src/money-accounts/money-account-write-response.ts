import { isUUID } from 'class-validator';

import type {
  MoneyAccountMutationResponse,
  MoneyAccountMutationRow,
} from './money-account-write.types';

const positiveDecimalPattern = /^[1-9]\d*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

export function mapMoneyAccountMutationResponse(
  row: MoneyAccountMutationRow,
  operationId: string,
): MoneyAccountMutationResponse {
  if (row.accountType !== 'transfer' || row.availability !== 'available' || row.isDefault) {
    throw new Error('Money Account public mutation projection invariant violated.');
  }

  return {
    id: row.id,
    name: row.name,
    accountType: row.accountType,
    isDefault: row.isDefault,
    status: row.status,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version.toString(),
    operationId,
  };
}

export function parseStoredMoneyAccountMutationResponse(
  value: unknown,
): MoneyAccountMutationResponse {
  if (!isRecord(value)) {
    throw new Error('Stored Money Account mutation response is invalid.');
  }

  const status = value.status;
  const archivedAt = value.archivedAt;
  if (
    typeof value.id !== 'string' ||
    !isUUID(value.id) ||
    typeof value.name !== 'string' ||
    value.accountType !== 'transfer' ||
    value.isDefault !== false ||
    (status !== 'active' && status !== 'archived') ||
    (archivedAt !== null && !isIsoDate(archivedAt)) ||
    !isIsoDate(value.createdAt) ||
    !isIsoDate(value.updatedAt) ||
    typeof value.version !== 'string' ||
    !positiveDecimalPattern.test(value.version) ||
    typeof value.operationId !== 'string' ||
    !isUUID(value.operationId)
  ) {
    throw new Error('Stored Money Account mutation response is invalid.');
  }

  return {
    id: value.id,
    name: value.name,
    accountType: value.accountType,
    isDefault: value.isDefault,
    status,
    archivedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    version: value.version,
    operationId: value.operationId,
  };
}
