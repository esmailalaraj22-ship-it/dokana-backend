import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const describeWithPostgres = environment ? describe : describe.skip;

interface ChangeEventRow {
  storeSequence: string;
  contractVersion: number;
  entityType: string;
  entityKey: string;
  entityId: string | null;
  payload: Record<string, unknown>;
}

describeWithPostgres('S19 commit-ordered Store change foundation', () => {
  let adminPool: Pool;
  let runtimePool: Pool;
  let poolsInitialized = false;

  const fixture = {
    stores: { a: randomUUID(), b: randomUUID() },
    users: { a: randomUUID(), b: randomUUID() },
    memberships: { a: randomUUID(), b: randomUUID() },
    devices: { a: randomUUID(), b: randomUUID() },
    customers: { a1: randomUUID(), a2: randomUUID(), b1: randomUUID() },
    customerOperations: { a1: randomUUID(), a2: randomUUID(), b1: randomUUID() },
  };

  const storeIds = Object.values(fixture.stores);
  const userIds = Object.values(fixture.users);
  const membershipIds = Object.values(fixture.memberships);
  const customerIds = Object.values(fixture.customers);

  async function setTenantContext(
    client: PoolClient,
    storeId: string,
    userId: string,
    deviceId: string,
  ): Promise<void> {
    await client.query(
      `select
         set_config('app.store_id', $1, true),
         set_config('app.user_id', $2, true),
         set_config('app.device_id', $3, true),
         set_config('app.request_id', $4, true)`,
      [storeId, userId, deviceId, randomUUID()],
    );
  }

  async function removeFixtures(): Promise<void> {
    await adminPool.query(
      `delete from sync.store_change_events_v1 where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await adminPool.query(
      `delete from sync.store_change_watermarks_v1 where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await adminPool.query(`delete from ledger.customers where id = any($1::uuid[])`, [customerIds]);
    await adminPool.query(`delete from ledger.devices where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await adminPool.query(`delete from platform.store_memberships where id = any($1::uuid[])`, [
      membershipIds,
    ]);
    await adminPool.query(`delete from platform.users where id = any($1::uuid[])`, [userIds]);
    await adminPool.query(`delete from ledger.stores where id = any($1::uuid[])`, [storeIds]);
  }

  async function readChangePage(
    storeId: string,
    userId: string,
    deviceId: string,
    afterSequence: string,
    limit: number,
  ): Promise<ChangeEventRow[]> {
    const client = await runtimePool.connect();
    try {
      await client.query('begin');
      await setTenantContext(client, storeId, userId, deviceId);
      const result = await client.query<ChangeEventRow>(
        `select
           store_sequence::text as "storeSequence",
           contract_version as "contractVersion",
           entity_type as "entityType",
           entity_key as "entityKey",
           entity_id as "entityId",
           payload
         from sync.read_store_change_page_v1($1, $2::bigint, $3)`,
        [storeId, afterSequence, limit],
      );
      await client.query('commit');
      return result.rows;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    if (!environment) {
      throw new Error('The approved local PostgreSQL test environment is unavailable.');
    }

    adminPool = createTestPool(
      environment.adminUrl,
      'dokana-s19-commit-order-admin',
      1,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    runtimePool = createTestPool(environment.runtimeUrl, 'dokana-s19-commit-order-runtime', 6);
    poolsInitialized = true;

    const approvedDatabase = await adminPool.query<{
      databaseName: string;
      isSuperuser: boolean;
    }>(`
      select
        current_database() as "databaseName",
        role_state.rolsuper as "isSuperuser"
      from pg_roles as role_state
      where role_state.rolname = current_user
    `);
    if (
      approvedDatabase.rows[0]?.databaseName !== environment.databaseName ||
      !approvedDatabase.rows[0].isSuperuser
    ) {
      throw new Error('The local synchronization fixture database is not approved.');
    }

    await removeFixtures();
    await adminPool.query(
      `insert into ledger.stores(id, name, status)
       values ($1, 'S19 Commit Store A', 'active'), ($2, 'S19 Commit Store B', 'active')`,
      storeIds,
    );
    await adminPool.query(
      `insert into platform.users(id, email, normalized_email, password_hash, full_name, status)
       values
         ($1, $2, $2, 'fixture-not-a-real-password-hash', 'S19 Owner A', 'active'),
         ($3, $4, $4, 'fixture-not-a-real-password-hash', 'S19 Owner B', 'active')`,
      [
        fixture.users.a,
        `s19-${fixture.users.a}@example.invalid`,
        fixture.users.b,
        `s19-${fixture.users.b}@example.invalid`,
      ],
    );
    await adminPool.query(
      `insert into platform.store_memberships(id, store_id, user_id, role, status)
       values
         ($1, $2, $3, 'owner', 'active'),
         ($4, $5, $6, 'owner', 'active')`,
      [
        fixture.memberships.a,
        fixture.stores.a,
        fixture.users.a,
        fixture.memberships.b,
        fixture.stores.b,
        fixture.users.b,
      ],
    );
    await adminPool.query(
      `insert into ledger.devices(
         id, store_id, device_name, platform, installation_id, device_prefix, status
       )
       values
         ($1, $2, 'S19 Device A', 'android', $3, 'S19A', 'active'),
         ($4, $5, 'S19 Device B', 'android', $6, 'S19B', 'active')`,
      [
        fixture.devices.a,
        fixture.stores.a,
        randomUUID(),
        fixture.devices.b,
        fixture.stores.b,
        randomUUID(),
      ],
    );
    await adminPool.query(
      `insert into ledger.customers(
         id, store_id, name, normalized_name, phone, normalized_phone,
         operation_id, device_id, version
       ) values
         ($1, $2, 'S19 Customer A1', 's19 customer a1', '0599000101', '+970599000101', $3, $4, 1),
         ($5, $2, 'S19 Customer A2', 's19 customer a2', '0599000102', '+970599000102', $6, $4, 1),
         ($7, $8, 'S19 Customer B1', 's19 customer b1', '0599000103', '+970599000103', $9, $10, 1)`,
      [
        fixture.customers.a1,
        fixture.stores.a,
        fixture.customerOperations.a1,
        fixture.devices.a,
        fixture.customers.a2,
        fixture.customerOperations.a2,
        fixture.customers.b1,
        fixture.stores.b,
        fixture.customerOperations.b1,
        fixture.devices.b,
      ],
    );
  }, 30_000);

  afterAll(async () => {
    if (!poolsInitialized) {
      return;
    }
    await removeFixtures();
    const residue = await adminPool.query<{ count: number }>(
      `select (
         (select count(*) from sync.store_change_events_v1 where store_id = any($1::uuid[]))
         + (select count(*) from sync.store_change_watermarks_v1 where store_id = any($1::uuid[]))
         + (select count(*) from ledger.customers where id = any($2::uuid[]))
         + (select count(*) from ledger.devices where store_id = any($1::uuid[]))
         + (select count(*) from platform.store_memberships where id = any($3::uuid[]))
         + (select count(*) from platform.users where id = any($4::uuid[]))
         + (select count(*) from ledger.stores where id = any($1::uuid[]))
       )::integer as count`,
      [storeIds, customerIds, membershipIds, userIds],
    );
    expect(residue.rows[0]?.count).toBe(0);
    await Promise.all([runtimePool.end(), adminPool.end()]);
  }, 30_000);

  it('preserves every post-snapshot commit when an older transaction commits later', async () => {
    const first = await runtimePool.connect();
    const second = await runtimePool.connect();
    const bootstrap = await runtimePool.connect();
    try {
      await first.query('begin');
      await setTenantContext(first, fixture.stores.a, fixture.users.a, fixture.devices.a);
      await first.query(
        `update ledger.customers
         set name = 'T1 commits later', normalized_name = 't1 commits later', version = version + 1
         where id = $1`,
        [fixture.customers.a1],
      );

      await second.query('begin');
      await setTenantContext(second, fixture.stores.a, fixture.users.a, fixture.devices.a);
      await second.query(
        `update ledger.customers
         set name = 'T2 commits first', normalized_name = 't2 commits first', version = version + 1
         where id = $1`,
        [fixture.customers.a2],
      );
      await second.query('commit');

      await bootstrap.query('begin isolation level repeatable read read only');
      await setTenantContext(bootstrap, fixture.stores.a, fixture.users.a, fixture.devices.a);
      const boundary = await bootstrap.query<{
        contractVersion: number;
        baseWatermark: string;
        snapshotId: string;
      }>(
        `select
           contract_version as "contractVersion",
           base_watermark::text as "baseWatermark",
           snapshot_id as "snapshotId"
         from sync.read_bootstrap_boundary_v1($1, $2)`,
        [fixture.stores.a, fixture.devices.a],
      );
      expect(boundary.rows[0]).toMatchObject({ contractVersion: 1, baseWatermark: '1' });
      expect(boundary.rows[0]?.snapshotId).toMatch(/^[0-9a-f]{64}$/);

      const beforeLateCommit = await bootstrap.query<{ id: string; name: string }>(
        `select id, name from ledger.customers where id = any($1::uuid[]) order by id`,
        [[fixture.customers.a1, fixture.customers.a2]],
      );
      expect(beforeLateCommit.rows).toEqual(
        expect.arrayContaining([
          { id: fixture.customers.a1, name: 'S19 Customer A1' },
          { id: fixture.customers.a2, name: 'T2 commits first' },
        ]),
      );

      await first.query('commit');

      const afterLateCommit = await bootstrap.query<{ id: string; name: string }>(
        `select id, name from ledger.customers where id = any($1::uuid[]) order by id`,
        [[fixture.customers.a1, fixture.customers.a2]],
      );
      expect(afterLateCommit.rows).toEqual(beforeLateCommit.rows);
      await bootstrap.query('commit');

      const futureChanges = await readChangePage(
        fixture.stores.a,
        fixture.users.a,
        fixture.devices.a,
        boundary.rows[0]?.baseWatermark ?? '0',
        100,
      );
      expect(futureChanges).toHaveLength(1);
      expect(futureChanges[0]).toMatchObject({
        storeSequence: '2',
        contractVersion: 1,
        entityType: 'customer',
        entityKey: fixture.customers.a1,
        entityId: fixture.customers.a1,
        payload: {
          entityKey: fixture.customers.a1,
          id: fixture.customers.a1,
          version: '2',
        },
      });
    } finally {
      await Promise.allSettled([
        first.query('rollback'),
        second.query('rollback'),
        bootstrap.query('rollback'),
      ]);
      first.release();
      second.release();
      bootstrap.release();
    }
  }, 30_000);

  it('pages deterministically, isolates Stores, and exposes only the sanitized v1 contract', async () => {
    const existingStoreAEvents = await readChangePage(
      fixture.stores.a,
      fixture.users.a,
      fixture.devices.a,
      '0',
      100,
    );
    const existingStoreBEvents = await readChangePage(
      fixture.stores.b,
      fixture.users.b,
      fixture.devices.b,
      '0',
      100,
    );
    const storeABaseline = existingStoreAEvents.at(-1)?.storeSequence ?? '0';
    const storeBBaseline = existingStoreBEvents.at(-1)?.storeSequence ?? '0';
    const storeAClient = await runtimePool.connect();
    const storeBClient = await runtimePool.connect();
    try {
      await storeAClient.query('begin');
      await setTenantContext(storeAClient, fixture.stores.a, fixture.users.a, fixture.devices.a);
      await storeAClient.query(
        `update ledger.customers set notes = 'private-a1', version = version + 1 where id = $1`,
        [fixture.customers.a1],
      );
      await storeAClient.query(
        `update ledger.customers set notes = 'private-a2', version = version + 1 where id = $1`,
        [fixture.customers.a2],
      );
      await storeAClient.query('commit');

      await storeBClient.query('begin');
      await setTenantContext(storeBClient, fixture.stores.b, fixture.users.b, fixture.devices.b);
      await storeBClient.query(
        `update ledger.customers set notes = 'private-b1', version = version + 1 where id = $1`,
        [fixture.customers.b1],
      );
      await storeBClient.query('commit');
    } finally {
      await Promise.allSettled([storeAClient.query('rollback'), storeBClient.query('rollback')]);
      storeAClient.release();
      storeBClient.release();
    }

    const firstPage = await readChangePage(
      fixture.stores.a,
      fixture.users.a,
      fixture.devices.a,
      storeABaseline,
      1,
    );
    const replayedFirstPage = await readChangePage(
      fixture.stores.a,
      fixture.users.a,
      fixture.devices.a,
      storeABaseline,
      1,
    );
    expect(replayedFirstPage).toEqual(firstPage);
    expect(firstPage).toHaveLength(1);

    const secondPage = await readChangePage(
      fixture.stores.a,
      fixture.users.a,
      fixture.devices.a,
      firstPage[0]?.storeSequence ?? '0',
      1,
    );
    expect(secondPage).toHaveLength(1);
    expect(BigInt(secondPage[0]?.storeSequence ?? '0')).toBeGreaterThan(
      BigInt(firstPage[0]?.storeSequence ?? '0'),
    );
    for (const event of [...firstPage, ...secondPage]) {
      expect(event.contractVersion).toBe(1);
      expect(event.entityType).toBe('customer');
      expect([fixture.customers.a1, fixture.customers.a2]).toContain(event.entityId);
      expect(Object.keys(event.payload).sort()).toEqual(
        expect.arrayContaining(['entityKey', 'id', 'status', 'version']),
      );
      expect(JSON.stringify(event.payload)).not.toMatch(
        /private-|name|phone|normalized|request_hash|password_hash|token_hash/i,
      );
    }

    const storeBEvents = await readChangePage(
      fixture.stores.b,
      fixture.users.b,
      fixture.devices.b,
      storeBBaseline,
      100,
    );
    expect(storeBEvents).toHaveLength(1);
    expect(storeBEvents[0]?.entityId).toBe(fixture.customers.b1);

    const mismatchedContext = await runtimePool.connect();
    try {
      await mismatchedContext.query('begin');
      await setTenantContext(
        mismatchedContext,
        fixture.stores.a,
        fixture.users.a,
        fixture.devices.a,
      );
      await expect(
        mismatchedContext.query(`select * from sync.read_store_change_page_v1($1, 0, 100)`, [
          fixture.stores.b,
        ]),
      ).rejects.toMatchObject({ code: '22023' });
      await mismatchedContext.query('rollback');
    } finally {
      await mismatchedContext.query('rollback').catch(() => undefined);
      mismatchedContext.release();
    }
  });

  it('enforces forced RLS and the narrow runtime function boundary', async () => {
    const catalog = await adminPool.query<{
      relationName: string;
      rlsEnabled: boolean;
      rlsForced: boolean;
    }>(`
      select
        class.relname as "relationName",
        class.relrowsecurity as "rlsEnabled",
        class.relforcerowsecurity as "rlsForced"
      from pg_class as class
      join pg_namespace as namespace on namespace.oid = class.relnamespace
      where namespace.nspname = 'sync'
        and class.relname in ('store_change_events_v1', 'store_change_watermarks_v1')
      order by class.relname
    `);
    expect(catalog.rows).toEqual([
      { relationName: 'store_change_events_v1', rlsEnabled: true, rlsForced: true },
      { relationName: 'store_change_watermarks_v1', rlsEnabled: true, rlsForced: true },
    ]);

    const grants = await adminPool.query<{
      runtimeEventsSelect: boolean;
      runtimeWatermarkSelect: boolean;
      runtimeBoundaryExecute: boolean;
      runtimePageExecute: boolean;
      runtimeSanitizerExecute: boolean;
      runtimeAllocatorExecute: boolean;
      runtimeCaptureExecute: boolean;
      publicBoundaryExecute: boolean;
      authBoundaryExecute: boolean;
      triggerCount: number;
    }>(`
      select
        has_table_privilege('shop_app_runtime', 'sync.store_change_events_v1', 'SELECT')
          as "runtimeEventsSelect",
        has_table_privilege('shop_app_runtime', 'sync.store_change_watermarks_v1', 'SELECT')
          as "runtimeWatermarkSelect",
        has_function_privilege('shop_app_runtime', 'sync.read_bootstrap_boundary_v1(uuid,uuid)', 'EXECUTE')
          as "runtimeBoundaryExecute",
        has_function_privilege('shop_app_runtime', 'sync.read_store_change_page_v1(uuid,bigint,integer)', 'EXECUTE')
          as "runtimePageExecute",
        has_function_privilege('shop_app_runtime', 'sync.sanitize_bootstrap_record_v1(jsonb)', 'EXECUTE')
          as "runtimeSanitizerExecute",
        has_function_privilege('shop_app_runtime', 'sync.allocate_store_change_sequence_v1(uuid)', 'EXECUTE')
          as "runtimeAllocatorExecute",
        has_function_privilege('shop_app_runtime', 'sync.capture_store_change_v1()', 'EXECUTE')
          as "runtimeCaptureExecute",
        has_function_privilege('public', 'sync.read_bootstrap_boundary_v1(uuid,uuid)', 'EXECUTE')
          as "publicBoundaryExecute",
        has_function_privilege('shop_app_auth', 'sync.read_bootstrap_boundary_v1(uuid,uuid)', 'EXECUTE')
          as "authBoundaryExecute",
        (
          select count(*)::integer
          from pg_trigger
          where tgfoid = 'sync.capture_store_change_v1()'::regprocedure
            and not tgisinternal
            and tgdeferrable
            and tginitdeferred
            and tgenabled = 'O'
        ) as "triggerCount"
    `);
    expect(grants.rows[0]).toEqual({
      runtimeEventsSelect: false,
      runtimeWatermarkSelect: false,
      runtimeBoundaryExecute: true,
      runtimePageExecute: true,
      runtimeSanitizerExecute: true,
      runtimeAllocatorExecute: false,
      runtimeCaptureExecute: false,
      publicBoundaryExecute: false,
      authBoundaryExecute: false,
      triggerCount: 44,
    });

    await expect(
      runtimePool.query(`select * from sync.store_change_events_v1`),
    ).rejects.toMatchObject({ code: '42501' });

    const sanitized = await runtimePool.query<{ value: Record<string, unknown> }>(
      `select sync.sanitize_bootstrap_record_v1(
         '{"amount":9007199254740993,"quantity":1250,"request_hash":"secret","nested":{"token_hash":"secret","value":7}}'::jsonb
       ) as value`,
    );
    expect(sanitized.rows[0]?.value).toEqual({
      amount: '9007199254740993',
      quantity: '1250',
      nested: { value: '7' },
    });
  });
});
