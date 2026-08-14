import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import { customers } from '../database/schema';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import {
  mapCustomerMutationResponse,
  parseStoredCustomerMutationResponse,
} from './customer-write-response';
import type {
  CustomerMutationFailure,
  CustomerMutationFailureCode,
  CustomerMutationResult,
  CustomerMutationRow,
  PreparedCustomerCreate,
  PreparedCustomerUpdate,
} from './customer-write.types';

const customerMutationSelection = {
  id: customers.id,
  name: customers.name,
  normalizedName: customers.normalizedName,
  phone: customers.phone,
  status: customers.status,
  archivedAt: customers.archivedAt,
  updatedAt: customers.updatedAt,
  notes: customers.notes,
  createdAt: customers.createdAt,
  version: customers.version,
  operationId: customers.operationId,
};

const failureDefinitions: Readonly<Record<CustomerMutationFailureCode, CustomerMutationFailure>> = {
  CONFLICT: {
    code: 'CONFLICT',
    message: 'The request conflicts with existing state.',
    statusCode: 409,
  },
  CUSTOMER_ARCHIVED: {
    code: 'CUSTOMER_ARCHIVED',
    message: 'Archived Customer cannot be updated.',
    statusCode: 409,
  },
  CUSTOMER_NOT_FOUND: {
    code: 'CUSTOMER_NOT_FOUND',
    message: 'Customer not found.',
    statusCode: 404,
  },
  CUSTOMER_PHONE_CONFLICT: {
    code: 'CUSTOMER_PHONE_CONFLICT',
    message: 'A Customer with this phone already exists.',
    statusCode: 409,
  },
  CUSTOMER_VERSION_CONFLICT: {
    code: 'CUSTOMER_VERSION_CONFLICT',
    message: 'Customer version conflict.',
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
  customerId: string;
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
  responseCode: number | null;
  responseBody: unknown;
  errorCode: string | null;
}

interface PostgreSqlError {
  code?: unknown;
  constraint?: unknown;
  cause?: unknown;
}

function failure(code: CustomerMutationFailureCode): CustomerMutationResult {
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

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const postgresError = databaseError(error);
  return (
    postgresError?.code === '23505' &&
    (constraint === undefined || postgresError.constraint === constraint)
  );
}

@Injectable()
export class CustomerWriteRepository {
  constructor(private readonly database: DatabaseService) {}

  create(
    context: TenantTransactionContext,
    input: PreparedCustomerCreate,
  ): Promise<CustomerMutationResult> {
    return this.database.withBusinessWriteTransaction(context, async (transaction) => {
      const operation: MutationOperation = {
        customerId: input.customerId,
        operationId: input.operationId,
        requestHash: input.requestHash,
        action: 'create',
      };
      const replay = await this.claimOrReplay(transaction, context, operation);
      if (replay) {
        return replay;
      }

      const rows = await transaction
        .insert(customers)
        .values({
          id: input.customerId,
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
        .onConflictDoNothing()
        .returning(customerMutationSelection);

      const row = rows[0];
      if (!row) {
        const conflict = await this.classifyCreateConflict(transaction, context, input);
        await this.rejectOperation(transaction, context.storeId, operation.operationId, conflict);
        return conflict;
      }

      const response = mapCustomerMutationResponse(row);
      await this.applyOperation(transaction, context.storeId, input.operationId, 201, response);
      return { ok: true, response };
    });
  }

  update(
    context: TenantTransactionContext,
    input: PreparedCustomerUpdate,
  ): Promise<CustomerMutationResult> {
    return this.database.withBusinessWriteTransaction(context, async (transaction) => {
      const operation: MutationOperation = {
        customerId: input.customerId,
        operationId: input.operationId,
        requestHash: input.requestHash,
        action: 'update',
        expectedVersion: input.expectedVersion,
      };
      const replay = await this.claimOrReplay(transaction, context, operation);
      if (replay) {
        return replay;
      }

      const updates: {
        deviceId: string;
        operationId: string;
        name?: string;
        normalizedName?: string;
        phone?: string;
        normalizedPhone?: string;
        notes?: string | null;
      } = {
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

      let rows: CustomerMutationRow[];
      try {
        rows = await transaction.transaction(async (savepoint) => {
          const updated = await savepoint
            .update(customers)
            .set(updates)
            .where(
              and(
                eq(customers.storeId, context.storeId),
                eq(customers.id, input.customerId),
                eq(customers.status, 'active'),
                eq(customers.version, input.expectedVersion),
              ),
            )
            .returning(customerMutationSelection);
          return updated;
        });
      } catch (error) {
        const conflict = this.classifyUpdateConstraint(error);
        if (!conflict) {
          throw error;
        }
        await this.rejectOperation(transaction, context.storeId, operation.operationId, conflict);
        return conflict;
      }

      const row = rows[0];
      if (!row) {
        const conflict = await this.classifyZeroRowUpdate(transaction, context, input);
        await this.rejectOperation(transaction, context.storeId, operation.operationId, conflict);
        return conflict;
      }

      const response = mapCustomerMutationResponse(row);
      await this.applyOperation(transaction, context.storeId, input.operationId, 200, response);
      return { ok: true, response };
    });
  }

  private async claimOrReplay(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    operation: MutationOperation,
  ): Promise<CustomerMutationResult | null> {
    const priorOperation = await this.readProcessedOperation(
      transaction,
      context.storeId,
      operation.operationId,
    );
    if (priorOperation) {
      return this.resolveProcessedOperation(transaction, context, operation, priorOperation);
    }

    let claimed: boolean;
    try {
      const result = await transaction.transaction((savepoint) =>
        savepoint.execute<{ claimed: boolean }>(sql`
          select sync.claim_operation(
            ${context.storeId}::uuid,
            ${operation.operationId}::uuid,
            ${context.deviceId}::uuid,
            'customers',
            ${operation.customerId}::uuid,
            ${operation.action},
            ${operation.requestHash}
          ) as claimed
        `),
      );
      claimed = result.rows[0]?.claimed === true;
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const concurrentOperation = await this.readProcessedOperation(
        transaction,
        context.storeId,
        operation.operationId,
      );
      if (!concurrentOperation) {
        throw error;
      }
      return this.resolveProcessedOperation(transaction, context, operation, concurrentOperation);
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
      throw new Error('Claimed Customer operation could not be read.');
    }
    return this.resolveProcessedOperation(transaction, context, operation, existing);
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
  ): Promise<CustomerMutationResult> {
    if (
      existing.deviceId !== context.deviceId ||
      existing.aggregateType !== 'customers' ||
      existing.aggregateId !== operation.customerId ||
      existing.action !== operation.action ||
      existing.requestHash !== operation.requestHash
    ) {
      await this.recordOperationConflict(transaction, context, operation);
      return failure('OPERATION_ID_CONFLICT');
    }

    if (existing.status === 'applied') {
      return {
        ok: true,
        response: parseStoredCustomerMutationResponse(existing.responseBody),
      };
    }
    if (existing.status === 'rejected') {
      const code = existing.errorCode;
      if (!code || !(code in failureDefinitions)) {
        throw new Error('Stored Customer mutation rejection is invalid.');
      }
      return failure(code as CustomerMutationFailureCode);
    }

    return failure('OPERATION_IN_PROGRESS');
  }

  private async classifyCreateConflict(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: PreparedCustomerCreate,
  ): Promise<CustomerMutationResult> {
    const sameId = await transaction
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.storeId, context.storeId), eq(customers.id, input.customerId)))
      .limit(1);
    if (sameId.length > 0) {
      return failure('CONFLICT');
    }

    const sameOperation = await transaction
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(eq(customers.storeId, context.storeId), eq(customers.operationId, input.operationId)),
      )
      .limit(1);
    if (sameOperation.length > 0) {
      return failure('OPERATION_ID_CONFLICT');
    }

    const samePhone = await transaction
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(
          eq(customers.storeId, context.storeId),
          eq(customers.normalizedPhone, input.normalizedPhone),
        ),
      )
      .limit(1);
    return samePhone.length > 0 ? failure('CUSTOMER_PHONE_CONFLICT') : failure('CONFLICT');
  }

  private classifyUpdateConstraint(error: unknown): CustomerMutationResult | null {
    if (isUniqueViolation(error, 'customers_store_id_normalized_phone_key')) {
      return failure('CUSTOMER_PHONE_CONFLICT');
    }
    if (isUniqueViolation(error, 'customers_store_id_operation_id_key')) {
      return failure('OPERATION_ID_CONFLICT');
    }
    return null;
  }

  private async classifyZeroRowUpdate(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: PreparedCustomerUpdate,
  ): Promise<CustomerMutationResult> {
    const rows = await transaction
      .select({ status: customers.status, version: customers.version })
      .from(customers)
      .where(and(eq(customers.storeId, context.storeId), eq(customers.id, input.customerId)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return failure('CUSTOMER_NOT_FOUND');
    }
    if (row.status === 'archived') {
      return failure('CUSTOMER_ARCHIVED');
    }
    if (row.version !== input.expectedVersion) {
      return failure('CUSTOMER_VERSION_CONFLICT');
    }
    throw new Error('Customer update did not return an expected row.');
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
      throw new Error('Customer operation completion failed.');
    }
  }

  private async rejectOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    result: CustomerMutationResult,
  ): Promise<void> {
    if (result.ok) {
      throw new TypeError('A successful Customer mutation cannot be rejected.');
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
      throw new Error('Customer operation rejection failed.');
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
        'customers',
        ${operation.customerId}::uuid,
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
