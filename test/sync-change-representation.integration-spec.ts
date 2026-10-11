import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { bootstrapBusinessDatasets } from '../src/sync/bootstrap-datasets';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const describeWithPostgres = environment ? describe : describe.skip;

interface ChangeRow {
  storeSequence: string;
  representationVersion: number;
  entityType: string;
  entityId: string | null;
  action: string;
  entityVersion: string;
  representation: Record<string, unknown>;
}

const exceptionalEntityTypes: Readonly<Record<string, string>> = {
  app_settings: 'app_settings',
  goods_receipt_items: 'legacy_goods_receipt_item',
  goods_receipts: 'legacy_goods_receipt',
  purchase_invoices: 'supplier_invoice',
  purchase_items: 'supplier_invoice_item',
};

function entityTypeForDataset(datasetId: string): string {
  const exceptional = exceptionalEntityTypes[datasetId];
  if (exceptional) return exceptional;
  if (datasetId.endsWith('_entries')) return `${datasetId.slice(0, -8)}_entry`;
  if (datasetId.endsWith('ies')) return `${datasetId.slice(0, -3)}y`;
  if (datasetId.endsWith('s')) return datasetId.slice(0, -1);
  throw new Error(`S19 dataset has no deterministic entity type: ${datasetId}`);
}

describeWithPostgres('S19 immutable Store change representations', () => {
  let fixturePool: Pool;
  let adminPool: Pool;
  let runtimePool: Pool;
  let poolsInitialized = false;

  const fixture = {
    stores: { a: randomUUID(), b: randomUUID() },
    users: { a: randomUUID(), b: randomUUID() },
    memberships: { a: randomUUID(), b: randomUUID() },
    devices: { a: randomUUID(), b: randomUUID() },
    customers: { a: randomUUID(), b: randomUUID() },
    operations: { a: randomUUID(), b: randomUUID() },
    legacyEvent: randomUUID(),
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

  async function inTenantTransaction<T>(
    storeId: string,
    userId: string,
    deviceId: string,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await runtimePool.connect();
    try {
      await client.query('begin');
      await setTenantContext(client, storeId, userId, deviceId);
      const value = await work(client);
      await client.query('commit');
      return value;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function readPage(
    storeId: string,
    userId: string,
    deviceId: string,
    afterSequence: string,
    limit = 100,
  ): Promise<ChangeRow[]> {
    return inTenantTransaction(storeId, userId, deviceId, async (client) => {
      const result = await client.query<ChangeRow>(
        `select
           store_sequence::text as "storeSequence",
           representation_version as "representationVersion",
           entity_type as "entityType",
           entity_id as "entityId",
           action,
           entity_version::text as "entityVersion",
           representation
         from sync.read_store_change_page_v2($1, $2::bigint, $3)`,
        [storeId, afterSequence, limit],
      );
      return result.rows;
    });
  }

  async function readHead(storeId: string, userId: string, deviceId: string): Promise<string> {
    return inTenantTransaction(storeId, userId, deviceId, async (client) => {
      const result = await client.query<{ head: string }>(
        `select head_sequence::text as head from sync.read_store_change_bounds_v1($1)`,
        [storeId],
      );
      return result.rows[0]?.head ?? '-1';
    });
  }

  async function removeFixtures(): Promise<void> {
    await fixturePool.query(
      `delete from sync.store_change_events_v1 where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await fixturePool.query(
      `delete from sync.store_change_watermarks_v1 where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await fixturePool.query(`delete from ledger.app_settings where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(`delete from ledger.customers where id = any($1::uuid[])`, [
      customerIds,
    ]);
    await fixturePool.query(`delete from ledger.devices where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(`delete from platform.store_memberships where id = any($1::uuid[])`, [
      membershipIds,
    ]);
    await fixturePool.query(`delete from platform.users where id = any($1::uuid[])`, [userIds]);
    await fixturePool.query(`delete from ledger.stores where id = any($1::uuid[])`, [storeIds]);
  }

  beforeAll(async () => {
    if (!environment) {
      throw new Error('The approved local PostgreSQL test environment is unavailable.');
    }

    fixturePool = createTestPool(
      environment.adminUrl,
      'dokana-s19-representation-fixture',
      1,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    adminPool = createTestPool(environment.adminUrl, 'dokana-s19-representation-admin', 2);
    runtimePool = createTestPool(environment.runtimeUrl, 'dokana-s19-representation-runtime', 6);
    poolsInitialized = true;

    const approved = await fixturePool.query<{ databaseName: string; isSuperuser: boolean }>(`
      select current_database() as "databaseName", role_state.rolsuper as "isSuperuser"
      from pg_roles as role_state where role_state.rolname = current_user
    `);
    if (
      approved.rows[0]?.databaseName !== environment.databaseName ||
      !approved.rows[0].isSuperuser
    ) {
      throw new Error('The local synchronization fixture database is not approved.');
    }

    await removeFixtures();
    await fixturePool.query(
      `insert into ledger.stores(id, name, status)
       values ($1, 'S19 Representation A', 'active'), ($2, 'S19 Representation B', 'active')`,
      storeIds,
    );
    await fixturePool.query(
      `insert into platform.users(id, email, normalized_email, password_hash, full_name, status)
       values
         ($1, $2, $2, 'fixture-not-a-real-password-hash', 'Representation Owner A', 'active'),
         ($3, $4, $4, 'fixture-not-a-real-password-hash', 'Representation Owner B', 'active')`,
      [
        fixture.users.a,
        `s19-representation-${fixture.users.a}@example.invalid`,
        fixture.users.b,
        `s19-representation-${fixture.users.b}@example.invalid`,
      ],
    );
    await fixturePool.query(
      `insert into platform.store_memberships(id, store_id, user_id, role, status)
       values ($1, $2, $3, 'owner', 'active'), ($4, $5, $6, 'owner', 'active')`,
      [
        fixture.memberships.a,
        fixture.stores.a,
        fixture.users.a,
        fixture.memberships.b,
        fixture.stores.b,
        fixture.users.b,
      ],
    );
    await fixturePool.query(
      `insert into ledger.devices(
         id, store_id, device_name, platform, installation_id, device_prefix, status
       ) values
         ($1, $2, 'Representation Device A', 'android', $3, 'S19RA', 'active'),
         ($4, $5, 'Representation Device B', 'android', $6, 'S19RB', 'active')`,
      [
        fixture.devices.a,
        fixture.stores.a,
        randomUUID(),
        fixture.devices.b,
        fixture.stores.b,
        randomUUID(),
      ],
    );
    await fixturePool.query(
      `insert into ledger.customers(
         id, store_id, name, normalized_name, phone, normalized_phone, notes,
         operation_id, device_id, version
       ) values
         ($1, $2, 'Original A', 'original a', '0599100001', '+970599100001', 'initial-a', $3, $4, 1),
         ($5, $6, 'Original B', 'original b', '0599100002', '+970599100002', 'initial-b', $7, $8, 1)`,
      [
        fixture.customers.a,
        fixture.stores.a,
        fixture.operations.a,
        fixture.devices.a,
        fixture.customers.b,
        fixture.stores.b,
        fixture.operations.b,
        fixture.devices.b,
      ],
    );
    await fixturePool.query(
      `insert into ledger.app_settings(store_id, export_directory_uri, attachments_directory_uri)
       values ($1, 'file:///server/export', 'file:///server/attachments'),
              ($2, 'file:///server/export-b', 'file:///server/attachments-b')`,
      storeIds,
    );
    await fixturePool.query(
      `insert into sync.store_change_watermarks_v1(
         store_id, last_sequence, minimum_replayable_sequence
       ) values ($1, 1, 1), ($2, 0, 0)`,
      storeIds,
    );
    await fixturePool.query(
      `insert into sync.store_change_events_v1(
         store_id, store_sequence, event_id, entity_type, entity_key, entity_id,
         action, entity_version, device_id, payload, occurred_at
       ) values (
         $1, 1, $2, 'customer', $3::text, $3::uuid, 'update', 1, $4,
         jsonb_build_object('entityKey', $3::text, 'id', $3::text, 'version', '1'),
         clock_timestamp()
       )`,
      [fixture.stores.a, fixture.legacyEvent, fixture.customers.a, fixture.devices.a],
    );
  }, 30_000);

  afterAll(async () => {
    if (!poolsInitialized) return;
    await removeFixtures();
    expect(
      await fixturePool.query(`select to_regclass('ledger.s19_capture_failure_probe') as probe`),
    ).toMatchObject({ rows: [{ probe: null }] });
    const residue = await fixturePool.query<{ count: number }>(
      `select (
         (select count(*) from sync.store_change_events_v1 where store_id = any($1::uuid[]))
         + (select count(*) from sync.store_change_watermarks_v1 where store_id = any($1::uuid[]))
         + (select count(*) from ledger.app_settings where store_id = any($1::uuid[]))
         + (select count(*) from ledger.customers where id = any($2::uuid[]))
         + (select count(*) from ledger.devices where store_id = any($1::uuid[]))
         + (select count(*) from platform.store_memberships where id = any($3::uuid[]))
         + (select count(*) from platform.users where id = any($4::uuid[]))
         + (select count(*) from ledger.stores where id = any($1::uuid[]))
       )::integer as count`,
      [storeIds, customerIds, membershipIds, userIds],
    );
    expect(residue.rows[0]?.count).toBe(0);
    await Promise.all([runtimePool.end(), adminPool.end(), fixturePool.end()]);
  }, 30_000);

  it('requires rebootstrap for pointer-only history and preserves immutable entity versions', async () => {
    await expect(
      readPage(fixture.stores.a, fixture.users.a, fixture.devices.a, '0'),
    ).rejects.toMatchObject({ code: 'P0001', message: 'SYNC_REBOOTSTRAP_REQUIRED' });

    await inTenantTransaction(fixture.stores.a, fixture.users.a, fixture.devices.a, (client) =>
      client.query(
        `update ledger.customers
           set name = 'Version Two', normalized_name = 'version two', notes = 'v2',
               version = version + 1
           where id = $1`,
        [fixture.customers.a],
      ),
    );
    const versionTwo = await readPage(fixture.stores.a, fixture.users.a, fixture.devices.a, '1');
    expect(versionTwo).toHaveLength(1);
    expect(versionTwo[0]).toMatchObject({
      storeSequence: '2',
      representationVersion: 1,
      entityType: 'customer',
      entityId: fixture.customers.a,
      entityVersion: '2',
      representation: {
        id: fixture.customers.a,
        store_id: fixture.stores.a,
        name: 'Version Two',
        normalized_name: 'version two',
        notes: 'v2',
        version: '2',
      },
    });

    await inTenantTransaction(fixture.stores.a, fixture.users.a, fixture.devices.a, (client) =>
      client.query(
        `update ledger.customers
           set name = 'Version Three', normalized_name = 'version three', notes = 'v3',
               version = version + 1
           where id = $1`,
        [fixture.customers.a],
      ),
    );
    const both = await readPage(fixture.stores.a, fixture.users.a, fixture.devices.a, '1');
    expect(both.map((event) => event.representation.name)).toEqual([
      'Version Two',
      'Version Three',
    ]);
    expect(both.map((event) => event.representation.version)).toEqual(['2', '3']);
  });

  it('captures lifecycle and sanitized settings without server-local paths', async () => {
    const baseline = await readHead(fixture.stores.a, fixture.users.a, fixture.devices.a);
    await inTenantTransaction(
      fixture.stores.a,
      fixture.users.a,
      fixture.devices.a,
      async (client) => {
        await client.query(
          `update ledger.customers
           set status = 'archived', archived_at = clock_timestamp(), version = version + 1
           where id = $1`,
          [fixture.customers.a],
        );
        await client.query(
          `update ledger.customers
           set status = 'active', archived_at = null, version = version + 1
           where id = $1`,
          [fixture.customers.a],
        );
        await client.query(
          `update ledger.app_settings
           set default_credit_limit_minor = 9007199254740993,
               export_directory_uri = 'file:///must-not-sync',
               attachments_directory_uri = 'file:///must-not-sync-either',
               version = version + 1,
               updated_at = clock_timestamp()
           where store_id = $1`,
          [fixture.stores.a],
        );
      },
    );
    const events = await readPage(fixture.stores.a, fixture.users.a, fixture.devices.a, baseline);
    expect(events.map((event) => event.action)).toEqual(['archive', 'restore', 'update']);
    expect(events[0]?.representation).toMatchObject({ status: 'archived' });
    expect(events[1]?.representation).toMatchObject({ status: 'active', archived_at: null });
    expect(events[2]?.representation).toMatchObject({
      default_credit_limit_minor: '9007199254740993',
    });
    expect(events[2]?.representation).not.toHaveProperty('export_directory_uri');
    expect(events[2]?.representation).not.toHaveProperty('attachments_directory_uri');
    expect(JSON.stringify(events)).not.toMatch(/request_hash|password_hash|token_hash/i);
  });

  it('rolls back changes and refuses a mutation when required capture fails', async () => {
    const before = await readHead(fixture.stores.a, fixture.users.a, fixture.devices.a);
    const runtime = await runtimePool.connect();
    try {
      await runtime.query('begin');
      await setTenantContext(runtime, fixture.stores.a, fixture.users.a, fixture.devices.a);
      await runtime.query(
        `update ledger.customers set notes = 'must-roll-back', version = version + 1 where id = $1`,
        [fixture.customers.a],
      );
      await runtime.query('rollback');
    } finally {
      await runtime.query('rollback').catch(() => undefined);
      runtime.release();
    }
    expect(await readHead(fixture.stores.a, fixture.users.a, fixture.devices.a)).toBe(before);

    const admin = await adminPool.connect();
    try {
      await admin.query('begin');
      await admin.query(`
        create table ledger.s19_capture_failure_probe (
          id uuid primary key,
          store_id uuid not null,
          version bigint not null default 1,
          created_at timestamptz not null default clock_timestamp()
        )
      `);
      await admin.query(`
        create constraint trigger trg_s19_capture_failure_probe
        after insert or update on ledger.s19_capture_failure_probe
        deferrable initially deferred for each row
        execute function sync.capture_store_change_v1()
      `);
      await admin.query(
        `insert into ledger.s19_capture_failure_probe(id, store_id) values ($1, $2)`,
        [randomUUID(), fixture.stores.a],
      );
      await expect(admin.query('commit')).rejects.toMatchObject({ code: '55000' });
      await admin.query('rollback').catch(() => undefined);
    } finally {
      await admin.query('rollback').catch(() => undefined);
      admin.release();
    }
    const probe = await adminPool.query<{ probe: string | null }>(
      `select to_regclass('ledger.s19_capture_failure_probe')::text as probe`,
    );
    expect(probe.rows[0]?.probe).toBeNull();
    expect(await readHead(fixture.stores.a, fixture.users.a, fixture.devices.a)).toBe(before);
  });

  it('keeps Stores isolated and keeps server-only platform rows out of the client stream', async () => {
    const aBefore = await readHead(fixture.stores.a, fixture.users.a, fixture.devices.a);
    const bBefore = await readHead(fixture.stores.b, fixture.users.b, fixture.devices.b);
    await inTenantTransaction(fixture.stores.b, fixture.users.b, fixture.devices.b, (client) =>
      client.query(
        `update ledger.customers
           set notes = 'store-b-only', version = version + 1 where id = $1`,
        [fixture.customers.b],
      ),
    );
    expect(await readPage(fixture.stores.a, fixture.users.a, fixture.devices.a, aBefore)).toEqual(
      [],
    );
    const storeB = await readPage(fixture.stores.b, fixture.users.b, fixture.devices.b, bBefore);
    expect(storeB).toHaveLength(1);
    expect(storeB[0]?.entityId).toBe(fixture.customers.b);

    const platformHead = await readHead(fixture.stores.a, fixture.users.a, fixture.devices.a);
    await adminPool.query(
      `update platform.store_memberships set version = version + 1 where id = $1`,
      [fixture.memberships.a],
    );
    expect(await readHead(fixture.stores.a, fixture.users.a, fixture.devices.a)).toBe(platformHead);
  });

  it('returns a safe post-bootstrap first change and preserves retry delivery', async () => {
    const bootstrap = await runtimePool.connect();
    let base = '-1';
    try {
      await bootstrap.query('begin isolation level repeatable read read only');
      await setTenantContext(bootstrap, fixture.stores.a, fixture.users.a, fixture.devices.a);
      const boundary = await bootstrap.query<{ base: string }>(
        `select base_watermark::text as base
         from sync.read_bootstrap_boundary_v1($1, $2)`,
        [fixture.stores.a, fixture.devices.a],
      );
      base = boundary.rows[0]?.base ?? '-1';
      await bootstrap.query('commit');
    } finally {
      await bootstrap.query('rollback').catch(() => undefined);
      bootstrap.release();
    }

    await inTenantTransaction(fixture.stores.a, fixture.users.a, fixture.devices.a, (client) =>
      client.query(
        `update ledger.customers set notes = 'after-bootstrap', version = version + 1 where id = $1`,
        [fixture.customers.a],
      ),
    );
    const first = await readPage(fixture.stores.a, fixture.users.a, fixture.devices.a, base, 1);
    const retry = await readPage(fixture.stores.a, fixture.users.a, fixture.devices.a, base, 1);
    expect(first).toHaveLength(1);
    expect(retry).toEqual(first);
    expect(BigInt(first[0]?.storeSequence ?? '0')).toBe(BigInt(base) + 1n);
  });

  it('uses a writer-blocking cutover lock and retains narrow forced-RLS authority', async () => {
    const writer = await runtimePool.connect();
    const locker = await adminPool.connect();
    try {
      await writer.query('begin');
      await setTenantContext(writer, fixture.stores.a, fixture.users.a, fixture.devices.a);
      await writer.query(
        `update ledger.customers set notes = 'cutover-lock-proof', version = version + 1 where id = $1`,
        [fixture.customers.a],
      );

      await locker.query('begin');
      await locker.query(`set local statement_timeout = '250ms'`);
      await expect(
        locker.query(`lock table ledger.customers in share row exclusive mode`),
      ).rejects.toMatchObject({ code: '57014' });
      await locker.query('rollback');
      await writer.query('commit');

      await locker.query('begin');
      await locker.query(`lock table ledger.customers in share row exclusive mode`);
      await locker.query('rollback');
    } finally {
      await Promise.allSettled([writer.query('rollback'), locker.query('rollback')]);
      writer.release();
      locker.release();
    }

    const security = await adminPool.query<{
      eventsRls: boolean;
      eventsForced: boolean;
      watermarksRls: boolean;
      watermarksForced: boolean;
      runtimeLegacy: boolean;
      runtimeBounds: boolean;
      runtimePage: boolean;
      runtimeEventsSelect: boolean;
      publicPage: boolean;
      authPage: boolean;
    }>(`
      select
        events.relrowsecurity as "eventsRls",
        events.relforcerowsecurity as "eventsForced",
        watermarks.relrowsecurity as "watermarksRls",
        watermarks.relforcerowsecurity as "watermarksForced",
        has_function_privilege('shop_app_runtime', 'sync.read_store_change_page_v1(uuid,bigint,integer)', 'EXECUTE') as "runtimeLegacy",
        has_function_privilege('shop_app_runtime', 'sync.read_store_change_bounds_v1(uuid)', 'EXECUTE') as "runtimeBounds",
        has_function_privilege('shop_app_runtime', 'sync.read_store_change_page_v2(uuid,bigint,integer)', 'EXECUTE') as "runtimePage",
        has_table_privilege('shop_app_runtime', 'sync.store_change_events_v1', 'SELECT') as "runtimeEventsSelect",
        has_function_privilege('public', 'sync.read_store_change_page_v2(uuid,bigint,integer)', 'EXECUTE') as "publicPage",
        has_function_privilege('shop_app_auth', 'sync.read_store_change_page_v2(uuid,bigint,integer)', 'EXECUTE') as "authPage"
      from pg_class as events
      cross join pg_class as watermarks
      where events.oid = 'sync.store_change_events_v1'::regclass
        and watermarks.oid = 'sync.store_change_watermarks_v1'::regclass
    `);
    expect(security.rows[0]).toEqual({
      eventsRls: true,
      eventsForced: true,
      watermarksRls: true,
      watermarksForced: true,
      runtimeLegacy: false,
      runtimeBounds: true,
      runtimePage: true,
      runtimeEventsSelect: false,
      publicPage: false,
      authPage: false,
    });
  });

  it('covers every mutable bootstrap relation with one deferred publisher and matching shape', async () => {
    const relations = bootstrapBusinessDatasets.map((dataset) => dataset.relation);
    const publishers = await adminPool.query<{ relation: string; count: number }>(
      `select
         namespace.nspname || '.' || relation.relname as relation,
         count(trigger.oid)::integer as count
       from pg_class as relation
       join pg_namespace as namespace on namespace.oid = relation.relnamespace
       left join pg_trigger as trigger
         on trigger.tgrelid = relation.oid
        and trigger.tgfoid = 'sync.capture_store_change_v1()'::regprocedure
        and not trigger.tgisinternal
        and trigger.tgenabled = 'O'
        and trigger.tgdeferrable
        and trigger.tginitdeferred
       where namespace.nspname || '.' || relation.relname = any($1::text[])
       group by namespace.nspname, relation.relname
       order by relation`,
      [relations],
    );
    expect(publishers.rows).toHaveLength(bootstrapBusinessDatasets.length);
    expect(publishers.rows.every((row) => row.count === 1)).toBe(true);

    for (const dataset of bootstrapBusinessDatasets) {
      const [schemaName, relationName] = dataset.relation.split('.');
      if (!schemaName || !relationName) throw new Error('Invalid bootstrap relation.');
      const shape = await adminPool.query<{
        columns: string[];
        representation: Record<string, unknown>;
      }>(
        `with relation_shape as (
           select
             array_agg(column_name::text order by ordinal_position)::text[] as columns,
             jsonb_object_agg(column_name, to_jsonb(null::text)) as row_shape
           from information_schema.columns
           where table_schema = $1 and table_name = $2
         )
         select
           columns,
           sync.build_change_representation_v1($3, row_shape) as representation
         from relation_shape`,
        [schemaName, relationName, entityTypeForDataset(dataset.id)],
      );
      const row = shape.rows[0];
      if (!row) throw new Error(`Missing relation shape for ${dataset.relation}.`);
      const omitted = new Set(dataset.omittedFields ?? []);
      const expectedFields = row.columns.filter((column) => !omitted.has(column)).sort();
      expect(Object.keys(row.representation).sort()).toEqual(expectedFields);
    }
  });
});
