import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { eq, SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';

import { deriveAccountingPeriodId } from '../src/accounting-periods/accounting-period-identity';
import { resolveAccountingPeriodBoundaries } from '../src/accounting-periods/accounting-period-month';
import { accountingPeriods } from '../src/database/schema';
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
const tableConfig = getTableConfig(accountingPeriods);
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
    .sql.replaceAll('"ledger"."accounting_periods".', '')
    .replaceAll('"', '')
    .replace(/\s+/g, ' ')
    .trim();
}

function postgresErrorCode(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return undefined;
}

describe('Accounting Period database contract', () => {
  let adminPool: Pool | undefined;
  let runtimePool: Pool | undefined;
  let sqliteDatabase: DatabaseSync | undefined;
  let sqliteTempDirectory: string | undefined;

  function admin(): Pool {
    if (!adminPool) {
      throw new Error('The PostgreSQL contract pool is unavailable.');
    }
    return adminPool;
  }

  function runtime(): Pool {
    if (!runtimePool) {
      throw new Error('The PostgreSQL runtime pool is unavailable.');
    }
    return runtimePool;
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

    adminPool = createTestPool(environment.adminUrl, 'dokana-task92-contract-admin', 1);
    runtimePool = createTestPool(environment.runtimeUrl, 'dokana-task92-contract-runtime', 1);

    const sqliteSource = resolve(
      process.cwd(),
      'database/reference/backend_database_reference/sqlite_shop_ledger_schema_v1_1_empty.db',
    );
    sqliteTempDirectory = mkdtempSync(join(tmpdir(), 'dokana-task92-'));
    const sqliteCopy = join(sqliteTempDirectory, 'accounting-period-contract.db');
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
    await runtimePool?.end();
    await adminPool?.end();
  });

  it('maps every live PostgreSQL column, default, nullability, and identity exactly', async () => {
    const catalog = await admin().query<CatalogColumnRow>(`
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
      where attribute.attrelid = 'ledger.accounting_periods'::regclass
        and attribute.attnum > 0
        and not attribute.attisdropped
      order by attribute.attnum
    `);

    expect({ schema: tableConfig.schema, table: tableConfig.name }).toEqual({
      schema: 'ledger',
      table: 'accounting_periods',
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
    expect(accountingPeriods.version.dataType).toBe('bigint');
  });

  it('matches ordinary constraints and verifies the database-owned GiST exclusion contract', async () => {
    const uniqueConstraints = await admin().query<NamedColumnsRow>(`
      select
        constraint_state.conname as name,
        array_agg(attribute.attname order by key_state.ordinality)::text[] as columns
      from pg_constraint as constraint_state
      cross join lateral unnest(constraint_state.conkey)
        with ordinality as key_state(attnum, ordinality)
      inner join pg_attribute as attribute
        on attribute.attrelid = constraint_state.conrelid
       and attribute.attnum = key_state.attnum
      where constraint_state.conrelid = 'ledger.accounting_periods'::regclass
        and constraint_state.contype = 'u'
      group by constraint_state.conname
      order by constraint_state.conname
    `);
    const foreignKeys = await admin().query<ForeignKeyRow>(`
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
      where constraint_state.conrelid = 'ledger.accounting_periods'::regclass
        and constraint_state.contype = 'f'
      order by constraint_state.conname
    `);
    const checkNames = await admin().query<{ name: string }>(`
      select conname as name
      from pg_constraint
      where conrelid = 'ledger.accounting_periods'::regclass and contype = 'c'
      order by conname
    `);
    const exclusion = await admin().query<{ name: string; definition: string }>(`
      select conname as name, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'ledger.accounting_periods'::regclass and contype = 'x'
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
    expect(tableConfig.checks.map((constraint) => constraint.name).sort()).toEqual(
      checkNames.rows.map((constraint) => constraint.name),
    );
    expect(
      Object.fromEntries(
        tableConfig.checks.map((constraint) => [constraint.name, mappedCheckSql(constraint.value)]),
      ),
    ).toEqual({
      accounting_periods_period_year_check: 'period_year >= 2020',
      accounting_periods_period_month_check: 'period_month between 1 and 12',
      accounting_periods_status_check: "status in ('open', 'closing', 'closed')",
      accounting_periods_check: 'ends_at > starts_at',
      accounting_periods_check1:
        "(status = 'closed' and closed_at is not null) or status in ('open', 'closing')",
      accounting_periods_version_check: 'version >= 1',
    });
    expect(tableConfig.indexes).toEqual([]);
    expect(exclusion.rows).toHaveLength(1);
    expect(exclusion.rows[0]?.name).toBe('accounting_periods_no_overlap');
    expect(exclusion.rows[0]?.definition).toContain('EXCLUDE USING gist');
    expect(exclusion.rows[0]?.definition).toContain('store_id WITH =');
    expect(exclusion.rows[0]?.definition).toContain(
      "tstzrange(starts_at, ends_at, '[)'::text) WITH &&",
    );
  });

  it('preserves forced RLS, tenant policy, trigger safeguards, and legacy period functions', async () => {
    const relation = await admin().query<{
      owner: string;
      rlsEnabled: boolean;
      rlsForced: boolean;
    }>(`
      select pg_get_userbyid(relation.relowner) as owner,
        relation.relrowsecurity as "rlsEnabled",
        relation.relforcerowsecurity as "rlsForced"
      from pg_class as relation
      where relation.oid = 'ledger.accounting_periods'::regclass
    `);
    const policies = await admin().query<{
      name: string;
      command: string;
      usingExpression: string;
      checkExpression: string;
    }>(`
      select policyname as name, cmd as command, qual as "usingExpression",
        with_check as "checkExpression"
      from pg_policies
      where schemaname = 'ledger' and tablename = 'accounting_periods'
      order by policyname
    `);
    const triggers = await admin().query<{ name: string; functionName: string }>(`
      select trigger_state.tgname as name,
        function_namespace.nspname || '.' || function_state.proname as "functionName"
      from pg_trigger as trigger_state
      inner join pg_proc as function_state on function_state.oid = trigger_state.tgfoid
      inner join pg_namespace as function_namespace
        on function_namespace.oid = function_state.pronamespace
      where trigger_state.tgrelid = 'ledger.accounting_periods'::regclass
        and not trigger_state.tgisinternal and trigger_state.tgenabled = 'O'
      order by trigger_state.tgname
    `);
    const functions = await admin().query<{ signature: string; securityDefiner: boolean }>(`
      select function_state.oid::regprocedure::text as signature,
        function_state.prosecdef as "securityDefiner"
      from pg_proc as function_state
      inner join pg_namespace as function_namespace
        on function_namespace.oid = function_state.pronamespace
      where function_namespace.nspname = 'ledger'
        and function_state.proname in (
          'assert_period_open', 'enforce_period_open', 'guard_accounting_period'
        )
      order by signature
    `);
    const runtimePrivileges = await admin().query<{
      selectAllowed: boolean;
      isSuperuser: boolean;
      bypassRls: boolean;
      tableOwner: boolean;
    }>(`
      select
        has_table_privilege('dokana_runtime_login', 'ledger.accounting_periods', 'select')
          as "selectAllowed",
        (select rolsuper from pg_roles where rolname = 'dokana_runtime_login') as "isSuperuser",
        (select rolbypassrls from pg_roles where rolname = 'dokana_runtime_login') as "bypassRls",
        pg_get_userbyid((select relowner from pg_class
          where oid = 'ledger.accounting_periods'::regclass)) = 'dokana_runtime_login'
          as "tableOwner"
    `);

    expect(relation.rows).toEqual([
      { owner: 'shop_app_migrator', rlsEnabled: true, rlsForced: true },
    ]);
    expect(policies.rows).toEqual([
      {
        name: 'tenant_isolation_accounting_periods',
        command: 'ALL',
        usingExpression: '(store_id = platform.current_store_id())',
        checkExpression: '(store_id = platform.current_store_id())',
      },
    ]);
    expect(triggers.rows).toEqual([
      { name: 'trg_accounting_period_guard', functionName: 'ledger.guard_accounting_period' },
      {
        name: 'trg_accounting_periods_central_audit',
        functionName: 'audit.capture_row_change',
      },
      {
        name: 'trg_accounting_periods_change_event',
        functionName: 'sync.capture_change_event',
      },
      { name: 'trg_accounting_periods_no_delete', functionName: 'ledger.prevent_delete' },
      { name: 'trg_accounting_periods_touch', functionName: 'ledger.touch_mutable_row' },
    ]);
    expect(functions.rows).toEqual([
      {
        signature: 'ledger.assert_period_open(uuid,uuid,timestamp with time zone)',
        securityDefiner: false,
      },
      { signature: 'ledger.enforce_period_open()', securityDefiner: false },
      { signature: 'ledger.guard_accounting_period()', securityDefiner: false },
    ]);
    expect(runtimePrivileges.rows).toEqual([
      { selectAllowed: true, isSuperuser: false, bypassRls: false, tableOwner: false },
    ]);
  });

  it('executes the mapped read under transaction-local runtime context and fails closed without it', async () => {
    const client = await runtime().connect();
    let transactionOpen = false;

    try {
      await client.query('begin');
      transactionOpen = true;
      const database = drizzle(client, { schema: { accountingPeriods } });

      expect(await database.select().from(accountingPeriods)).toEqual([]);

      const storeId = randomUUID();
      await client.query("select set_config('app.store_id', $1, true)", [storeId]);
      await client.query("select set_config('app.user_id', $1, true)", [randomUUID()]);
      await client.query("select set_config('app.device_id', $1, true)", [randomUUID()]);
      await client.query("select set_config('app.request_id', $1, true)", [randomUUID()]);

      expect(
        await database
          .select({ id: accountingPeriods.id })
          .from(accountingPeriods)
          .where(eq(accountingPeriods.storeId, storeId)),
      ).toEqual([]);

      await client.query('rollback');
      transactionOpen = false;
    } finally {
      if (transactionOpen) {
        await client.query('rollback');
      }
      client.release();
    }
  });

  it('accepts adjacent periods, rejects physical overlap, and leaves no fixture residue', async () => {
    const client = await admin().connect();
    const storeId = randomUUID();
    let transactionOpen = false;

    try {
      await client.query('begin');
      transactionOpen = true;
      await client.query("select set_config('app.store_id', $1, true)", [storeId]);
      await client.query("select set_config('app.user_id', '', true)");
      await client.query("select set_config('app.device_id', '', true)");
      await client.query("select set_config('app.request_id', $1, true)", [randomUUID()]);
      await client.query("select set_config('app.suppress_change_events', 'on', true)");
      await client.query('insert into ledger.stores (id, name) values ($1, $2)', [
        storeId,
        'S9.2 contract fixture',
      ]);

      const september = resolveAccountingPeriodBoundaries(2026, 9);
      const october = resolveAccountingPeriodBoundaries(2026, 10);
      const insertPeriod = `
        insert into ledger.accounting_periods (
          id, store_id, period_year, period_month, starts_at, ends_at, operation_id
        ) values ($1, $2, $3, $4, $5, $6, $7)
      `;

      await client.query(insertPeriod, [
        deriveAccountingPeriodId(storeId, 2026, 9),
        storeId,
        2026,
        9,
        september.startsAt,
        september.endsAt,
        randomUUID(),
      ]);
      await client.query(insertPeriod, [
        deriveAccountingPeriodId(storeId, 2026, 10),
        storeId,
        2026,
        10,
        october.startsAt,
        october.endsAt,
        randomUUID(),
      ]);

      await client.query('savepoint overlapping_period');
      let overlapCode: string | undefined;
      try {
        await client.query(insertPeriod, [
          deriveAccountingPeriodId(storeId, 2026, 11),
          storeId,
          2026,
          11,
          new Date('2026-09-15T00:00:00.000Z'),
          new Date('2026-10-15T00:00:00.000Z'),
          randomUUID(),
        ]);
      } catch (error) {
        overlapCode = postgresErrorCode(error);
        await client.query('rollback to savepoint overlapping_period');
      }

      expect(overlapCode).toBe('23P01');
      const periodCount = await client.query<{ count: string }>(
        'select count(*)::text as count from ledger.accounting_periods where store_id = $1',
        [storeId],
      );
      expect(periodCount.rows).toEqual([{ count: '2' }]);

      await client.query('rollback');
      transactionOpen = false;

      const residue = await client.query<{ count: string }>(
        'select count(*)::text as count from ledger.stores where id = $1',
        [storeId],
      );
      expect(residue.rows).toEqual([{ count: '0' }]);
    } finally {
      if (transactionOpen) {
        await client.query('rollback');
      }
      client.release();
    }
  });

  it('matches the approved SQLite shared Accounting Period representation read-only', () => {
    const sqliteColumns = sqlite()
      .prepare("pragma table_info('accounting_periods')")
      .all() as unknown as SqliteColumnRow[];
    const triggers = sqlite()
      .prepare(
        "select name from sqlite_master where type = 'trigger' and tbl_name = 'accounting_periods' order by name",
      )
      .all();
    const sqliteTypeForPostgres: Record<string, string> = {
      uuid: 'TEXT',
      integer: 'INTEGER',
      text: 'TEXT',
      bigint: 'INTEGER',
      'timestamp with time zone': 'INTEGER',
    };

    expect(sqlite().prepare('pragma quick_check').all()).toEqual([{ quick_check: 'ok' }]);
    expect(sqlite().prepare('pragma foreign_key_check').all()).toEqual([]);
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
    ).toEqual({
      id: null,
      store_id: null,
      period_year: null,
      period_month: null,
      starts_at: null,
      ends_at: null,
      status: "'open'",
      closed_at: null,
      device_id: null,
      operation_id: null,
      created_at: null,
      updated_at: null,
      version: '1',
    });
    expect(triggers).toEqual([
      { name: 'trg_accounting_period_close_validate' },
      { name: 'trg_accounting_period_no_overlap_insert' },
      { name: 'trg_accounting_period_no_overlap_update' },
      { name: 'trg_accounting_period_no_reopen' },
      { name: 'trg_accounting_periods_no_delete' },
    ]);
  });
});
