import { isUUID } from 'class-validator';

import type {
  AppSettingsMutationResponse,
  AppSettingsReadRow,
  PersistedCreditPolicy,
} from './app-settings.types';
import { MVP_TIMEZONE_NAME } from './app-settings.types';

const positiveDecimalPattern = /^[1-9]\d*$/;
const nonNegativeDecimalPattern = /^(0|[1-9]\d*)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isPersistedCreditPolicy(value: unknown): value is PersistedCreditPolicy {
  return value === 'allow' || value === 'warn' || value === 'block';
}

export function mapAppSettingsMutationResponse(
  row: AppSettingsReadRow,
  operationId: string,
): AppSettingsMutationResponse {
  if (row.timezoneName !== MVP_TIMEZONE_NAME) {
    throw new Error('Settings timezone state is incompatible with the MVP contract.');
  }

  return {
    dailyReportTimeMinutes: row.dailyReportTimeMinutes,
    defaultCreditPolicy: row.defaultCreditPolicy,
    defaultCreditLimitMinor: row.defaultCreditLimitMinor?.toString() ?? null,
    allowNegativeStock: row.allowNegativeStock,
    lowStockAlertEnabled: row.lowStockAlertEnabled,
    debtAgeAlertDays: row.debtAgeAlertDays,
    backupEnabled: row.backupEnabled,
    backupIntervalHours: row.backupIntervalHours,
    timezoneName: MVP_TIMEZONE_NAME,
    version: row.version.toString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    operationId,
  };
}

export function parseStoredAppSettingsMutationResponse(
  value: unknown,
): AppSettingsMutationResponse {
  if (
    !isRecord(value) ||
    typeof value.dailyReportTimeMinutes !== 'number' ||
    !Number.isInteger(value.dailyReportTimeMinutes) ||
    !isPersistedCreditPolicy(value.defaultCreditPolicy) ||
    (value.defaultCreditLimitMinor !== null &&
      (typeof value.defaultCreditLimitMinor !== 'string' ||
        !nonNegativeDecimalPattern.test(value.defaultCreditLimitMinor))) ||
    typeof value.allowNegativeStock !== 'boolean' ||
    typeof value.lowStockAlertEnabled !== 'boolean' ||
    typeof value.debtAgeAlertDays !== 'number' ||
    !Number.isInteger(value.debtAgeAlertDays) ||
    typeof value.backupEnabled !== 'boolean' ||
    typeof value.backupIntervalHours !== 'number' ||
    !Number.isInteger(value.backupIntervalHours) ||
    value.timezoneName !== MVP_TIMEZONE_NAME ||
    typeof value.version !== 'string' ||
    !positiveDecimalPattern.test(value.version) ||
    !isIsoDate(value.createdAt) ||
    !isIsoDate(value.updatedAt) ||
    typeof value.operationId !== 'string' ||
    !isUUID(value.operationId)
  ) {
    throw new Error('Stored Settings mutation response is invalid.');
  }

  return {
    dailyReportTimeMinutes: value.dailyReportTimeMinutes,
    defaultCreditPolicy: value.defaultCreditPolicy,
    defaultCreditLimitMinor: value.defaultCreditLimitMinor,
    allowNegativeStock: value.allowNegativeStock,
    lowStockAlertEnabled: value.lowStockAlertEnabled,
    debtAgeAlertDays: value.debtAgeAlertDays,
    backupEnabled: value.backupEnabled,
    backupIntervalHours: value.backupIntervalHours,
    timezoneName: MVP_TIMEZONE_NAME,
    version: value.version,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    operationId: value.operationId,
  };
}
