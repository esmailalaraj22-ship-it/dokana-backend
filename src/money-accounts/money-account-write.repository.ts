import { ForbiddenException, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import { moneyAccounts, stores } from '../database/schema';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { uniqueConstraint } from './money-account-database-error';
import {
  mapMoneyAccountMutationResponse,
  parseStoredMoneyAccountMutationResponse,
} from './money-account-write-response';
import type {
  MoneyAccountLifecycleAction,
  MoneyAccountMutationFailure,
  MoneyAccountMutationFailureCode,
  MoneyAccountMutationResult,
  MoneyAccountMutationRow,
  PreparedMoneyAccountCreate,
  PreparedMoneyAccountLifecycle,
} from './money-account-write.types';
import { isValidSystemCash } from './system-cash-invariants';

const moneyAccountSelection = {
  id: moneyAccounts.id,
  name: moneyAccounts.name,
  normalizedName: moneyAccounts.normalizedName,
  accountType: moneyAccounts.accountType,
  availability: moneyAccounts.availability,
  isDefault: moneyAccounts.isDefault,
  status: moneyAccounts.status,
  archivedAt: moneyAccounts.archivedAt,
  createdAt: moneyAccounts.createdAt,
  updatedAt: moneyAccounts.updatedAt,
  version: moneyAccounts.version,
} as const;

const failureDefinitions: Readonly<
  Record<MoneyAccountMutationFailureCode, MoneyAccountMutationFailure>
> = {
  CONFLICT: {
    code: 'CONFLICT',
    message: 'The request conflicts with existing state.',
    statusCode: 409,
  },
  MONEY_ACCOUNT_NOT_INITIALIZED: {
    code: 'MONEY_ACCOUNT_NOT_INITIALIZED',
    message: 'Money Accounts are not initialized.',
    statusCode: 409,
  },
  MONEY_ACCOUNT_NOT_FOUND: {
    code: 'MONEY_ACCOUNT_NOT_FOUND',
    message: 'Money Account not found.',
    statusCode: 404,
  },
  MONEY_ACCOUNT_NAME_CONFLICT: {
    code: 'MONEY_ACCOUNT_NAME_CONFLICT',
    message: 'A Money Account with this name already exists.',
    statusCode: 409,
  },
  MONEY_ACCOUNT_CASH_IMMUTABLE: {
    code: 'MONEY_ACCOUNT_CASH_IMMUTABLE',
    message: 'The system Cash account is immutable.',
    statusCode: 409,
  },
  MONEY_ACCOUNT_VERSION_CONFLICT: {
    code: 'MONEY_ACCOUNT_VERSION_CONFLICT',
    message: 'Money Account version conflict.',
    statusCode: 409,
  },
  MONEY_ACCOUNT_NON_ZERO_BALANCE: {
    code: 'MONEY_ACCOUNT_NON_ZERO_BALANCE',
    message: 'Only a zero-balance Money Account can be archived.',
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

interface MutationOperation {
  moneyAccountId: string;
  operationId: string;
  requestHash: string;
  action: 'create' | MoneyAccountLifecycleAction;
  expectedVersion?: bigint;
}

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

interface BalanceRow extends Record<string, unknown> {
  balanceMinor: string | bigint;
}

interface FailureResult {
  ok: false;
  error: MoneyAccountMutationFailure;
}

function failure(code: MoneyAccountMutationFailureCode): FailureResult {
  return { ok: false, error: failureDefinitions[code] };
}

@Injectable()
export class MoneyAccountWriteRepository {
  constructor(private readonly database: DatabaseService) {}

  create(
    context: TenantTransactionContext,
    input: PreparedMoneyAccountCreate,
  ): Promise<MoneyAccountMutationResult> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const operation: MutationOperation = {
        moneyAccountId: input.moneyAccountId,
        operationId: input.operationId,
        requestHash: input.requestHash,
        action: 'create',
      };
      const begun = await this.beginMutation(transaction, context, operation);
      if (begun) {
        return begun;
      }

      const cashRows = await transaction
        .select(moneyAccountSelection)
        .from(moneyAccounts)
        .where(
          and(eq(moneyAccounts.storeId, context.storeId), eq(moneyAccounts.accountType, 'cash')),
        )
        .for('share');
      if (cashRows.length !== 1 || !cashRows[0] || !isValidSystemCash(cashRows[0])) {
        const conflict = failure('MONEY_ACCOUNT_NOT_INITIALIZED');
        await this.rejectOperation(transaction, context.storeId, input.operationId, conflict);
        return conflict;
      }

      let row: MoneyAccountMutationRow;
      try {
        row = await transaction.transaction(async (savepoint) => {
          const rows = await savepoint
            .insert(moneyAccounts)
            .values({
              id: input.moneyAccountId,
              storeId: context.storeId,
              name: input.name,
              normalizedName: input.normalizedName,
              accountType: 'transfer',
              availability: 'available',
              isDefault: false,
              status: 'active',
              archivedAt: null,
              deviceId: context.deviceId,
              operationId: input.operationId,
            })
            .returning(moneyAccountSelection);
          const created = rows[0];
          if (!created) {
            throw new Error('Money Account create did not return a row.');
          }
          return created;
        });
      } catch (error) {
        const conflict = this.classifyConstraint(error);
        if (!conflict) {
          throw error;
        }
        await this.rejectOperation(transaction, context.storeId, input.operationId, conflict);
        return conflict;
      }

      const response = mapMoneyAccountMutationResponse(row, input.operationId);
      await this.applyOperation(transaction, context.storeId, input.operationId, 201, response);
      return { ok: true, response };
    });
  }

  changeLifecycle(
    context: TenantTransactionContext,
    input: PreparedMoneyAccountLifecycle,
  ): Promise<MoneyAccountMutationResult> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const operation: MutationOperation = {
        moneyAccountId: input.moneyAccountId,
        operationId: input.operationId,
        requestHash: input.requestHash,
        action: input.action,
        expectedVersion: input.expectedVersion,
      };
      const begun = await this.beginMutation(transaction, context, operation);
      if (begun) {
        return begun;
      }

      const currentRows = await transaction
        .select(moneyAccountSelection)
        .from(moneyAccounts)
        .where(
          and(
            eq(moneyAccounts.storeId, context.storeId),
            eq(moneyAccounts.id, input.moneyAccountId),
          ),
        )
        .limit(1)
        .for('update');
      const current = currentRows[0];
      const visibilityConflict = this.classifyLifecycleTarget(current);
      if (visibilityConflict) {
        await this.rejectOperation(
          transaction,
          context.storeId,
          input.operationId,
          visibilityConflict,
        );
        return visibilityConflict;
      }
      const account = current as MoneyAccountMutationRow;
      if (account.version !== input.expectedVersion) {
        const conflict = failure('MONEY_ACCOUNT_VERSION_CONFLICT');
        await this.rejectOperation(transaction, context.storeId, input.operationId, conflict);
        return conflict;
      }

      const targetStatus = input.action === 'archive' ? 'archived' : 'active';
      let resultRow = account;
      if (account.status !== targetStatus) {
        if (
          input.action === 'archive' &&
          (await this.readBalance(transaction, context, account.id)) !== 0n
        ) {
          const conflict = failure('MONEY_ACCOUNT_NON_ZERO_BALANCE');
          await this.rejectOperation(transaction, context.storeId, input.operationId, conflict);
          return conflict;
        }

        const rows = await transaction
          .update(moneyAccounts)
          .set({
            status: targetStatus,
            archivedAt: input.action === 'archive' ? sql<Date>`clock_timestamp()` : null,
            deviceId: context.deviceId,
            operationId: input.operationId,
          })
          .where(
            and(
              eq(moneyAccounts.storeId, context.storeId),
              eq(moneyAccounts.id, input.moneyAccountId),
              eq(moneyAccounts.accountType, 'transfer'),
              eq(moneyAccounts.availability, 'available'),
              eq(moneyAccounts.status, account.status),
              eq(moneyAccounts.version, input.expectedVersion),
            ),
          )
          .returning(moneyAccountSelection);
        const updated = rows[0];
        if (!updated) {
          throw new Error('Locked Money Account lifecycle update did not return a row.');
        }
        resultRow = updated;
      }

      const response = mapMoneyAccountMutationResponse(resultRow, input.operationId);
      await this.applyOperation(transaction, context.storeId, input.operationId, 200, response);
      return { ok: true, response };
    });
  }

  private async beginMutation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    operation: MutationOperation,
  ): Promise<MoneyAccountMutationResult | null> {
    const prior = await this.readProcessedOperation(
      transaction,
      context.storeId,
      operation.operationId,
    );
    if (prior) {
      return this.resolveProcessedOperation(transaction, context, operation, prior);
    }

    await this.assertActiveStoreForNewWrite(transaction, context.storeId);

    let claimed: boolean;
    try {
      const result = await transaction.transaction((savepoint) =>
        savepoint.execute<{ claimed: boolean }>(sql`
          select sync.claim_operation(
            ${context.storeId}::uuid,
            ${operation.operationId}::uuid,
            ${context.deviceId}::uuid,
            'money_accounts',
            ${operation.moneyAccountId}::uuid,
            ${operation.action},
            ${operation.requestHash}
          ) as claimed
        `),
      );
      claimed = result.rows[0]?.claimed === true;
    } catch (error) {
      if (uniqueConstraint(error) === undefined) {
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
      throw new Error('Claimed Money Account operation could not be read.');
    }
    return this.resolveProcessedOperation(transaction, context, operation, existing);
  }

  private async assertActiveStoreForNewWrite(
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
  ): Promise<MoneyAccountMutationResult> {
    if (
      existing.deviceId !== context.deviceId ||
      existing.aggregateType !== 'money_accounts' ||
      existing.aggregateId !== operation.moneyAccountId ||
      existing.action !== operation.action ||
      existing.requestHash !== operation.requestHash
    ) {
      await this.recordOperationConflict(transaction, context, operation);
      return failure('OPERATION_ID_CONFLICT');
    }
    if (existing.status === 'applied') {
      return {
        ok: true,
        response: parseStoredMoneyAccountMutationResponse(existing.responseBody),
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
      !body ||
      typeof body !== 'object' ||
      !('code' in body) ||
      !('message' in body) ||
      body.code !== code ||
      typeof body.message !== 'string'
    ) {
      throw new Error('Stored Money Account mutation rejection is invalid.');
    }
    const definition = failureDefinitions[code as MoneyAccountMutationFailureCode];
    if (existing.responseCode !== definition.statusCode) {
      throw new Error('Stored Money Account mutation rejection is invalid.');
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

  private classifyLifecycleTarget(
    current: MoneyAccountMutationRow | undefined,
  ): FailureResult | null {
    if (
      !current ||
      current.accountType === 'external_party' ||
      current.availability !== 'available'
    ) {
      return failure('MONEY_ACCOUNT_NOT_FOUND');
    }
    if (current.accountType === 'cash') {
      return failure('MONEY_ACCOUNT_CASH_IMMUTABLE');
    }
    if (current.isDefault) {
      return failure('MONEY_ACCOUNT_NOT_FOUND');
    }
    return null;
  }

  private async readBalance(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    moneyAccountId: string,
  ): Promise<bigint> {
    const result = await transaction.execute<BalanceRow>(sql`
      select balance_minor as "balanceMinor"
      from ledger.v_money_account_balances
      where store_id = ${context.storeId}::uuid
        and account_id = ${moneyAccountId}::uuid
    `);
    const value = result.rows[0]?.balanceMinor;
    if (typeof value !== 'string' && typeof value !== 'bigint') {
      throw new Error('Money Account authoritative balance is unavailable.');
    }
    return BigInt(value);
  }

  private classifyConstraint(error: unknown): FailureResult | null {
    const constraint = uniqueConstraint(error);
    if (constraint === undefined) {
      return null;
    }
    if (constraint === 'money_accounts_store_id_normalized_name_key') {
      return failure('MONEY_ACCOUNT_NAME_CONFLICT');
    }
    if (constraint === 'money_accounts_store_id_operation_id_key') {
      return failure('OPERATION_ID_CONFLICT');
    }
    return failure('CONFLICT');
  }

  private async applyOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    responseCode: number,
    response: unknown,
  ): Promise<void> {
    const result = await transaction.execute(sql`
      update sync.processed_operations
      set
        status = 'applied',
        response_code = ${responseCode},
        response_body = ${JSON.stringify(response)}::jsonb,
        error_code = null,
        completed_at = clock_timestamp()
      where store_id = ${storeId}::uuid
        and operation_id = ${operationId}::uuid
        and status = 'processing'
      returning operation_id
    `);
    if (result.rows.length !== 1) {
      throw new Error('Money Account operation completion failed.');
    }
  }

  private async rejectOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    result: MoneyAccountMutationResult,
  ): Promise<void> {
    if (result.ok) {
      throw new TypeError('A successful Money Account mutation cannot be rejected.');
    }
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
      throw new Error('Money Account operation rejection failed.');
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
        client_version,
        conflict_type,
        client_payload
      ) values (
        ${context.storeId}::uuid,
        ${operation.operationId}::uuid,
        'money_accounts',
        ${operation.moneyAccountId}::uuid,
        ${operation.expectedVersion?.toString() ?? null}::bigint,
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
