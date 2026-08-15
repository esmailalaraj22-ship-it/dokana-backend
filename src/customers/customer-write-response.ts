import { isCustomerId, isCustomerOperationId } from './customer-identifiers';
import type { CustomerMutationResponse, CustomerMutationRow } from './customer-write.types';

const positiveDecimalPattern = /^[1-9]\d*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

export function mapCustomerMutationResponse(row: CustomerMutationRow): CustomerMutationResponse {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    status: row.status,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    version: row.version.toString(),
    operationId: row.operationId,
  };
}

export function parseStoredCustomerMutationResponse(value: unknown): CustomerMutationResponse {
  if (!isRecord(value)) {
    throw new Error('Stored Customer mutation response is invalid.');
  }

  const status = value.status;
  const archivedAt = value.archivedAt;
  if (
    typeof value.id !== 'string' ||
    !isCustomerId(value.id) ||
    typeof value.name !== 'string' ||
    typeof value.phone !== 'string' ||
    (status !== 'active' && status !== 'archived') ||
    (archivedAt !== null && !isIsoDate(archivedAt)) ||
    !isIsoDate(value.updatedAt) ||
    (value.notes !== null && typeof value.notes !== 'string') ||
    !isIsoDate(value.createdAt) ||
    typeof value.version !== 'string' ||
    !positiveDecimalPattern.test(value.version) ||
    typeof value.operationId !== 'string' ||
    !isCustomerOperationId(value.operationId)
  ) {
    throw new Error('Stored Customer mutation response is invalid.');
  }

  return {
    id: value.id,
    name: value.name,
    phone: value.phone,
    status,
    archivedAt,
    updatedAt: value.updatedAt,
    notes: value.notes,
    createdAt: value.createdAt,
    version: value.version,
    operationId: value.operationId,
  };
}
