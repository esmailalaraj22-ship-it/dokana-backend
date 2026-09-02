import { ForbiddenException, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import { accountingPeriods, stores } from '../database/schema';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { postgresqlErrorCode } from './accounting-period-database-error';
import {
  AccountingPeriodIntegrityError,
  AccountingPeriodProvisioningService,
} from './accounting-period-provisioning.service';
import {
  mapAccountingPeriodMutationResponse,
  parseStoredAccountingPeriodMutationResponse,
} from './accounting-period-write-response';
import type {
  AccountingPeriodMutationFailure,
  AccountingPeriodMutationFailureCode,
  AccountingPeriodMutationResult,
  AccountingPeriodMutationRow,
  PreparedAccountingPeriodClose,
} from './accounting-period-write.types';

const accountingPeriodSelection = {
  id: accountingPeriods.id,
  storeId: accountingPeriods.storeId,
  periodYear: accountingPeriods.periodYear,
  periodMonth: accountingPeriods.periodMonth,
  startsAt: accountingPeriods.startsAt,
  endsAt: accountingPeriods.endsAt,
  status: accountingPeriods.status,
  closedAt: accountingPeriods.closedAt,
  deviceId: accountingPeriods.deviceId,
  operationId: accountingPeriods.operationId,
  createdAt: accountingPeriods.createdAt,
  updatedAt: accountingPeriods.updatedAt,
  version: accountingPeriods.version,
} as const;

const failureDefinitions: Readonly<
  Record<AccountingPeriodMutationFailureCode, AccountingPeriodMutationFailure>
> = {
  ACCOUNTING_PERIOD_NOT_FOUND: {
    code: 'ACCOUNTING_PERIOD_NOT_FOUND',
    message: 'Accounting Period not found.',
    statusCode: 404,
  },
  ACCOUNTING_PERIOD_VERSION_CONFLICT: {
    code: 'ACCOUNTING_PERIOD_VERSION_CONFLICT',
    message: 'Accounting Period version conflict.',
    statusCode: 409,
  },
  ACCOUNTING_PERIOD_INTEGRITY_CONFLICT: {
    code: 'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT',
    message: 'Accounting Period integrity conflict.',
    statusCode: 409,
  },
  ACCOUNTING_PERIOD_CLOSING: {
    code: 'ACCOUNTING_PERIOD_CLOSING',
    message: 'Accounting Period is in an internal closing state.',
    statusCode: 409,
  },
  ACCOUNTING_PERIOD_CLOSE_BLOCKED: {
    code: 'ACCOUNTING_PERIOD_CLOSE_BLOCKED',
    message: 'Accounting Period cannot be closed while blocking transactions or costs exist.',
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

interface CloseBlockerRow extends Record<string, unknown> {
  hasBlocker: boolean;
}

interface FailureResult {
  ok: false;
  error: AccountingPeriodMutationFailure;
}

function failure(code: AccountingPeriodMutationFailureCode): FailureResult {
  return { ok: false, error: failureDefinitions[code] };
}

@Injectable()
export class AccountingPeriodWriteRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly provisioning: AccountingPeriodProvisioningService,
  ) {}

  close(
    context: TenantTransactionContext,
    input: PreparedAccountingPeriodClose,
  ): Promise<AccountingPeriodMutationResult> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const begun = await this.beginMutation(transaction, context, input);
      if (begun) {
        return begun;
      }

      const currentRows = await transaction
        .select(accountingPeriodSelection)
        .from(accountingPeriods)
        .where(
          and(
            eq(accountingPeriods.storeId, context.storeId),
            eq(accountingPeriods.id, input.accountingPeriodId),
          ),
        )
        .limit(1)
        .for('update');
      const current = currentRows[0];
      if (!current) {
        return this.reject(
          transaction,
          context.storeId,
          input.operationId,
          'ACCOUNTING_PERIOD_NOT_FOUND',
        );
      }

      try {
        this.provisioning.assertCanonicalExistingRow(current, context.storeId);
      } catch (error) {
        if (!(error instanceof AccountingPeriodIntegrityError)) {
          throw error;
        }
        return this.reject(
          transaction,
          context.storeId,
          input.operationId,
          'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT',
        );
      }

      if (current.version !== input.expectedVersion) {
        return this.reject(
          transaction,
          context.storeId,
          input.operationId,
          'ACCOUNTING_PERIOD_VERSION_CONFLICT',
        );
      }
      if (current.status === 'closing') {
        return this.reject(
          transaction,
          context.storeId,
          input.operationId,
          'ACCOUNTING_PERIOD_CLOSING',
        );
      }

      let resultRow: AccountingPeriodMutationRow = current;
      if (current.status === 'open') {
        if (await this.hasCloseBlocker(transaction, context.storeId, current.id)) {
          return this.reject(
            transaction,
            context.storeId,
            input.operationId,
            'ACCOUNTING_PERIOD_CLOSE_BLOCKED',
          );
        }

        try {
          resultRow = await transaction.transaction(async (savepoint) => {
            const rows = await savepoint
              .update(accountingPeriods)
              .set({
                status: 'closed',
                closedAt: sql<Date>`clock_timestamp()`,
                deviceId: context.deviceId,
                operationId: input.operationId,
              })
              .where(
                and(
                  eq(accountingPeriods.storeId, context.storeId),
                  eq(accountingPeriods.id, input.accountingPeriodId),
                  eq(accountingPeriods.status, 'open'),
                  eq(accountingPeriods.version, input.expectedVersion),
                ),
              )
              .returning(accountingPeriodSelection);
            const closed = rows[0];
            if (!closed) {
              throw new Error('Locked Accounting Period close did not return a row.');
            }
            return closed;
          });
        } catch (error) {
          if (postgresqlErrorCode(error) !== '23514') {
            throw error;
          }
          return this.reject(
            transaction,
            context.storeId,
            input.operationId,
            'ACCOUNTING_PERIOD_CLOSE_BLOCKED',
          );
        }
      }

      const response = mapAccountingPeriodMutationResponse(resultRow, input.operationId);
      await this.applyOperation(transaction, context.storeId, input.operationId, response);
      return { ok: true, response };
    });
  }

  private async beginMutation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: PreparedAccountingPeriodClose,
  ): Promise<AccountingPeriodMutationResult | null> {
    const prior = await this.readProcessedOperation(
      transaction,
      context.storeId,
      input.operationId,
    );
    if (prior) {
      return this.resolveProcessedOperation(transaction, context, input, prior);
    }

    await this.assertActiveStoreForNewWrite(transaction, context.storeId);

    let claimed: boolean;
    try {
      const result = await transaction.transaction((savepoint) =>
        savepoint.execute<{ claimed: boolean }>(sql`
          select sync.claim_operation(
            ${context.storeId}::uuid,
            ${input.operationId}::uuid,
            ${context.deviceId}::uuid,
            'accounting_periods',
            ${input.accountingPeriodId}::uuid,
            ${input.action},
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
      return this.resolveProcessedOperation(transaction, context, input, concurrent);
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
      throw new Error('Claimed Accounting Period operation could not be read.');
    }
    return this.resolveProcessedOperation(transaction, context, input, existing);
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

  private async hasCloseBlocker(
    transaction: DatabaseTransaction,
    storeId: string,
    accountingPeriodId: string,
  ): Promise<boolean> {
    const result = await transaction.execute<CloseBlockerRow>(sql`
      select (
        exists (
          select 1 from ledger.sales
          where store_id = ${storeId}::uuid
            and accounting_period_id = ${accountingPeriodId}::uuid
            and status in ('posted', 'corrected')
            and pending_cost_line_count > 0
        )
        or exists (
          select 1 from ledger.inventory_movements
          where store_id = ${storeId}::uuid
            and accounting_period_id = ${accountingPeriodId}::uuid
            and has_pending_cost_after = true
        )
        or exists (
          select 1 from ledger.sales
          where store_id = ${storeId}::uuid
            and accounting_period_id = ${accountingPeriodId}::uuid
            and status = 'draft'
        )
        or exists (
          select 1 from ledger.goods_receipts
          where store_id = ${storeId}::uuid
            and accounting_period_id = ${accountingPeriodId}::uuid
            and status = 'draft'
        )
        or exists (
          select 1 from ledger.customer_payments
          where store_id = ${storeId}::uuid
            and accounting_period_id = ${accountingPeriodId}::uuid
            and status = 'draft'
        )
        or exists (
          select 1 from ledger.supplier_payments
          where store_id = ${storeId}::uuid
            and accounting_period_id = ${accountingPeriodId}::uuid
            and status = 'draft'
        )
        or exists (
          select 1 from ledger.expenses
          where store_id = ${storeId}::uuid
            and accounting_period_id = ${accountingPeriodId}::uuid
            and status = 'draft'
        )
      ) as "hasBlocker"
    `);
    return result.rows[0]?.hasBlocker === true;
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
    input: PreparedAccountingPeriodClose,
    existing: ProcessedOperationRow,
  ): Promise<AccountingPeriodMutationResult> {
    if (
      existing.deviceId !== context.deviceId ||
      existing.aggregateType !== 'accounting_periods' ||
      existing.aggregateId !== input.accountingPeriodId ||
      existing.action !== input.action ||
      existing.requestHash !== input.requestHash
    ) {
      await this.recordOperationConflict(transaction, context, input);
      return failure('OPERATION_ID_CONFLICT');
    }
    if (existing.status === 'applied') {
      return {
        ok: true,
        response: parseStoredAccountingPeriodMutationResponse(existing.responseBody),
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
      throw new Error('Stored Accounting Period close rejection is invalid.');
    }
    const definition = failureDefinitions[code as AccountingPeriodMutationFailureCode];
    if (existing.responseCode !== definition.statusCode) {
      throw new Error('Stored Accounting Period close rejection is invalid.');
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

  private async reject(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    code: AccountingPeriodMutationFailureCode,
  ): Promise<FailureResult> {
    const result = failure(code);
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
      throw new Error('Accounting Period operation rejection failed.');
    }
    return result;
  }

  private async applyOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    response: unknown,
  ): Promise<void> {
    const completed = await transaction.execute(sql`
      update sync.processed_operations
      set
        status = 'applied',
        response_code = 200,
        response_body = ${JSON.stringify(response)}::jsonb,
        error_code = null,
        completed_at = clock_timestamp()
      where store_id = ${storeId}::uuid
        and operation_id = ${operationId}::uuid
        and status = 'processing'
      returning operation_id
    `);
    if (completed.rows.length !== 1) {
      throw new Error('Accounting Period operation completion failed.');
    }
  }

  private async recordOperationConflict(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: PreparedAccountingPeriodClose,
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
        ${input.operationId}::uuid,
        'accounting_periods',
        ${input.accountingPeriodId}::uuid,
        ${input.expectedVersion.toString()}::bigint,
        'duplicate_identity',
        jsonb_build_object(
          'action',
          ${input.action}::text,
          'requestHash',
          ${input.requestHash}::text
        )
      )
    `);
  }
}
