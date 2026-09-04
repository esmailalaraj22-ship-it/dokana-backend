import { isUUID } from 'class-validator';

import { moneyMovementTypes, type MoneyMovementTypeValue } from '../database/schema/ledger';
import {
  deriveMoneyFactId,
  deriveMoneyFactOperationId,
} from '../money-movements/money-movement-identity';
import type { PostedMoneyMovement } from '../money-movements/money-movement.types';
import type { MoneyTransferMutationResponse, PostedMoneyTransfer } from './money-transfer.types';

const positiveIntegerStringPattern = /^[1-9]\d*$/;
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
    throw new Error('Stored Money Transfer response is invalid.');
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

function parseTransfer(value: unknown): PostedMoneyTransfer {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !isUUID(value.id) ||
    typeof value.displayNumber !== 'string' ||
    value.displayNumber.length === 0 ||
    typeof value.sourceAccountId !== 'string' ||
    !isUUID(value.sourceAccountId) ||
    typeof value.destinationAccountId !== 'string' ||
    !isUUID(value.destinationAccountId) ||
    value.sourceAccountId === value.destinationAccountId ||
    typeof value.amountMinor !== 'string' ||
    !positiveIntegerStringPattern.test(value.amountMinor) ||
    !isIsoDate(value.transferAt) ||
    typeof value.sourceMovementId !== 'string' ||
    !isUUID(value.sourceMovementId) ||
    typeof value.destinationMovementId !== 'string' ||
    !isUUID(value.destinationMovementId) ||
    value.sourceMovementId === value.destinationMovementId ||
    value.status !== 'posted' ||
    typeof value.operationId !== 'string' ||
    !isUUID(value.operationId) ||
    !isIsoDate(value.createdAt) ||
    !isIsoDate(value.updatedAt) ||
    typeof value.version !== 'string' ||
    !positiveIntegerStringPattern.test(value.version)
  ) {
    throw new Error('Stored Money Transfer response is invalid.');
  }
  return {
    id: value.id,
    displayNumber: value.displayNumber,
    sourceAccountId: value.sourceAccountId,
    destinationAccountId: value.destinationAccountId,
    amountMinor: value.amountMinor,
    transferAt: value.transferAt,
    sourceMovementId: value.sourceMovementId,
    destinationMovementId: value.destinationMovementId,
    status: value.status,
    operationId: value.operationId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    version: value.version,
  };
}

export function parseStoredMoneyTransferMutationResponse(
  value: unknown,
): MoneyTransferMutationResponse {
  if (
    !isRecord(value) ||
    typeof value.operationId !== 'string' ||
    !isUUID(value.operationId) ||
    typeof value.postingDate !== 'string' ||
    !businessDatePattern.test(value.postingDate) ||
    typeof value.accountingPeriodId !== 'string' ||
    !isUUID(value.accountingPeriodId) ||
    !Array.isArray(value.movements) ||
    value.movements.length !== 2
  ) {
    throw new Error('Stored Money Transfer response is invalid.');
  }

  const transfer = parseTransfer(value.transfer);
  const source = parseMovement(value.movements[0]);
  const destination = parseMovement(value.movements[1]);
  const expectedHeaderId = deriveMoneyFactId(value.operationId, 'transfer-header');
  const expectedSourceId = deriveMoneyFactId(value.operationId, 'transfer-source');
  const expectedDestinationId = deriveMoneyFactId(value.operationId, 'transfer-destination');

  if (
    transfer.id !== expectedHeaderId ||
    transfer.operationId !== deriveMoneyFactOperationId(value.operationId, 'transfer-header') ||
    transfer.sourceMovementId !== expectedSourceId ||
    transfer.destinationMovementId !== expectedDestinationId ||
    source.id !== expectedSourceId ||
    source.operationId !== deriveMoneyFactOperationId(value.operationId, 'transfer-source') ||
    source.accountId !== transfer.sourceAccountId ||
    source.accountingPeriodId !== value.accountingPeriodId ||
    source.movementType !== 'internal_transfer' ||
    source.amountDeltaMinor !== `-${transfer.amountMinor}` ||
    source.transactionGroupId !== value.operationId ||
    source.occurredAt !== transfer.transferAt ||
    destination.id !== expectedDestinationId ||
    destination.operationId !==
      deriveMoneyFactOperationId(value.operationId, 'transfer-destination') ||
    destination.accountId !== transfer.destinationAccountId ||
    destination.accountingPeriodId !== value.accountingPeriodId ||
    destination.movementType !== 'internal_transfer' ||
    destination.amountDeltaMinor !== transfer.amountMinor ||
    destination.transactionGroupId !== value.operationId ||
    destination.occurredAt !== transfer.transferAt
  ) {
    throw new Error('Stored Money Transfer response is invalid.');
  }

  return {
    operationId: value.operationId,
    postingDate: value.postingDate,
    accountingPeriodId: value.accountingPeriodId,
    transfer,
    movements: [source, destination],
  };
}
