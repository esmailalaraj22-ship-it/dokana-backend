import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';

import { customers } from '../src/database/schema';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

interface CatalogColumnRow {
  name: string;
  sqlType: string;
  notNull: boolean;
  defaultExpression: string | null;
  primary: boolean;
}

interface NamedColumnsRow {
  name: string;
  columns: string[];
}

interface ForeignKeyRow extends NamedColumnsRow {
  foreignSchema: string;
  foreignTable: string;
  foreignColumns: string[];
  onUpdate: string;
  onDelete: string;
}

interface SqliteColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

const environment = readLocalPostgresTestEnvironment();
const tableConfig = getTableConfig(customers);
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
  if (typeof value === 'bigint' || typeof value === 'number') {
    return value.toString();
  }

  throw new TypeError(`Unsupported mapped default for ${column.name}.`);
}

function mappedCheckSql(value: SQL): string {
  return dialect
    .sqlToQuery(value)
    .sql.replaceAll('"ledger"."customers".', '')
    .replaceAll('"', '')
    .replace(/\s+/g, ' ')
    .trim();
}

function mappedIndexColumnName(column: object): string {
  if (!('name' in column) || typeof column.name !== 'string') {
    throw new TypeError('Customer indexes must use named physical columns.');
  }
  return column.name;
}

describe('Customer database contract', () => {
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

    adminPool = createTestPool(environment.adminUrl, 'dokana-task42-contract', 1);
    const sqliteSource = resolve(
      process.cwd(),
      'database/reference/backend_database_reference/sqlite_shop_ledger_schema_v1_1_empty.db',
    );
    sqliteTempDirectory = mkdtempSync(join(tmpdir(), 'dokana-task42-'));
    const sqliteCopy = join(sqliteTempDirectory, 'customer-contract.db');
    copyFileSync(sqliteSource, sqliteCopy);
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

  it('maps every PostgreSQL Customer column, default, and identity rule exactly', async () => {
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
      where attribute.attrelid = 'ledger.customers'::regclass
        and attribute.attnum > 0
        and not attribute.attisdropped
      order by attribute.attnum
    `);

    expect({ schema: tableConfig.schema, table: tableConfig.name }).toEqual({
      schema: 'ledger',
      table: 'customers',
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
    expect(customers.id.hasDefault).toBe(false);
    expect(customers.creditLimitMinor.dataType).toBe('bigint');
    expect(customers.version.dataType).toBe('bigint');
  });

  it('matches PostgreSQL constraints, indexes, and tenant-safe foreign keys', async () => {
    const uniqueConstraints = await pool().query<NamedColumnsRow>(`
      select
        constraint_state.conname as name,
        array_agg(attribute.attname order by key_state.ordinality)::text[] as columns
      from pg_constraint as constraint_state
      cross join lateral unnest(constraint_state.conkey)
        with ordinality as key_state(attnum, ordinality)
      inner join pg_attribute as attribute
        on attribute.attrelid = constraint_state.conrelid
       and attribute.attnum = key_state.attnum
      where constraint_state.conrelid = 'ledger.customers'::regclass
        and constraint_state.contype = 'u'
      group by constraint_state.conname
      order by constraint_state.conname
    `);
    const foreignKeys = await pool().query<ForeignKeyRow>(`
      select
        constraint_state.conname as name,
        array(
          select source_attribute.attname
          from unnest(constraint_state.conkey)
            with ordinality as source_key(attnum, ordinality)
          inner join pg_attribute as source_attribute
            on source_attribute.attrelid = constraint_state.conrelid
           and source_attribute.attnum = source_key.attnum
          order by source_key.ordinality
        )::text[] as columns,
        foreign_namespace.nspname as "foreignSchema",
        foreign_relation.relname as "foreignTable",
        array(
          select foreign_attribute.attname
          from unnest(constraint_state.confkey)
            with ordinality as foreign_key(attnum, ordinality)
          inner join pg_attribute as foreign_attribute
            on foreign_attribute.attrelid = constraint_state.confrelid
           and foreign_attribute.attnum = foreign_key.attnum
          order by foreign_key.ordinality
        )::text[] as "foreignColumns",
        case constraint_state.confupdtype
          when 'c' then 'cascade'
          when 'r' then 'restrict'
          when 'a' then 'no action'
          when 'n' then 'set null'
          when 'd' then 'set default'
        end as "onUpdate",
        case constraint_state.confdeltype
          when 'c' then 'cascade'
          when 'r' then 'restrict'
          when 'a' then 'no action'
          when 'n' then 'set null'
          when 'd' then 'set default'
        end as "onDelete"
      from pg_constraint as constraint_state
      inner join pg_class as foreign_relation
        on foreign_relation.oid = constraint_state.confrelid
      inner join pg_namespace as foreign_namespace
        on foreign_namespace.oid = foreign_relation.relnamespace
      where constraint_state.conrelid = 'ledger.customers'::regclass
        and constraint_state.contype = 'f'
      order by constraint_state.conname
    `);
    const indexes = await pool().query<NamedColumnsRow & { unique: boolean }>(`
      select
        index_relation.relname as name,
        index_state.indisunique as unique,
        array(
          select pg_get_indexdef(index_state.indexrelid, position, true)
          from generate_series(1, index_state.indnkeyatts) as position
        )::text[] as columns
      from pg_index as index_state
      inner join pg_class as index_relation on index_relation.oid = index_state.indexrelid
      left join pg_constraint as backing_constraint
        on backing_constraint.conindid = index_state.indexrelid
      where index_state.indrelid = 'ledger.customers'::regclass
        and backing_constraint.oid is null
      order by index_relation.relname
    `);
    const checks = await pool().query<{ name: string }>(`
      select conname as name
      from pg_constraint
      where conrelid = 'ledger.customers'::regclass
        and contype = 'c'
      order by conname
    `);

    expect(
      tableConfig.uniqueConstraints
        .map((constraint) => ({
          name: constraint.getName(),
          columns: constraint.columns.map((column) => column.name),
        }))
        .sort((left, right) => (left.name ?? '').localeCompare(right.name ?? '')),
    ).toEqual(uniqueConstraints.rows);
    expect(
      tableConfig.foreignKeys
        .map((foreignKey) => {
          const reference = foreignKey.reference();
          const foreignTable = getTableConfig(reference.foreignTable);
          return {
            name: foreignKey.getName(),
            columns: reference.columns.map((column) => column.name),
            foreignSchema: foreignTable.schema,
            foreignTable: foreignTable.name,
            foreignColumns: reference.foreignColumns.map((column) => column.name),
            onUpdate: foreignKey.onUpdate,
            onDelete: foreignKey.onDelete,
          };
        })
        .sort((left, right) => left.name.localeCompare(right.name)),
    ).toEqual(foreignKeys.rows);
    expect(
      tableConfig.indexes.map((mappedIndex) => ({
        name: mappedIndex.config.name,
        unique: mappedIndex.config.unique,
        columns: mappedIndex.config.columns.map(mappedIndexColumnName),
      })),
    ).toEqual(indexes.rows);
    expect(tableConfig.checks.map((constraint) => constraint.name).sort()).toEqual(
      checks.rows.map((constraint) => constraint.name),
    );
    expect(
      Object.fromEntries(
        tableConfig.checks.map((constraint) => [constraint.name, mappedCheckSql(constraint.value)]),
      ),
    ).toEqual({
      customers_name_check: 'length(trim(name)) > 0',
      customers_normalized_name_check: 'length(trim(normalized_name)) > 0',
      customers_phone_check: 'length(trim(phone)) > 0',
      customers_normalized_phone_check: 'length(trim(normalized_phone)) > 0',
      customers_credit_limit_minor_check: 'credit_limit_minor is null or credit_limit_minor >= 0',
      customers_credit_policy_check:
        "credit_policy is null or credit_policy in ('allow', 'warn', 'block')",
      customers_status_check: "status in ('active', 'archived')",
      customers_check: "(status = 'archived' and archived_at is not null) or status = 'active'",
      customers_version_check: 'version >= 1',
    });
  });

  it('verifies server-only RLS, trigger, ownership, and incoming-reference behavior', async () => {
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
      where relation.oid = 'ledger.customers'::regclass
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
      where schemaname = 'ledger' and tablename = 'customers'
      order by policyname
    `);
    const triggers = await pool().query<{
      name: string;
      functionName: string;
    }>(`
      select
        trigger_state.tgname as name,
        function_namespace.nspname || '.' || function_state.proname as "functionName"
      from pg_trigger as trigger_state
      inner join pg_proc as function_state on function_state.oid = trigger_state.tgfoid
      inner join pg_namespace as function_namespace
        on function_namespace.oid = function_state.pronamespace
      where trigger_state.tgrelid = 'ledger.customers'::regclass
        and not trigger_state.tgisinternal
        and trigger_state.tgenabled = 'O'
      order by trigger_state.tgname
    `);
    const incomingReferences = await pool().query<{
      sourceTable: string;
      name: string;
    }>(`
      select
        constraint_state.conrelid::regclass::text as "sourceTable",
        constraint_state.conname as name
      from pg_constraint as constraint_state
      where constraint_state.confrelid = 'ledger.customers'::regclass
      order by "sourceTable", name
    `);
    const runtimePrivileges = await pool().query<{
      selectAllowed: boolean;
      insertAllowed: boolean;
      updateAllowed: boolean;
      deleteAllowed: boolean;
      bypassRls: boolean;
    }>(`
      select
        has_table_privilege('shop_app_runtime', 'ledger.customers', 'select') as "selectAllowed",
        has_table_privilege('shop_app_runtime', 'ledger.customers', 'insert') as "insertAllowed",
        has_table_privilege('shop_app_runtime', 'ledger.customers', 'update') as "updateAllowed",
        has_table_privilege('shop_app_runtime', 'ledger.customers', 'delete') as "deleteAllowed",
        (select rolbypassrls from pg_roles where rolname = 'shop_app_runtime') as "bypassRls"
    `);

    expect(relation.rows).toEqual([
      { owner: 'shop_app_migrator', rlsEnabled: true, rlsForced: true },
    ]);
    expect(policies.rows).toEqual([
      {
        name: 'tenant_isolation_customers',
        command: 'ALL',
        usingExpression: '(store_id = platform.current_store_id())',
        checkExpression: '(store_id = platform.current_store_id())',
      },
    ]);
    expect(triggers.rows).toEqual([
      { name: 'trg_customers_central_audit', functionName: 'audit.capture_row_change' },
      { name: 'trg_customers_change_event', functionName: 'sync.capture_change_event' },
      { name: 'trg_customers_no_delete', functionName: 'ledger.prevent_delete' },
      { name: 'trg_customers_touch', functionName: 'ledger.touch_mutable_row' },
    ]);
    expect(incomingReferences.rows).toEqual([
      {
        sourceTable: 'ledger.customer_ledger_entries',
        name: 'customer_ledger_entries_store_id_customer_id_fkey',
      },
      {
        sourceTable: 'ledger.customer_payments',
        name: 'customer_payments_store_id_customer_id_fkey',
      },
      {
        sourceTable: 'ledger.sale_returns',
        name: 'sale_returns_store_id_customer_id_fkey',
      },
      {
        sourceTable: 'ledger.sales',
        name: 'sales_store_id_customer_id_fkey',
      },
    ]);
    expect(runtimePrivileges.rows).toEqual([
      {
        selectAllowed: true,
        insertAllowed: true,
        updateAllowed: true,
        deleteAllowed: true,
        bypassRls: false,
      },
    ]);
  });

  it('matches the approved SQLite shared Customer representation read-only', async () => {
    const quickCheck = sqlite().prepare('pragma quick_check').all();
    const foreignKeyCheck = sqlite().prepare('pragma foreign_key_check').all();
    const sqliteColumns = sqlite()
      .prepare("pragma table_info('customers')")
      .all() as unknown as SqliteColumnRow[];
    const searchIndexColumns = sqlite()
      .prepare("pragma index_info('idx_customers_search')")
      .all() as unknown as { name: string }[];
    const noDeleteTrigger = sqlite()
      .prepare(
        "select name from sqlite_master where type = 'trigger' and tbl_name = 'customers' order by name",
      )
      .all();

    const sqliteTypeForPostgres: Record<string, string> = {
      uuid: 'TEXT',
      text: 'TEXT',
      bigint: 'INTEGER',
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
      id: null,
      status: "'active'",
      created_at: null,
      updated_at: null,
      version: '1',
    });
    expect(searchIndexColumns.map((column) => column.name)).toEqual([
      'store_id',
      'status',
      'normalized_name',
      'normalized_phone',
    ]);
    expect(noDeleteTrigger).toEqual([{ name: 'trg_customers_no_delete' }]);
  });
});
