import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type { UpdateAppSettingsDto } from './dto/update-app-settings.dto';
import { AppSettingsWriteRepository } from './app-settings-write.repository';
import {
  APP_SETTINGS_MUTABLE_FIELDS,
  type AppSettingsMutationFailure,
  type AppSettingsMutationResponse,
  type AppSettingsUpdateCommand,
  type PreparedAppSettingsUpdate,
} from './app-settings.types';

const maximumPostgreSqlBigint = 9_223_372_036_854_775_807n;
const positiveDecimalPattern = /^[1-9]\d*$/;
const nonNegativeDecimalPattern = /^(0|[1-9]\d*)$/;
export const APP_SETTINGS_WRITE_REQUEST_VERSION = 1;

type AppSettingsWritePrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class AppSettingsWriteService {
  constructor(private readonly repository: AppSettingsWriteRepository) {}

  async update(
    principal: AppSettingsWritePrincipal,
    context: TenantTransactionContext,
    dto: UpdateAppSettingsDto,
  ): Promise<AppSettingsMutationResponse> {
    this.assertAuthorized(principal, context);

    const operationId = this.canonicalUuid(dto.operationId, 'operationId');
    const expectedVersion = this.parseBigint(
      dto.expectedVersion,
      'expectedVersion',
      positiveDecimalPattern,
    );
    const values = this.prepareValues(dto);
    if (!APP_SETTINGS_MUTABLE_FIELDS.some((field) => values[field] !== undefined)) {
      throw this.validationException('body', 'appSettingsMutableField');
    }

    const canonicalRequest: Record<string, unknown> = {
      v: APP_SETTINGS_WRITE_REQUEST_VERSION,
      action: 'settings.update',
      expectedVersion: expectedVersion.toString(),
    };
    for (const field of APP_SETTINGS_MUTABLE_FIELDS) {
      const value = values[field];
      if (value !== undefined) {
        canonicalRequest[field] = typeof value === 'bigint' ? value.toString() : value;
      }
    }

    const input: PreparedAppSettingsUpdate = {
      operationId,
      expectedVersion,
      values,
      requestHash: createHash('sha256')
        .update(JSON.stringify(canonicalRequest), 'utf8')
        .digest('hex'),
    };

    const result = await this.repository.update(context, input);
    if (result.ok) {
      return result.response;
    }
    this.throwMutationFailure(result.error);
  }

  private prepareValues(dto: UpdateAppSettingsDto): AppSettingsUpdateCommand {
    const values: AppSettingsUpdateCommand = {};
    if (dto.dailyReportTimeMinutes !== undefined) {
      values.dailyReportTimeMinutes = this.integer(
        dto.dailyReportTimeMinutes,
        'dailyReportTimeMinutes',
        0,
        1439,
      );
    }
    if (dto.defaultCreditPolicy !== undefined) {
      const policy: unknown = dto.defaultCreditPolicy;
      if (policy !== 'warn' && policy !== 'block') {
        throw this.validationException('defaultCreditPolicy', 'isIn');
      }
      values.defaultCreditPolicy = policy;
    }
    if (dto.defaultCreditLimitMinor !== undefined) {
      values.defaultCreditLimitMinor =
        dto.defaultCreditLimitMinor === null
          ? null
          : this.parseBigint(
              dto.defaultCreditLimitMinor,
              'defaultCreditLimitMinor',
              nonNegativeDecimalPattern,
            );
    }
    if (dto.allowNegativeStock !== undefined) {
      values.allowNegativeStock = this.boolean(dto.allowNegativeStock, 'allowNegativeStock');
    }
    if (dto.lowStockAlertEnabled !== undefined) {
      values.lowStockAlertEnabled = this.boolean(dto.lowStockAlertEnabled, 'lowStockAlertEnabled');
    }
    if (dto.debtAgeAlertDays !== undefined) {
      values.debtAgeAlertDays = this.integer(
        dto.debtAgeAlertDays,
        'debtAgeAlertDays',
        0,
        2_147_483_647,
      );
    }
    if (dto.backupEnabled !== undefined) {
      values.backupEnabled = this.boolean(dto.backupEnabled, 'backupEnabled');
    }
    if (dto.backupIntervalHours !== undefined) {
      values.backupIntervalHours = this.integer(
        dto.backupIntervalHours,
        'backupIntervalHours',
        1,
        2_147_483_647,
      );
    }
    return values;
  }

  private assertAuthorized(
    principal: AppSettingsWritePrincipal,
    context: TenantTransactionContext,
  ): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'SETTINGS_WRITE_NOT_ALLOWED',
        message: 'Settings writes are not allowed.',
      });
    }
  }

  private canonicalUuid(value: unknown, field: string): string {
    if (typeof value !== 'string' || !isUUID(value)) {
      throw this.validationException(field, 'isUuid');
    }
    return value.toLowerCase();
  }

  private parseBigint(value: unknown, field: string, pattern: RegExp): bigint {
    if (typeof value !== 'string' || !pattern.test(value)) {
      throw this.validationException(field, 'isBigintDecimal');
    }
    const parsed = BigInt(value);
    if (parsed > maximumPostgreSqlBigint) {
      throw this.validationException(field, 'maxPostgreSqlBigint');
    }
    return parsed;
  }

  private integer(value: unknown, field: string, minimum: number, maximum: number): number {
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < minimum ||
      value > maximum
    ) {
      throw this.validationException(field, 'isIntRange');
    }
    return value;
  }

  private boolean(value: unknown, field: string): boolean {
    if (typeof value !== 'boolean') {
      throw this.validationException(field, 'isBoolean');
    }
    return value;
  }

  private throwMutationFailure(error: AppSettingsMutationFailure): never {
    const payload = { code: error.code, message: error.message };
    if (error.statusCode === 404) {
      throw new NotFoundException(payload);
    }
    throw new ConflictException(payload);
  }

  private validationException(field: string, constraint: string): BadRequestException {
    return new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed.',
      details: [{ field, constraints: [constraint] }],
    });
  }
}
