import { isUUID } from 'class-validator';

import { moneyMovementTypes, type MoneyMovementTypeValue } from '../database/schema/ledger';
import type { MoneyMovementPostingResponse, PostedMoneyMovement } from './money-movement.types';

const integerStringPattern = /^-?(0|[1-9]\d*)$/;
const businessDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isMovementType(value: unknown): value is MoneyMovementTypeValue {
  return typeof value === 'string' && (moneyMovementTypes as readonly string[]).includes(value);
}

function parseMovement(value: unknown): PostedMoneyMovement {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !isUUID(value.id) ||
    typeof value.accountId !== 'string' ||
    !isUUID(value.accountId) ||
    typeof value.accountingPeriodId !== 'string' ||
    !isUUID(value.accountingPeriodId) ||
    !isMovementType(value.movementType) ||
    typeof value.amountDeltaMinor !== 'string' ||
    !integerStringPattern.test(value.amountDeltaMinor) ||
    value.amountDeltaMinor === '0' ||
    typeof value.transactionGroupId !== 'string' ||
    !isUUID(value.transactionGroupId) ||
    typeof value.operationId !== 'string' ||
    !isUUID(value.operationId) ||
    !isIsoDate(value.occurredAt) ||
    !isIsoDate(value.createdAt)
  ) {
    throw new Error('Stored Money Movement posting response is invalid.');
  }
  return {
    id: value.id,
    accountId: value.accountId,
    accountingPeriodId: value.accountingPeriodId,
    movementType: value.movementType,
    amountDeltaMinor: value.amountDeltaMinor,
    transactionGroupId: value.transactionGroupId,
    operationId: value.operationId,
    occurredAt: value.occurredAt,
    createdAt: value.createdAt,
  };
}

export function parseStoredMoneyMovementPostingResponse(
  value: unknown,
): MoneyMovementPostingResponse {
  if (
    !isRecord(value) ||
    typeof value.operationId !== 'string' ||
    !isUUID(value.operationId) ||
    typeof value.postingDate !== 'string' ||
    !businessDatePattern.test(value.postingDate) ||
    typeof value.accountingPeriodId !== 'string' ||
    !isUUID(value.accountingPeriodId) ||
    !Array.isArray(value.movements) ||
    value.movements.length === 0
  ) {
    throw new Error('Stored Money Movement posting response is invalid.');
  }
  return {
    operationId: value.operationId,
    postingDate: value.postingDate,
    accountingPeriodId: value.accountingPeriodId,
    movements: value.movements.map(parseMovement),
  };
}
