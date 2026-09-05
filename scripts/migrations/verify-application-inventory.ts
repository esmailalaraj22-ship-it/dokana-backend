import type { PoolClient } from 'pg';

import { readMigrationFile } from './migration-files';

import {
  applicationRoutines,
  applicationSchemas,
  applicationSequences,
  applicationTables,
  applicationViews,
  ownershipFoundationAdditions,
  station2ContextFunctions,
} from './application-object-inventory';

interface RelationRow {
  qualifiedName: string;
  relationKind: string;
  owner: string;
}

interface RoutineRow {
  signature: string;
  owner: string;
  securityDefiner: boolean;
  configuration: string[] | null;
}

function assertExactSet(
  label: string,
  actual: readonly string[],
  expected: readonly string[],
): void {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((entry) => !actualSet.has(entry));
  const unexpected = actual.filter((entry) => !expectedSet.has(entry));

  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `${label} inventory mismatch (missing=${missing.join(',') || 'none'}; unexpected=${
        unexpected.join(',') || 'none'
      }).`,
    );
  }
}

export async function verifyApplicationInventory(
  client: PoolClient,
  expectedOwner: 'postgres' | 'shop_app_migrator',
  includeFoundation: boolean,
): Promise<void> {
  // The baseline inventory remains frozen. Versioned additions are admitted only
  // after their exact migration is registered, without accepting arbitrary objects.
  let inventoryFoundationApplied = false;
  if (includeFoundation) {
    const applied = await client.query<{ checksum: string }>(
      `select checksum_sha256 as checksum from platform.schema_migrations
       where filename = '0007_inventory_physical_foundation.sql'`,
    );
    if (applied.rows[0]) {
      const file = await readMigrationFile('0007_inventory_physical_foundation.sql');
      if (applied.rows[0].checksum !== file.checksumSha256) {
        throw new Error('Inventory foundation migration checksum mismatch.');
      }
      inventoryFoundationApplied = true;
    }
  }
  const schemaResult = await client.query<{ schemaName: string; owner: string }>(
    `
      select
        namespace.nspname as "schemaName",
        pg_get_userbyid(namespace.nspowner) as owner
      from pg_namespace as namespace
      where namespace.nspname = any($1::text[])
      order by namespace.nspname
    `,
    [applicationSchemas],
  );

  assertExactSet(
    'Application schema',
    schemaResult.rows.map((row) => row.schemaName),
    applicationSchemas,
  );
  if (schemaResult.rows.some((row) => row.owner !== expectedOwner)) {
    throw new Error('An application schema has an unexpected owner.');
  }

  const relationResult = await client.query<RelationRow>(
    `
      select
        namespace.nspname || '.' || relation.relname as "qualifiedName",
        relation.relkind as "relationKind",
        pg_get_userbyid(relation.relowner) as owner
      from pg_class as relation
      inner join pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = any($1::text[])
        and relation.relkind = any($2::"char"[])
      order by namespace.nspname, relation.relname
    `,
    [applicationSchemas, ['r', 'p', 'S', 'v', 'm', 'f']],
  );

  const expectedRelations = [
    ...applicationTables,
    ...applicationSequences,
    ...applicationViews,
    ...(includeFoundation ? ownershipFoundationAdditions : []),
    ...(inventoryFoundationApplied ? ['ledger.manual_inventory_entries'] : []),
  ];
  assertExactSet(
    'Application relation',
    relationResult.rows.map((row) => row.qualifiedName),
    expectedRelations,
  );
  if (relationResult.rows.some((row) => row.owner !== expectedOwner)) {
    throw new Error('An application relation has an unexpected owner.');
  }
  if (relationResult.rows.some((row) => ['m', 'f', 'p'].includes(row.relationKind))) {
    throw new Error('An unexpected materialized view, foreign table, or partitioned table exists.');
  }

  const routineResult = await client.query<RoutineRow>(
    `
      select
        namespace.nspname || '.' || function_state.proname || '('
          || pg_get_function_identity_arguments(function_state.oid) || ')' as signature,
        pg_get_userbyid(function_state.proowner) as owner,
        function_state.prosecdef as "securityDefiner",
        function_state.proconfig as configuration
      from pg_proc as function_state
      inner join pg_namespace as namespace on namespace.oid = function_state.pronamespace
      where namespace.nspname = any($1::text[])
      order by signature
    `,
    [applicationSchemas],
  );
  assertExactSet(
    'Application routine',
    routineResult.rows.map((row) => row.signature),
    [
      ...applicationRoutines,
      ...(inventoryFoundationApplied
        ? [
            'ledger.inventory_base_quantity(p_selected bigint, p_num integer, p_den integer)',
            'ledger.validate_inventory_unit()',
            'ledger.validate_manual_inventory_movement()',
            'ledger.validate_inventory_manual_reference()',
            'ledger.guard_inventory_count_item()',
            'ledger.guard_inventory_count_header()',
            'ledger.validate_inventory_count_facts()',
          ]
        : []),
    ],
  );
  if (routineResult.rows.some((row) => row.owner !== expectedOwner)) {
    throw new Error('An application routine has an unexpected owner.');
  }

  const standaloneTypeResult = await client.query<{ typeName: string }>(
    `
      select namespace.nspname || '.' || type_state.typname as "typeName"
      from pg_type as type_state
      inner join pg_namespace as namespace on namespace.oid = type_state.typnamespace
      left join pg_class as relation on relation.oid = type_state.typrelid
      where namespace.nspname = any($1::text[])
        and type_state.typtype = any($2::"char"[])
        and relation.oid is null
    `,
    [applicationSchemas, ['c', 'd', 'e', 'm', 'r']],
  );
  if (standaloneTypeResult.rowCount !== 0) {
    throw new Error('An unexpected standalone application type exists.');
  }

  const indexOwnerResult = await client.query<{ qualifiedName: string; owner: string }>(
    `
      select
        namespace.nspname || '.' || relation.relname as "qualifiedName",
        pg_get_userbyid(relation.relowner) as owner
      from pg_class as relation
      inner join pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = any($1::text[])
        and relation.relkind = any($2::"char"[])
      order by namespace.nspname, relation.relname
    `,
    [applicationSchemas, ['i', 'I']],
  );
  if (indexOwnerResult.rows.some((row) => row.owner !== expectedOwner)) {
    throw new Error('An ownership-dependent application index has an unexpected owner.');
  }
}

export async function verifyStation2ContextFunctions(
  client: PoolClient,
  expectedOwner: 'postgres' | 'shop_app_migrator',
): Promise<void> {
  const result = await client.query<RoutineRow>(
    `
      select
        namespace.nspname || '.' || function_state.proname || '('
          || pg_get_function_identity_arguments(function_state.oid) || ')' as signature,
        pg_get_userbyid(function_state.proowner) as owner,
        function_state.prosecdef as "securityDefiner",
        function_state.proconfig as configuration
      from pg_proc as function_state
      inner join pg_namespace as namespace on namespace.oid = function_state.pronamespace
      where function_state.oid = any($1::regprocedure[])
      order by signature
    `,
    [station2ContextFunctions],
  );

  assertExactSet(
    'Station 2 context function',
    result.rows.map((row) => row.signature),
    station2ContextFunctions,
  );

  const expectedSearchPath = 'search_path=pg_catalog, platform, pg_temp';
  for (const row of result.rows) {
    if (
      row.owner !== expectedOwner ||
      !row.securityDefiner ||
      row.configuration?.length !== 1 ||
      row.configuration[0] !== expectedSearchPath
    ) {
      throw new Error(`Station 2 context function state mismatch: ${row.signature}.`);
    }
  }
}
