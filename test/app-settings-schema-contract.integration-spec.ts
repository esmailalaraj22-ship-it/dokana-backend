import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';

import { appSettings } from '../src/database/schema';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

interface CatalogColumnRow {
  name: string;
  sqlType: string;
  notNull: boolean;
  defaultExpression: string | null;
  primary: boolean;
}

interface SqliteColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

const environment = readLocalPostgresTestEnvironment();
const tableConfig = getTableConfig(appSettings);
const dialect = new PgDialect();

function getMappedDefault(column: (typeof tableConfig.columns)[number]): string | null {
  if (!column.hasDefault) {
    return null;
  }

  const value: unknown = column.default;
  if (value instanceof SQL) {
    return dialect.sqlToQuery(value).sql;
  }
  if (typeof value === 'string') {
    return `'${value.replaceAll("'", "''")}'::text`;
  }
  if (typeof value === 'boolean') {
    return value.toString();
  }
  if (typeof value === 'bigint' || typeof value === 'number') {
    return value.toString();
  }

  throw new TypeError(`Unsupported mapped default for ${column.name}.`);
}

function mappedCheckSql(value: SQL): string {
  return dialect
    .sqlToQuery(value)
    .sql.replaceAll('"ledger"."app_settings".', '')
    .replaceAll('"', '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('Store settings database contract', () => {
  let adminPool: Pool | undefined;
  let sqliteDatabase: DatabaseSync | undefined;
  let sqliteTempDirectory: string | undefined;

  function pool(): Pool {
    if (!adminPool) {
      throw new Error('The PostgreSQL contract pool is unavailable.');
    }
    return adminPool;
  }

  function sqlite(): DatabaseSync {
    if (!sqliteDatabase) {
      throw new Error('The SQLite contract database is unavailable.');
    }
    return sqliteDatabase;
  }

  beforeAll(() => {
    if (!environment) {
      throw new Error('The approved local PostgreSQL verification environment is unavailable.');
    }

    adminPool = createTestPool(environment.adminUrl, 'dokana-task72-contract', 1);

    // Copy the shared v1.1 SQLite reference and apply the approved v1.2 settings
    // patch onto the disposable copy so the shared time fields can be compared.
    // The immutable reference package is never modified.
    const referenceRoot = resolve(process.cwd(), 'database/reference/backend_database_reference');
    const sqliteSource = join(referenceRoot, 'sqlite_shop_ledger_schema_v1_1_empty.db');
    const settingsPatch = readFileSync(
      join(referenceRoot, 'sqlite_v1_2_settings_patch.sql'),
      'utf8',
    );
    sqliteTempDirectory = mkdtempSync(join(tmpdir(), 'dokana-task72-'));
    const sqliteCopy = join(sqliteTempDirectory, 'app-settings-contract.db');
    copyFileSync(sqliteSource, sqliteCopy);
    const patchTarget = new DatabaseSync(sqliteCopy);
    patchTarget.exec(settingsPatch);
    patchTarget.close();
    sqliteDatabase = new DatabaseSync(sqliteCopy, { readOnly: true });
  });

  afterAll(async () => {
    sqliteDatabase?.close();
    if (sqliteTempDirectory) {
      const resolvedTempRoot = resolve(tmpdir());
      const resolvedTestDirectory = resolve(sqliteTempDirectory);
      if (!resolvedTestDirectory.startsWith(`${resolvedTempRoot}${sep}`)) {
        throw new Error('Refusing to remove a SQLite test directory outside the system temp root.');
      }
      rmSync(resolvedTestDirectory, { recursive: true, force: true });
    }
    await adminPool?.end();
  });

  it('maps every PostgreSQL app_settings column, default, nullability, and identity exactly', async () => {
    const catalog = await pool().query<CatalogColumnRow>(`
      select
        attribute.attname as name,
        format_type(attribute.atttypid, attribute.atttypmod) as "sqlType",
        attribute.attnotnull as "notNull",
        pg_get_expr(default_state.adbin, default_state.adrelid) as "defaultExpression",
        exists (
          select 1
          from pg_index as primary_index
          where primary_index.indrelid = attribute.attrelid
            and primary_index.indisprimary
            and attribute.attnum = any(primary_index.indkey::smallint[])
        ) as primary
      from pg_attribute as attribute
      left join pg_attrdef as default_state
        on default_state.adrelid = attribute.attrelid
       and default_state.adnum = attribute.attnum
      where attribute.attrelid = 'ledger.app_settings'::regclass
        and attribute.attnum > 0
        and not attribute.attisdropped
      order by attribute.attnum
    `);

    expect({ schema: tableConfig.schema, table: tableConfig.name }).toEqual({
      schema: 'ledger',
      table: 'app_settings',
    });
    expect(
      tableConfig.columns.map((column) => ({
        name: column.name,
        sqlType: column.getSQLType(),
        notNull: column.notNull,
        defaultExpression: getMappedDefault(column),
        primary: column.primary,
      })),
    ).toEqual(catalog.rows);
    expect(appSettings.storeId.primary).toBe(true);
    expect(appSettings.defaultCreditLimitMinor.notNull).toBe(false);
    expect(appSettings.exportDirectoryUri.notNull).toBe(false);
    expect(appSettings.attachmentsDirectoryUri.notNull).toBe(false);
    expect(appSettings.version.dataType).toBe('bigint');
    expect(appSettings.defaultCreditLimitMinor.dataType).toBe('bigint');
  });

  it('has no unique constraints and one cascade tenant foreign key', async () => {
    const uniqueConstraints = await pool().query<{ name: string }>(`
      select conname as name
      from pg_constraint
      where conrelid = 'ledger.app_settings'::regclass and contype = 'u'
      order by conname
    `);
    const foreignKeys = await pool().query<{
      name: string;
      definition: string;
    }>(`
      select conname as name, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'ledger.app_settings'::regclass and contype = 'f'
      order by conname
    `);
    const checkNames = await pool().query<{ name: string }>(`
      select conname as name
      from pg_constraint
      where conrelid = 'ledger.app_settings'::regclass and contype = 'c'
      order by conname
    `);

    expect(uniqueConstraints.rows).toEqual([]);
    expect(tableConfig.uniqueConstraints).toEqual([]);
    expect(foreignKeys.rows).toEqual([
      {
        name: 'app_settings_store_id_fkey',
        definition:
          'FOREIGN KEY (store_id) REFERENCES ledger.stores(id) ON UPDATE CASCADE ON DELETE CASCADE',
      },
    ]);
    const [mappedForeignKey] = tableConfig.foreignKeys;
    if (!mappedForeignKey) {
      throw new Error('app_settings must map exactly one foreign key.');
    }
    expect(mappedForeignKey.getName()).toBe('app_settings_store_id_fkey');
    expect(mappedForeignKey.onUpdate).toBe('cascade');
    expect(mappedForeignKey.onDelete).toBe('cascade');
    expect(tableConfig.checks.map((constraint) => constraint.name).sort()).toEqual(
      checkNames.rows.map((constraint) => constraint.name),
    );
  });

  it('validates CHECK semantics against the live catalog and the mapped expressions', async () => {
    const catalogChecks = await pool().query<{ name: string; definition: string }>(`
      select conname as name, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'ledger.app_settings'::regclass and contype = 'c'
      order by conname
    `);

    // Independent evidence of the real physical CHECK semantics: integer bounds,
    // the physical credit-policy domain (which still includes the legacy 'allow'
    // value), the version/bigint floor, and the business-day mode and ranges.
    // Hand-authored from the live catalog so the assertion is not derived from
    // the Drizzle mapping under test.
    expect(Object.fromEntries(catalogChecks.rows.map((row) => [row.name, row.definition]))).toEqual(
      {
        app_settings_backup_interval_hours_check: 'CHECK ((backup_interval_hours >= 1))',
        app_settings_business_day_end_minutes_check:
          'CHECK (((business_day_end_minutes >= 0) AND (business_day_end_minutes <= 1439)))',
        app_settings_business_day_mode_check:
          "CHECK ((business_day_mode = ANY (ARRAY['fixed_24h'::text, 'custom'::text])))",
        app_settings_business_day_start_minutes_check:
          'CHECK (((business_day_start_minutes >= 0) AND (business_day_start_minutes <= 1439)))',
        app_settings_daily_report_time_minutes_check:
          'CHECK (((daily_report_time_minutes >= 0) AND (daily_report_time_minutes <= 1439)))',
        app_settings_debt_age_alert_days_check: 'CHECK ((debt_age_alert_days >= 0))',
        app_settings_default_credit_limit_minor_check:
          'CHECK (((default_credit_limit_minor IS NULL) OR (default_credit_limit_minor >= 0)))',
        app_settings_default_credit_policy_check:
          "CHECK ((default_credit_policy = ANY (ARRAY['allow'::text, 'warn'::text, 'block'::text])))",
        app_settings_version_check: 'CHECK ((version >= 1))',
      },
    );

    // The mapped Drizzle CHECK expressions, pinned to independent expectations so
    // a future edit that keeps a name but changes the expression is detected.
    expect(
      Object.fromEntries(
        tableConfig.checks.map((constraint) => [constraint.name, mappedCheckSql(constraint.value)]),
      ),
    ).toEqual({
      app_settings_daily_report_time_minutes_check:
        'daily_report_time_minutes >= 0 and daily_report_time_minutes <= 1439',
      app_settings_default_credit_policy_check:
        "default_credit_policy in ('allow', 'warn', 'block')",
      app_settings_default_credit_limit_minor_check:
        'default_credit_limit_minor is null or default_credit_limit_minor >= 0',
      app_settings_debt_age_alert_days_check: 'debt_age_alert_days >= 0',
      app_settings_backup_interval_hours_check: 'backup_interval_hours >= 1',
      app_settings_version_check: 'version >= 1',
      app_settings_business_day_start_minutes_check:
        'business_day_start_minutes >= 0 and business_day_start_minutes <= 1439',
      app_settings_business_day_end_minutes_check:
        'business_day_end_minutes >= 0 and business_day_end_minutes <= 1439',
      app_settings_business_day_mode_check: "business_day_mode in ('fixed_24h', 'custom')",
    });
  });

  it('verifies forced RLS, tenant policy, and the settings trigger set', async () => {
    const relation = await pool().query<{
      owner: string;
      rlsEnabled: boolean;
      rlsForced: boolean;
    }>(`
      select
        pg_get_userbyid(relation.relowner) as owner,
        relation.relrowsecurity as "rlsEnabled",
        relation.relforcerowsecurity as "rlsForced"
      from pg_class as relation
      where relation.oid = 'ledger.app_settings'::regclass
    `);
    const policies = await pool().query<{
      name: string;
      command: string;
      usingExpression: string;
      checkExpression: string;
    }>(`
      select
        policyname as name,
        cmd as command,
        qual as "usingExpression",
        with_check as "checkExpression"
      from pg_policies
      where schemaname = 'ledger' and tablename = 'app_settings'
      order by policyname
    `);
    const triggers = await pool().query<{ name: string; functionName: string }>(`
      select
        trigger_state.tgname as name,
        function_namespace.nspname || '.' || function_state.proname as "functionName"
      from pg_trigger as trigger_state
      inner join pg_proc as function_state on function_state.oid = trigger_state.tgfoid
      inner join pg_namespace as function_namespace
        on function_namespace.oid = function_state.pronamespace
      where trigger_state.tgrelid = 'ledger.app_settings'::regclass
        and not trigger_state.tgisinternal
        and trigger_state.tgenabled = 'O'
      order by trigger_state.tgname
    `);
    const incomingReferences = await pool().query<{ name: string }>(`
      select constraint_state.conname as name
      from pg_constraint as constraint_state
      where constraint_state.confrelid = 'ledger.app_settings'::regclass
      order by name
    `);
    const runtimePrivileges = await pool().query<{
      selectAllowed: boolean;
      insertAllowed: boolean;
      updateAllowed: boolean;
      deleteAllowed: boolean;
    }>(`
      select
        has_table_privilege('dokana_runtime_login', 'ledger.app_settings', 'select') as "selectAllowed",
        has_table_privilege('dokana_runtime_login', 'ledger.app_settings', 'insert') as "insertAllowed",
        has_table_privilege('dokana_runtime_login', 'ledger.app_settings', 'update') as "updateAllowed",
        has_table_privilege('dokana_runtime_login', 'ledger.app_settings', 'delete') as "deleteAllowed"
    `);

    expect(relation.rows).toEqual([
      { owner: 'shop_app_migrator', rlsEnabled: true, rlsForced: true },
    ]);
    expect(policies.rows).toEqual([
      {
        name: 'tenant_isolation_app_settings',
        command: 'ALL',
        usingExpression: '(store_id = platform.current_store_id())',
        checkExpression: '(store_id = platform.current_store_id())',
      },
    ]);
    // app_settings is intentionally in the touch and change-event loops but NOT
    // the central-audit or no-delete loops. The absent no-delete trigger plus the
    // DELETE privilege below is the documented Task 7.2 residual controlled in
    // application code (no delete path) and by forced RLS.
    expect(triggers.rows).toEqual([
      { name: 'trg_app_settings_change_event', functionName: 'sync.capture_change_event' },
      { name: 'trg_app_settings_touch', functionName: 'ledger.touch_mutable_row' },
    ]);
    expect(incomingReferences.rows).toEqual([]);
    expect(runtimePrivileges.rows).toEqual([
      {
        selectAllowed: true,
        insertAllowed: true,
        updateAllowed: true,
        deleteAllowed: true,
      },
    ]);
  });

  it('matches the approved SQLite shared settings representation read-only', () => {
    const quickCheck = sqlite().prepare('pragma quick_check').all();
    const foreignKeyCheck = sqlite().prepare('pragma foreign_key_check').all();
    const sqliteColumns = sqlite()
      .prepare("pragma table_info('app_settings')")
      .all() as unknown as SqliteColumnRow[];

    const sqliteTypeForPostgres: Record<string, string> = {
      uuid: 'TEXT',
      text: 'TEXT',
      integer: 'INTEGER',
      bigint: 'INTEGER',
      boolean: 'INTEGER',
      'timestamp with time zone': 'INTEGER',
    };

    expect(quickCheck).toEqual([{ quick_check: 'ok' }]);
    expect(foreignKeyCheck).toEqual([]);
    expect(
      sqliteColumns.map((column) => ({
        name: column.name,
        type: column.type,
        notNull: column.notnull === 1,
        primary: column.pk === 1,
      })),
    ).toEqual(
      tableConfig.columns.map((column) => ({
        name: column.name,
        type: sqliteTypeForPostgres[column.getSQLType()],
        notNull: column.notNull,
        primary: column.primary,
      })),
    );
    expect(
      Object.fromEntries(sqliteColumns.map((column) => [column.name, column.dflt_value])),
    ).toMatchObject({
      store_id: null,
      daily_report_time_minutes: '1200',
      default_credit_policy: "'warn'",
      default_credit_limit_minor: null,
      allow_negative_stock: '0',
      low_stock_alert_enabled: '1',
      debt_age_alert_days: '90',
      backup_enabled: '1',
      backup_interval_hours: '24',
      export_directory_uri: null,
      attachments_directory_uri: null,
      created_at: null,
      updated_at: null,
      version: '1',
      timezone_name: "'Asia/Hebron'",
      business_day_start_minutes: '720',
      business_day_end_minutes: '720',
      business_day_mode: "'fixed_24h'",
    });
  });
});
