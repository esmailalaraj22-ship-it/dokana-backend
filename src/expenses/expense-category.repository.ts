import { ForbiddenException, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import { expenseCategories, stores } from '../database/schema';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { uniqueConstraint } from '../money-accounts/money-account-database-error';
import {
  mapExpenseCategoryMutation,
  parseStoredExpenseCategoryMutation,
} from './expense-category-response';
import type {
  ExpenseCategoryMutationFailure,
  ExpenseCategoryMutationFailureCode,
  ExpenseCategoryMutationResult,
  ExpenseCategoryRow,
  ExpenseCategoryStatus,
  PreparedExpenseCategoryMutation,
} from './expense-category.types';

const selection = {
  id: expenseCategories.id,
  name: expenseCategories.name,
  normalizedName: expenseCategories.normalizedName,
  status: expenseCategories.status,
  createdAt: expenseCategories.createdAt,
  updatedAt: expenseCategories.updatedAt,
  version: expenseCategories.version,
} as const;

const failures: Readonly<
  Record<ExpenseCategoryMutationFailureCode, ExpenseCategoryMutationFailure>
> = {
  EXPENSE_CATEGORY_NOT_FOUND: {
    code: 'EXPENSE_CATEGORY_NOT_FOUND',
    message: 'Expense Category not found.',
    statusCode: 404,
  },
  EXPENSE_CATEGORY_ARCHIVED: {
    code: 'EXPENSE_CATEGORY_ARCHIVED',
    message: 'Archived Expense Category cannot be updated.',
    statusCode: 409,
  },
  EXPENSE_CATEGORY_NAME_CONFLICT: {
    code: 'EXPENSE_CATEGORY_NAME_CONFLICT',
    message: 'An Expense Category with this name already exists.',
    statusCode: 409,
  },
  EXPENSE_CATEGORY_VERSION_CONFLICT: {
    code: 'EXPENSE_CATEGORY_VERSION_CONFLICT',
    message: 'Expense Category version conflict.',
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
  CONFLICT: {
    code: 'CONFLICT',
    message: 'The request conflicts with existing state.',
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

interface FailureResult {
  ok: false;
  error: ExpenseCategoryMutationFailure;
}

function failure(code: ExpenseCategoryMutationFailureCode): FailureResult {
  return { ok: false, error: failures[code] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class ExpenseCategoryRepository {
  constructor(private readonly database: DatabaseService) {}

  list(
    context: TenantTransactionContext,
    status: ExpenseCategoryStatus,
  ): Promise<ExpenseCategoryRow[]> {
    return this.database.withTenantTransaction(context, (transaction) =>
      transaction
        .select(selection)
        .from(expenseCategories)
        .where(
          and(eq(expenseCategories.storeId, context.storeId), eq(expenseCategories.status, status)),
        )
        .orderBy(asc(expenseCategories.normalizedName), asc(expenseCategories.id)),
    );
  }

  findById(
    context: TenantTransactionContext,
    categoryId: string,
  ): Promise<ExpenseCategoryRow | undefined> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const rows = await transaction
        .select(selection)
        .from(expenseCategories)
        .where(
          and(eq(expenseCategories.storeId, context.storeId), eq(expenseCategories.id, categoryId)),
        )
        .limit(1);
      return rows[0];
    });
  }

  mutate(
    context: TenantTransactionContext,
    input: PreparedExpenseCategoryMutation,
  ): Promise<ExpenseCategoryMutationResult> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const replay = await this.beginMutation(transaction, context, input);
      if (replay) return replay;

      let result: ExpenseCategoryMutationResult;
      try {
        result = await transaction.transaction((savepoint) =>
          this.applyMutation(savepoint, context, input),
        );
      } catch (error) {
        const classified = this.classifyConstraint(error);
        if (!classified) throw error;
        result = classified;
      }

      if (!result.ok) {
        await this.rejectOperation(transaction, context.storeId, input.operationId, result);
        return result;
      }
      await this.applyOperation(
        transaction,
        context.storeId,
        input.operationId,
        input.action === 'create' ? 201 : 200,
        result.response,
      );
      return result;
    });
  }

  private async applyMutation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: PreparedExpenseCategoryMutation,
  ): Promise<ExpenseCategoryMutationResult> {
    if (input.action === 'create') {
      const rows = await transaction
        .insert(expenseCategories)
        .values({
          id: input.categoryId,
          storeId: context.storeId,
          name: input.name,
          normalizedName: input.normalizedName,
          status: 'active',
          deviceId: context.deviceId,
          operationId: input.operationId,
        })
        .returning(selection);
      const created = rows[0];
      if (!created) throw new Error('Expense Category create did not return a row.');
      return { ok: true, response: mapExpenseCategoryMutation(created, input.operationId) };
    }

    const currentRows = await transaction
      .select(selection)
      .from(expenseCategories)
      .where(
        and(
          eq(expenseCategories.storeId, context.storeId),
          eq(expenseCategories.id, input.categoryId),
        ),
      )
      .limit(1)
      .for('update');
    const current = currentRows[0];
    if (!current) return failure('EXPENSE_CATEGORY_NOT_FOUND');
    if (current.version !== input.expectedVersion) {
      return failure('EXPENSE_CATEGORY_VERSION_CONFLICT');
    }

    if (input.action === 'update') {
      if (current.status === 'archived') return failure('EXPENSE_CATEGORY_ARCHIVED');
      if (current.name === input.name && current.normalizedName === input.normalizedName) {
        return { ok: true, response: mapExpenseCategoryMutation(current, input.operationId) };
      }
      const rows = await transaction
        .update(expenseCategories)
        .set({
          name: input.name,
          normalizedName: input.normalizedName,
          deviceId: context.deviceId,
          operationId: input.operationId,
        })
        .where(
          and(
            eq(expenseCategories.storeId, context.storeId),
            eq(expenseCategories.id, input.categoryId),
            eq(expenseCategories.version, input.expectedVersion),
          ),
        )
        .returning(selection);
      const updated = rows[0];
      if (!updated) throw new Error('Locked Expense Category update did not return a row.');
      return { ok: true, response: mapExpenseCategoryMutation(updated, input.operationId) };
    }

    const targetStatus = input.action === 'archive' ? 'archived' : 'active';
    if (current.status === targetStatus) {
      return { ok: true, response: mapExpenseCategoryMutation(current, input.operationId) };
    }
    const rows = await transaction
      .update(expenseCategories)
      .set({ status: targetStatus, deviceId: context.deviceId, operationId: input.operationId })
      .where(
        and(
          eq(expenseCategories.storeId, context.storeId),
          eq(expenseCategories.id, input.categoryId),
          eq(expenseCategories.status, current.status),
          eq(expenseCategories.version, input.expectedVersion),
        ),
      )
      .returning(selection);
    const updated = rows[0];
    if (!updated) throw new Error('Locked Expense Category lifecycle update returned no row.');
    return { ok: true, response: mapExpenseCategoryMutation(updated, input.operationId) };
  }

  private async beginMutation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: PreparedExpenseCategoryMutation,
  ): Promise<ExpenseCategoryMutationResult | null> {
    const prior = await this.readProcessedOperation(
      transaction,
      context.storeId,
      input.operationId,
    );
    if (prior) return this.resolveProcessedOperation(transaction, context, input, prior);

    await this.assertActiveStore(transaction, context.storeId);
    try {
      const claimed = await transaction.transaction((savepoint) =>
        savepoint.execute<{ claimed: boolean }>(sql`
          select sync.claim_operation(
            ${context.storeId}::uuid,
            ${input.operationId}::uuid,
            ${context.deviceId}::uuid,
            'expense_categories',
            ${input.categoryId}::uuid,
            ${input.action},
            ${input.requestHash}
          ) as claimed
        `),
      );
      if (claimed.rows[0]?.claimed === true) return null;
    } catch (error) {
      if (uniqueConstraint(error) === undefined) throw error;
    }

    const existing = await this.readProcessedOperation(
      transaction,
      context.storeId,
      input.operationId,
    );
    if (!existing) throw new Error('Claimed Expense Category operation could not be read.');
    return this.resolveProcessedOperation(transaction, context, input, existing);
  }

  private async assertActiveStore(
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
      select device_id as "deviceId", aggregate_type as "aggregateType",
        aggregate_id as "aggregateId", action, request_hash as "requestHash",
        status, response_code as "responseCode", response_body as "responseBody",
        error_code as "errorCode"
      from sync.processed_operations
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid
    `);
    return result.rows[0];
  }

  private async resolveProcessedOperation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: PreparedExpenseCategoryMutation,
    existing: ProcessedOperationRow,
  ): Promise<ExpenseCategoryMutationResult> {
    if (
      existing.deviceId !== context.deviceId ||
      existing.aggregateType !== 'expense_categories' ||
      existing.aggregateId !== input.categoryId ||
      existing.action !== input.action ||
      existing.requestHash !== input.requestHash
    ) {
      await transaction.execute(sql`
        insert into sync.conflicts (
          store_id, operation_id, entity_type, entity_id, client_version,
          conflict_type, client_payload
        ) values (
          ${context.storeId}::uuid, ${input.operationId}::uuid,
          'expense_categories', ${input.categoryId}::uuid,
          ${input.action === 'create' ? null : input.expectedVersion.toString()}::bigint,
          'duplicate_identity',
          jsonb_build_object('action', ${input.action}::text, 'requestHash', ${input.requestHash}::text)
        )
      `);
      return failure('OPERATION_ID_CONFLICT');
    }
    if (existing.status === 'applied') {
      return { ok: true, response: parseStoredExpenseCategoryMutation(existing.responseBody) };
    }
    if (existing.status === 'processing') return failure('OPERATION_IN_PROGRESS');
    const code = existing.errorCode;
    if (
      !code ||
      !(code in failures) ||
      !isRecord(existing.responseBody) ||
      existing.responseBody.code !== code ||
      typeof existing.responseBody.message !== 'string'
    ) {
      throw new Error('Stored Expense Category rejection is invalid.');
    }
    const definition = failures[code as ExpenseCategoryMutationFailureCode];
    if (existing.responseCode !== definition.statusCode) {
      throw new Error('Stored Expense Category rejection status is invalid.');
    }
    return {
      ok: false,
      error: { ...definition, message: existing.responseBody.message },
    };
  }

  private classifyConstraint(error: unknown): FailureResult | null {
    const constraint = uniqueConstraint(error);
    if (constraint === undefined) return null;
    if (constraint === 'expense_categories_store_id_normalized_name_key') {
      return failure('EXPENSE_CATEGORY_NAME_CONFLICT');
    }
    if (constraint === 'expense_categories_store_id_operation_id_key') {
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
    const completed = await transaction.execute(sql`
      update sync.processed_operations
      set status='applied', response_code=${responseCode},
        response_body=${JSON.stringify(response)}::jsonb, error_code=null,
        completed_at=clock_timestamp()
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid
        and status='processing'
      returning operation_id
    `);
    if (completed.rows.length !== 1) {
      throw new Error('Expense Category operation completion failed.');
    }
  }

  private async rejectOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    result: FailureResult,
  ): Promise<void> {
    const body = { code: result.error.code, message: result.error.message };
    const completed = await transaction.execute(sql`
      update sync.processed_operations
      set status='rejected', response_code=${result.error.statusCode},
        response_body=${JSON.stringify(body)}::jsonb, error_code=${result.error.code},
        completed_at=clock_timestamp()
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid
        and status='processing'
      returning operation_id
    `);
    if (completed.rows.length !== 1) {
      throw new Error('Expense Category operation rejection failed.');
    }
  }
}
