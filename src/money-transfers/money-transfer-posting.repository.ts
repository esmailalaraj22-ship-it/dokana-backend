import { ForbiddenException, HttpException, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';

import {
  AccountingPeriodNotPostingEligibleError,
  AccountingPeriodPostingContextService,
} from '../accounting-periods/accounting-period-posting-context.service';
import type { AccountingPeriodPostingContext } from '../accounting-periods/accounting-period-posting-context.types';
import { AccountingPeriodIntegrityError } from '../accounting-periods/accounting-period-provisioning.service';
import { DatabaseService } from '../database/database.service';
import { moneyTransfers, stores } from '../database/schema';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import {
  postgresqlConstraint,
  postgresqlErrorCode,
} from '../money-movements/money-movement-database-error';
import {
  deriveMoneyFactId,
  deriveMoneyFactOperationId,
  deriveTransactionGroupId,
} from '../money-movements/money-movement-identity';
import { MoneyMovementPostingRepository } from '../money-movements/money-movement-posting.repository';
import type { PostedMoneyMovement } from '../money-movements/money-movement.types';
import { parseStoredMoneyTransferMutationResponse } from './money-transfer-response';
import type {
  MoneyTransferCommandInput,
  MoneyTransferMutationFailure,
  MoneyTransferMutationFailureCode,
  MoneyTransferMutationResponse,
  MoneyTransferMutationResult,
  PostedMoneyTransfer,
} from './money-transfer.types';

const MONEY_TRANSFERS_AGGREGATE = 'money_transfers';
const MONEY_TRANSFER_ACTION = 'create';

const factIdentityConstraints = new Set([
  'money_movements_pkey',
  'money_movements_store_id_id_key',
  'money_movements_store_id_operation_id_key',
  'money_transfers_pkey',
  'money_transfers_store_id_id_key',
  'money_transfers_store_id_operation_id_key',
  'money_transfers_store_id_source_movement_id_key',
  'money_transfers_store_id_destination_movement_id_key',
]);

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

interface MutationOperation {
  operationId: string;
  aggregateId: string;
  requestHash: string;
}

interface FailureResult {
  ok: false;
  error: MoneyTransferMutationFailure;
}

const failureDefinitions: Readonly<
  Record<MoneyTransferMutationFailureCode, MoneyTransferMutationFailure>
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
  MONEY_TRANSFER_SAME_ACCOUNT: {
    code: 'MONEY_TRANSFER_SAME_ACCOUNT',
    message: 'Transfer source and destination must differ.',
    statusCode: 409,
  },
  MONEY_TRANSFER_FACT_IDENTITY_CONFLICT: {
    code: 'MONEY_TRANSFER_FACT_IDENTITY_CONFLICT',
    message: 'Money Transfer fact identity conflicts with immutable history.',
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
};

class MoneyTransferRejectedError extends Error {
  constructor(readonly result: FailureResult) {
    super(result.error.message);
    this.name = 'MoneyTransferRejectedError';
  }
}

function failure(code: MoneyTransferMutationFailureCode): FailureResult {
  return { ok: false, error: failureDefinitions[code] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class MoneyTransferPostingRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly postingContext: AccountingPeriodPostingContextService,
    private readonly moneyMovements: MoneyMovementPostingRepository,
  ) {}

  post(
    context: TenantTransactionContext,
    input: MoneyTransferCommandInput,
  ): Promise<MoneyTransferMutationResult> {
    const transferId = deriveMoneyFactId(input.operationId, 'transfer-header');
    const transactionGroupId = deriveTransactionGroupId(input.operationId);
    const operation: MutationOperation = {
      operationId: input.operationId,
      aggregateId: transferId,
      requestHash: input.requestHash,
    };

    return this.database.withTenantTransaction(context, async (transaction) => {
      const begun = await this.beginMutation(transaction, context, operation);
      if (begun) {
        return begun;
      }

      try {
        const response = await transaction.transaction(async (savepoint) => {
          const posting = await this.resolvePosting(savepoint, context, input);
          const accountIds = [...new Set([input.sourceAccountId, input.destinationAccountId])];
          await this.lockAndValidateAccounts(savepoint, context.storeId, accountIds);
          if (input.sourceAccountId === input.destinationAccountId) {
            throw new MoneyTransferRejectedError(failure('MONEY_TRANSFER_SAME_ACCOUNT'));
          }

          const sourceMovementId = deriveMoneyFactId(input.operationId, 'transfer-source');
          const destinationMovementId = deriveMoneyFactId(
            input.operationId,
            'transfer-destination',
          );
          const source = await this.moneyMovements.insertMovementWithinTransaction(
            savepoint,
            context,
            {
              commandOperationId: input.operationId,
              discriminator: 'transfer-source',
              accountId: input.sourceAccountId,
              amountDeltaMinor: -input.amountMinor,
              movementType: 'internal_transfer',
              referenceType: 'money_transfer',
              referenceId: transferId,
              accountingPeriodId: posting.accountingPeriodId,
              occurredAt: input.occurredAt,
              transactionGroupId,
              transferGroupId: transferId,
              counterAccountId: input.destinationAccountId,
            },
          );
          const destination = await this.moneyMovements.insertMovementWithinTransaction(
            savepoint,
            context,
            {
              commandOperationId: input.operationId,
              discriminator: 'transfer-destination',
              accountId: input.destinationAccountId,
              amountDeltaMinor: input.amountMinor,
              movementType: 'internal_transfer',
              referenceType: 'money_transfer',
              referenceId: transferId,
              accountingPeriodId: posting.accountingPeriodId,
              occurredAt: input.occurredAt,
              transactionGroupId,
              transferGroupId: transferId,
              counterAccountId: input.sourceAccountId,
            },
          );
          const displayNumber = await this.nextDisplayNumberWithinTransaction(
            savepoint,
            context,
            posting.postingDate,
          );
          const transfer = await this.insertTransferWithinTransaction(savepoint, context, {
            id: transferId,
            operationId: deriveMoneyFactOperationId(input.operationId, 'transfer-header'),
            displayNumber,
            sourceAccountId: input.sourceAccountId,
            destinationAccountId: input.destinationAccountId,
            amountMinor: input.amountMinor,
            transferAt: input.occurredAt,
            sourceMovementId,
            destinationMovementId,
            accountingPeriodId: posting.accountingPeriodId,
          });

          return this.response(input.operationId, posting, transfer, source, destination);
        });

        await this.applyOperation(transaction, context.storeId, input.operationId, response);
        return { ok: true, response };
      } catch (error) {
        return this.persistKnownRejection(
          transaction,
          context.storeId,
          input.operationId,
          this.classifyFactIdentityCollision(error),
        );
      }
    });
  }

  private response(
    operationId: string,
    posting: AccountingPeriodPostingContext,
    transfer: PostedMoneyTransfer,
    source: PostedMoneyMovement,
    destination: PostedMoneyMovement,
  ): MoneyTransferMutationResponse {
    return {
      operationId,
      postingDate: posting.postingDate,
      accountingPeriodId: posting.accountingPeriodId,
      transfer,
      movements: [source, destination],
    };
  }

  private async resolvePosting(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: MoneyTransferCommandInput,
  ): Promise<AccountingPeriodPostingContext> {
    try {
      return await this.postingContext.resolveForWrite(transaction, context, {
        postingDate: input.postingDate,
        operationId: input.operationId,
      });
    } catch (error) {
      if (error instanceof AccountingPeriodNotPostingEligibleError) {
        throw new MoneyTransferRejectedError(failure('ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE'));
      }
      if (error instanceof AccountingPeriodIntegrityError) {
        throw new MoneyTransferRejectedError(failure('ACCOUNTING_PERIOD_INTEGRITY_CONFLICT'));
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
      await this.moneyMovements.lockAndValidateAccounts(transaction, storeId, accountIds);
    } catch (error) {
      const accountFailure = this.classifyMoneyAccountError(error);
      if (accountFailure) {
        throw new MoneyTransferRejectedError(accountFailure);
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

  private classifyFactIdentityCollision(error: unknown): unknown {
    if (
      postgresqlErrorCode(error) === '23505' &&
      factIdentityConstraints.has(postgresqlConstraint(error) ?? '')
    ) {
      return new MoneyTransferRejectedError(failure('MONEY_TRANSFER_FACT_IDENTITY_CONFLICT'));
    }
    return error;
  }

  async nextDisplayNumberWithinTransaction(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    postingDate: string,
  ): Promise<string> {
    const sequenceYear = Number.parseInt(postingDate.slice(0, 4), 10);
    const result = await transaction.execute<{ displayNumber: string }>(sql`
      select ledger.next_document_number(
        ${context.storeId}::uuid,
        ${context.deviceId}::uuid,
        'money_transfer',
        ${sequenceYear}::integer,
        device_prefix
      ) as "displayNumber"
      from ledger.devices
      where store_id = ${context.storeId}::uuid
        and id = ${context.deviceId}::uuid
        and status = 'active'
    `);
    const displayNumber = result.rows[0]?.displayNumber;
    if (!displayNumber) {
      throw new Error('Money Transfer display-number allocation failed.');
    }
    return displayNumber;
  }

  async insertTransferWithinTransaction(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    spec: {
      id: string;
      operationId: string;
      displayNumber: string;
      sourceAccountId: string;
      destinationAccountId: string;
      amountMinor: bigint;
      transferAt: Date;
      sourceMovementId: string;
      destinationMovementId: string;
      accountingPeriodId: string;
    },
  ): Promise<PostedMoneyTransfer> {
    const rows = await transaction
      .insert(moneyTransfers)
      .values({
        id: spec.id,
        storeId: context.storeId,
        accountingPeriodId: spec.accountingPeriodId,
        displayNumber: spec.displayNumber,
        sourceAccountId: spec.sourceAccountId,
        destinationAccountId: spec.destinationAccountId,
        amountMinor: spec.amountMinor,
        transferAt: spec.transferAt,
        sourceMovementId: spec.sourceMovementId,
        destinationMovementId: spec.destinationMovementId,
        status: 'posted',
        notes: null,
        cancelledAt: null,
        deviceId: context.deviceId,
        operationId: spec.operationId,
      })
      .returning({
        id: moneyTransfers.id,
        displayNumber: moneyTransfers.displayNumber,
        sourceAccountId: moneyTransfers.sourceAccountId,
        destinationAccountId: moneyTransfers.destinationAccountId,
        amountMinor: moneyTransfers.amountMinor,
        transferAt: moneyTransfers.transferAt,
        sourceMovementId: moneyTransfers.sourceMovementId,
        destinationMovementId: moneyTransfers.destinationMovementId,
        status: moneyTransfers.status,
        operationId: moneyTransfers.operationId,
        createdAt: moneyTransfers.createdAt,
        updatedAt: moneyTransfers.updatedAt,
        version: moneyTransfers.version,
      });
    const row = rows[0];
    if (!row?.sourceMovementId || !row.destinationMovementId || row.status !== 'posted') {
      throw new Error('Money Transfer insertion did not return a posted header.');
    }
    return {
      id: row.id,
      displayNumber: row.displayNumber,
      sourceAccountId: row.sourceAccountId,
      destinationAccountId: row.destinationAccountId,
      amountMinor: row.amountMinor.toString(),
      transferAt: row.transferAt.toISOString(),
      sourceMovementId: row.sourceMovementId,
      destinationMovementId: row.destinationMovementId,
      status: 'posted',
      operationId: row.operationId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: row.version.toString(),
    };
  }

  private async beginMutation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    operation: MutationOperation,
  ): Promise<MoneyTransferMutationResult | null> {
    const prior = await this.readProcessedOperation(
      transaction,
      context.storeId,
      operation.operationId,
    );
    if (prior) {
      return this.resolveProcessedOperation(transaction, context, operation, prior);
    }

    await this.lockActiveStoreForNewWrite(transaction, context.storeId);

    let claimed: boolean;
    try {
      const result = await transaction.transaction((savepoint) =>
        savepoint.execute<{ claimed: boolean }>(sql`
          select sync.claim_operation(
            ${context.storeId}::uuid,
            ${operation.operationId}::uuid,
            ${context.deviceId}::uuid,
            ${MONEY_TRANSFERS_AGGREGATE},
            ${operation.aggregateId}::uuid,
            ${MONEY_TRANSFER_ACTION},
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
      throw new Error('Claimed Money Transfer operation could not be read.');
    }
    return this.resolveProcessedOperation(transaction, context, operation, existing);
  }

  private async lockActiveStoreForNewWrite(
    transaction: DatabaseTransaction,
    storeId: string,
  ): Promise<void> {
    const rows = await transaction
      .select({ status: stores.status })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1)
      .for('share');
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
  ): Promise<MoneyTransferMutationResult> {
    if (
      existing.deviceId !== context.deviceId ||
      existing.aggregateType !== MONEY_TRANSFERS_AGGREGATE ||
      existing.aggregateId !== operation.aggregateId ||
      existing.action !== MONEY_TRANSFER_ACTION ||
      existing.requestHash !== operation.requestHash
    ) {
      await this.recordOperationConflict(transaction, context, operation);
      return failure('OPERATION_ID_CONFLICT');
    }
    if (existing.status === 'applied') {
      return {
        ok: true,
        response: parseStoredMoneyTransferMutationResponse(existing.responseBody),
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
      throw new Error('Stored Money Transfer rejection is invalid.');
    }
    const definition = failureDefinitions[code as MoneyTransferMutationFailureCode];
    if (existing.responseCode !== definition.statusCode) {
      throw new Error('Stored Money Transfer rejection is invalid.');
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
    response: MoneyTransferMutationResponse,
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
      throw new Error('Money Transfer operation completion failed.');
    }
  }

  private async persistKnownRejection(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    error: unknown,
  ): Promise<FailureResult> {
    if (!(error instanceof MoneyTransferRejectedError)) {
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
      throw new Error('Money Transfer operation rejection failed.');
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
        ${MONEY_TRANSFERS_AGGREGATE},
        ${operation.aggregateId}::uuid,
        'duplicate_identity',
        jsonb_build_object(
          'action',
          ${MONEY_TRANSFER_ACTION}::text,
          'requestHash',
          ${operation.requestHash}::text
        )
      )
    `);
  }
}
