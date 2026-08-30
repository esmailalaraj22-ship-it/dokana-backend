import { ForbiddenException, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import { appSettings, stores } from '../database/schema';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import {
  mapAppSettingsMutationResponse,
  parseStoredAppSettingsMutationResponse,
} from './app-settings-write-response';
import type {
  AppSettingsMutationFailure,
  AppSettingsMutationFailureCode,
  AppSettingsMutationResult,
  AppSettingsReadRow,
  AppSettingsUpdateCommand,
  PreparedAppSettingsUpdate,
} from './app-settings.types';

const settingsSelection = {
  dailyReportTimeMinutes: appSettings.dailyReportTimeMinutes,
  defaultCreditPolicy: appSettings.defaultCreditPolicy,
  defaultCreditLimitMinor: appSettings.defaultCreditLimitMinor,
  allowNegativeStock: appSettings.allowNegativeStock,
  lowStockAlertEnabled: appSettings.lowStockAlertEnabled,
  debtAgeAlertDays: appSettings.debtAgeAlertDays,
  backupEnabled: appSettings.backupEnabled,
  backupIntervalHours: appSettings.backupIntervalHours,
  timezoneName: appSettings.timezoneName,
  version: appSettings.version,
  createdAt: appSettings.createdAt,
  updatedAt: appSettings.updatedAt,
} as const;

const failureDefinitions: Readonly<
  Record<AppSettingsMutationFailureCode, AppSettingsMutationFailure>
> = {
  SETTINGS_NOT_INITIALIZED: {
    code: 'SETTINGS_NOT_INITIALIZED',
    message: 'Store settings are not initialized.',
    statusCode: 404,
  },
  SETTINGS_VERSION_CONFLICT: {
    code: 'SETTINGS_VERSION_CONFLICT',
    message: 'Settings version conflict.',
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

interface PostgreSqlError {
  code?: unknown;
  cause?: unknown;
}

function databaseError(error: unknown): PostgreSqlError | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const candidate: PostgreSqlError = {
    code: 'code' in error ? error.code : undefined,
    cause: 'cause' in error ? error.cause : undefined,
  };
  if (candidate.code !== undefined) {
    return candidate;
  }
  return candidate.cause === error ? undefined : databaseError(candidate.cause);
}

function failure(code: AppSettingsMutationFailureCode): AppSettingsMutationResult {
  return { ok: false, error: failureDefinitions[code] };
}

@Injectable()
export class AppSettingsWriteRepository {
  constructor(private readonly database: DatabaseService) {}

  update(
    context: TenantTransactionContext,
    input: PreparedAppSettingsUpdate,
  ): Promise<AppSettingsMutationResult> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const prior = await this.readProcessedOperation(
        transaction,
        context.storeId,
        input.operationId,
      );
      if (prior) {
        return this.resolveProcessedOperation(transaction, context, input, prior);
      }

      await this.assertActiveStoreForNewWrite(transaction, context.storeId);
      const claimed = await this.claimOperation(transaction, context, input);
      if (claimed) {
        return claimed;
      }

      const rows = await transaction
        .select(settingsSelection)
        .from(appSettings)
        .where(eq(appSettings.storeId, context.storeId))
        .limit(1)
        .for('update');
      const current = rows[0];
      if (!current) {
        const result = failure('SETTINGS_NOT_INITIALIZED');
        await this.rejectOperation(transaction, context.storeId, input.operationId, result);
        return result;
      }
      if (current.version !== input.expectedVersion) {
        const result = failure('SETTINGS_VERSION_CONFLICT');
        await this.rejectOperation(transaction, context.storeId, input.operationId, result);
        return result;
      }

      let resultRow: AppSettingsReadRow = current;
      if (!this.isNoOp(current, input.values)) {
        const updatedRows = await transaction
          .update(appSettings)
          .set(this.buildUpdates(input.values))
          .where(
            and(
              eq(appSettings.storeId, context.storeId),
              eq(appSettings.version, input.expectedVersion),
            ),
          )
          .returning(settingsSelection);
        const updated = updatedRows[0];
        if (!updated) {
          throw new Error('Locked Settings update did not return a row.');
        }
        resultRow = updated;
      }

      const response = mapAppSettingsMutationResponse(resultRow, input.operationId);
      await this.applyOperation(transaction, context.storeId, input.operationId, response);
      return { ok: true, response };
    });
  }

  private async claimOperation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: PreparedAppSettingsUpdate,
  ): Promise<AppSettingsMutationResult | null> {
    let claimed: boolean;
    try {
      const result = await transaction.transaction((savepoint) =>
        savepoint.execute<{ claimed: boolean }>(sql`
          select sync.claim_operation(
            ${context.storeId}::uuid,
            ${input.operationId}::uuid,
            ${context.deviceId}::uuid,
            'app_settings',
            ${context.storeId}::uuid,
            'update',
            ${input.requestHash}
          ) as claimed
        `),
      );
      claimed = result.rows[0]?.claimed === true;
    } catch (error) {
      if (databaseError(error)?.code !== '23505') {
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
      throw new Error('Claimed Settings operation could not be read.');
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
    input: PreparedAppSettingsUpdate,
    existing: ProcessedOperationRow,
  ): Promise<AppSettingsMutationResult> {
    if (
      existing.deviceId !== context.deviceId ||
      existing.aggregateType !== 'app_settings' ||
      existing.aggregateId !== context.storeId ||
      existing.action !== 'update' ||
      existing.requestHash !== input.requestHash
    ) {
      await this.recordOperationConflict(transaction, context, input);
      return failure('OPERATION_ID_CONFLICT');
    }
    if (existing.status === 'applied') {
      return {
        ok: true,
        response: parseStoredAppSettingsMutationResponse(existing.responseBody),
      };
    }
    if (existing.status === 'rejected') {
      const code = existing.errorCode;
      const response = existing.responseBody;
      if (
        !code ||
        !(code in failureDefinitions) ||
        !response ||
        typeof response !== 'object' ||
        !('code' in response) ||
        !('message' in response) ||
        response.code !== code ||
        typeof response.message !== 'string' ||
        existing.responseCode !==
          failureDefinitions[code as AppSettingsMutationFailureCode].statusCode
      ) {
        throw new Error('Stored Settings mutation rejection is invalid.');
      }
      return {
        ok: false,
        error: {
          code: code as AppSettingsMutationFailureCode,
          message: response.message,
          statusCode: existing.responseCode,
        },
      };
    }
    return failure('OPERATION_IN_PROGRESS');
  }

  private isNoOp(current: AppSettingsReadRow, values: AppSettingsUpdateCommand): boolean {
    for (const field of Object.keys(values) as (keyof AppSettingsUpdateCommand)[]) {
      if (values[field] !== current[field]) {
        return false;
      }
    }
    return true;
  }

  private buildUpdates(values: AppSettingsUpdateCommand): AppSettingsUpdateCommand {
    const updates: AppSettingsUpdateCommand = {};
    if (values.dailyReportTimeMinutes !== undefined) {
      updates.dailyReportTimeMinutes = values.dailyReportTimeMinutes;
    }
    if (values.defaultCreditPolicy !== undefined) {
      updates.defaultCreditPolicy = values.defaultCreditPolicy;
    }
    if (values.defaultCreditLimitMinor !== undefined) {
      updates.defaultCreditLimitMinor = values.defaultCreditLimitMinor;
    }
    if (values.allowNegativeStock !== undefined) {
      updates.allowNegativeStock = values.allowNegativeStock;
    }
    if (values.lowStockAlertEnabled !== undefined) {
      updates.lowStockAlertEnabled = values.lowStockAlertEnabled;
    }
    if (values.debtAgeAlertDays !== undefined) {
      updates.debtAgeAlertDays = values.debtAgeAlertDays;
    }
    if (values.backupEnabled !== undefined) {
      updates.backupEnabled = values.backupEnabled;
    }
    if (values.backupIntervalHours !== undefined) {
      updates.backupIntervalHours = values.backupIntervalHours;
    }
    return updates;
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
      throw new Error('Settings operation completion failed.');
    }
  }

  private async rejectOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    result: AppSettingsMutationResult,
  ): Promise<void> {
    if (result.ok) {
      throw new TypeError('A successful Settings mutation cannot be rejected.');
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
      throw new Error('Settings operation rejection failed.');
    }
  }

  private async recordOperationConflict(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: PreparedAppSettingsUpdate,
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
        'app_settings',
        ${context.storeId}::uuid,
        ${input.expectedVersion.toString()}::bigint,
        'duplicate_identity',
        jsonb_build_object('action', 'update', 'requestHash', ${input.requestHash}::text)
      )
    `);
  }
}
