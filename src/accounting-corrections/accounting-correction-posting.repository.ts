import { ForbiddenException, HttpException, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import {
  AccountingPeriodNotPostingEligibleError,
  AccountingPeriodPostingContextService,
} from '../accounting-periods/accounting-period-posting-context.service';
import type { AccountingPeriodPostingContext } from '../accounting-periods/accounting-period-posting-context.types';
import { AccountingPeriodIntegrityError } from '../accounting-periods/accounting-period-provisioning.service';
import { DatabaseService } from '../database/database.service';
import {
  moneyMovements,
  moneyTransfers,
  ownerLedgerEntries,
  ownerPosition,
  stores,
  type MoneyMovementTypeValue,
  type OwnerLedgerEntryTypeValue,
} from '../database/schema';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { postgresqlErrorCode } from '../money-movements/money-movement-database-error';
import {
  deriveMoneyFactId,
  deriveMoneyFactOperationId,
  deriveTransactionGroupId,
} from '../money-movements/money-movement-identity';
import { MoneyMovementPostingRepository } from '../money-movements/money-movement-posting.repository';
import { MoneyTransferPostingRepository } from '../money-transfers/money-transfer-posting.repository';
import type { PostedMoneyTransfer } from '../money-transfers/money-transfer.types';
import { OwnerLedgerPostingRepository } from '../owner-ledger/owner-ledger-posting.repository';
import { parseStoredAccountingCorrectionResponse } from './accounting-correction-response';
import type {
  AccountingCorrectionCommandInput,
  AccountingCorrectionDomain,
  AccountingCorrectionFailure,
  AccountingCorrectionFailureCode,
  AccountingCorrectionMutationResponse,
  AccountingCorrectionMutationResult,
  CorrectionPostedMoneyMovement,
  CorrectionPostedOwnerEntry,
} from './accounting-correction.types';

interface ProcessedOperationRow extends Record<string, unknown> {
  deviceId: string;
  aggregateType: string;
  aggregateId: string;
  action: string;
  requestHash: string;
  status: 'processing' | 'applied' | 'rejected';
  responseCode: number | null;
  responseBody: unknown;
  errorCode: string | null;
}

interface HistoricalMovement {
  id: string;
  accountId: string;
  accountingPeriodId: string;
  movementType: MoneyMovementTypeValue;
  amountDeltaMinor: bigint;
  referenceType: string;
  referenceId: string;
  transactionGroupId: string;
  transferGroupId: string | null;
  counterAccountId: string | null;
  occurredAt: Date;
  reversalOfId: string | null;
  operationId: string;
}

interface HistoricalOwnerEntry {
  id: string;
  accountingPeriodId: string;
  entryType: OwnerLedgerEntryTypeValue;
  ownerLiabilityDeltaMinor: bigint;
  equityDeltaMinor: bigint;
  moneyAccountId: string | null;
  referenceType: string | null;
  referenceId: string | null;
  transactionGroupId: string;
  occurredAt: Date;
  reversalOfId: string | null;
  operationId: string;
}

interface HistoricalTransfer {
  id: string;
  accountingPeriodId: string | null;
  sourceAccountId: string;
  destinationAccountId: string;
  amountMinor: bigint;
  transferAt: Date;
  sourceMovementId: string | null;
  destinationMovementId: string | null;
  status: 'draft' | 'posted' | 'cancelled';
  operationId: string;
}

interface OpeningEvent {
  domain: 'opening_balance';
  operationId: string;
  movement: HistoricalMovement;
}

interface OwnerEvent {
  domain: Exclude<AccountingCorrectionDomain, 'opening_balance' | 'internal_transfer'>;
  operationId: string;
  movement: HistoricalMovement;
  ownerEntry: HistoricalOwnerEntry;
}

interface TransferEvent {
  domain: 'internal_transfer';
  operationId: string;
  transfer: HistoricalTransfer;
  sourceMovement: HistoricalMovement;
  destinationMovement: HistoricalMovement;
}

type ActiveEvent = OpeningEvent | OwnerEvent | TransferEvent;

interface DomainDescriptor {
  aggregateType: 'money_movements' | 'owner_ledger_entries' | 'money_transfers';
  originalAction: string;
  movementType: MoneyMovementTypeValue;
  ownerEntryType?: OwnerLedgerEntryTypeValue;
  liabilityFactor: -1 | 0 | 1;
  equityFactor: -1 | 0 | 1;
}

interface FailureResult {
  ok: false;
  error: AccountingCorrectionFailure;
}

const DOMAIN_DESCRIPTORS: Record<AccountingCorrectionDomain, DomainDescriptor> = {
  opening_balance: {
    aggregateType: 'money_movements',
    originalAction: 'owner_ledger.opening_balance',
    movementType: 'opening_balance',
    liabilityFactor: 0,
    equityFactor: 0,
  },
  owner_contribution: {
    aggregateType: 'owner_ledger_entries',
    originalAction: 'owner_ledger.contribution',
    movementType: 'owner_contribution',
    ownerEntryType: 'capital_contribution',
    liabilityFactor: 0,
    equityFactor: 1,
  },
  owner_loan: {
    aggregateType: 'owner_ledger_entries',
    originalAction: 'owner_ledger.loan',
    movementType: 'owner_loan',
    ownerEntryType: 'owner_loan_to_store',
    liabilityFactor: 1,
    equityFactor: 0,
  },
  owner_reimbursement: {
    aggregateType: 'owner_ledger_entries',
    originalAction: 'owner_ledger.reimbursement',
    movementType: 'owner_reimbursement',
    ownerEntryType: 'owner_reimbursement',
    liabilityFactor: -1,
    equityFactor: 0,
  },
  owner_personal_withdrawal: {
    aggregateType: 'owner_ledger_entries',
    originalAction: 'owner_ledger.personal_withdrawal',
    movementType: 'owner_withdrawal',
    ownerEntryType: 'personal_withdrawal',
    liabilityFactor: 0,
    equityFactor: -1,
  },
  owner_capital_withdrawal: {
    aggregateType: 'owner_ledger_entries',
    originalAction: 'owner_ledger.capital_withdrawal',
    movementType: 'owner_withdrawal',
    ownerEntryType: 'capital_withdrawal',
    liabilityFactor: 0,
    equityFactor: -1,
  },
  internal_transfer: {
    aggregateType: 'money_transfers',
    originalAction: 'create',
    movementType: 'internal_transfer',
    liabilityFactor: 0,
    equityFactor: 0,
  },
};

const failureDefinitions: Readonly<
  Record<AccountingCorrectionFailureCode, AccountingCorrectionFailure>
> = {
  ACCOUNTING_CORRECTION_DOMAIN_MISMATCH: {
    code: 'ACCOUNTING_CORRECTION_DOMAIN_MISMATCH',
    message: 'The target is not an approved event in this correction domain.',
    statusCode: 409,
  },
  ACCOUNTING_CORRECTION_NO_OP: {
    code: 'ACCOUNTING_CORRECTION_NO_OP',
    message: 'The replacement must change at least one approved field.',
    statusCode: 409,
  },
  ACCOUNTING_CORRECTION_TARGET_INTEGRITY_CONFLICT: {
    code: 'ACCOUNTING_CORRECTION_TARGET_INTEGRITY_CONFLICT',
    message: 'The target accounting history is incomplete or inconsistent.',
    statusCode: 409,
  },
  ACCOUNTING_CORRECTION_TARGET_NOT_ACTIVE: {
    code: 'ACCOUNTING_CORRECTION_TARGET_NOT_ACTIVE',
    message: 'The target is not the active correctable event.',
    statusCode: 409,
  },
  ACCOUNTING_CORRECTION_TARGET_NOT_FOUND: {
    code: 'ACCOUNTING_CORRECTION_TARGET_NOT_FOUND',
    message: 'Accounting correction target not found.',
    statusCode: 404,
  },
  ACCOUNTING_PERIOD_INTEGRITY_CONFLICT: {
    code: 'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT',
    message: 'Accounting Period identity or boundaries are inconsistent.',
    statusCode: 409,
  },
  ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE: {
    code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE',
    message: 'Accounting Period is not eligible for posting.',
    statusCode: 409,
  },
  MONEY_ACCOUNT_NOT_FOUND: {
    code: 'MONEY_ACCOUNT_NOT_FOUND',
    message: 'Money Account not found.',
    statusCode: 404,
  },
  MONEY_ACCOUNT_UNAVAILABLE: {
    code: 'MONEY_ACCOUNT_UNAVAILABLE',
    message: 'Money Account is not available for new posting.',
    statusCode: 409,
  },
  MONEY_TRANSFER_SAME_ACCOUNT: {
    code: 'MONEY_TRANSFER_SAME_ACCOUNT',
    message: 'Transfer source and destination must differ.',
    statusCode: 409,
  },
  OPERATION_ID_CONFLICT: {
    code: 'OPERATION_ID_CONFLICT',
    message: 'Operation ID was reused with a different request.',
    statusCode: 409,
  },
  OPERATION_IN_PROGRESS: {
    code: 'OPERATION_IN_PROGRESS',
    message: 'The operation is still being processed.',
    statusCode: 409,
  },
  OWNER_LIABILITY_EXCEEDED: {
    code: 'OWNER_LIABILITY_EXCEEDED',
    message: 'The correction would make owner liability negative.',
    statusCode: 409,
  },
};

class AccountingCorrectionRejectedError extends Error {
  constructor(readonly result: FailureResult) {
    super(result.error.message);
    this.name = 'AccountingCorrectionRejectedError';
  }
}

function failure(code: AccountingCorrectionFailureCode): FailureResult {
  return { ok: false, error: failureDefinitions[code] };
}

function reject(code: AccountingCorrectionFailureCode): never {
  throw new AccountingCorrectionRejectedError(failure(code));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class AccountingCorrectionPostingRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly postingContext: AccountingPeriodPostingContextService,
    private readonly moneyPosting: MoneyMovementPostingRepository,
    private readonly ownerPosting: OwnerLedgerPostingRepository,
    private readonly transferPosting: MoneyTransferPostingRepository,
  ) {}

  correct(
    context: TenantTransactionContext,
    input: AccountingCorrectionCommandInput,
  ): Promise<AccountingCorrectionMutationResult> {
    const action = this.action(input);

    return this.database.withTenantTransaction(context, async (transaction) => {
      const prior = await this.readProcessedOperation(
        transaction,
        context.storeId,
        input.operationId,
      );
      if (prior) {
        return this.resolveProcessedOperation(transaction, context, input, action, prior);
      }

      await this.lockActiveStore(
        transaction,
        context.storeId,
        input.domain === 'owner_loan' || input.domain === 'owner_reimbursement',
      );

      const begun = await this.claimOperation(transaction, context, input, action);
      if (begun) {
        return begun;
      }

      try {
        const response = await transaction.transaction((savepoint) =>
          this.applyCorrection(savepoint, context, input),
        );
        await this.applyOperation(transaction, context.storeId, input.operationId, response);
        return { ok: true, response };
      } catch (error) {
        return this.persistKnownRejection(transaction, context.storeId, input.operationId, error);
      }
    });
  }

  private async applyCorrection(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: AccountingCorrectionCommandInput,
  ): Promise<AccountingCorrectionMutationResponse> {
    const targetOperation = await this.lockTargetOperation(
      transaction,
      context.storeId,
      input.targetOperationId,
    );
    const targetKind = this.resolveTargetKind(
      targetOperation,
      input.targetOperationId,
      input.domain,
    );
    await this.assertTargetIsActive(transaction, context.storeId, input.targetOperationId);
    const target = await this.loadActiveEvent(transaction, context.storeId, input, targetKind);
    this.assertReplacementChangesTarget(input, target);

    const posting = await this.resolvePosting(transaction, context, input);
    const accountIds = this.collectAffectedAccountIds(input, target);
    await this.lockAndValidateAccounts(transaction, context.storeId, accountIds);
    await this.assertProjectedOwnerLiability(transaction, context.storeId, input, target);

    const effects = await this.insertCorrectionFacts(transaction, context, input, target, posting);
    return {
      operationId: input.operationId,
      targetOperationId: input.targetOperationId,
      domain: input.domain,
      correctionKind: input.kind,
      postingDate: posting.postingDate,
      accountingPeriodId: posting.accountingPeriodId,
      movements: effects.movements,
      ownerEntries: effects.ownerEntries,
      replacementTransfer: effects.replacementTransfer,
    };
  }

  private resolveTargetKind(
    row: ProcessedOperationRow | undefined,
    operationId: string,
    domain: AccountingCorrectionDomain,
  ): 'original' | 'replacement' {
    if (!row) {
      reject('ACCOUNTING_CORRECTION_TARGET_NOT_FOUND');
    }
    if (row.status !== 'applied') {
      reject('ACCOUNTING_CORRECTION_TARGET_NOT_ACTIVE');
    }
    const descriptor = DOMAIN_DESCRIPTORS[domain];
    if (
      row.aggregateType === descriptor.aggregateType &&
      row.action === descriptor.originalAction
    ) {
      const expectedAggregateId =
        domain === 'internal_transfer'
          ? deriveMoneyFactId(operationId, 'transfer-header')
          : deriveTransactionGroupId(operationId);
      if (row.aggregateId !== expectedAggregateId) {
        reject('ACCOUNTING_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      return 'original';
    }
    if (row.action === this.correctionAction('replacement', domain)) {
      if (
        row.aggregateType !== 'money_movements' ||
        row.aggregateId !== deriveTransactionGroupId(operationId)
      ) {
        reject('ACCOUNTING_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      return 'replacement';
    }
    if (row.action.startsWith('accounting_correction.replacement.')) {
      reject('ACCOUNTING_CORRECTION_DOMAIN_MISMATCH');
    }
    if (row.action.startsWith('accounting_correction.')) {
      reject('ACCOUNTING_CORRECTION_TARGET_NOT_ACTIVE');
    }
    reject('ACCOUNTING_CORRECTION_DOMAIN_MISMATCH');
  }

  private async assertTargetIsActive(
    transaction: DatabaseTransaction,
    storeId: string,
    targetOperationId: string,
  ): Promise<void> {
    const result = await transaction.execute<{ superseded: boolean }>(sql`
      select exists (
        select 1
        from sync.processed_operations
        where store_id = ${storeId}::uuid
          and status = 'applied'
          and action like 'accounting_correction.%'
          and response_body ->> 'targetOperationId' = ${targetOperationId}
      ) as superseded
    `);
    if (result.rows[0]?.superseded === true) {
      reject('ACCOUNTING_CORRECTION_TARGET_NOT_ACTIVE');
    }
  }

  private loadActiveEvent(
    transaction: DatabaseTransaction,
    storeId: string,
    input: AccountingCorrectionCommandInput,
    targetKind: 'original' | 'replacement',
  ): Promise<ActiveEvent> {
    if (input.domain === 'opening_balance') {
      return this.loadOpeningEvent(transaction, storeId, input.targetOperationId, targetKind);
    }
    if (input.domain === 'internal_transfer') {
      return this.loadTransferEvent(transaction, storeId, input.targetOperationId, targetKind);
    }
    return this.loadOwnerEvent(
      transaction,
      storeId,
      input.targetOperationId,
      input.domain,
      targetKind,
    );
  }

  private async loadOpeningEvent(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    targetKind: 'original' | 'replacement',
  ): Promise<OpeningEvent> {
    const role = targetKind === 'original' ? 'opening' : 'replacement:opening';
    const movement = await this.readMovement(
      transaction,
      storeId,
      deriveMoneyFactId(operationId, role),
    );
    if (
      movement?.operationId !== deriveMoneyFactOperationId(operationId, role) ||
      movement.transactionGroupId !== operationId ||
      movement.reversalOfId !== null ||
      movement.movementType !== (targetKind === 'original' ? 'opening_balance' : 'correction') ||
      movement.amountDeltaMinor === 0n
    ) {
      reject('ACCOUNTING_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    return { domain: 'opening_balance', operationId, movement };
  }

  private async loadOwnerEvent(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    domain: OwnerEvent['domain'],
    targetKind: 'original' | 'replacement',
  ): Promise<OwnerEvent> {
    const prefix = targetKind === 'original' ? '' : 'replacement:';
    const movementRole = `${prefix}owner-money`;
    const ownerRole = `${prefix}owner-entry`;
    const movement = await this.readMovement(
      transaction,
      storeId,
      deriveMoneyFactId(operationId, movementRole),
    );
    const ownerEntry = await this.readOwnerEntry(
      transaction,
      storeId,
      deriveMoneyFactId(operationId, ownerRole),
    );
    const descriptor = DOMAIN_DESCRIPTORS[domain];
    if (
      !movement ||
      !ownerEntry ||
      movement.operationId !== deriveMoneyFactOperationId(operationId, movementRole) ||
      ownerEntry.operationId !== deriveMoneyFactOperationId(operationId, ownerRole) ||
      movement.transactionGroupId !== operationId ||
      ownerEntry.transactionGroupId !== operationId ||
      movement.reversalOfId !== null ||
      ownerEntry.reversalOfId !== null ||
      movement.accountId !== ownerEntry.moneyAccountId ||
      movement.accountingPeriodId !== ownerEntry.accountingPeriodId ||
      movement.occurredAt.getTime() !== ownerEntry.occurredAt.getTime() ||
      movement.referenceType !== 'owner_ledger_entry' ||
      movement.referenceId !== ownerEntry.id ||
      ownerEntry.referenceType !== 'money_movement' ||
      ownerEntry.referenceId !== movement.id ||
      movement.movementType !==
        (targetKind === 'original' ? descriptor.movementType : 'correction') ||
      ownerEntry.entryType !==
        (targetKind === 'original' ? descriptor.ownerEntryType : 'correction') ||
      !this.ownerDeltasMatch(descriptor, movement, ownerEntry)
    ) {
      reject('ACCOUNTING_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    return { domain, operationId, movement, ownerEntry };
  }

  private ownerDeltasMatch(
    descriptor: DomainDescriptor,
    movement: HistoricalMovement,
    ownerEntry: HistoricalOwnerEntry,
  ): boolean {
    const magnitude =
      movement.amountDeltaMinor < 0n ? -movement.amountDeltaMinor : movement.amountDeltaMinor;
    const expectedMoneySign =
      descriptor.liabilityFactor === -1 || descriptor.equityFactor === -1 ? -1n : 1n;
    return (
      movement.amountDeltaMinor === expectedMoneySign * magnitude &&
      ownerEntry.ownerLiabilityDeltaMinor === BigInt(descriptor.liabilityFactor) * magnitude &&
      ownerEntry.equityDeltaMinor === BigInt(descriptor.equityFactor) * magnitude
    );
  }

  private async loadTransferEvent(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    targetKind: 'original' | 'replacement',
  ): Promise<TransferEvent> {
    const prefix = targetKind === 'original' ? '' : 'replacement:';
    const headerRole = `${prefix}transfer-header`;
    const sourceRole = `${prefix}transfer-source`;
    const destinationRole = `${prefix}transfer-destination`;
    const transfer = await this.readTransfer(
      transaction,
      storeId,
      deriveMoneyFactId(operationId, headerRole),
    );
    const sourceMovement = await this.readMovement(
      transaction,
      storeId,
      deriveMoneyFactId(operationId, sourceRole),
    );
    const destinationMovement = await this.readMovement(
      transaction,
      storeId,
      deriveMoneyFactId(operationId, destinationRole),
    );
    const expectedMovementType = targetKind === 'original' ? 'internal_transfer' : 'correction';
    if (
      !transfer ||
      !sourceMovement ||
      !destinationMovement ||
      transfer.status !== 'posted' ||
      !transfer.accountingPeriodId ||
      transfer.operationId !== deriveMoneyFactOperationId(operationId, headerRole) ||
      transfer.sourceMovementId !== sourceMovement.id ||
      transfer.destinationMovementId !== destinationMovement.id ||
      sourceMovement.operationId !== deriveMoneyFactOperationId(operationId, sourceRole) ||
      destinationMovement.operationId !==
        deriveMoneyFactOperationId(operationId, destinationRole) ||
      sourceMovement.transactionGroupId !== operationId ||
      destinationMovement.transactionGroupId !== operationId ||
      sourceMovement.reversalOfId !== null ||
      destinationMovement.reversalOfId !== null ||
      sourceMovement.accountId !== transfer.sourceAccountId ||
      destinationMovement.accountId !== transfer.destinationAccountId ||
      sourceMovement.accountingPeriodId !== transfer.accountingPeriodId ||
      destinationMovement.accountingPeriodId !== transfer.accountingPeriodId ||
      sourceMovement.movementType !== expectedMovementType ||
      destinationMovement.movementType !== expectedMovementType ||
      sourceMovement.amountDeltaMinor !== -transfer.amountMinor ||
      destinationMovement.amountDeltaMinor !== transfer.amountMinor ||
      sourceMovement.referenceType !== 'money_transfer' ||
      destinationMovement.referenceType !== 'money_transfer' ||
      sourceMovement.referenceId !== transfer.id ||
      destinationMovement.referenceId !== transfer.id ||
      sourceMovement.transferGroupId !== transfer.id ||
      destinationMovement.transferGroupId !== transfer.id ||
      sourceMovement.counterAccountId !== transfer.destinationAccountId ||
      destinationMovement.counterAccountId !== transfer.sourceAccountId ||
      sourceMovement.occurredAt.getTime() !== transfer.transferAt.getTime() ||
      destinationMovement.occurredAt.getTime() !== transfer.transferAt.getTime()
    ) {
      reject('ACCOUNTING_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    return {
      domain: 'internal_transfer',
      operationId,
      transfer,
      sourceMovement,
      destinationMovement,
    };
  }

  private assertReplacementChangesTarget(
    input: AccountingCorrectionCommandInput,
    target: ActiveEvent,
  ): void {
    if (input.kind !== 'replacement') {
      return;
    }
    const replacement = input.replacement;
    if (!replacement) {
      reject('ACCOUNTING_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    if (target.domain === 'opening_balance') {
      if (replacement.amountMinor === target.movement.amountDeltaMinor) {
        reject('ACCOUNTING_CORRECTION_NO_OP');
      }
      return;
    }
    if (target.domain === 'internal_transfer') {
      if (!replacement.destinationAccountId) {
        reject('ACCOUNTING_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      const finalSource = replacement.sourceAccountId ?? target.transfer.sourceAccountId;
      const finalDestination = replacement.destinationAccountId;
      if (finalSource === finalDestination) {
        reject('MONEY_TRANSFER_SAME_ACCOUNT');
      }
      if (
        replacement.amountMinor === target.transfer.amountMinor &&
        finalSource === target.transfer.sourceAccountId &&
        finalDestination === target.transfer.destinationAccountId
      ) {
        reject('ACCOUNTING_CORRECTION_NO_OP');
      }
      return;
    }
    if (!replacement.moneyAccountId) {
      reject('ACCOUNTING_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    const currentAmount =
      target.movement.amountDeltaMinor < 0n
        ? -target.movement.amountDeltaMinor
        : target.movement.amountDeltaMinor;
    if (
      replacement.amountMinor === currentAmount &&
      replacement.moneyAccountId === target.movement.accountId
    ) {
      reject('ACCOUNTING_CORRECTION_NO_OP');
    }
  }

  private collectAffectedAccountIds(
    input: AccountingCorrectionCommandInput,
    target: ActiveEvent,
  ): string[] {
    const ids = new Set<string>();
    if (target.domain === 'internal_transfer') {
      ids.add(target.transfer.sourceAccountId);
      ids.add(target.transfer.destinationAccountId);
      if (input.replacement?.sourceAccountId) {
        ids.add(input.replacement.sourceAccountId);
      }
      if (input.replacement?.destinationAccountId) {
        ids.add(input.replacement.destinationAccountId);
      }
    } else {
      ids.add(target.movement.accountId);
      if (input.replacement?.moneyAccountId) {
        ids.add(input.replacement.moneyAccountId);
      }
    }
    return [...ids];
  }

  private async assertProjectedOwnerLiability(
    transaction: DatabaseTransaction,
    storeId: string,
    input: AccountingCorrectionCommandInput,
    target: ActiveEvent,
  ): Promise<void> {
    if (target.domain !== 'owner_loan' && target.domain !== 'owner_reimbursement') {
      return;
    }
    const rows = await transaction
      .select({ liability: ownerPosition.storeOwesOwnerMinor })
      .from(ownerPosition)
      .where(eq(ownerPosition.storeId, storeId))
      .limit(1);
    const current = rows[0]?.liability ?? 0n;
    const reversalDelta = -target.ownerEntry.ownerLiabilityDeltaMinor;
    const replacementDelta = input.replacement
      ? BigInt(DOMAIN_DESCRIPTORS[target.domain].liabilityFactor) * input.replacement.amountMinor
      : 0n;
    if (current + reversalDelta + replacementDelta < 0n) {
      reject('OWNER_LIABILITY_EXCEEDED');
    }
  }

  private async insertCorrectionFacts(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: AccountingCorrectionCommandInput,
    target: ActiveEvent,
    posting: AccountingPeriodPostingContext,
  ): Promise<{
    movements: CorrectionPostedMoneyMovement[];
    ownerEntries: CorrectionPostedOwnerEntry[];
    replacementTransfer: PostedMoneyTransfer | null;
  }> {
    if (target.domain === 'opening_balance') {
      return this.insertOpeningCorrection(transaction, context, input, target, posting);
    }
    if (target.domain === 'internal_transfer') {
      return this.insertTransferCorrection(transaction, context, input, target, posting);
    }
    return this.insertOwnerCorrection(transaction, context, input, target, posting);
  }

  private async insertOpeningCorrection(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: AccountingCorrectionCommandInput,
    target: OpeningEvent,
    posting: AccountingPeriodPostingContext,
  ) {
    const transactionGroupId = deriveTransactionGroupId(input.operationId);
    const reversal = await this.insertMovement(transaction, context, input, posting, {
      discriminator: 'reversal:opening',
      accountId: target.movement.accountId,
      amountDeltaMinor: -target.movement.amountDeltaMinor,
      referenceType: 'opening_balance',
      referenceId: target.movement.accountId,
      reversalOfId: target.movement.id,
      transactionGroupId,
    });
    const movements = [reversal];
    if (input.replacement) {
      movements.push(
        await this.insertMovement(transaction, context, input, posting, {
          discriminator: 'replacement:opening',
          accountId: target.movement.accountId,
          amountDeltaMinor: input.replacement.amountMinor,
          referenceType: 'opening_balance',
          referenceId: target.movement.accountId,
          reversalOfId: null,
          transactionGroupId,
        }),
      );
    }
    return { movements, ownerEntries: [], replacementTransfer: null };
  }

  private async insertOwnerCorrection(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: AccountingCorrectionCommandInput,
    target: OwnerEvent,
    posting: AccountingPeriodPostingContext,
  ) {
    const transactionGroupId = deriveTransactionGroupId(input.operationId);
    const reversalMoneyId = deriveMoneyFactId(input.operationId, 'reversal:owner-money');
    const reversalOwnerId = deriveMoneyFactId(input.operationId, 'reversal:owner-entry');
    const reversalMovement = await this.insertMovement(transaction, context, input, posting, {
      discriminator: 'reversal:owner-money',
      accountId: target.movement.accountId,
      amountDeltaMinor: -target.movement.amountDeltaMinor,
      referenceType: 'owner_ledger_entry',
      referenceId: reversalOwnerId,
      reversalOfId: target.movement.id,
      transactionGroupId,
    });
    const reversalOwner = await this.insertOwnerEntry(transaction, context, input, posting, {
      id: reversalOwnerId,
      discriminator: 'reversal:owner-entry',
      moneyAccountId: target.movement.accountId,
      ownerLiabilityDeltaMinor: -target.ownerEntry.ownerLiabilityDeltaMinor,
      equityDeltaMinor: -target.ownerEntry.equityDeltaMinor,
      referenceId: reversalMoneyId,
      reversalOfId: target.ownerEntry.id,
      transactionGroupId,
    });
    const movements = [reversalMovement];
    const ownerEntries = [reversalOwner];

    if (input.replacement?.moneyAccountId) {
      const descriptor = DOMAIN_DESCRIPTORS[target.domain];
      const replacementOwnerId = deriveMoneyFactId(input.operationId, 'replacement:owner-entry');
      const replacementMoneyId = deriveMoneyFactId(input.operationId, 'replacement:owner-money');
      const magnitude = input.replacement.amountMinor;
      const moneySign =
        descriptor.liabilityFactor === -1 || descriptor.equityFactor === -1 ? -1n : 1n;
      movements.push(
        await this.insertMovement(transaction, context, input, posting, {
          discriminator: 'replacement:owner-money',
          accountId: input.replacement.moneyAccountId,
          amountDeltaMinor: moneySign * magnitude,
          referenceType: 'owner_ledger_entry',
          referenceId: replacementOwnerId,
          reversalOfId: null,
          transactionGroupId,
        }),
      );
      ownerEntries.push(
        await this.insertOwnerEntry(transaction, context, input, posting, {
          id: replacementOwnerId,
          discriminator: 'replacement:owner-entry',
          moneyAccountId: input.replacement.moneyAccountId,
          ownerLiabilityDeltaMinor: BigInt(descriptor.liabilityFactor) * magnitude,
          equityDeltaMinor: BigInt(descriptor.equityFactor) * magnitude,
          referenceId: replacementMoneyId,
          reversalOfId: null,
          transactionGroupId,
        }),
      );
    }
    return { movements, ownerEntries, replacementTransfer: null };
  }

  private async insertTransferCorrection(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: AccountingCorrectionCommandInput,
    target: TransferEvent,
    posting: AccountingPeriodPostingContext,
  ) {
    const transactionGroupId = deriveTransactionGroupId(input.operationId);
    const reversalSource = await this.insertMovement(transaction, context, input, posting, {
      discriminator: 'reversal:transfer-source',
      accountId: target.transfer.sourceAccountId,
      amountDeltaMinor: target.transfer.amountMinor,
      referenceType: 'money_transfer',
      referenceId: target.transfer.id,
      reversalOfId: target.sourceMovement.id,
      transactionGroupId,
      transferGroupId: target.transfer.id,
      counterAccountId: target.transfer.destinationAccountId,
    });
    const reversalDestination = await this.insertMovement(transaction, context, input, posting, {
      discriminator: 'reversal:transfer-destination',
      accountId: target.transfer.destinationAccountId,
      amountDeltaMinor: -target.transfer.amountMinor,
      referenceType: 'money_transfer',
      referenceId: target.transfer.id,
      reversalOfId: target.destinationMovement.id,
      transactionGroupId,
      transferGroupId: target.transfer.id,
      counterAccountId: target.transfer.sourceAccountId,
    });
    const movements = [reversalSource, reversalDestination];
    let replacementTransfer: PostedMoneyTransfer | null = null;

    if (input.replacement?.destinationAccountId) {
      // The replacement Transfer may relocate the source account; when the client omits it the
      // original source is reused. Reversal facts above always target the immutable original.
      const finalSource = input.replacement.sourceAccountId ?? target.transfer.sourceAccountId;
      const replacementHeaderId = deriveMoneyFactId(
        input.operationId,
        'replacement:transfer-header',
      );
      const sourceMovementId = deriveMoneyFactId(input.operationId, 'replacement:transfer-source');
      const destinationMovementId = deriveMoneyFactId(
        input.operationId,
        'replacement:transfer-destination',
      );
      const replacementSource = await this.insertMovement(transaction, context, input, posting, {
        discriminator: 'replacement:transfer-source',
        accountId: finalSource,
        amountDeltaMinor: -input.replacement.amountMinor,
        referenceType: 'money_transfer',
        referenceId: replacementHeaderId,
        reversalOfId: null,
        transactionGroupId,
        transferGroupId: replacementHeaderId,
        counterAccountId: input.replacement.destinationAccountId,
      });
      const replacementDestination = await this.insertMovement(
        transaction,
        context,
        input,
        posting,
        {
          discriminator: 'replacement:transfer-destination',
          accountId: input.replacement.destinationAccountId,
          amountDeltaMinor: input.replacement.amountMinor,
          referenceType: 'money_transfer',
          referenceId: replacementHeaderId,
          reversalOfId: null,
          transactionGroupId,
          transferGroupId: replacementHeaderId,
          counterAccountId: finalSource,
        },
      );
      movements.push(replacementSource, replacementDestination);
      const displayNumber = await this.transferPosting.nextDisplayNumberWithinTransaction(
        transaction,
        context,
        posting.postingDate,
      );
      replacementTransfer = await this.transferPosting.insertTransferWithinTransaction(
        transaction,
        context,
        {
          id: replacementHeaderId,
          operationId: deriveMoneyFactOperationId(input.operationId, 'replacement:transfer-header'),
          displayNumber,
          sourceAccountId: finalSource,
          destinationAccountId: input.replacement.destinationAccountId,
          amountMinor: input.replacement.amountMinor,
          transferAt: input.occurredAt,
          sourceMovementId,
          destinationMovementId,
          accountingPeriodId: posting.accountingPeriodId,
        },
      );
    }
    return { movements, ownerEntries: [], replacementTransfer };
  }

  private async insertMovement(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: AccountingCorrectionCommandInput,
    posting: AccountingPeriodPostingContext,
    spec: {
      discriminator: string;
      accountId: string;
      amountDeltaMinor: bigint;
      referenceType: string;
      referenceId: string;
      reversalOfId: string | null;
      transactionGroupId: string;
      transferGroupId?: string | null;
      counterAccountId?: string | null;
    },
  ): Promise<CorrectionPostedMoneyMovement> {
    const movement = await this.moneyPosting.insertMovementWithinTransaction(transaction, context, {
      commandOperationId: input.operationId,
      discriminator: spec.discriminator,
      accountId: spec.accountId,
      amountDeltaMinor: spec.amountDeltaMinor,
      movementType: 'correction',
      referenceType: spec.referenceType,
      referenceId: spec.referenceId,
      accountingPeriodId: posting.accountingPeriodId,
      occurredAt: input.occurredAt,
      transactionGroupId: spec.transactionGroupId,
      transferGroupId: spec.transferGroupId ?? null,
      counterAccountId: spec.counterAccountId ?? null,
      reversalOfId: spec.reversalOfId,
    });
    return { ...movement, reversalOfId: spec.reversalOfId };
  }

  private async insertOwnerEntry(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: AccountingCorrectionCommandInput,
    posting: AccountingPeriodPostingContext,
    spec: {
      id: string;
      discriminator: string;
      moneyAccountId: string;
      ownerLiabilityDeltaMinor: bigint;
      equityDeltaMinor: bigint;
      referenceId: string;
      reversalOfId: string | null;
      transactionGroupId: string;
    },
  ): Promise<CorrectionPostedOwnerEntry> {
    const ownerEntry = await this.ownerPosting.insertOwnerEntryWithinTransaction(
      transaction,
      context,
      {
        id: spec.id,
        operationId: deriveMoneyFactOperationId(input.operationId, spec.discriminator),
        entryType: 'correction',
        ownerLiabilityDeltaMinor: spec.ownerLiabilityDeltaMinor,
        equityDeltaMinor: spec.equityDeltaMinor,
        moneyAccountId: spec.moneyAccountId,
        accountingPeriodId: posting.accountingPeriodId,
        transactionGroupId: spec.transactionGroupId,
        occurredAt: input.occurredAt,
        referenceType: 'money_movement',
        referenceId: spec.referenceId,
        reversalOfId: spec.reversalOfId,
      },
    );
    return { ...ownerEntry, reversalOfId: spec.reversalOfId };
  }

  private async readMovement(
    transaction: DatabaseTransaction,
    storeId: string,
    id: string,
  ): Promise<HistoricalMovement | undefined> {
    const rows = await transaction
      .select({
        id: moneyMovements.id,
        accountId: moneyMovements.accountId,
        accountingPeriodId: moneyMovements.accountingPeriodId,
        movementType: moneyMovements.movementType,
        amountDeltaMinor: moneyMovements.amountDeltaMinor,
        referenceType: moneyMovements.referenceType,
        referenceId: moneyMovements.referenceId,
        transactionGroupId: moneyMovements.transactionGroupId,
        transferGroupId: moneyMovements.transferGroupId,
        counterAccountId: moneyMovements.counterAccountId,
        occurredAt: moneyMovements.occurredAt,
        reversalOfId: moneyMovements.reversalOfId,
        operationId: moneyMovements.operationId,
      })
      .from(moneyMovements)
      .where(and(eq(moneyMovements.storeId, storeId), eq(moneyMovements.id, id)))
      .limit(1);
    return rows[0];
  }

  private async readOwnerEntry(
    transaction: DatabaseTransaction,
    storeId: string,
    id: string,
  ): Promise<HistoricalOwnerEntry | undefined> {
    const rows = await transaction
      .select({
        id: ownerLedgerEntries.id,
        accountingPeriodId: ownerLedgerEntries.accountingPeriodId,
        entryType: ownerLedgerEntries.entryType,
        ownerLiabilityDeltaMinor: ownerLedgerEntries.ownerLiabilityDeltaMinor,
        equityDeltaMinor: ownerLedgerEntries.equityDeltaMinor,
        moneyAccountId: ownerLedgerEntries.moneyAccountId,
        referenceType: ownerLedgerEntries.referenceType,
        referenceId: ownerLedgerEntries.referenceId,
        transactionGroupId: ownerLedgerEntries.transactionGroupId,
        occurredAt: ownerLedgerEntries.occurredAt,
        reversalOfId: ownerLedgerEntries.reversalOfId,
        operationId: ownerLedgerEntries.operationId,
      })
      .from(ownerLedgerEntries)
      .where(and(eq(ownerLedgerEntries.storeId, storeId), eq(ownerLedgerEntries.id, id)))
      .limit(1);
    return rows[0];
  }

  private async readTransfer(
    transaction: DatabaseTransaction,
    storeId: string,
    id: string,
  ): Promise<HistoricalTransfer | undefined> {
    const rows = await transaction
      .select({
        id: moneyTransfers.id,
        accountingPeriodId: moneyTransfers.accountingPeriodId,
        sourceAccountId: moneyTransfers.sourceAccountId,
        destinationAccountId: moneyTransfers.destinationAccountId,
        amountMinor: moneyTransfers.amountMinor,
        transferAt: moneyTransfers.transferAt,
        sourceMovementId: moneyTransfers.sourceMovementId,
        destinationMovementId: moneyTransfers.destinationMovementId,
        status: moneyTransfers.status,
        operationId: moneyTransfers.operationId,
      })
      .from(moneyTransfers)
      .where(and(eq(moneyTransfers.storeId, storeId), eq(moneyTransfers.id, id)))
      .limit(1);
    return rows[0];
  }

  private async resolvePosting(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: AccountingCorrectionCommandInput,
  ): Promise<AccountingPeriodPostingContext> {
    try {
      return await this.postingContext.resolveForWrite(transaction, context, {
        postingDate: input.postingDate,
        operationId: input.operationId,
      });
    } catch (error) {
      if (error instanceof AccountingPeriodNotPostingEligibleError) {
        reject('ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE');
      }
      if (error instanceof AccountingPeriodIntegrityError) {
        reject('ACCOUNTING_PERIOD_INTEGRITY_CONFLICT');
      }
      throw error;
    }
  }

  private async lockAndValidateAccounts(
    transaction: DatabaseTransaction,
    storeId: string,
    accountIds: string[],
  ): Promise<void> {
    try {
      await this.moneyPosting.lockAndValidateAccounts(transaction, storeId, accountIds);
    } catch (error) {
      if (error instanceof HttpException) {
        const response = error.getResponse();
        if (isRecord(response) && response.code === 'MONEY_ACCOUNT_NOT_FOUND') {
          reject('MONEY_ACCOUNT_NOT_FOUND');
        }
        if (isRecord(response) && response.code === 'MONEY_ACCOUNT_UNAVAILABLE') {
          reject('MONEY_ACCOUNT_UNAVAILABLE');
        }
      }
      throw error;
    }
  }

  private async lockActiveStore(
    transaction: DatabaseTransaction,
    storeId: string,
    exclusive: boolean,
  ): Promise<void> {
    const selection = transaction
      .select({ status: stores.status })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1);
    const rows = exclusive ? await selection.for('update') : await selection.for('share');
    if (rows[0]?.status !== 'active') {
      throw new ForbiddenException({
        code: 'BUSINESS_WRITE_NOT_ALLOWED',
        message: 'Business writes are not allowed.',
      });
    }
  }

  private async lockTargetOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
  ): Promise<ProcessedOperationRow | undefined> {
    const result = await transaction.execute<ProcessedOperationRow>(sql`
      select
        device_id as "deviceId",
        aggregate_type as "aggregateType",
        aggregate_id as "aggregateId",
        action,
        request_hash as "requestHash",
        status,
        response_code as "responseCode",
        response_body as "responseBody",
        error_code as "errorCode"
      from sync.processed_operations
      where store_id = ${storeId}::uuid and operation_id = ${operationId}::uuid
      for update
    `);
    return result.rows[0];
  }

  private async claimOperation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: AccountingCorrectionCommandInput,
    action: string,
  ): Promise<AccountingCorrectionMutationResult | null> {
    let claimed: boolean;
    try {
      const result = await transaction.transaction((savepoint) =>
        savepoint.execute<{ claimed: boolean }>(sql`
          select sync.claim_operation(
            ${context.storeId}::uuid,
            ${input.operationId}::uuid,
            ${context.deviceId}::uuid,
            'money_movements',
            ${deriveTransactionGroupId(input.operationId)}::uuid,
            ${action},
            ${input.requestHash}
          ) as claimed
        `),
      );
      claimed = result.rows[0]?.claimed === true;
    } catch (error) {
      if (postgresqlErrorCode(error) !== '23505') {
        throw error;
      }
      const concurrent = await this.readProcessedOperation(
        transaction,
        context.storeId,
        input.operationId,
      );
      if (!concurrent) {
        throw error;
      }
      return this.resolveProcessedOperation(transaction, context, input, action, concurrent);
    }
    if (claimed) {
      return null;
    }
    const existing = await this.readProcessedOperation(
      transaction,
      context.storeId,
      input.operationId,
    );
    if (!existing) {
      throw new Error('Claimed accounting-correction operation could not be read.');
    }
    return this.resolveProcessedOperation(transaction, context, input, action, existing);
  }

  private async readProcessedOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
  ): Promise<ProcessedOperationRow | undefined> {
    const result = await transaction.execute<ProcessedOperationRow>(sql`
      select
        device_id as "deviceId",
        aggregate_type as "aggregateType",
        aggregate_id as "aggregateId",
        action,
        request_hash as "requestHash",
        status,
        response_code as "responseCode",
        response_body as "responseBody",
        error_code as "errorCode"
      from sync.processed_operations
      where store_id = ${storeId}::uuid and operation_id = ${operationId}::uuid
    `);
    return result.rows[0];
  }

  private async resolveProcessedOperation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: AccountingCorrectionCommandInput,
    action: string,
    existing: ProcessedOperationRow,
  ): Promise<AccountingCorrectionMutationResult> {
    if (
      existing.deviceId !== context.deviceId ||
      existing.aggregateType !== 'money_movements' ||
      existing.aggregateId !== deriveTransactionGroupId(input.operationId) ||
      existing.action !== action ||
      existing.requestHash !== input.requestHash
    ) {
      await this.recordOperationConflict(transaction, context, input, action);
      return failure('OPERATION_ID_CONFLICT');
    }
    if (existing.status === 'applied') {
      return { ok: true, response: parseStoredAccountingCorrectionResponse(existing.responseBody) };
    }
    if (existing.status === 'rejected') {
      return this.parseStoredRejection(existing);
    }
    return failure('OPERATION_IN_PROGRESS');
  }

  private parseStoredRejection(existing: ProcessedOperationRow): FailureResult {
    const code = existing.errorCode;
    if (
      existing.responseCode !== null &&
      code &&
      Object.hasOwn(failureDefinitions, code) &&
      failureDefinitions[code as AccountingCorrectionFailureCode].statusCode ===
        existing.responseCode
    ) {
      return failure(code as AccountingCorrectionFailureCode);
    }
    throw new Error('Stored accounting-correction rejection is invalid.');
  }

  private async applyOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    response: AccountingCorrectionMutationResponse,
  ): Promise<void> {
    const completed = await transaction.execute(sql`
      update sync.processed_operations
      set
        status = 'applied',
        response_code = 201,
        response_body = ${JSON.stringify(response)}::jsonb,
        error_code = null,
        completed_at = clock_timestamp()
      where store_id = ${storeId}::uuid
        and operation_id = ${operationId}::uuid
        and status = 'processing'
      returning operation_id
    `);
    if (completed.rows.length !== 1) {
      throw new Error('Accounting correction operation completion failed.');
    }
  }

  private async persistKnownRejection(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    error: unknown,
  ): Promise<AccountingCorrectionMutationResult> {
    if (!(error instanceof AccountingCorrectionRejectedError)) {
      throw error;
    }
    await this.rejectOperation(transaction, storeId, operationId, error.result.error);
    return error.result;
  }

  private async rejectOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    error: AccountingCorrectionFailure,
  ): Promise<void> {
    const completed = await transaction.execute(sql`
      update sync.processed_operations
      set
        status = 'rejected',
        response_code = ${error.statusCode},
        response_body = ${JSON.stringify({ code: error.code, message: error.message })}::jsonb,
        error_code = ${error.code},
        completed_at = clock_timestamp()
      where store_id = ${storeId}::uuid
        and operation_id = ${operationId}::uuid
        and status = 'processing'
      returning operation_id
    `);
    if (completed.rows.length !== 1) {
      throw new Error('Accounting correction rejection persistence failed.');
    }
  }

  private async recordOperationConflict(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: AccountingCorrectionCommandInput,
    action: string,
  ): Promise<void> {
    await transaction.execute(sql`
      insert into sync.conflicts (
        store_id,
        operation_id,
        entity_type,
        entity_id,
        conflict_type,
        client_payload
      ) values (
        ${context.storeId}::uuid,
        ${input.operationId}::uuid,
        'money_movements',
        ${deriveTransactionGroupId(input.operationId)}::uuid,
        'duplicate_identity',
        jsonb_build_object('action', ${action}::text, 'requestHash', ${input.requestHash}::text)
      )
    `);
  }

  private correctionAction(
    kind: AccountingCorrectionCommandInput['kind'],
    domain: AccountingCorrectionDomain,
  ): string {
    return `accounting_correction.${kind}.${domain}`;
  }

  private action(input: AccountingCorrectionCommandInput): string {
    return this.correctionAction(input.kind, input.domain);
  }
}
