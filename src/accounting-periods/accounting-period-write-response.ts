import { isUUID } from 'class-validator';

import type {
  AccountingPeriodMutationResponse,
  AccountingPeriodMutationRow,
} from './accounting-period-write.types';

const positiveDecimalPattern = /^[1-9]\d*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

export function mapAccountingPeriodMutationResponse(
  row: AccountingPeriodMutationRow,
  operationId: string,
): AccountingPeriodMutationResponse {
  if (row.status !== 'closed' || row.closedAt === null) {
    throw new Error('Accounting Period close response invariant violated.');
  }

  return {
    id: row.id,
    periodYear: row.periodYear,
    periodMonth: row.periodMonth,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    status: row.status,
    closedAt: row.closedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version.toString(),
    operationId,
  };
}

export function parseStoredAccountingPeriodMutationResponse(
  value: unknown,
): AccountingPeriodMutationResponse {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !isUUID(value.id) ||
    typeof value.periodYear !== 'number' ||
    !Number.isInteger(value.periodYear) ||
    typeof value.periodMonth !== 'number' ||
    !Number.isInteger(value.periodMonth) ||
    !isIsoDate(value.startsAt) ||
    !isIsoDate(value.endsAt) ||
    value.status !== 'closed' ||
    !isIsoDate(value.closedAt) ||
    !isIsoDate(value.createdAt) ||
    !isIsoDate(value.updatedAt) ||
    typeof value.version !== 'string' ||
    !positiveDecimalPattern.test(value.version) ||
    typeof value.operationId !== 'string' ||
    !isUUID(value.operationId)
  ) {
    throw new Error('Stored Accounting Period close response is invalid.');
  }

  return {
    id: value.id,
    periodYear: value.periodYear,
    periodMonth: value.periodMonth,
    startsAt: value.startsAt,
    endsAt: value.endsAt,
    status: value.status,
    closedAt: value.closedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    version: value.version,
    operationId: value.operationId,
  };
}
