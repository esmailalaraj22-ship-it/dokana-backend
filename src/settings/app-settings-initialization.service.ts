import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service';
import { appSettings } from '../database/schema';
import type { TenantTransactionContext } from '../database/database.types';
import type { AppSettingsInitializationValues } from './app-settings.types';
import { MVP_TIMEZONE_NAME } from './app-settings.types';

const maximumPostgreSqlBigint = 9_223_372_036_854_775_807n;
const preparatoryBusinessDayMinutes = 720;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class AppSettingsInitializationService {
  constructor(private readonly database: DatabaseService) {}

  async ensureForStore(
    context: TenantTransactionContext,
    values: AppSettingsInitializationValues,
  ): Promise<void> {
    this.validate(values);

    await this.database.withBusinessWriteTransaction(context, async (transaction) => {
      await transaction
        .insert(appSettings)
        .values({
          storeId: context.storeId,
          dailyReportTimeMinutes: values.dailyReportTimeMinutes,
          defaultCreditPolicy: values.defaultCreditPolicy,
          defaultCreditLimitMinor: values.defaultCreditLimitMinor,
          allowNegativeStock: values.allowNegativeStock,
          lowStockAlertEnabled: values.lowStockAlertEnabled,
          debtAgeAlertDays: values.debtAgeAlertDays,
          backupEnabled: values.backupEnabled,
          backupIntervalHours: values.backupIntervalHours,
          exportDirectoryUri: null,
          attachmentsDirectoryUri: null,
          timezoneName: MVP_TIMEZONE_NAME,
          businessDayStartMinutes: preparatoryBusinessDayMinutes,
          businessDayEndMinutes: preparatoryBusinessDayMinutes,
          businessDayMode: 'fixed_24h',
        })
        .onConflictDoNothing({ target: appSettings.storeId });
    });
  }

  private validate(input: unknown): asserts input is AppSettingsInitializationValues {
    if (!isRecord(input)) {
      throw new TypeError('Settings initialization values are invalid.');
    }
    this.integer(input.dailyReportTimeMinutes, 0, 1439);
    if (input.defaultCreditPolicy !== 'warn' && input.defaultCreditPolicy !== 'block') {
      throw new TypeError('Settings initialization values are invalid.');
    }
    if (
      input.defaultCreditLimitMinor !== null &&
      (typeof input.defaultCreditLimitMinor !== 'bigint' ||
        input.defaultCreditLimitMinor < 0n ||
        input.defaultCreditLimitMinor > maximumPostgreSqlBigint)
    ) {
      throw new TypeError('Settings initialization values are invalid.');
    }
    for (const value of [
      input.allowNegativeStock,
      input.lowStockAlertEnabled,
      input.backupEnabled,
    ]) {
      if (typeof value !== 'boolean') {
        throw new TypeError('Settings initialization values are invalid.');
      }
    }
    this.integer(input.debtAgeAlertDays, 0, 2_147_483_647);
    this.integer(input.backupIntervalHours, 1, 2_147_483_647);
    if (input.timezoneName !== MVP_TIMEZONE_NAME || input.businessDayMode !== 'fixed_24h') {
      throw new TypeError('Settings initialization values are invalid.');
    }
  }

  private integer(value: unknown, minimum: number, maximum: number): void {
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < minimum ||
      value > maximum
    ) {
      throw new TypeError('Settings initialization values are invalid.');
    }
  }
}
