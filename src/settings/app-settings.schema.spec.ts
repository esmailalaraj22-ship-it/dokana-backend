import { getTableConfig } from 'drizzle-orm/pg-core';

import { appSettings, stores } from '../database/schema';
import {
  APP_SETTINGS_DEVICE_LOCAL_FIELDS,
  APP_SETTINGS_MUTABLE_FIELDS,
  APP_SETTINGS_SERVER_ONLY_FIELDS,
} from './app-settings.types';

const tableConfig = getTableConfig(appSettings);

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

describe('app_settings Drizzle mapping foundation', () => {
  it('maps the ledger.app_settings identity and physical column order exactly', () => {
    expect({ schema: tableConfig.schema, table: tableConfig.name }).toEqual({
      schema: 'ledger',
      table: 'app_settings',
    });

    expect(tableConfig.columns.map((column) => column.name)).toEqual([
      'store_id',
      'daily_report_time_minutes',
      'default_credit_policy',
      'default_credit_limit_minor',
      'allow_negative_stock',
      'low_stock_alert_enabled',
      'debt_age_alert_days',
      'backup_enabled',
      'backup_interval_hours',
      'export_directory_uri',
      'attachments_directory_uri',
      'created_at',
      'updated_at',
      'version',
      'timezone_name',
      'business_day_start_minutes',
      'business_day_end_minutes',
      'business_day_mode',
    ]);
  });

  it('preserves the singleton primary key, nullability, and lossless bigint semantics', () => {
    expect(appSettings.storeId.primary).toBe(true);
    expect(appSettings.storeId.hasDefault).toBe(false);

    // Nullable physical columns.
    expect(appSettings.defaultCreditLimitMinor.notNull).toBe(false);
    expect(appSettings.exportDirectoryUri.notNull).toBe(false);
    expect(appSettings.attachmentsDirectoryUri.notNull).toBe(false);

    // bigint columns must never degrade to a JavaScript number.
    expect(appSettings.version.dataType).toBe('bigint');
    expect(appSettings.defaultCreditLimitMinor.dataType).toBe('bigint');
  });

  it('maps the tenant foreign key to ledger.stores with cascade semantics', () => {
    const [foreignKey] = tableConfig.foreignKeys;
    if (!foreignKey) {
      throw new Error('app_settings must map exactly one foreign key.');
    }
    const reference = foreignKey.reference();
    const foreignTable = getTableConfig(reference.foreignTable);

    expect(foreignKey.getName()).toBe('app_settings_store_id_fkey');
    expect(reference.columns.map((column) => column.name)).toEqual(['store_id']);
    expect({ schema: foreignTable.schema, table: foreignTable.name }).toEqual({
      schema: 'ledger',
      table: 'stores',
    });
    expect(reference.foreignColumns.map((column) => column.name)).toEqual(['id']);
    expect(foreignKey.onUpdate).toBe('cascade');
    expect(foreignKey.onDelete).toBe('cascade');
    // Guard against accidental self-reference regressions.
    expect(reference.foreignTable).toBe(stores);
  });

  it('maps every physical CHECK constraint by name', () => {
    expect(tableConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      'app_settings_backup_interval_hours_check',
      'app_settings_business_day_end_minutes_check',
      'app_settings_business_day_mode_check',
      'app_settings_business_day_start_minutes_check',
      'app_settings_daily_report_time_minutes_check',
      'app_settings_debt_age_alert_days_check',
      'app_settings_default_credit_limit_minor_check',
      'app_settings_default_credit_policy_check',
      'app_settings_version_check',
    ]);
  });

  it('classifies every physical column exactly once so future columns force a decision', () => {
    const classified = [
      ...APP_SETTINGS_MUTABLE_FIELDS,
      ...APP_SETTINGS_SERVER_ONLY_FIELDS,
      ...APP_SETTINGS_DEVICE_LOCAL_FIELDS,
    ];

    // Pairwise disjoint: no field may be both mutable and server-only, etc.
    expect(new Set(classified).size).toBe(classified.length);

    // Exact partition of the physical columns (via camelCase -> snake_case).
    expect(classified.map(camelToSnake).sort()).toEqual(
      tableConfig.columns.map((column) => column.name).sort(),
    );
  });

  it('keeps server-only, device-local, and timezone/business-day fields out of the mutable set', () => {
    const mutable = new Set<string>(APP_SETTINGS_MUTABLE_FIELDS);

    for (const field of [
      'storeId',
      'version',
      'createdAt',
      'updatedAt',
      'timezoneName',
      'businessDayStartMinutes',
      'businessDayEndMinutes',
      'businessDayMode',
      'exportDirectoryUri',
      'attachmentsDirectoryUri',
    ]) {
      expect(mutable.has(field)).toBe(false);
    }

    expect([...mutable].sort()).toEqual(
      [
        'allowNegativeStock',
        'backupEnabled',
        'backupIntervalHours',
        'dailyReportTimeMinutes',
        'debtAgeAlertDays',
        'defaultCreditLimitMinor',
        'defaultCreditPolicy',
        'lowStockAlertEnabled',
      ].sort(),
    );
  });
});
