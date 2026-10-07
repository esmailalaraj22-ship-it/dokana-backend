import 'dotenv/config';

import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

export default async function integrationGlobalTeardown(): Promise<void> {
  const environment = readLocalPostgresTestEnvironment();
  if (!environment) return;

  const pool = createTestPool(environment.adminUrl, 'dokana-integration-global-teardown', 1);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const approval = await client.query<{ databaseName: string; isSuperuser: boolean }>(`
      select
        current_database() as "databaseName",
        role_state.rolsuper as "isSuperuser"
      from pg_roles as role_state
      where role_state.rolname = current_user
    `);
    if (
      approval.rows[0]?.databaseName !== environment.databaseName ||
      !approval.rows[0].isSuperuser
    ) {
      throw new Error('The integration teardown database is not approved.');
    }

    await client.query(`
      delete from sync.store_change_events_v1 as event
      where not exists (
        select 1 from ledger.stores as store_record where store_record.id = event.store_id
      )
    `);
    await client.query(`
      delete from sync.store_change_watermarks_v1 as watermark
      where not exists (
        select 1 from ledger.stores as store_record where store_record.id = watermark.store_id
      )
    `);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
