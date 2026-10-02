import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { getTableConfig } from 'drizzle-orm/pg-core';
import type { Pool, PoolClient } from 'pg';

import {
  adminActions,
  licenseIssuances,
  platformAdminAssignments,
  subscriptionPlans,
  subscriptions,
} from '../src/database/schema';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();

const fixture = {
  store: randomUUID(),
  otherStore: randomUUID(),
  platformAdmin: randomUUID(),
  owner: randomUUID(),
  manager: randomUUID(),
  ordinary: randomUUID(),
  plan: randomUUID(),
  subscription: randomUUID(),
};

interface EntitlementRow {
  checkedAt: Date;
  storeId: string;
  storeStatus: string;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  entitlementStartsAt: Date | null;
  entitlementEndsAt: Date | null;
  effectiveAccess: string;
  writeEligible: boolean;
  denialReason: string | null;
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

async function expectPostgresError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected PostgreSQL error ${code}.`);
  } catch (error) {
    expect(postgresErrorCode(error)).toBe(code);
  }
}

describe('S18.3 Platform Admin and effective-entitlement foundation', () => {
  let adminPool: Pool;
  let fixturePool: Pool;
  let runtimePool: Pool;

  async function setTenantContext(
    client: PoolClient,
    storeId: string,
    userId: string,
  ): Promise<void> {
    await client.query(`select set_config('app.store_id', $1, true)`, [storeId]);
    await client.query(`select set_config('app.user_id', $1, true)`, [userId]);
    await client.query(`select set_config('app.device_id', $1, true)`, [randomUUID()]);
    await client.query(`select set_config('app.request_id', $1, true)`, [randomUUID()]);
  }

  async function currentActorIsPlatformAdmin(storeId: string, userId: string): Promise<boolean> {
    const client = await runtimePool.connect();
    try {
      await client.query('begin');
      await setTenantContext(client, storeId, userId);
      const result = await client.query<{ authorized: boolean }>(
        `select ledger.current_actor_is_platform_admin() as authorized`,
      );
      await client.query('rollback');
      return result.rows[0]?.authorized === true;
    } finally {
      client.release();
    }
  }

  async function readEntitlement(
    storeId = fixture.store,
    userId = fixture.owner,
  ): Promise<EntitlementRow> {
    const client = await runtimePool.connect();
    try {
      await client.query('begin');
      await setTenantContext(client, storeId, userId);
      const result = await client.query<EntitlementRow>(
        `
          select
            checked_at as "checkedAt",
            store_id as "storeId",
            store_status as "storeStatus",
            subscription_id as "subscriptionId",
            subscription_status as "subscriptionStatus",
            entitlement_starts_at as "entitlementStartsAt",
            entitlement_ends_at as "entitlementEndsAt",
            effective_access as "effectiveAccess",
            write_eligible as "writeEligible",
            denial_reason as "denialReason"
          from ledger.lock_effective_entitlement($1)
        `,
        [storeId],
      );
      await client.query('rollback');
      const row = result.rows[0];
      if (!row) throw new Error('Expected an effective-entitlement result.');
      return row;
    } finally {
      client.release();
    }
  }

  async function insertSubscription(
    status: 'active' | 'expired' | 'cancelled',
    startsAt: Date,
    expiresAt: Date,
  ): Promise<void> {
    await fixturePool.query(
      `
        insert into platform.subscriptions (
          id, store_id, plan_id, status, starts_at, expires_at
        ) values ($1, $2, $3, $4, $5, $6)
      `,
      [fixture.subscription, fixture.store, fixture.plan, status, startsAt, expiresAt],
    );
  }

  async function clearTransientState(): Promise<void> {
    await fixturePool.query(`delete from platform.admin_actions where store_id = any($1::uuid[])`, [
      [fixture.store, fixture.otherStore],
    ]);
    await fixturePool.query(`delete from platform.subscriptions where store_id = $1`, [
      fixture.store,
    ]);
    await fixturePool.query(
      `
        update ledger.stores
        set status = 'active'
        where id = any($1::uuid[])
      `,
      [[fixture.store, fixture.otherStore]],
    );
    await fixturePool.query(
      `
        update platform.platform_admin_assignments
        set status = 'active', revoked_at = null, revoked_by_user_id = null,
            revoke_reason = null, updated_at = clock_timestamp(), version = version + 1
        where user_id = $1
      `,
      [fixture.platformAdmin],
    );
  }

  async function removeFixtures(): Promise<void> {
    await fixturePool.query(`delete from platform.admin_actions where store_id = any($1::uuid[])`, [
      [fixture.store, fixture.otherStore],
    ]);
    await fixturePool.query(`delete from platform.subscriptions where store_id = $1`, [
      fixture.store,
    ]);
    await fixturePool.query(`delete from platform.platform_admin_assignments where user_id = $1`, [
      fixture.platformAdmin,
    ]);
    await fixturePool.query(
      `delete from platform.store_memberships where store_id = any($1::uuid[])`,
      [[fixture.store, fixture.otherStore]],
    );
    await fixturePool.query(`delete from platform.subscription_plans where id = $1`, [
      fixture.plan,
    ]);
    await fixturePool.query(`delete from platform.users where id = any($1::uuid[])`, [
      [fixture.platformAdmin, fixture.owner, fixture.manager, fixture.ordinary],
    ]);
    await fixturePool.query(`delete from ledger.stores where id = any($1::uuid[])`, [
      [fixture.store, fixture.otherStore],
    ]);
  }

  beforeAll(async () => {
    if (!environment) {
      throw new Error('The approved local PostgreSQL verification environment is unavailable.');
    }

    adminPool = createTestPool(environment.adminUrl, 'dokana-s18-platform-admin', 3);
    fixturePool = createTestPool(
      environment.adminUrl,
      'dokana-s18-platform-fixture',
      1,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    runtimePool = createTestPool(environment.runtimeUrl, 'dokana-s18-platform-runtime', 3);

    await removeFixtures();
    await fixturePool.query(
      `
        insert into ledger.stores (id, name, status)
        values ($1, 'S18 Store', 'active'), ($2, 'S18 Other Store', 'active')
      `,
      [fixture.store, fixture.otherStore],
    );
    await fixturePool.query(
      `
        insert into platform.users (
          id, email, normalized_email, password_hash, full_name, status
        ) values
          ($1, $5, $5, 'not-used', 'Platform Admin', 'active'),
          ($2, $6, $6, 'not-used', 'Store Owner', 'active'),
          ($3, $7, $7, 'not-used', 'Store Manager', 'active'),
          ($4, $8, $8, 'not-used', 'Ordinary User', 'active')
      `,
      [
        fixture.platformAdmin,
        fixture.owner,
        fixture.manager,
        fixture.ordinary,
        `platform-admin-${fixture.platformAdmin}@example.test`,
        `owner-${fixture.owner}@example.test`,
        `manager-${fixture.manager}@example.test`,
        `ordinary-${fixture.ordinary}@example.test`,
      ],
    );
    await fixturePool.query(
      `
        insert into platform.store_memberships (store_id, user_id, role, status)
        values ($1, $2, 'owner', 'active'), ($1, $3, 'manager', 'active')
      `,
      [fixture.store, fixture.owner, fixture.manager],
    );
    await fixturePool.query(
      `
        insert into platform.platform_admin_assignments (user_id, status)
        values ($1, 'active')
      `,
      [fixture.platformAdmin],
    );
    await fixturePool.query(
      `
        insert into platform.subscription_plans (
          id, code, name, duration_days, price_minor, offline_grace_days, status
        ) values ($1, $2, 'Dokana MVP', 30, 0, 0, 'active')
      `,
      [fixture.plan, `s18-${fixture.plan}`],
    );
  }, 30_000);

  beforeEach(async () => {
    await clearTransientState();
  });

  afterAll(async () => {
    await removeFixtures();
    await Promise.all([adminPool.end(), fixturePool.end(), runtimePool.end()]);
  });

  it('maps the existing S18 platform tables and the new assignment table exactly by column', async () => {
    const mappedTables = [
      subscriptionPlans,
      subscriptions,
      licenseIssuances,
      adminActions,
      platformAdminAssignments,
    ];

    for (const table of mappedTables) {
      const config = getTableConfig(table);
      const live = await adminPool.query<{ columnName: string }>(
        `
          select column_name as "columnName"
          from information_schema.columns
          where table_schema = 'platform' and table_name = $1
          order by ordinal_position
        `,
        [config.name],
      );
      expect(live.rows.map((row) => row.columnName)).toEqual(
        config.columns.map((column) => column.name),
      );
    }
  });

  it('authorizes only an active durable Platform Admin assignment', async () => {
    await expect(currentActorIsPlatformAdmin(fixture.store, fixture.platformAdmin)).resolves.toBe(
      true,
    );
    await expect(currentActorIsPlatformAdmin(fixture.store, fixture.owner)).resolves.toBe(false);
    await expect(currentActorIsPlatformAdmin(fixture.store, fixture.manager)).resolves.toBe(false);
    await expect(currentActorIsPlatformAdmin(fixture.store, fixture.ordinary)).resolves.toBe(false);

    await fixturePool.query(
      `
        update platform.platform_admin_assignments
        set status = 'revoked', revoked_at = clock_timestamp(), revoked_by_user_id = $1,
            revoke_reason = 'S18 fixture revocation', updated_at = clock_timestamp(),
            version = version + 1
        where user_id = $1
      `,
      [fixture.platformAdmin],
    );
    await expect(currentActorIsPlatformAdmin(fixture.store, fixture.platformAdmin)).resolves.toBe(
      false,
    );
  });

  it('prevents runtime self-promotion and keeps platform tables outside runtime authority', async () => {
    await expectPostgresError(
      runtimePool.query(`insert into platform.platform_admin_assignments (user_id) values ($1)`, [
        fixture.owner,
      ]),
      '42501',
    );

    const privileges = await adminPool.query<{
      assignmentSelect: boolean;
      assignmentInsert: boolean;
      subscriptionSelect: boolean;
      platformUsage: boolean;
    }>(`
      select
        has_table_privilege('shop_app_runtime', 'platform.platform_admin_assignments', 'SELECT')
          as "assignmentSelect",
        has_table_privilege('shop_app_runtime', 'platform.platform_admin_assignments', 'INSERT')
          as "assignmentInsert",
        has_table_privilege('shop_app_runtime', 'platform.subscriptions', 'SELECT')
          as "subscriptionSelect",
        has_schema_privilege('shop_app_runtime', 'platform', 'USAGE') as "platformUsage"
    `);
    expect(privileges.rows[0]).toEqual({
      assignmentSelect: false,
      assignmentInsert: false,
      subscriptionSelect: false,
      platformUsage: false,
    });
  });

  it('exposes only the two narrow functions and preserves the cross-Store accounting firewall', async () => {
    const grants = await adminPool.query<{
      signature: string;
      publicExecute: boolean;
      runtimeExecute: boolean;
      authOwnerExecute: boolean;
    }>(`
      select
        routine.oid::regprocedure::text as signature,
        exists (
          select 1 from aclexplode(coalesce(routine.proacl, acldefault('f', routine.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute",
        has_function_privilege('shop_app_runtime', routine.oid, 'EXECUTE') as "runtimeExecute",
        has_function_privilege('shop_app_auth_owner', routine.oid, 'EXECUTE')
          as "authOwnerExecute"
      from pg_proc routine
      where routine.oid in (
        'ledger.current_actor_is_platform_admin()'::regprocedure,
        'ledger.lock_effective_entitlement(uuid)'::regprocedure
      )
      order by signature
    `);
    expect(grants.rows).toHaveLength(2);
    expect(grants.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          publicExecute: false,
          runtimeExecute: true,
          authOwnerExecute: true,
        }),
      ]),
    );

    const client = await runtimePool.connect();
    try {
      await client.query('begin');
      await setTenantContext(client, fixture.store, fixture.platformAdmin);
      const crossStore = await client.query(
        `update ledger.stores set name = name where id = $1 returning id`,
        [fixture.otherStore],
      );
      expect(crossStore.rowCount).toBe(0);
      await expectPostgresError(
        client.query(`select * from ledger.lock_effective_entitlement($1)`, [fixture.otherStore]),
        '42501',
      );
      await client.query('rollback');
    } finally {
      client.release();
    }
  });

  it('makes existing administrative audit rows immutable and requires meaningful audit data', async () => {
    const auditId = randomUUID();
    await adminPool.query(
      `
        insert into platform.admin_actions (
          id, admin_user_id, store_id, action, reason, request_id, metadata
        ) values ($1, $2, $3, 'platform_admin_fixture', 'S18 immutable audit test', $4, '{}')
      `,
      [auditId, fixture.platformAdmin, fixture.store, randomUUID()],
    );
    await expectPostgresError(
      adminPool.query(`update platform.admin_actions set reason = 'changed' where id = $1`, [
        auditId,
      ]),
      '55000',
    );
    await expectPostgresError(
      adminPool.query(`delete from platform.admin_actions where id = $1`, [auditId]),
      '55000',
    );
    await expectPostgresError(
      adminPool.query(
        `insert into platform.admin_actions (admin_user_id, action, reason) values ($1, 'x', ' ')`,
        [fixture.platformAdmin],
      ),
      '23514',
    );
  });

  it('allows writes only for an active Store with a currently valid active Subscription', async () => {
    const now = Date.now();
    await insertSubscription('active', new Date(now - 60_000), new Date(now + 3_600_000));
    await expect(readEntitlement()).resolves.toMatchObject({
      storeId: fixture.store,
      storeStatus: 'active',
      subscriptionId: fixture.subscription,
      subscriptionStatus: 'active',
      effectiveAccess: 'write',
      writeEligible: true,
      denialReason: null,
    });
  });

  it.each([
    ['expired', 'expired', -7_200_000, -3_600_000, 'subscription_inactive'],
    ['cancelled', 'cancelled', -60_000, 3_600_000, 'subscription_cancelled'],
  ] as const)(
    'makes an active Store read-only for %s entitlement',
    async (_label, status, startOffset, endOffset, reason) => {
      const now = Date.now();
      await insertSubscription(status, new Date(now + startOffset), new Date(now + endOffset));
      await expect(readEntitlement()).resolves.toMatchObject({
        effectiveAccess: 'read_only',
        writeEligible: false,
        denialReason: reason,
      });
    },
  );

  it('makes missing and future entitlements read-only', async () => {
    await expect(readEntitlement()).resolves.toMatchObject({
      subscriptionId: null,
      effectiveAccess: 'read_only',
      writeEligible: false,
      denialReason: 'subscription_missing',
    });

    const now = Date.now();
    await insertSubscription('active', new Date(now + 3_600_000), new Date(now + 7_200_000));
    await expect(readEntitlement()).resolves.toMatchObject({
      effectiveAccess: 'read_only',
      writeEligible: false,
      denialReason: 'subscription_not_started',
    });
  });

  it.each([
    ['read_only', 'read_only', 'store_read_only'],
    ['suspended', 'blocked', 'store_suspended'],
    ['archived', 'blocked', 'store_archived'],
  ] as const)(
    'preserves the stronger %s Store restriction despite valid entitlement',
    async (storeStatus, effectiveAccess, denialReason) => {
      const now = Date.now();
      await insertSubscription('active', new Date(now - 60_000), new Date(now + 3_600_000));
      await fixturePool.query(`update ledger.stores set status = $2 where id = $1`, [
        fixture.store,
        storeStatus,
      ]);
      await expect(readEntitlement()).resolves.toMatchObject({
        storeStatus,
        effectiveAccess,
        writeEligible: false,
        denialReason,
      });
    },
  );

  it('uses server time, rejects the exact end boundary, and accepts no client time argument', async () => {
    await fixturePool.query(
      `
        insert into platform.subscriptions (
          id, store_id, plan_id, status, starts_at, expires_at
        ) values ($1, $2, $3, 'active', clock_timestamp() - interval '1 hour', clock_timestamp())
      `,
      [fixture.subscription, fixture.store, fixture.plan],
    );

    const client = await runtimePool.connect();
    try {
      await client.query('begin');
      await setTenantContext(client, fixture.store, fixture.owner);
      await client.query(`select set_config('app.client_time', '2099-01-01T00:00:00Z', true)`);
      const before = await client.query<{ now: Date }>(`select clock_timestamp() as now`);
      const result = await client.query<EntitlementRow>(
        `
        select
          checked_at as "checkedAt",
          effective_access as "effectiveAccess",
          write_eligible as "writeEligible",
          denial_reason as "denialReason"
        from ledger.lock_effective_entitlement($1)
      `,
        [fixture.store],
      );
      const after = await client.query<{ now: Date }>(`select clock_timestamp() as now`);
      expect(result.rows[0]).toMatchObject({
        effectiveAccess: 'read_only',
        writeEligible: false,
        denialReason: 'subscription_expired',
      });
      expect(result.rows[0]?.checkedAt.getTime()).toBeGreaterThanOrEqual(
        before.rows[0]?.now.getTime() ?? Number.POSITIVE_INFINITY,
      );
      expect(result.rows[0]?.checkedAt.getTime()).toBeLessThanOrEqual(
        after.rows[0]?.now.getTime() ?? Number.NEGATIVE_INFINITY,
      );
      await client.query('rollback');
    } finally {
      client.release();
    }

    const signature = await adminPool.query<{ arguments: string }>(`
      select pg_get_function_identity_arguments(
        'ledger.lock_effective_entitlement(uuid)'::regprocedure
      ) as arguments
    `);
    expect(signature.rows[0]?.arguments).toBe('p_store_id uuid');
  });

  it('serializes an entitlement check against concurrent Subscription cancellation', async () => {
    const now = Date.now();
    await insertSubscription('active', new Date(now - 60_000), new Date(now + 3_600_000));
    const protectedClient = await runtimePool.connect();
    const mutationClient = await adminPool.connect();
    let mutationSettled = false;
    try {
      await protectedClient.query('begin');
      await setTenantContext(protectedClient, fixture.store, fixture.owner);
      const authority = await protectedClient.query<{ writeEligible: boolean }>(
        `select write_eligible as "writeEligible" from ledger.lock_effective_entitlement($1)`,
        [fixture.store],
      );
      expect(authority.rows[0]?.writeEligible).toBe(true);

      await mutationClient.query('begin');
      await mutationClient.query(`set local lock_timeout = '3s'`);
      const mutation = mutationClient
        .query(`update platform.subscriptions set status = 'cancelled' where id = $1`, [
          fixture.subscription,
        ])
        .then(() => {
          mutationSettled = true;
        });
      await delay(150);
      expect(mutationSettled).toBe(false);
      await protectedClient.query('commit');
      await mutation;
      await mutationClient.query('commit');
      await expect(readEntitlement()).resolves.toMatchObject({
        writeEligible: false,
        denialReason: 'subscription_cancelled',
      });
    } finally {
      await protectedClient.query('rollback').catch(() => undefined);
      await mutationClient.query('rollback').catch(() => undefined);
      protectedClient.release();
      mutationClient.release();
    }
  });

  it('serializes an entitlement check against concurrent Store suspension', async () => {
    const now = Date.now();
    await insertSubscription('active', new Date(now - 60_000), new Date(now + 3_600_000));
    const protectedClient = await runtimePool.connect();
    const mutationClient = await adminPool.connect();
    let mutationSettled = false;
    try {
      await protectedClient.query('begin');
      await setTenantContext(protectedClient, fixture.store, fixture.owner);
      const authority = await protectedClient.query<{ writeEligible: boolean }>(
        `select write_eligible as "writeEligible" from ledger.lock_effective_entitlement($1)`,
        [fixture.store],
      );
      expect(authority.rows[0]?.writeEligible).toBe(true);

      await mutationClient.query('begin');
      await mutationClient.query(`set local session_replication_role = replica`);
      await mutationClient.query(`set local lock_timeout = '3s'`);
      const mutation = mutationClient
        .query(`update ledger.stores set status = 'suspended' where id = $1`, [fixture.store])
        .then(() => {
          mutationSettled = true;
        });
      await delay(150);
      expect(mutationSettled).toBe(false);
      await protectedClient.query('commit');
      await mutation;
      await mutationClient.query('commit');
      await expect(readEntitlement()).resolves.toMatchObject({
        storeStatus: 'suspended',
        effectiveAccess: 'blocked',
        writeEligible: false,
        denialReason: 'store_suspended',
      });
    } finally {
      await protectedClient.query('rollback').catch(() => undefined);
      await mutationClient.query('rollback').catch(() => undefined);
      protectedClient.release();
      mutationClient.release();
    }
  });
});
