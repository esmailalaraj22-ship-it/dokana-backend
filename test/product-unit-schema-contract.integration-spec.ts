import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { eq, SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import type { Pool, PoolClient } from 'pg';

import { productUnits, products } from '../src/database/schema';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

interface CatalogColumnRow {
  tableName: string;
  name: string;
  sqlType: string;
  notNull: boolean;
  defaultExpression: string | null;
  primary: boolean;
}

interface NamedColumnsRow {
  tableName: string;
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

interface IndexRow extends NamedColumnsRow {
  unique: boolean;
  predicate: string | null;
}

interface SqliteColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

const environment = readLocalPostgresTestEnvironment();
const productConfig = getTableConfig(products);
const productUnitConfig = getTableConfig(productUnits);
const dialect = new PgDialect();
const precisionSentinel = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
const fixture = {
  stores: [randomUUID(), randomUUID()],
  products: [randomUUID(), randomUUID()],
  productUnit: randomUUID(),
  otherProductUnit: randomUUID(),
  operations: [randomUUID(), randomUUID(), randomUUID(), randomUUID()],
};

type MappedColumn = (typeof productConfig.columns)[number];
type TableConfig = typeof productConfig;

function getMappedDefault(column: MappedColumn): string | null {
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
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') {
    return value.toString();
  }

  throw new TypeError(`Unsupported mapped default for ${column.name}.`);
}

function mappedCheckSql(value: SQL, tableName: string): string {
  return dialect
    .sqlToQuery(value)
    .sql.replaceAll(`"ledger"."${tableName}".`, '')
    .replaceAll('"', '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePredicate(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  return value
    .replaceAll('"ledger"."product_units".', '')
    .replaceAll('"', '')
    .replaceAll('::text', '')
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function mappedIndexColumnName(column: object): string {
  if (!('name' in column) || typeof column.name !== 'string') {
    throw new TypeError('Product indexes must use named physical columns.');
  }
  return column.name;
}

function mappedColumns(config: TableConfig): Omit<CatalogColumnRow, 'tableName'>[] {
  return config.columns.map((column) => ({
    name: column.name,
    sqlType: column.getSQLType(),
    notNull: column.notNull,
    defaultExpression: getMappedDefault(column),
    primary: column.primary,
  }));
}

function mappedUniqueConstraints(config: TableConfig): Omit<NamedColumnsRow, 'tableName'>[] {
  return config.uniqueConstraints
    .map((constraint) => ({
      name: constraint.getName() ?? '',
      columns: constraint.columns.map((column) => column.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function mappedForeignKeys(config: TableConfig): Omit<ForeignKeyRow, 'tableName'>[] {
  return config.foreignKeys
    .map((foreignKey) => {
      const reference = foreignKey.reference();
      const foreignTable = getTableConfig(reference.foreignTable);
      return {
        name: foreignKey.getName(),
        columns: reference.columns.map((column) => column.name),
        foreignSchema: foreignTable.schema ?? '',
        foreignTable: foreignTable.name,
        foreignColumns: reference.foreignColumns.map((column) => column.name),
        onUpdate: foreignKey.onUpdate ?? 'no action',
        onDelete: foreignKey.onDelete ?? 'no action',
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function mappedIndexes(config: TableConfig): Omit<IndexRow, 'tableName'>[] {
  return config.indexes
    .map((mappedIndex) => ({
      name: mappedIndex.config.name ?? '',
      unique: mappedIndex.config.unique,
      columns: mappedIndex.config.columns.map(mappedIndexColumnName),
      predicate: normalizePredicate(
        mappedIndex.config.where ? dialect.sqlToQuery(mappedIndex.config.where).sql : null,
      ),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function setStoreContext(client: PoolClient, storeId: string): Promise<void> {
  await client.query(
    `
      select
        set_config('app.store_id', $1, true),
        set_config('app.request_id', $2, true)
    `,
    [storeId, randomUUID()],
  );
}

describe('Product and Unit database contract', () => {
  let adminPool: Pool;
  let maintenancePool: Pool;
  let runtimePool: Pool;
  let sqliteDatabase: DatabaseSync | undefined;
  let sqliteTempDirectory: string | undefined;
  let poolsInitialized = false;

  async function removeFixtures(): Promise<void> {
    await maintenancePool.query(
      `delete from audit.central_audit_logs where store_id = any($1::uuid[])`,
      [fixture.stores],
    );
    await maintenancePool.query(`delete from sync.change_events where store_id = any($1::uuid[])`, [
      fixture.stores,
    ]);
    await maintenancePool.query(
      `delete from ledger.product_units where store_id = any($1::uuid[])`,
      [fixture.stores],
    );
    await maintenancePool.query(`delete from ledger.products where store_id = any($1::uuid[])`, [
      fixture.stores,
    ]);
    await maintenancePool.query(`delete from ledger.stores where id = any($1::uuid[])`, [
      fixture.stores,
    ]);
  }

  beforeAll(async () => {
    if (!environment) {
      throw new Error('The approved local PostgreSQL verification environment is unavailable.');
    }

    adminPool = createTestPool(environment.adminUrl, 'dokana-task51-contract-admin', 1);
    maintenancePool = createTestPool(
      environment.adminUrl,
      'dokana-task51-contract-maintenance',
      1,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    runtimePool = createTestPool(environment.runtimeUrl, 'dokana-task51-contract-runtime', 2);
    poolsInitialized = true;

    const sqliteSource = resolve(
      process.cwd(),
      'database/reference/backend_database_reference/sqlite_shop_ledger_schema_v1_1_empty.db',
    );
    sqliteTempDirectory = mkdtempSync(join(tmpdir(), 'dokana-task51-'));
    const sqliteCopy = join(sqliteTempDirectory, 'product-unit-contract.db');
    copyFileSync(sqliteSource, sqliteCopy);
    sqliteDatabase = new DatabaseSync(sqliteCopy, { readOnly: true });

    await removeFixtures();
    await maintenancePool.query(
      `
        insert into ledger.stores (id, name, status)
        values ($1, 'Task 5.1 Store A', 'active'), ($2, 'Task 5.1 Store B', 'active')
      `,
      fixture.stores,
    );
    await maintenancePool.query(
      `
        insert into ledger.products (
          id, store_id, name, normalized_name, measurement_type,
          low_stock_threshold_milli, operation_id
        )
        values
          ($1, $2, 'Task 5.1 Product A', 'task 5.1 product a', 'count', $3, $4),
          ($5, $6, 'Task 5.1 Product B', 'task 5.1 product b', 'count', null, $7)
      `,
      [
        fixture.products[0],
        fixture.stores[0],
        precisionSentinel.toString(),
        fixture.operations[0],
        fixture.products[1],
        fixture.stores[1],
        fixture.operations[1],
      ],
    );
    await maintenancePool.query(
      `
        insert into ledger.product_units (
          id, store_id, product_id, measurement_type, unit_name, is_base,
          factor_num, factor_den, sale_price_minor, purchase_price_minor, operation_id
        )
        values ($1, $2, $3, 'count', 'Piece', true, 1, 1, $4, $4, $5)
      `,
      [
        fixture.productUnit,
        fixture.stores[0],
        fixture.products[0],
        precisionSentinel.toString(),
        fixture.operations[2],
      ],
    );
    await maintenancePool.query(
      `
        insert into ledger.product_units (
          id, store_id, product_id, measurement_type, unit_name, is_base,
          factor_num, factor_den, operation_id
        )
        values ($1, $2, $3, 'count', 'Piece B', true, 1, 1, $4)
      `,
      [fixture.otherProductUnit, fixture.stores[1], fixture.products[1], fixture.operations[3]],
    );
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

    if (!poolsInitialized) {
      return;
    }
    await removeFixtures();
    await Promise.all([adminPool.end(), maintenancePool.end(), runtimePool.end()]);
  });

  it('maps every PostgreSQL Product and Unit column, default, and identity rule exactly', async () => {
    const catalog = await adminPool.query<CatalogColumnRow>(`
      select
        relation.relname as "tableName",
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
      inner join pg_class as relation on relation.oid = attribute.attrelid
      inner join pg_namespace as namespace on namespace.oid = relation.relnamespace
      left join pg_attrdef as default_state
        on default_state.adrelid = attribute.attrelid
       and default_state.adnum = attribute.attnum
      where namespace.nspname = 'ledger'
        and relation.relname = any(array['products', 'product_units'])
        and attribute.attnum > 0
        and not attribute.attisdropped
      order by relation.relname, attribute.attnum
    `);

    expect({ schema: productConfig.schema, table: productConfig.name }).toEqual({
      schema: 'ledger',
      table: 'products',
    });
    expect({ schema: productUnitConfig.schema, table: productUnitConfig.name }).toEqual({
      schema: 'ledger',
      table: 'product_units',
    });
    expect(mappedColumns(productConfig)).toEqual(
      catalog.rows
        .filter((column) => column.tableName === 'products')
        .map((column) => ({
          name: column.name,
          sqlType: column.sqlType,
          notNull: column.notNull,
          defaultExpression: column.defaultExpression,
          primary: column.primary,
        })),
    );
    expect(mappedColumns(productUnitConfig)).toEqual(
      catalog.rows
        .filter((column) => column.tableName === 'product_units')
        .map((column) => ({
          name: column.name,
          sqlType: column.sqlType,
          notNull: column.notNull,
          defaultExpression: column.defaultExpression,
          primary: column.primary,
        })),
    );
    expect(products.id.hasDefault).toBe(false);
    expect(productUnits.id.hasDefault).toBe(false);
  });

  it('matches constraints, indexes, and tenant-safe foreign keys exactly', async () => {
    const uniqueConstraints = await adminPool.query<NamedColumnsRow>(`
      select
        relation.relname as "tableName",
        constraint_state.conname as name,
        array_agg(attribute.attname order by key_state.ordinality)::text[] as columns
      from pg_constraint as constraint_state
      inner join pg_class as relation on relation.oid = constraint_state.conrelid
      inner join pg_namespace as namespace on namespace.oid = relation.relnamespace
      cross join lateral unnest(constraint_state.conkey)
        with ordinality as key_state(attnum, ordinality)
      inner join pg_attribute as attribute
        on attribute.attrelid = constraint_state.conrelid
       and attribute.attnum = key_state.attnum
      where namespace.nspname = 'ledger'
        and relation.relname = any(array['products', 'product_units'])
        and constraint_state.contype = 'u'
      group by relation.relname, constraint_state.conname
      order by relation.relname, constraint_state.conname
    `);
    const foreignKeys = await adminPool.query<ForeignKeyRow>(`
      select
        relation.relname as "tableName",
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
          when 'c' then 'cascade' when 'r' then 'restrict' when 'a' then 'no action'
          when 'n' then 'set null' when 'd' then 'set default'
        end as "onUpdate",
        case constraint_state.confdeltype
          when 'c' then 'cascade' when 'r' then 'restrict' when 'a' then 'no action'
          when 'n' then 'set null' when 'd' then 'set default'
        end as "onDelete"
      from pg_constraint as constraint_state
      inner join pg_class as relation on relation.oid = constraint_state.conrelid
      inner join pg_namespace as namespace on namespace.oid = relation.relnamespace
      inner join pg_class as foreign_relation on foreign_relation.oid = constraint_state.confrelid
      inner join pg_namespace as foreign_namespace
        on foreign_namespace.oid = foreign_relation.relnamespace
      where namespace.nspname = 'ledger'
        and relation.relname = any(array['products', 'product_units'])
        and constraint_state.contype = 'f'
      order by relation.relname, constraint_state.conname
    `);
    const indexes = await adminPool.query<IndexRow>(`
      select
        relation.relname as "tableName",
        index_relation.relname as name,
        index_state.indisunique as unique,
        array(
          select pg_get_indexdef(index_state.indexrelid, position, true)
          from generate_series(1, index_state.indnkeyatts) as position
        )::text[] as columns,
        pg_get_expr(index_state.indpred, index_state.indrelid) as predicate
      from pg_index as index_state
      inner join pg_class as relation on relation.oid = index_state.indrelid
      inner join pg_namespace as namespace on namespace.oid = relation.relnamespace
      inner join pg_class as index_relation on index_relation.oid = index_state.indexrelid
      left join pg_constraint as backing_constraint
        on backing_constraint.conindid = index_state.indexrelid
      where namespace.nspname = 'ledger'
        and relation.relname = any(array['products', 'product_units'])
        and backing_constraint.oid is null
      order by relation.relname, index_relation.relname
    `);
    const checks = await adminPool.query<{ tableName: string; name: string }>(`
      select relation.relname as "tableName", constraint_state.conname as name
      from pg_constraint as constraint_state
      inner join pg_class as relation on relation.oid = constraint_state.conrelid
      inner join pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'ledger'
        and relation.relname = any(array['products', 'product_units'])
        and constraint_state.contype = 'c'
      order by relation.relname, constraint_state.conname
    `);

    for (const [tableName, config] of [
      ['products', productConfig],
      ['product_units', productUnitConfig],
    ] as const) {
      expect(mappedUniqueConstraints(config)).toEqual(
        uniqueConstraints.rows
          .filter((constraint) => constraint.tableName === tableName)
          .map((constraint) => ({ name: constraint.name, columns: constraint.columns })),
      );
      expect(mappedForeignKeys(config)).toEqual(
        foreignKeys.rows
          .filter((foreignKey) => foreignKey.tableName === tableName)
          .map((foreignKey) => ({
            name: foreignKey.name,
            columns: foreignKey.columns,
            foreignSchema: foreignKey.foreignSchema,
            foreignTable: foreignKey.foreignTable,
            foreignColumns: foreignKey.foreignColumns,
            onUpdate: foreignKey.onUpdate,
            onDelete: foreignKey.onDelete,
          })),
      );
      expect(mappedIndexes(config)).toEqual(
        indexes.rows
          .filter((mappedIndex) => mappedIndex.tableName === tableName)
          .map((mappedIndex) => ({
            name: mappedIndex.name,
            columns: mappedIndex.columns,
            unique: mappedIndex.unique,
            predicate: normalizePredicate(mappedIndex.predicate),
          })),
      );
      expect(config.checks.map((constraint) => constraint.name).sort()).toEqual(
        checks.rows
          .filter((constraint) => constraint.tableName === tableName)
          .map((constraint) => constraint.name),
      );
    }

    expect(
      Object.fromEntries(
        productConfig.checks.map((constraint) => [
          constraint.name,
          mappedCheckSql(constraint.value, 'products'),
        ]),
      ),
    ).toEqual({
      products_name_check: 'length(trim(name)) > 0',
      products_normalized_name_check: 'length(trim(normalized_name)) > 0',
      products_measurement_type_check:
        "measurement_type in ('count', 'weight', 'volume', 'length')",
      products_low_stock_threshold_milli_check:
        'low_stock_threshold_milli is null or low_stock_threshold_milli >= 0',
      products_status_check: "status in ('active', 'archived')",
      products_check: "(status = 'archived' and archived_at is not null) or status = 'active'",
      products_version_check: 'version >= 1',
    });
    expect(
      Object.fromEntries(
        productUnitConfig.checks.map((constraint) => [
          constraint.name,
          mappedCheckSql(constraint.value, 'product_units'),
        ]),
      ),
    ).toEqual({
      product_units_measurement_type_check:
        "measurement_type in ('count', 'weight', 'volume', 'length')",
      product_units_unit_name_check: 'length(trim(unit_name)) > 0',
      product_units_factor_num_check: 'factor_num > 0',
      product_units_factor_den_check: 'factor_den > 0',
      product_units_sale_price_minor_check: 'sale_price_minor is null or sale_price_minor >= 0',
      product_units_purchase_price_minor_check:
        'purchase_price_minor is null or purchase_price_minor >= 0',
      product_units_status_check: "status in ('active', 'archived')",
      product_units_check:
        '(is_base = true and factor_num = 1 and factor_den = 1) or is_base = false',
      product_units_version_check: 'version >= 1',
    });
  });

  it('verifies forced RLS, least-privilege grants, trigger wiring, and function semantics', async () => {
    const relations = await adminPool.query<{
      tableName: string;
      owner: string;
      rlsEnabled: boolean;
      rlsForced: boolean;
    }>(`
      select
        relation.relname as "tableName",
        pg_get_userbyid(relation.relowner) as owner,
        relation.relrowsecurity as "rlsEnabled",
        relation.relforcerowsecurity as "rlsForced"
      from pg_class as relation
      inner join pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'ledger'
        and relation.relname = any(array['products', 'product_units'])
      order by relation.relname
    `);
    const policies = await adminPool.query<{
      tableName: string;
      name: string;
      command: string;
      usingExpression: string;
      checkExpression: string;
    }>(`
      select
        tablename as "tableName",
        policyname as name,
        cmd as command,
        qual as "usingExpression",
        with_check as "checkExpression"
      from pg_policies
      where schemaname = 'ledger'
        and tablename = any(array['products', 'product_units'])
      order by tablename, policyname
    `);
    const triggers = await adminPool.query<{
      tableName: string;
      name: string;
      enabled: string;
      definition: string;
      functionName: string;
    }>(`
      select
        relation.relname as "tableName",
        trigger_state.tgname as name,
        trigger_state.tgenabled as enabled,
        pg_get_triggerdef(trigger_state.oid, true) as definition,
        function_namespace.nspname || '.' || function_state.proname as "functionName"
      from pg_trigger as trigger_state
      inner join pg_class as relation on relation.oid = trigger_state.tgrelid
      inner join pg_namespace as namespace on namespace.oid = relation.relnamespace
      inner join pg_proc as function_state on function_state.oid = trigger_state.tgfoid
      inner join pg_namespace as function_namespace
        on function_namespace.oid = function_state.pronamespace
      where namespace.nspname = 'ledger'
        and relation.relname = any(array['products', 'product_units'])
        and not trigger_state.tgisinternal
      order by relation.relname, trigger_state.tgname
    `);
    const privileges = await adminPool.query<{
      tableName: string;
      runtimeSelect: boolean;
      runtimeInsert: boolean;
      runtimeUpdate: boolean;
      runtimeDelete: boolean;
      readonlySelect: boolean;
      authSelect: boolean;
      runtimeBypassRls: boolean;
    }>(`
      select
        relation_name as "tableName",
        has_table_privilege('shop_app_runtime', 'ledger.' || relation_name, 'select') as "runtimeSelect",
        has_table_privilege('shop_app_runtime', 'ledger.' || relation_name, 'insert') as "runtimeInsert",
        has_table_privilege('shop_app_runtime', 'ledger.' || relation_name, 'update') as "runtimeUpdate",
        has_table_privilege('shop_app_runtime', 'ledger.' || relation_name, 'delete') as "runtimeDelete",
        has_table_privilege('shop_app_readonly', 'ledger.' || relation_name, 'select') as "readonlySelect",
        has_table_privilege('shop_app_auth', 'ledger.' || relation_name, 'select') as "authSelect",
        (select rolbypassrls from pg_roles where rolname = 'shop_app_runtime') as "runtimeBypassRls"
      from unnest(array['product_units', 'products']) as relation_name
      order by relation_name
    `);
    const functions = await adminPool.query<{
      name: string;
      securityDefiner: boolean;
      configuration: string[] | null;
      definition: string;
    }>(`
      select
        namespace.nspname || '.' || function_state.proname as name,
        function_state.prosecdef as "securityDefiner",
        function_state.proconfig as configuration,
        pg_get_functiondef(function_state.oid) as definition
      from pg_proc as function_state
      inner join pg_namespace as namespace on namespace.oid = function_state.pronamespace
      where function_state.oid = any(array[
        'ledger.prevent_delete()'::regprocedure,
        'ledger.touch_mutable_row()'::regprocedure,
        'sync.capture_change_event()'::regprocedure,
        'audit.capture_row_change()'::regprocedure
      ])
      order by name
    `);

    expect(relations.rows).toEqual([
      { tableName: 'product_units', owner: 'shop_app_migrator', rlsEnabled: true, rlsForced: true },
      { tableName: 'products', owner: 'shop_app_migrator', rlsEnabled: true, rlsForced: true },
    ]);
    expect(policies.rows).toEqual([
      {
        tableName: 'product_units',
        name: 'tenant_isolation_product_units',
        command: 'ALL',
        usingExpression: '(store_id = platform.current_store_id())',
        checkExpression: '(store_id = platform.current_store_id())',
      },
      {
        tableName: 'products',
        name: 'tenant_isolation_products',
        command: 'ALL',
        usingExpression: '(store_id = platform.current_store_id())',
        checkExpression: '(store_id = platform.current_store_id())',
      },
    ]);
    expect(privileges.rows).toEqual(
      ['product_units', 'products'].map((tableName) => ({
        tableName,
        runtimeSelect: true,
        runtimeInsert: true,
        runtimeUpdate: true,
        runtimeDelete: true,
        readonlySelect: true,
        authSelect: false,
        runtimeBypassRls: false,
      })),
    );
    for (const tableName of ['product_units', 'products']) {
      const tableTriggers = triggers.rows.filter((trigger) => trigger.tableName === tableName);
      expect(tableTriggers.map((trigger) => trigger.name)).toEqual([
        `trg_${tableName}_central_audit`,
        `trg_${tableName}_change_event`,
        `trg_${tableName}_no_delete`,
        `trg_${tableName}_touch`,
      ]);
      expect(tableTriggers.every((trigger) => trigger.enabled === 'O')).toBe(true);
      expect(tableTriggers.map((trigger) => trigger.functionName)).toEqual([
        'audit.capture_row_change',
        'sync.capture_change_event',
        'ledger.prevent_delete',
        'ledger.touch_mutable_row',
      ]);
      expect(
        tableTriggers.find((trigger) => trigger.name.endsWith('_no_delete'))?.definition,
      ).toContain('BEFORE DELETE');
      expect(
        tableTriggers.find((trigger) => trigger.name.endsWith('_touch'))?.definition,
      ).toContain('BEFORE UPDATE');
      expect(
        tableTriggers.find((trigger) => trigger.name.endsWith('_change_event'))?.definition,
      ).toContain('AFTER INSERT OR UPDATE');
      expect(
        tableTriggers.find((trigger) => trigger.name.endsWith('_central_audit'))?.definition,
      ).toContain('AFTER INSERT OR DELETE OR UPDATE');
    }

    const functionByName = new Map(
      functions.rows.map((functionState) => [functionState.name, functionState]),
    );
    expect(functionByName.get('ledger.prevent_delete')?.definition).toContain(
      "USING ERRCODE = '55000'",
    );
    expect(functionByName.get('ledger.touch_mutable_row')?.definition).toContain(
      'NEW.version := OLD.version + 1',
    );
    expect(functionByName.get('ledger.touch_mutable_row')?.definition).toContain(
      'NEW.updated_at := clock_timestamp()',
    );
    expect(functionByName.get('sync.capture_change_event')).toMatchObject({
      securityDefiner: true,
      configuration: ['search_path=pg_catalog, sync, ledger, platform'],
    });
    expect(functionByName.get('sync.capture_change_event')?.definition).toContain(
      'INSERT INTO sync.change_events',
    );
    expect(functionByName.get('audit.capture_row_change')).toMatchObject({
      securityDefiner: true,
      configuration: ['search_path=pg_catalog, audit, platform'],
    });
    expect(functionByName.get('audit.capture_row_change')?.definition).toContain(
      'INSERT INTO audit.central_audit_logs',
    );
  });

  it('fails closed, isolates stores, and preserves bigint precision through Drizzle', async () => {
    const missingContext = await runtimePool.query<{ count: number }>(
      `
      select count(*)::integer as count
      from ledger.products
      where id = any($1::uuid[])
    `,
      [fixture.products],
    );
    expect(missingContext.rows).toEqual([{ count: 0 }]);
    const missingUnitContext = await runtimePool.query<{ count: number }>(
      `
        select count(*)::integer as count
        from ledger.product_units
        where id = any($1::uuid[])
      `,
      [[fixture.productUnit, fixture.otherProductUnit]],
    );
    expect(missingUnitContext.rows).toEqual([{ count: 0 }]);

    const client = await runtimePool.connect();
    try {
      await client.query('begin');
      await setStoreContext(client, fixture.stores[0] ?? '');

      const visibleProducts = await client.query<{ id: string }>(
        `
        select id from ledger.products where id = any($1::uuid[]) order by id
      `,
        [fixture.products],
      );
      expect(visibleProducts.rows.map((row) => row.id)).toEqual([fixture.products[0]]);
      const visibleUnits = await client.query<{ id: string }>(
        `
          select id
          from ledger.product_units
          where id = any($1::uuid[])
          order by id
        `,
        [[fixture.productUnit, fixture.otherProductUnit]],
      );
      expect(visibleUnits.rows.map((row) => row.id)).toEqual([fixture.productUnit]);

      const database = drizzle(client);
      const mappedProducts = await database
        .select({
          id: products.id,
          lowStockThresholdMilli: products.lowStockThresholdMilli,
          version: products.version,
        })
        .from(products)
        .where(eq(products.id, fixture.products[0] ?? ''));
      expect(mappedProducts).toEqual([
        {
          id: fixture.products[0],
          lowStockThresholdMilli: precisionSentinel,
          version: 1n,
        },
      ]);
      expect(typeof mappedProducts[0]?.lowStockThresholdMilli).toBe('bigint');
      expect(typeof mappedProducts[0]?.version).toBe('bigint');

      const mappedUnits = await database
        .select({
          id: productUnits.id,
          salePriceMinor: productUnits.salePriceMinor,
          purchasePriceMinor: productUnits.purchasePriceMinor,
          factorNum: productUnits.factorNum,
          factorDen: productUnits.factorDen,
          version: productUnits.version,
        })
        .from(productUnits)
        .where(eq(productUnits.id, fixture.productUnit));
      expect(mappedUnits).toEqual([
        {
          id: fixture.productUnit,
          salePriceMinor: precisionSentinel,
          purchasePriceMinor: precisionSentinel,
          factorNum: 1,
          factorDen: 1,
          version: 1n,
        },
      ]);
      expect(typeof mappedUnits[0]?.salePriceMinor).toBe('bigint');
      expect(typeof mappedUnits[0]?.purchasePriceMinor).toBe('bigint');
      expect(typeof mappedUnits[0]?.version).toBe('bigint');

      await expect(
        client.query(
          `
            insert into ledger.products (
              id, store_id, name, normalized_name, measurement_type, operation_id
            ) values ($1, $2, 'Blocked', 'blocked', 'count', $3)
          `,
          [randomUUID(), fixture.stores[1], randomUUID()],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback');
    } finally {
      client.release();
    }

    const unitClient = await runtimePool.connect();
    try {
      await unitClient.query('begin');
      await setStoreContext(unitClient, fixture.stores[0] ?? '');
      await expect(
        unitClient.query(
          `
            insert into ledger.product_units (
              id, store_id, product_id, measurement_type, unit_name,
              factor_num, factor_den, operation_id
            ) values ($1, $2, $3, 'count', 'Blocked cross-store unit', 2, 1, $4)
          `,
          [randomUUID(), fixture.stores[1], fixture.products[1], randomUUID()],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await unitClient.query('rollback');
    } finally {
      unitClient.release();
    }
  });

  it('rejects cross-store relationships and invalid conversion persistence', async () => {
    await expect(
      adminPool.query(
        `
          insert into ledger.product_units (
            id, store_id, product_id, measurement_type, unit_name,
            factor_num, factor_den, operation_id
          ) values ($1, $2, $3, 'count', 'Cross store', 2, 1, $4)
        `,
        [randomUUID(), fixture.stores[0], fixture.products[1], randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23503' });

    await expect(
      adminPool.query(
        `
          insert into ledger.product_units (
            id, store_id, product_id, measurement_type, unit_name,
            factor_num, factor_den, operation_id
          ) values ($1, $2, $3, 'count', 'Invalid denominator', 1, 0, $4)
        `,
        [randomUUID(), fixture.stores[0], fixture.products[0], randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      adminPool.query(
        `
          insert into ledger.product_units (
            id, store_id, product_id, measurement_type, unit_name, is_base,
            factor_num, factor_den, operation_id
          ) values ($1, $2, $3, 'count', 'Duplicate base', true, 1, 1, $4)
        `,
        [randomUUID(), fixture.stores[0], fixture.products[0], randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('executes touch, change-event, audit, and no-delete semantics without permanent residue', async () => {
    const client = await runtimePool.connect();
    try {
      await client.query('begin');
      await setStoreContext(client, fixture.stores[0] ?? '');
      await client.query(
        `update ledger.products set description = 'mapped contract update' where id = $1`,
        [fixture.products[0]],
      );
      await client.query(`update ledger.product_units set unit_code = 'pc' where id = $1`, [
        fixture.productUnit,
      ]);
      await client.query('commit');
    } finally {
      client.release();
    }

    const versions = await adminPool.query<{ entity: string; version: string }>(
      `
        select 'products' as entity, version::text
        from ledger.products where id = $1
        union all
        select 'product_units' as entity, version::text
        from ledger.product_units where id = $2
        order by entity
      `,
      [fixture.products[0], fixture.productUnit],
    );
    expect(versions.rows).toEqual([
      { entity: 'product_units', version: '2' },
      { entity: 'products', version: '2' },
    ]);

    const changes = await adminPool.query<{ entityType: string; action: string; version: string }>(
      `
        select entity_type as "entityType", action, entity_version::text as version
        from sync.change_events
        where store_id = $1 and entity_id = any($2::uuid[])
        order by entity_type
      `,
      [fixture.stores[0], [fixture.products[0], fixture.productUnit]],
    );
    expect(changes.rows).toEqual([
      { entityType: 'product_units', action: 'update', version: '2' },
      { entityType: 'products', action: 'update', version: '2' },
    ]);

    const audits = await adminPool.query<{ entityType: string; action: string }>(
      `
        select entity_type as "entityType", action
        from audit.central_audit_logs
        where store_id = $1 and entity_id = any($2::uuid[])
        order by entity_type
      `,
      [fixture.stores[0], [fixture.products[0], fixture.productUnit]],
    );
    expect(audits.rows).toEqual([
      { entityType: 'ledger.product_units', action: 'update' },
      { entityType: 'ledger.products', action: 'update' },
    ]);

    for (const [table, id] of [
      ['product_units', fixture.productUnit],
      ['products', fixture.products[0]],
    ] as const) {
      const deleteClient = await runtimePool.connect();
      try {
        await deleteClient.query('begin');
        await setStoreContext(deleteClient, fixture.stores[0] ?? '');
        await expect(
          deleteClient.query(`delete from ledger.${table} where id = $1`, [id]),
        ).rejects.toMatchObject({
          code: '55000',
        });
        await deleteClient.query('rollback');
      } finally {
        deleteClient.release();
      }
    }
  });

  it('matches the stable SQLite Product and Unit representation read-only', () => {
    if (!sqliteDatabase) {
      throw new Error('The SQLite contract database is unavailable.');
    }

    expect(sqliteDatabase.prepare('pragma quick_check').all()).toEqual([{ quick_check: 'ok' }]);
    expect(sqliteDatabase.prepare('pragma foreign_key_check').all()).toEqual([]);

    const sqliteTypeForPostgres: Record<string, string> = {
      uuid: 'TEXT',
      text: 'TEXT',
      boolean: 'INTEGER',
      integer: 'INTEGER',
      bigint: 'INTEGER',
      'timestamp with time zone': 'INTEGER',
    };
    for (const [tableName, config] of [
      ['products', productConfig],
      ['product_units', productUnitConfig],
    ] as const) {
      const sqliteColumns = sqliteDatabase
        .prepare(`pragma table_info('${tableName}')`)
        .all() as unknown as SqliteColumnRow[];
      expect(
        sqliteColumns.map((column) => ({
          name: column.name,
          type: column.type,
          notNull: column.notnull === 1,
          primary: column.pk === 1,
        })),
      ).toEqual(
        config.columns.map((column) => ({
          name: column.name,
          type: sqliteTypeForPostgres[column.getSQLType()],
          notNull: column.notNull,
          primary: column.primary,
        })),
      );
    }

    const productDefaults = Object.fromEntries(
      (
        sqliteDatabase
          .prepare("pragma table_info('products')")
          .all() as unknown as SqliteColumnRow[]
      ).map((column) => [column.name, column.dflt_value]),
    );
    expect(productDefaults).toMatchObject({
      id: null,
      track_inventory: '1',
      is_pinned: '0',
      status: "'active'",
      created_at: null,
      updated_at: null,
      version: '1',
    });
    const unitDefaults = Object.fromEntries(
      (
        sqliteDatabase
          .prepare("pragma table_info('product_units')")
          .all() as unknown as SqliteColumnRow[]
      ).map((column) => [column.name, column.dflt_value]),
    );
    expect(unitDefaults).toMatchObject({
      id: null,
      is_base: '0',
      factor_den: '1',
      status: "'active'",
      created_at: null,
      updated_at: null,
      version: '1',
    });

    const productIndexColumns = sqliteDatabase
      .prepare("pragma index_info('idx_products_search')")
      .all() as unknown as { name: string }[];
    expect(productIndexColumns.map((column) => column.name)).toEqual([
      'store_id',
      'status',
      'normalized_name',
      'barcode',
      'sku',
      'is_pinned',
    ]);
    const unitIndexColumns = sqliteDatabase
      .prepare("pragma index_info('uq_product_one_base_unit')")
      .all() as unknown as { name: string }[];
    expect(unitIndexColumns.map((column) => column.name)).toEqual(['store_id', 'product_id']);

    const productTriggers = sqliteDatabase
      .prepare(
        "select name from sqlite_master where type = 'trigger' and tbl_name = 'products' order by name",
      )
      .all();
    const unitTriggers = sqliteDatabase
      .prepare(
        "select name from sqlite_master where type = 'trigger' and tbl_name = 'product_units' order by name",
      )
      .all();
    expect(productTriggers).toEqual([{ name: 'trg_products_no_delete' }]);
    expect(unitTriggers).toEqual([
      { name: 'trg_product_base_unit_cannot_archive_with_active_conversions' },
      { name: 'trg_product_unit_nonbase_requires_base' },
      { name: 'trg_product_units_used_cannot_delete' },
    ]);
  });
});
