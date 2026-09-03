import { isUUID } from 'class-validator';

import {
  moneyMovementTypes,
  ownerLedgerEntryTypes,
  type MoneyMovementTypeValue,
  type OwnerLedgerEntryTypeValue,
} from '../database/schema/ledger';
import type { PostedMoneyMovement } from '../money-movements/money-movement.types';
import type { OwnerLedgerMutationResponse, PostedOwnerLedgerEntry } from './owner-ledger.types';

const integerStringPattern = /^-?(0|[1-9]\d*)$/;
const nonZeroIntegerStringPattern = /^-?[1-9]\d*$/;
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

function isEntryType(value: unknown): value is OwnerLedgerEntryTypeValue {
  return typeof value === 'string' && (ownerLedgerEntryTypes as readonly string[]).includes(value);
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
    !nonZeroIntegerStringPattern.test(value.amountDeltaMinor) ||
    typeof value.transactionGroupId !== 'string' ||
    !isUUID(value.transactionGroupId) ||
    typeof value.operationId !== 'string' ||
    !isUUID(value.operationId) ||
    !isIsoDate(value.occurredAt) ||
    !isIsoDate(value.createdAt)
  ) {
    throw new Error('Stored owner-ledger response is invalid.');
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

function parseOwnerEntry(value: unknown): PostedOwnerLedgerEntry {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !isUUID(value.id) ||
    !isEntryType(value.entryType) ||
    typeof value.ownerLiabilityDeltaMinor !== 'string' ||
    !integerStringPattern.test(value.ownerLiabilityDeltaMinor) ||
    typeof value.equityDeltaMinor !== 'string' ||
    !integerStringPattern.test(value.equityDeltaMinor) ||
    (value.ownerLiabilityDeltaMinor === '0' && value.equityDeltaMinor === '0') ||
    (value.moneyAccountId !== null &&
      (typeof value.moneyAccountId !== 'string' || !isUUID(value.moneyAccountId))) ||
    typeof value.transactionGroupId !== 'string' ||
    !isUUID(value.transactionGroupId) ||
    typeof value.operationId !== 'string' ||
    !isUUID(value.operationId) ||
    !isIsoDate(value.occurredAt) ||
    !isIsoDate(value.createdAt)
  ) {
    throw new Error('Stored owner-ledger response is invalid.');
  }
  return {
    id: value.id,
    entryType: value.entryType,
    ownerLiabilityDeltaMinor: value.ownerLiabilityDeltaMinor,
    equityDeltaMinor: value.equityDeltaMinor,
    moneyAccountId: value.moneyAccountId,
    transactionGroupId: value.transactionGroupId,
    operationId: value.operationId,
    occurredAt: value.occurredAt,
    createdAt: value.createdAt,
  };
}

export function parseStoredOwnerLedgerMutationResponse(
  value: unknown,
): OwnerLedgerMutationResponse {
  if (
    !isRecord(value) ||
    typeof value.operationId !== 'string' ||
    !isUUID(value.operationId) ||
    typeof value.postingDate !== 'string' ||
    !businessDatePattern.test(value.postingDate) ||
    typeof value.accountingPeriodId !== 'string' ||
    !isUUID(value.accountingPeriodId) ||
    !Array.isArray(value.movements) ||
    !Array.isArray(value.ownerEntries)
  ) {
    throw new Error('Stored owner-ledger response is invalid.');
  }
  return {
    operationId: value.operationId,
    postingDate: value.postingDate,
    accountingPeriodId: value.accountingPeriodId,
    movements: value.movements.map(parseMovement),
    ownerEntries: value.ownerEntries.map(parseOwnerEntry),
  };
}
