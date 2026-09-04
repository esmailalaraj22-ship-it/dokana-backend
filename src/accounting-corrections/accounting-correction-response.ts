import { isUUID } from 'class-validator';

import {
  deriveMoneyFactId,
  deriveMoneyFactOperationId,
} from '../money-movements/money-movement-identity';
import type { PostedMoneyTransfer } from '../money-transfers/money-transfer.types';
import { accountingCorrectionDomains } from './accounting-correction.types';
import type {
  AccountingCorrectionDomain,
  AccountingCorrectionKind,
  AccountingCorrectionMutationResponse,
  CorrectionPostedMoneyMovement,
  CorrectionPostedOwnerEntry,
} from './accounting-correction.types';

const businessDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const integerPattern = /^-?(0|[1-9]\d*)$/;
const nonZeroIntegerPattern = /^-?[1-9]\d*$/;
const positiveIntegerPattern = /^[1-9]\d*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function invalidStoredResponse(): never {
  throw new Error('Stored accounting-correction response is invalid.');
}

function parseMovement(value: unknown): CorrectionPostedMoneyMovement {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !isUUID(value.id) ||
    typeof value.accountId !== 'string' ||
    !isUUID(value.accountId) ||
    typeof value.accountingPeriodId !== 'string' ||
    !isUUID(value.accountingPeriodId) ||
    value.movementType !== 'correction' ||
    typeof value.amountDeltaMinor !== 'string' ||
    !nonZeroIntegerPattern.test(value.amountDeltaMinor) ||
    typeof value.transactionGroupId !== 'string' ||
    !isUUID(value.transactionGroupId) ||
    typeof value.operationId !== 'string' ||
    !isUUID(value.operationId) ||
    !isIsoInstant(value.occurredAt) ||
    !isIsoInstant(value.createdAt) ||
    (value.reversalOfId !== null &&
      (typeof value.reversalOfId !== 'string' || !isUUID(value.reversalOfId)))
  ) {
    invalidStoredResponse();
  }
  return {
    id: value.id,
    accountId: value.accountId,
    accountingPeriodId: value.accountingPeriodId,
    movementType: 'correction',
    amountDeltaMinor: value.amountDeltaMinor,
    transactionGroupId: value.transactionGroupId,
    operationId: value.operationId,
    occurredAt: value.occurredAt,
    createdAt: value.createdAt,
    reversalOfId: value.reversalOfId,
  };
}

function parseOwnerEntry(value: unknown): CorrectionPostedOwnerEntry {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !isUUID(value.id) ||
    value.entryType !== 'correction' ||
    typeof value.ownerLiabilityDeltaMinor !== 'string' ||
    !integerPattern.test(value.ownerLiabilityDeltaMinor) ||
    typeof value.equityDeltaMinor !== 'string' ||
    !integerPattern.test(value.equityDeltaMinor) ||
    (value.ownerLiabilityDeltaMinor === '0' && value.equityDeltaMinor === '0') ||
    (value.moneyAccountId !== null &&
      (typeof value.moneyAccountId !== 'string' || !isUUID(value.moneyAccountId))) ||
    typeof value.transactionGroupId !== 'string' ||
    !isUUID(value.transactionGroupId) ||
    typeof value.operationId !== 'string' ||
    !isUUID(value.operationId) ||
    !isIsoInstant(value.occurredAt) ||
    !isIsoInstant(value.createdAt) ||
    (value.reversalOfId !== null &&
      (typeof value.reversalOfId !== 'string' || !isUUID(value.reversalOfId)))
  ) {
    invalidStoredResponse();
  }
  return {
    id: value.id,
    entryType: 'correction',
    ownerLiabilityDeltaMinor: value.ownerLiabilityDeltaMinor,
    equityDeltaMinor: value.equityDeltaMinor,
    moneyAccountId: value.moneyAccountId,
    transactionGroupId: value.transactionGroupId,
    operationId: value.operationId,
    occurredAt: value.occurredAt,
    createdAt: value.createdAt,
    reversalOfId: value.reversalOfId,
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
    !positiveIntegerPattern.test(value.amountMinor) ||
    !isIsoInstant(value.transferAt) ||
    typeof value.sourceMovementId !== 'string' ||
    !isUUID(value.sourceMovementId) ||
    typeof value.destinationMovementId !== 'string' ||
    !isUUID(value.destinationMovementId) ||
    value.sourceMovementId === value.destinationMovementId ||
    value.status !== 'posted' ||
    typeof value.operationId !== 'string' ||
    !isUUID(value.operationId) ||
    !isIsoInstant(value.createdAt) ||
    !isIsoInstant(value.updatedAt) ||
    typeof value.version !== 'string' ||
    !positiveIntegerPattern.test(value.version)
  ) {
    invalidStoredResponse();
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

function expectedFactRoles(
  domain: AccountingCorrectionDomain,
  kind: AccountingCorrectionKind,
): { movementRoles: string[]; ownerRoles: string[] } {
  if (domain === 'opening_balance') {
    return {
      movementRoles:
        kind === 'replacement' ? ['reversal:opening', 'replacement:opening'] : ['reversal:opening'],
      ownerRoles: [],
    };
  }
  if (domain === 'internal_transfer') {
    return {
      movementRoles:
        kind === 'replacement'
          ? [
              'reversal:transfer-source',
              'reversal:transfer-destination',
              'replacement:transfer-source',
              'replacement:transfer-destination',
            ]
          : ['reversal:transfer-source', 'reversal:transfer-destination'],
      ownerRoles: [],
    };
  }
  return {
    movementRoles:
      kind === 'replacement'
        ? ['reversal:owner-money', 'replacement:owner-money']
        : ['reversal:owner-money'],
    ownerRoles:
      kind === 'replacement'
        ? ['reversal:owner-entry', 'replacement:owner-entry']
        : ['reversal:owner-entry'],
  };
}

function validateFactIdentity(
  operationId: string,
  accountingPeriodId: string,
  movements: CorrectionPostedMoneyMovement[],
  ownerEntries: CorrectionPostedOwnerEntry[],
  movementRoles: string[],
  ownerRoles: string[],
): void {
  if (movements.length !== movementRoles.length || ownerEntries.length !== ownerRoles.length) {
    invalidStoredResponse();
  }
  movements.forEach((movement, index) => {
    const role = movementRoles[index];
    if (
      !role ||
      movement.id !== deriveMoneyFactId(operationId, role) ||
      movement.operationId !== deriveMoneyFactOperationId(operationId, role) ||
      movement.transactionGroupId !== operationId ||
      movement.accountingPeriodId !== accountingPeriodId ||
      (role.startsWith('reversal:')
        ? movement.reversalOfId === null
        : movement.reversalOfId !== null)
    ) {
      invalidStoredResponse();
    }
  });
  ownerEntries.forEach((entry, index) => {
    const role = ownerRoles[index];
    if (
      !role ||
      entry.id !== deriveMoneyFactId(operationId, role) ||
      entry.operationId !== deriveMoneyFactOperationId(operationId, role) ||
      entry.transactionGroupId !== operationId ||
      (role.startsWith('reversal:') ? entry.reversalOfId === null : entry.reversalOfId !== null)
    ) {
      invalidStoredResponse();
    }
  });
}

function validateTransferReplacement(
  operationId: string,
  domain: AccountingCorrectionDomain,
  kind: AccountingCorrectionKind,
  movements: CorrectionPostedMoneyMovement[],
  value: unknown,
): PostedMoneyTransfer | null {
  if (domain !== 'internal_transfer' || kind !== 'replacement') {
    if (value !== null) {
      invalidStoredResponse();
    }
    return null;
  }
  const transfer = parseTransfer(value);
  const source = movements[2];
  const destination = movements[3];
  if (
    !source ||
    !destination ||
    transfer.id !== deriveMoneyFactId(operationId, 'replacement:transfer-header') ||
    transfer.operationId !==
      deriveMoneyFactOperationId(operationId, 'replacement:transfer-header') ||
    transfer.sourceMovementId !== source.id ||
    transfer.destinationMovementId !== destination.id ||
    transfer.sourceAccountId !== source.accountId ||
    transfer.destinationAccountId !== destination.accountId ||
    source.amountDeltaMinor !== `-${transfer.amountMinor}` ||
    destination.amountDeltaMinor !== transfer.amountMinor ||
    source.occurredAt !== transfer.transferAt ||
    destination.occurredAt !== transfer.transferAt
  ) {
    invalidStoredResponse();
  }
  return transfer;
}

export function parseStoredAccountingCorrectionResponse(
  value: unknown,
): AccountingCorrectionMutationResponse {
  if (
    !isRecord(value) ||
    typeof value.operationId !== 'string' ||
    !isUUID(value.operationId) ||
    typeof value.targetOperationId !== 'string' ||
    !isUUID(value.targetOperationId) ||
    typeof value.domain !== 'string' ||
    !(accountingCorrectionDomains as readonly string[]).includes(value.domain) ||
    (value.correctionKind !== 'reversal' && value.correctionKind !== 'replacement') ||
    typeof value.postingDate !== 'string' ||
    !businessDatePattern.test(value.postingDate) ||
    typeof value.accountingPeriodId !== 'string' ||
    !isUUID(value.accountingPeriodId) ||
    !Array.isArray(value.movements) ||
    !Array.isArray(value.ownerEntries) ||
    (value.replacementTransfer !== null && !isRecord(value.replacementTransfer))
  ) {
    invalidStoredResponse();
  }

  const domain = value.domain as AccountingCorrectionDomain;
  const correctionKind = value.correctionKind;
  const movements = value.movements.map(parseMovement);
  const ownerEntries = value.ownerEntries.map(parseOwnerEntry);
  const roles = expectedFactRoles(domain, correctionKind);
  validateFactIdentity(
    value.operationId,
    value.accountingPeriodId,
    movements,
    ownerEntries,
    roles.movementRoles,
    roles.ownerRoles,
  );
  const replacementTransfer = validateTransferReplacement(
    value.operationId,
    domain,
    correctionKind,
    movements,
    value.replacementTransfer,
  );

  return {
    operationId: value.operationId,
    targetOperationId: value.targetOperationId,
    domain,
    correctionKind,
    postingDate: value.postingDate,
    accountingPeriodId: value.accountingPeriodId,
    movements,
    ownerEntries,
    replacementTransfer,
  };
}
