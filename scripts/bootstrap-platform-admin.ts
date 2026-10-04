import type { PoolClient } from 'pg';

import { createMigrationPool, requiredPostgresUrl } from './migrations/migration-database';
import { verifyMigrationSession } from './migrate';

interface BootstrapInput {
  userId: string;
  operationId: string;
  reason: string;
}

function requiredArgument(name: string): string {
  const prefix = `--${name}=`;
  const values = process.argv.slice(2).filter((argument) => argument.startsWith(prefix));
  if (values.length !== 1) {
    throw new Error(`Exactly one ${prefix}<value> argument is required.`);
  }
  const value = values[0]?.slice(prefix.length).trim() ?? '';
  if (value.length === 0) throw new Error(`${name} must not be empty.`);
  return value;
}

function requireUuid(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} must be a UUID.`);
  }
  return value.toLowerCase();
}

export async function bootstrapFirstPlatformAdmin(
  client: PoolClient,
  input: BootstrapInput,
): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 1_000) {
    throw new Error('reason must contain between 1 and 1000 characters.');
  }

  await client.query(
    `select pg_advisory_xact_lock(hashtextextended('dokana:first-platform-admin', 0))`,
  );
  const state = await client.query<{
    targetStatus: string | null;
    assignmentCount: string;
  }>(
    `
      select
        (select status from platform.users where id = $1::uuid) as "targetStatus",
        (select count(*)::text from platform.platform_admin_assignments) as "assignmentCount"
    `,
    [input.userId],
  );
  const current = state.rows[0];
  if (current?.targetStatus !== 'active') {
    throw new Error('The target must be an existing active global user.');
  }
  if (current.assignmentCount !== '0') {
    throw new Error('A Platform Admin assignment already exists; bootstrap is no longer allowed.');
  }

  await client.query(
    `
      insert into platform.platform_admin_assignments (
        user_id,
        status,
        assigned_at,
        assigned_by_user_id,
        updated_at,
        version
      )
      values ($1::uuid, 'active', clock_timestamp(), null, clock_timestamp(), 1)
    `,
    [input.userId],
  );
  await client.query(
    `
      insert into platform.admin_actions (
        admin_user_id,
        store_id,
        action,
        reason,
        request_id,
        metadata,
        occurred_at
      )
      values (
        $1::uuid,
        null,
        'platform_admin_bootstrapped',
        $2::text,
        $3::uuid,
        jsonb_build_object('bootstrap', true, 'targetUserId', $1::text),
        clock_timestamp()
      )
    `,
    [input.userId, reason, input.operationId],
  );
}

async function main(): Promise<void> {
  const input: BootstrapInput = {
    userId: requireUuid(requiredArgument('user-id'), 'user-id'),
    operationId: requireUuid(requiredArgument('operation-id'), 'operation-id'),
    reason: requiredArgument('reason'),
  };
  const pool = createMigrationPool(
    requiredPostgresUrl('DATABASE_MIGRATION_URL'),
    'dokana-platform-admin-bootstrap',
  );
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await verifyMigrationSession(client);
    await client.query('begin');
    transactionStarted = true;
    await client.query('set local role shop_app_migrator');
    await bootstrapFirstPlatformAdmin(client, input);
    await client.query('commit');
    transactionStarted = false;
    process.stdout.write('First Platform Admin bootstrap: OK.\n');
  } catch (error) {
    if (transactionStarted) await client.query('rollback');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown bootstrap failure.';
    process.stderr.write(`First Platform Admin bootstrap: FAIL (${message})\n`);
    process.exitCode = 1;
  });
}
