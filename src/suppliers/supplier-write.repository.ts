import { ForbiddenException, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import { stores, suppliers } from '../database/schema';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import {
  mapSupplierMutationResponse,
  parseStoredSupplierMutationResponse,
} from './supplier-write-response';
import type {
  PreparedSupplierCreate,
  PreparedSupplierUpdate,
  SupplierMutationFailure,
  SupplierMutationFailureCode,
  SupplierMutationResult,
  SupplierMutationRow,
} from './supplier-write.types';

const supplierSelection = {
  id: suppliers.id,
  name: suppliers.name,
  normalizedName: suppliers.normalizedName,
  phone: suppliers.phone,
  normalizedPhone: suppliers.normalizedPhone,
  status: suppliers.status,
  archivedAt: suppliers.archivedAt,
  updatedAt: suppliers.updatedAt,
  notes: suppliers.notes,
  createdAt: suppliers.createdAt,
  version: suppliers.version,
} as const;

const failureDefinitions: Readonly<Record<SupplierMutationFailureCode, SupplierMutationFailure>> = {
  CONFLICT: {
    code: 'CONFLICT',
    message: 'The request conflicts with existing state.',
    statusCode: 409,
  },
  SUPPLIER_ARCHIVED: {
    code: 'SUPPLIER_ARCHIVED',
    message: 'Archived Supplier cannot be updated.',
    statusCode: 409,
  },
  SUPPLIER_NOT_FOUND: {
    code: 'SUPPLIER_NOT_FOUND',
    message: 'Supplier not found.',
    statusCode: 404,
  },
  SUPPLIER_PHONE_CONFLICT: {
    code: 'SUPPLIER_PHONE_CONFLICT',
    message: 'A Supplier with this phone already exists.',
    statusCode: 409,
  },
  SUPPLIER_VERSION_CONFLICT: {
    code: 'SUPPLIER_VERSION_CONFLICT',
    message: 'Supplier version conflict.',
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
  supplierId: string;
  operationId: string;
  requestHash: string;
  action: 'create' | 'update';
  expectedVersion?: bigint;
}

interface ProcessedOperationRow extends Record<string, unknown> {
  deviceId: string;
  aggregateType: string;
  aggregateId: string;
  action: string;
  requestHash: string;
  status: 'processing' | 'applied' | 'rejected';
  responseBody: unknown;
  errorCode: string | null;
}

interface PostgreSqlError {
  code?: unknown;
  constraint?: unknown;
  cause?: unknown;
}

interface FailureResult {
  ok: false;
  error: SupplierMutationFailure;
}

function failure(code: SupplierMutationFailureCode): FailureResult {
  return { ok: false, error: failureDefinitions[code] };
}

function databaseError(error: unknown): PostgreSqlError | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const candidate: PostgreSqlError = {
    code: 'code' in error ? error.code : undefined,
    constraint: 'constraint' in error ? error.constraint : undefined,
    cause: 'cause' in error ? error.cause : undefined,
  };
  if (candidate.code !== undefined || candidate.constraint !== undefined) {
    return candidate;
  }
  return candidate.cause === error ? undefined : databaseError(candidate.cause);
}

function uniqueConstraint(error: unknown): string | undefined {
  const postgresError = databaseError(error);
  if (postgresError?.code !== '23505') {
    return undefined;
  }
  return typeof postgresError.constraint === 'string' ? postgresError.constraint : '';
}

@Injectable()
export class SupplierWriteRepository {
  constructor(private readonly database: DatabaseService) {}

  create(
    context: TenantTransactionContext,
    input: PreparedSupplierCreate,
  ): Promise<SupplierMutationResult> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const operation: MutationOperation = {
        supplierId: input.supplierId,
        operationId: input.operationId,
        requestHash: input.requestHash,
        action: 'create',
      };
      const begun = await this.beginMutation(transaction, context, operation);
      if (begun) {
        return begun;
      }

      let row: SupplierMutationRow;
      try {
        row = await transaction.transaction(async (savepoint) => {
          const rows = await savepoint
            .insert(suppliers)
            .values({
              id: input.supplierId,
              storeId: context.storeId,
              name: input.name,
              normalizedName: input.normalizedName,
              phone: input.phone,
              normalizedPhone: input.normalizedPhone,
              notes: input.notes,
              status: 'active',
              archivedAt: null,
              deviceId: context.deviceId,
              operationId: input.operationId,
            })
            .returning(supplierSelection);
          const created = rows[0];
          if (!created) {
            throw new Error('Supplier create did not return a row.');
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

      const response = mapSupplierMutationResponse(row, input.operationId);
      await this.applyOperation(transaction, context.storeId, input.operationId, 201, response);
      return { ok: true, response };
    });
  }

  update(
    context: TenantTransactionContext,
    input: PreparedSupplierUpdate,
  ): Promise<SupplierMutationResult> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const operation: MutationOperation = {
        supplierId: input.supplierId,
        operationId: input.operationId,
        requestHash: input.requestHash,
        action: 'update',
        expectedVersion: input.expectedVersion,
      };
      const begun = await this.beginMutation(transaction, context, operation);
      if (begun) {
        return begun;
      }

      const currentRows = await transaction
        .select(supplierSelection)
        .from(suppliers)
        .where(and(eq(suppliers.storeId, context.storeId), eq(suppliers.id, input.supplierId)))
        .limit(1)
        .for('update');
      const current = currentRows[0];
      const stateConflict = this.classifyState(current, input.expectedVersion);
      if (stateConflict) {
        await this.rejectOperation(transaction, context.storeId, input.operationId, stateConflict);
        return stateConflict;
      }
      const currentSupplier = current as SupplierMutationRow;

      let row: SupplierMutationRow;
      if (this.isNoOp(currentSupplier, input)) {
        row = currentSupplier;
      } else {
        try {
          const rows = await transaction.transaction((savepoint) =>
            savepoint
              .update(suppliers)
              .set(this.buildUpdates(context, input))
              .where(
                and(
                  eq(suppliers.storeId, context.storeId),
                  eq(suppliers.id, input.supplierId),
                  eq(suppliers.status, 'active'),
                  eq(suppliers.version, input.expectedVersion),
                ),
              )
              .returning(supplierSelection),
          );
          const updated = rows[0];
          if (!updated) {
            throw new Error('Locked Supplier update did not return a row.');
          }
          row = updated;
        } catch (error) {
          const conflict = this.classifyConstraint(error);
          if (!conflict) {
            throw error;
          }
          await this.rejectOperation(transaction, context.storeId, input.operationId, conflict);
          return conflict;
        }
      }

      const response = mapSupplierMutationResponse(row, input.operationId);
      await this.applyOperation(transaction, context.storeId, input.operationId, 200, response);
      return { ok: true, response };
    });
  }

  private async beginMutation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    operation: MutationOperation,
  ): Promise<SupplierMutationResult | null> {
    const prior = await this.readProcessedOperation(
      transaction,
      context.storeId,
      operation.operationId,
    );
    if (prior) {
      return this.resolveProcessedOperation(transaction, context, operation, prior);
    }

    await this.assertActiveStoreForNewWrite(transaction, context);

    let claimed: boolean;
    try {
      const result = await transaction.transaction((savepoint) =>
        savepoint.execute<{ claimed: boolean }>(sql`
          select sync.claim_operation(
            ${context.storeId}::uuid,
            ${operation.operationId}::uuid,
            ${context.deviceId}::uuid,
            'suppliers',
            ${operation.supplierId}::uuid,
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
      throw new Error('Claimed Supplier operation could not be read.');
    }
    return this.resolveProcessedOperation(transaction, context, operation, existing);
  }

  private async assertActiveStoreForNewWrite(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
  ): Promise<void> {
    const rows = await transaction
      .select({ status: stores.status })
      .from(stores)
      .where(eq(stores.id, context.storeId))
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
  ): Promise<SupplierMutationResult> {
    if (
      existing.deviceId !== context.deviceId ||
      existing.aggregateType !== 'suppliers' ||
      existing.aggregateId !== operation.supplierId ||
      existing.action !== operation.action ||
      existing.requestHash !== operation.requestHash
    ) {
      await this.recordOperationConflict(transaction, context, operation);
      return failure('OPERATION_ID_CONFLICT');
    }

    if (existing.status === 'applied') {
      return { ok: true, response: parseStoredSupplierMutationResponse(existing.responseBody) };
    }
    if (existing.status === 'rejected') {
      const code = existing.errorCode;
      if (!code || !(code in failureDefinitions)) {
        throw new Error('Stored Supplier mutation rejection is invalid.');
      }
      return failure(code as SupplierMutationFailureCode);
    }
    return failure('OPERATION_IN_PROGRESS');
  }

  private classifyState(
    current: SupplierMutationRow | undefined,
    expectedVersion: bigint,
  ): FailureResult | null {
    if (!current) {
      return failure('SUPPLIER_NOT_FOUND');
    }
    if (current.status === 'archived') {
      return failure('SUPPLIER_ARCHIVED');
    }
    if (current.version !== expectedVersion) {
      return failure('SUPPLIER_VERSION_CONFLICT');
    }
    return null;
  }

  private isNoOp(current: SupplierMutationRow, input: PreparedSupplierUpdate): boolean {
    if (input.name !== undefined && input.name !== current.name) {
      return false;
    }
    if (input.normalizedName !== undefined && input.normalizedName !== current.normalizedName) {
      return false;
    }
    if (input.phone !== undefined && input.phone !== current.phone) {
      return false;
    }
    if (input.normalizedPhone !== undefined && input.normalizedPhone !== current.normalizedPhone) {
      return false;
    }
    if (input.notes !== undefined && input.notes !== current.notes) {
      return false;
    }
    return true;
  }

  private buildUpdates(
    context: TenantTransactionContext,
    input: PreparedSupplierUpdate,
  ): Record<string, unknown> {
    const updates: Record<string, unknown> = {
      deviceId: context.deviceId,
      operationId: input.operationId,
    };
    if (input.name !== undefined && input.normalizedName !== undefined) {
      updates.name = input.name;
      updates.normalizedName = input.normalizedName;
    }
    if (input.phone !== undefined && input.normalizedPhone !== undefined) {
      updates.phone = input.phone;
      updates.normalizedPhone = input.normalizedPhone;
    }
    if (input.notes !== undefined) {
      updates.notes = input.notes;
    }
    return updates;
  }

  private classifyConstraint(error: unknown): FailureResult | null {
    const constraint = uniqueConstraint(error);
    if (constraint === undefined) {
      return null;
    }
    if (constraint === 'suppliers_store_id_normalized_phone_key') {
      return failure('SUPPLIER_PHONE_CONFLICT');
    }
    if (constraint === 'suppliers_store_id_operation_id_key') {
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
      throw new Error('Supplier operation completion failed.');
    }
  }

  private async rejectOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    result: SupplierMutationResult,
  ): Promise<void> {
    if (result.ok) {
      throw new TypeError('A successful Supplier mutation cannot be rejected.');
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
      throw new Error('Supplier operation rejection failed.');
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
        'suppliers',
        ${operation.supplierId}::uuid,
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
