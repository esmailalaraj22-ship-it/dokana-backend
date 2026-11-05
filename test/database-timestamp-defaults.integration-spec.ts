import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';

import {
  platformAdminAssignments,
  recoveryControl,
  schemaMigrations,
} from '../src/database/schema/platform';
import {
  offlineOperationProvenanceV1,
  offlineOperationRecoveryEventsV1,
  storeChangeEventsV1,
} from '../src/database/schema/sync';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const describeDatabase = environment ? describe : describe.skip;

describeDatabase('database-authoritative timestamp defaults', () => {
  let admin: Pool;
  beforeAll(() => {
    if (!environment) throw new Error('Local PostgreSQL is required.');
    admin = createTestPool(environment.adminUrl, 'dokana-timestamp-defaults', 1);
  });
  afterAll(async () => {
    await admin.end();
  });

  it('maps wall-clock event timestamps to the existing PostgreSQL expressions', async () => {
    const columns = [
      platformAdminAssignments.assignedAt,
      platformAdminAssignments.updatedAt,
      recoveryControl.updatedAt,
      schemaMigrations.registeredAt,
      offlineOperationProvenanceV1.createdAt,
      offlineOperationRecoveryEventsV1.recordedAt,
      storeChangeEventsV1.capturedAt,
    ];
    const dialect = new PgDialect();
    for (const column of columns) {
      const table = getTableConfig(column.table);
      const actual = await admin.query<{ expression: string }>(
        `
        select pg_get_expr(d.adbin, d.adrelid) as expression
        from pg_attrdef d
        join pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum
        join pg_class c on c.oid=a.attrelid
        join pg_namespace n on n.oid=c.relnamespace
        where n.nspname=$1 and c.relname=$2 and a.attname=$3
      `,
        [table.schema, table.name, column.name],
      );
      expect(actual.rows).toHaveLength(1);
      const expression = column.default;
      if (!expression || expression instanceof Date)
        throw new Error('Expected SQL timestamp default.');
      expect(dialect.sqlToQuery(expression).sql).toBe(actual.rows[0]?.expression);
    }
  });
});
