import { ForbiddenException, HttpException, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';

import {
  AccountingPeriodNotPostingEligibleError,
  AccountingPeriodPostingContextService,
} from '../accounting-periods/accounting-period-posting-context.service';
import type { AccountingPeriodPostingContext } from '../accounting-periods/accounting-period-posting-context.types';
import { AccountingPeriodIntegrityError } from '../accounting-periods/accounting-period-provisioning.service';
import { DatabaseService } from '../database/database.service';
import {
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
import type { PostedMoneyMovement } from '../money-movements/money-movement.types';
import { parseStoredOwnerLedgerMutationResponse } from './owner-ledger-response';
import type {
  OpeningBalanceCommandInput,
  OwnerLedgerCommandInput,
  OwnerLedgerCommandKind,
  OwnerLedgerMutationFailure,
  OwnerLedgerMutationFailureCode,
  OwnerLedgerMutationResponse,
  OwnerLedgerMutationResult,
  PostedOwnerLedgerEntry,
} from './owner-ledger.types';

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

interface OwnerCommandDescriptor {
  aggregateType: 'owner_ledger_entries';
  action: string;
  movementType: MoneyMovementTypeValue;
  entryType: OwnerLedgerEntryTypeValue;
  moneyDelta: (magnitude: bigint) => bigint;
  liabilityDelta: (magnitude: bigint) => bigint;
  equityDelta: (magnitude: bigint) => bigint;
  requiresLiability: boolean;
}

interface MutationOperation {
  operationId: string;
  aggregateType: 'money_movements' | 'owner_ledger_entries';
  aggregateId: string;
  action: string;
  requestHash: string;
}

interface FailureResult {
  ok: false;
  error: OwnerLedgerMutationFailure;
}

const OWNER_COMMAND_DESCRIPTORS: Record<OwnerLedgerCommandKind, OwnerCommandDescriptor> = {
  owner_contribution: {
    aggregateType: 'owner_ledger_entries',
    action: 'owner_ledger.contribution',
    movementType: 'owner_contribution',
    entryType: 'capital_contribution',
    moneyDelta: (magnitude) => magnitude,
    liabilityDelta: () => 0n,
    equityDelta: (magnitude) => magnitude,
    requiresLiability: false,
  },
  owner_loan: {
    aggregateType: 'owner_ledger_entries',
    action: 'owner_ledger.loan',
    movementType: 'owner_loan',
    entryType: 'owner_loan_to_store',
    moneyDelta: (magnitude) => magnitude,
    liabilityDelta: (magnitude) => magnitude,
    equityDelta: () => 0n,
    requiresLiability: false,
  },
  owner_reimbursement: {
    aggregateType: 'owner_ledger_entries',
    action: 'owner_ledger.reimbursement',
    movementType: 'owner_reimbursement',
    entryType: 'owner_reimbursement',
    moneyDelta: (magnitude) => -magnitude,
    liabilityDelta: (magnitude) => -magnitude,
    equityDelta: () => 0n,
    requiresLiability: true,
  },
  owner_personal_withdrawal: {
    aggregateType: 'owner_ledger_entries',
    action: 'owner_ledger.personal_withdrawal',
    movementType: 'owner_withdrawal',
    entryType: 'personal_withdrawal',
    moneyDelta: (magnitude) => -magnitude,
    liabilityDelta: () => 0n,
    equityDelta: (magnitude) => -magnitude,
    requiresLiability: false,
  },
  owner_capital_withdrawal: {
    aggregateType: 'owner_ledger_entries',
    action: 'owner_ledger.capital_withdrawal',
    movementType: 'owner_withdrawal',
    entryType: 'capital_withdrawal',
    moneyDelta: (magnitude) => -magnitude,
    liabilityDelta: () => 0n,
    equityDelta: (magnitude) => -magnitude,
    requiresLiability: false,
  },
};

const failureDefinitions: Readonly<
  Record<OwnerLedgerMutationFailureCode, OwnerLedgerMutationFailure>
> = {
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
  OPENING_BALANCE_ALREADY_EXISTS: {
    code: 'OPENING_BALANCE_ALREADY_EXISTS',
    message: 'An original opening balance already exists for this Money Account.',
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
    message: 'Reimbursement exceeds the outstanding owner liability.',
    statusCode: 409,
  },
};

class OwnerLedgerRejectedError extends Error {
  constructor(readonly result: FailureResult) {
    super(result.error.message);
    this.name = 'OwnerLedgerRejectedError';
  }
}

function failure(code: OwnerLedgerMutationFailureCode): FailureResult {
  return { ok: false, error: failureDefinitions[code] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class OwnerLedgerPostingRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly postingContext: AccountingPeriodPostingContextService,
    private readonly moneyMovements: MoneyMovementPostingRepository,
  ) {}

  postOpeningBalance(
    context: TenantTransactionContext,
    input: OpeningBalanceCommandInput,
  ): Promise<OwnerLedgerMutationResult> {
    const transactionGroupId = deriveTransactionGroupId(input.operationId);
    const operation: MutationOperation = {
      operationId: input.operationId,
      action: 'owner_ledger.opening_balance',
      aggregateType: 'money_movements',
      aggregateId: transactionGroupId,
      requestHash: input.requestHash,
    };

    return this.database.withTenantTransaction(context, async (transaction) => {
      const begun = await this.beginMutation(transaction, context, operation, false);
      if (begun) {
        return begun;
      }

      try {
        const response = await transaction.transaction(async (savepoint) => {
          const posting = await this.resolvePosting(savepoint, context, input);
          await this.lockAndValidateAccount(savepoint, context.storeId, input.moneyAccountId);

          if (input.amountMinor === 0n) {
            return this.response(input.operationId, posting, [], []);
          }

          const existing = await savepoint.execute<{ present: boolean }>(sql`
            select exists (
              select 1
              from ledger.money_movements
              where store_id = ${context.storeId}::uuid
                and account_id = ${input.moneyAccountId}::uuid
                and movement_type = 'opening_balance'
                and reversal_of_id is null
            ) as present
          `);
          if (existing.rows[0]?.present === true) {
            throw new OwnerLedgerRejectedError(failure('OPENING_BALANCE_ALREADY_EXISTS'));
          }

          const movement = await this.moneyMovements.insertMovementWithinTransaction(
            savepoint,
            context,
            {
              commandOperationId: input.operationId,
              discriminator: 'opening',
              accountId: input.moneyAccountId,
              amountDeltaMinor: input.amountMinor,
              movementType: 'opening_balance',
              referenceType: 'opening_balance',
              referenceId: input.moneyAccountId,
              accountingPeriodId: posting.accountingPeriodId,
              occurredAt: input.occurredAt,
              transactionGroupId,
            },
          );
          return this.response(input.operationId, posting, [movement], []);
        });

        await this.applyOperation(transaction, context.storeId, input.operationId, response);
        return { ok: true, response };
      } catch (error) {
        return this.persistKnownRejection(transaction, context.storeId, input.operationId, error);
      }
    });
  }

  postOwnerCommand(
    context: TenantTransactionContext,
    input: OwnerLedgerCommandInput,
    kind: OwnerLedgerCommandKind,
  ): Promise<OwnerLedgerMutationResult> {
    const descriptor = OWNER_COMMAND_DESCRIPTORS[kind];
    const transactionGroupId = deriveTransactionGroupId(input.operationId);
    const operation: MutationOperation = {
      operationId: input.operationId,
      action: descriptor.action,
      aggregateType: descriptor.aggregateType,
      aggregateId: transactionGroupId,
      requestHash: input.requestHash,
    };

    return this.database.withTenantTransaction(context, async (transaction) => {
      const begun = await this.beginMutation(
        transaction,
        context,
        operation,
        descriptor.requiresLiability,
      );
      if (begun) {
        return begun;
      }

      try {
        const response = await transaction.transaction(async (savepoint) => {
          const posting = await this.resolvePosting(savepoint, context, input);
          await this.lockAndValidateAccount(savepoint, context.storeId, input.moneyAccountId);

          if (descriptor.requiresLiability) {
            const liability = await this.readOwnerLiability(savepoint, context.storeId);
            if (input.amountMinor > liability) {
              throw new OwnerLedgerRejectedError(failure('OWNER_LIABILITY_EXCEEDED'));
            }
          }

          const ownerEntryId = deriveMoneyFactId(input.operationId, 'owner-entry');
          const moneyMovementId = deriveMoneyFactId(input.operationId, 'owner-money');
          const movement = await this.moneyMovements.insertMovementWithinTransaction(
            savepoint,
            context,
            {
              commandOperationId: input.operationId,
              discriminator: 'owner-money',
              accountId: input.moneyAccountId,
              amountDeltaMinor: descriptor.moneyDelta(input.amountMinor),
              movementType: descriptor.movementType,
              referenceType: 'owner_ledger_entry',
              referenceId: ownerEntryId,
              accountingPeriodId: posting.accountingPeriodId,
              occurredAt: input.occurredAt,
              transactionGroupId,
            },
          );
          const ownerEntry = await this.insertOwnerEntry(savepoint, context, {
            id: ownerEntryId,
            operationId: deriveMoneyFactOperationId(input.operationId, 'owner-entry'),
            entryType: descriptor.entryType,
            ownerLiabilityDeltaMinor: descriptor.liabilityDelta(input.amountMinor),
            equityDeltaMinor: descriptor.equityDelta(input.amountMinor),
            moneyAccountId: input.moneyAccountId,
            accountingPeriodId: posting.accountingPeriodId,
            transactionGroupId,
            occurredAt: input.occurredAt,
            referenceType: 'money_movement',
            referenceId: moneyMovementId,
          });
          return this.response(input.operationId, posting, [movement], [ownerEntry]);
        });

        await this.applyOperation(transaction, context.storeId, input.operationId, response);
        return { ok: true, response };
      } catch (error) {
        return this.persistKnownRejection(transaction, context.storeId, input.operationId, error);
      }
    });
  }

  private response(
    operationId: string,
    posting: AccountingPeriodPostingContext,
    movements: PostedMoneyMovement[],
    ownerEntries: PostedOwnerLedgerEntry[],
  ): OwnerLedgerMutationResponse {
    return {
      operationId,
      postingDate: posting.postingDate,
      accountingPeriodId: posting.accountingPeriodId,
      movements,
      ownerEntries,
    };
  }

  private async resolvePosting(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: Pick<OwnerLedgerCommandInput, 'operationId' | 'postingDate'>,
  ): Promise<AccountingPeriodPostingContext> {
    try {
      return await this.postingContext.resolveForWrite(transaction, context, {
        postingDate: input.postingDate,
        operationId: input.operationId,
      });
    } catch (error) {
      if (error instanceof AccountingPeriodNotPostingEligibleError) {
        throw new OwnerLedgerRejectedError(failure('ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE'));
      }
      if (error instanceof AccountingPeriodIntegrityError) {
        throw new OwnerLedgerRejectedError(failure('ACCOUNTING_PERIOD_INTEGRITY_CONFLICT'));
      }
      throw error;
    }
  }

  private async lockAndValidateAccount(
    transaction: DatabaseTransaction,
    storeId: string,
    accountId: string,
  ): Promise<void> {
    try {
      await this.moneyMovements.lockAndValidateAccounts(transaction, storeId, [accountId]);
    } catch (error) {
      const accountFailure = this.classifyMoneyAccountError(error);
      if (accountFailure) {
        throw new OwnerLedgerRejectedError(accountFailure);
      }
      throw error;
    }
  }

  private classifyMoneyAccountError(error: unknown): FailureResult | null {
    if (!(error instanceof HttpException)) {
      return null;
    }
    const response = error.getResponse();
    if (!isRecord(response) || typeof response.code !== 'string') {
      return null;
    }
    if (response.code === 'MONEY_ACCOUNT_NOT_FOUND') {
      return failure('MONEY_ACCOUNT_NOT_FOUND');
    }
    if (response.code === 'MONEY_ACCOUNT_UNAVAILABLE') {
      return failure('MONEY_ACCOUNT_UNAVAILABLE');
    }
    return null;
  }

  private async readOwnerLiability(
    transaction: DatabaseTransaction,
    storeId: string,
  ): Promise<bigint> {
    const rows = await transaction
      .select({ liability: ownerPosition.storeOwesOwnerMinor })
      .from(ownerPosition)
      .where(eq(ownerPosition.storeId, storeId))
      .limit(1);
    return rows[0]?.liability ?? 0n;
  }

  private async insertOwnerEntry(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    spec: {
      id: string;
      operationId: string;
      entryType: OwnerLedgerEntryTypeValue;
      ownerLiabilityDeltaMinor: bigint;
      equityDeltaMinor: bigint;
      moneyAccountId: string;
      accountingPeriodId: string;
      transactionGroupId: string;
      occurredAt: Date;
      referenceType: string;
      referenceId: string;
    },
  ): Promise<PostedOwnerLedgerEntry> {
    const rows = await transaction
      .insert(ownerLedgerEntries)
      .values({
        id: spec.id,
        storeId: context.storeId,
        accountingPeriodId: spec.accountingPeriodId,
        entryType: spec.entryType,
        ownerLiabilityDeltaMinor: spec.ownerLiabilityDeltaMinor,
        equityDeltaMinor: spec.equityDeltaMinor,
        moneyAccountId: spec.moneyAccountId,
        referenceType: spec.referenceType,
        referenceId: spec.referenceId,
        transactionGroupId: spec.transactionGroupId,
        occurredAt: spec.occurredAt,
        deviceId: context.deviceId,
        operationId: spec.operationId,
      })
      .returning({
        id: ownerLedgerEntries.id,
        entryType: ownerLedgerEntries.entryType,
        ownerLiabilityDeltaMinor: ownerLedgerEntries.ownerLiabilityDeltaMinor,
        equityDeltaMinor: ownerLedgerEntries.equityDeltaMinor,
        moneyAccountId: ownerLedgerEntries.moneyAccountId,
        transactionGroupId: ownerLedgerEntries.transactionGroupId,
        operationId: ownerLedgerEntries.operationId,
        occurredAt: ownerLedgerEntries.occurredAt,
        createdAt: ownerLedgerEntries.createdAt,
      });
    const row = rows[0];
    if (!row) {
      throw new Error('Owner Ledger insertion did not return a row.');
    }
    return {
      id: row.id,
      entryType: row.entryType,
      ownerLiabilityDeltaMinor: row.ownerLiabilityDeltaMinor.toString(),
      equityDeltaMinor: row.equityDeltaMinor.toString(),
      moneyAccountId: row.moneyAccountId,
      transactionGroupId: row.transactionGroupId,
      operationId: row.operationId,
      occurredAt: row.occurredAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async beginMutation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    operation: MutationOperation,
    serializeOwnerLiability: boolean,
  ): Promise<OwnerLedgerMutationResult | null> {
    const prior = await this.readProcessedOperation(
      transaction,
      context.storeId,
      operation.operationId,
    );
    if (prior) {
      return this.resolveProcessedOperation(transaction, context, operation, prior);
    }

    await this.lockActiveStoreForNewWrite(transaction, context.storeId, serializeOwnerLiability);

    let claimed: boolean;
    try {
      const result = await transaction.transaction((savepoint) =>
        savepoint.execute<{ claimed: boolean }>(sql`
          select sync.claim_operation(
            ${context.storeId}::uuid,
            ${operation.operationId}::uuid,
            ${context.deviceId}::uuid,
            ${operation.aggregateType},
            ${operation.aggregateId}::uuid,
            ${operation.action},
            ${operation.requestHash}
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
        operation.operationId,
      );
      if (!concurrent) {
        throw error;
      }
      return this.resolveProcessedOperation(transaction, context, operation, concurrent);
    }

    if (claimed) {
      return null;
    }
    const existing = await this.readProcessedOperation(
      transaction,
      context.storeId,
      operation.operationId,
    );
    if (!existing) {
      throw new Error('Claimed Owner Ledger operation could not be read.');
    }
    return this.resolveProcessedOperation(transaction, context, operation, existing);
  }

  private async lockActiveStoreForNewWrite(
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
      where store_id = ${storeId}::uuid
        and operation_id = ${operationId}::uuid
    `);
    return result.rows[0];
  }

  private async resolveProcessedOperation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    operation: MutationOperation,
    existing: ProcessedOperationRow,
  ): Promise<OwnerLedgerMutationResult> {
    if (
      existing.deviceId !== context.deviceId ||
      existing.aggregateType !== operation.aggregateType ||
      existing.aggregateId !== operation.aggregateId ||
      existing.action !== operation.action ||
      existing.requestHash !== operation.requestHash
    ) {
      await this.recordOperationConflict(transaction, context, operation);
      return failure('OPERATION_ID_CONFLICT');
    }
    if (existing.status === 'applied') {
      return {
        ok: true,
        response: parseStoredOwnerLedgerMutationResponse(existing.responseBody),
      };
    }
    if (existing.status === 'rejected') {
      return this.parseStoredRejection(existing);
    }
    return failure('OPERATION_IN_PROGRESS');
  }

  private parseStoredRejection(existing: ProcessedOperationRow): FailureResult {
    const code = existing.errorCode;
    const body = existing.responseBody;
    if (
      !code ||
      !(code in failureDefinitions) ||
      !isRecord(body) ||
      body.code !== code ||
      typeof body.message !== 'string'
    ) {
      throw new Error('Stored Owner Ledger mutation rejection is invalid.');
    }
    const definition = failureDefinitions[code as OwnerLedgerMutationFailureCode];
    if (existing.responseCode !== definition.statusCode) {
      throw new Error('Stored Owner Ledger mutation rejection is invalid.');
    }
    return {
      ok: false,
      error: {
        code: definition.code,
        message: body.message,
        statusCode: definition.statusCode,
      },
    };
  }

  private async applyOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    response: OwnerLedgerMutationResponse,
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
      throw new Error('Owner Ledger operation completion failed.');
    }
  }

  private async persistKnownRejection(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    error: unknown,
  ): Promise<FailureResult> {
    if (!(error instanceof OwnerLedgerRejectedError)) {
      throw error;
    }
    await this.rejectOperation(transaction, storeId, operationId, error.result);
    return error.result;
  }

  private async rejectOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    result: FailureResult,
  ): Promise<void> {
    const response = { code: result.error.code, message: result.error.message };
    const completed = await transaction.execute(sql`
      update sync.processed_operations
      set
        status = 'rejected',
        response_code = ${result.error.statusCode},
        response_body = ${JSON.stringify(response)}::jsonb,
        error_code = ${result.error.code},
        completed_at = clock_timestamp()
      where store_id = ${storeId}::uuid
        and operation_id = ${operationId}::uuid
        and status = 'processing'
      returning operation_id
    `);
    if (completed.rows.length !== 1) {
      throw new Error('Owner Ledger operation rejection failed.');
    }
  }

  private async recordOperationConflict(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    operation: MutationOperation,
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
        ${operation.operationId}::uuid,
        ${operation.aggregateType},
        ${operation.aggregateId}::uuid,
        'duplicate_identity',
        jsonb_build_object(
          'action',
          ${operation.action}::text,
          'requestHash',
          ${operation.requestHash}::text
        )
      )
    `);
  }
}
