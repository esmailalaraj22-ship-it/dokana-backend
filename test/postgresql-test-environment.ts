import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

export interface LocalPostgresTestEnvironment {
  runtimeUrl: string;
  adminUrl: string;
  authUrl: string;
  migrationUrl: string;
  ssl: false | { rejectUnauthorized: true };
  databaseName: string;
}

export interface ActiveTestEntitlementFixture {
  subscriptionIds: string[];
  ownedPlanId: string | null;
}

const localHostnames = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function readLocalPostgresTestEnvironment(): LocalPostgresTestEnvironment | undefined {
  const runtimeUrl = process.env.TEST_DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  const authUrl = process.env.AUTH_DATABASE_URL;
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;

  if (
    !runtimeUrl ||
    !adminUrl ||
    !authUrl ||
    !migrationUrl ||
    process.env.APP_ENV === 'production'
  ) {
    return undefined;
  }

  try {
    const parsedRuntime = new URL(runtimeUrl);
    const parsedAdmin = new URL(adminUrl);
    const parsedAuth = new URL(authUrl);
    const parsedMigration = new URL(migrationUrl);
    const urls = [parsedRuntime, parsedAdmin, parsedAuth, parsedMigration];
    const databaseNames = urls.map((url) => decodeURIComponent(url.pathname.slice(1)));

    if (
      urls.some(
        (url) =>
          !['postgres:', 'postgresql:'].includes(url.protocol) || !localHostnames.has(url.hostname),
      ) ||
      databaseNames.some((name) => !name || name !== databaseNames[0])
    ) {
      return undefined;
    }

    return {
      runtimeUrl,
      adminUrl,
      authUrl,
      migrationUrl,
      ssl:
        process.env.TEST_DATABASE_SSL_MODE === 'verify-full' ? { rejectUnauthorized: true } : false,
      databaseName: databaseNames[0] ?? '',
    };
  } catch {
    return undefined;
  }
}

export function createTestPool(
  connectionString: string,
  applicationName: string,
  max = 2,
  options?: string,
): Pool {
  return new Pool({
    connectionString,
    ssl:
      process.env.TEST_DATABASE_SSL_MODE === 'verify-full' ? { rejectUnauthorized: true } : false,
    application_name: applicationName,
    options,
    max,
    connectionTimeoutMillis: 5_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 15_000,
    allowExitOnIdle: true,
  });
}

export async function provisionActiveTestEntitlements(
  pool: Pool,
  storeIds: readonly string[],
): Promise<ActiveTestEntitlementFixture> {
  const plans = await pool.query<{ id: string }>(
    `select id from platform.subscription_plans where status = 'active' order by id`,
  );
  let planId: string;
  let ownedPlanId: string | null = null;
  if (plans.rowCount === 0) {
    planId = randomUUID();
    ownedPlanId = planId;
    await pool.query(
      `insert into platform.subscription_plans (
         id, code, name, duration_days, price_minor, offline_grace_days, status
       ) values ($1, $2, 'Integration Test Entitlement', 365, 0, 0, 'active')`,
      [planId, `integration-${planId}`],
    );
  } else if (plans.rowCount === 1 && plans.rows[0]) {
    planId = plans.rows[0].id;
  } else {
    throw new Error('Integration fixtures require exactly one active Subscription plan.');
  }

  const subscriptionIds: string[] = [];
  for (const storeId of [...new Set(storeIds)]) {
    const existing = await pool.query<{ id: string }>(
      `select id from platform.subscriptions
       where store_id = $1 and status in ('trial', 'active', 'past_due', 'suspended')`,
      [storeId],
    );
    if (existing.rowCount !== 0) continue;
    const subscriptionId = randomUUID();
    await pool.query(
      `insert into platform.subscriptions (
         id, store_id, plan_id, status, starts_at, expires_at
       ) values (
         $1, $2, $3, 'active', clock_timestamp() - interval '1 day',
         clock_timestamp() + interval '365 days'
       )`,
      [subscriptionId, storeId, planId],
    );
    subscriptionIds.push(subscriptionId);
  }
  return { subscriptionIds, ownedPlanId };
}

export async function removeActiveTestEntitlements(
  pool: Pool,
  fixture: ActiveTestEntitlementFixture | undefined,
): Promise<void> {
  if (!fixture) return;
  if (fixture.subscriptionIds.length > 0) {
    await pool.query(`delete from platform.subscriptions where id = any($1::uuid[])`, [
      fixture.subscriptionIds,
    ]);
  }
  if (fixture.ownedPlanId) {
    await pool.query(`delete from platform.subscription_plans where id = $1`, [
      fixture.ownedPlanId,
    ]);
  }
}
