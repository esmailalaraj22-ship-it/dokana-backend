import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const fixture = {
  stores: {
    a: 'a4100000-0000-4000-8000-000000000001',
    b: 'a4100000-0000-4000-8000-000000000002',
  },
  users: {
    ownerA: 'a4200000-0000-4000-8000-000000000001',
    managerA: 'a4200000-0000-4000-8000-000000000002',
    ownerB: 'a4200000-0000-4000-8000-000000000003',
  },
  memberships: {
    ownerA: 'a4300000-0000-4000-8000-000000000001',
    managerA: 'a4300000-0000-4000-8000-000000000002',
    ownerB: 'a4300000-0000-4000-8000-000000000003',
  },
  devices: {
    ownerA: 'a4400000-0000-4000-8000-000000000001',
    managerA: 'a4400000-0000-4000-8000-000000000002',
    ownerB: 'a4400000-0000-4000-8000-000000000003',
  },
  parents: {
    a: 'a4500000-0000-4000-8000-000000000001',
    b: 'a4500000-0000-4000-8000-000000000002',
  },
};

interface RuntimeIdentity {
  storeId: string;
  userId: string;
  deviceId: string;
}

const ownerA: RuntimeIdentity = {
  storeId: fixture.stores.a,
  userId: fixture.users.ownerA,
  deviceId: fixture.devices.ownerA,
};
const managerA: RuntimeIdentity = {
  storeId: fixture.stores.a,
  userId: fixture.users.managerA,
  deviceId: fixture.devices.managerA,
};
const ownerB: RuntimeIdentity = {
  storeId: fixture.stores.b,
  userId: fixture.users.ownerB,
  deviceId: fixture.devices.ownerB,
};

describe('attachment lifecycle and sanitized audit authority with real PostgreSQL', () => {
  let fixturePool: Pool;
  let runtimePool: Pool;
  let poolsInitialized = false;

  async function removeFixtures(): Promise<void> {
    const storeIds = Object.values(fixture.stores);
    const userIds = Object.values(fixture.users);
    await fixturePool.query(`delete from audit.central_audit_logs where store_id=any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(`delete from ledger.attachments where store_id=any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(`delete from ledger.devices where store_id=any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(
      `delete from platform.store_memberships where store_id=any($1::uuid[])`,
      [storeIds],
    );
    await fixturePool.query(`delete from platform.users where id=any($1::uuid[])`, [userIds]);
    await fixturePool.query(`delete from ledger.stores where id=any($1::uuid[])`, [storeIds]);
  }

  async function setContext(client: PoolClient, identity: RuntimeIdentity): Promise<void> {
    await client.query(
      `select
         set_config('app.store_id',$1,true),
         set_config('app.user_id',$2,true),
         set_config('app.device_id',$3,true),
         set_config('app.request_id',$4,true)`,
      [identity.storeId, identity.userId, identity.deviceId, randomUUID()],
    );
  }

  async function withRuntimeTransaction<T>(
    identity: RuntimeIdentity,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await runtimePool.connect();
    try {
      await client.query('begin');
      await setContext(client, identity);
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function insertAttachment(
    client: PoolClient,
    input: { id: string; parentId?: string; fileName?: string; remoteKey?: string },
  ): Promise<void> {
    await client.query(
      `insert into ledger.attachments (
         id, store_id, entity_type, entity_id, kind, file_name, mime_type,
         remote_key, file_size_bytes, checksum_sha256, sync_status
       ) values ($1,$2,'customer',$3,'document',$4,'application/pdf',$5,18,$6,'uploaded')`,
      [
        input.id,
        ownerA.storeId,
        input.parentId ?? fixture.parents.a,
        input.fileName ?? 'receipt.pdf',
        input.remoteKey ?? `stores/${ownerA.storeId}/attachments/${input.id}`,
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      ],
    );
  }

  beforeAll(async () => {
    if (!environment) {
      throw new Error('The approved local PostgreSQL test environment is unavailable.');
    }
    fixturePool = createTestPool(
      environment.adminUrl,
      'dokana-s21-attachment-lifecycle-fixtures',
      2,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    runtimePool = createTestPool(environment.runtimeUrl, 'dokana-s21-attachment-lifecycle', 2);
    poolsInitialized = true;

    await removeFixtures();
    for (const [key, storeId] of Object.entries(fixture.stores)) {
      await fixturePool.query(
        `insert into ledger.stores (id,name,status) values ($1,$2,'active')`,
        [storeId, `S21 attachment ${key}`],
      );
    }
    for (const [key, userId] of Object.entries(fixture.users)) {
      const email = `s21-attachment-${key.toLowerCase()}@example.test`;
      await fixturePool.query(
        `insert into platform.users (
           id,email,normalized_email,password_hash,full_name,status
         ) values ($1,$2,$2,'not-used',$3,'active')`,
        [userId, email, `S21 attachment ${key}`],
      );
    }
    await fixturePool.query(
      `insert into platform.store_memberships (id,store_id,user_id,role,status) values
       ($1,$2,$3,'owner','active'),
       ($4,$2,$5,'manager','active'),
       ($6,$7,$8,'owner','active')`,
      [
        fixture.memberships.ownerA,
        fixture.stores.a,
        fixture.users.ownerA,
        fixture.memberships.managerA,
        fixture.users.managerA,
        fixture.memberships.ownerB,
        fixture.stores.b,
        fixture.users.ownerB,
      ],
    );
    for (const [key, deviceId] of Object.entries(fixture.devices)) {
      const identity = key === 'ownerB' ? ownerB : key === 'managerA' ? managerA : ownerA;
      const devicePrefix = key === 'ownerB' ? 'OB' : key === 'managerA' ? 'MA' : 'OA';
      await fixturePool.query(
        `insert into ledger.devices (
           id,store_id,device_name,platform,installation_id,device_prefix,status
         ) values ($1,$2,$3,'android',$4,$5,'active')`,
        [deviceId, identity.storeId, `S21 attachment ${key}`, randomUUID(), devicePrefix],
      );
    }
  }, 30_000);

  afterAll(async () => {
    if (!poolsInitialized) return;
    await removeFixtures();
    const residue = await fixturePool.query<{ count: number }>(
      `select (
         (select count(*) from audit.central_audit_logs where store_id=any($1::uuid[])) +
         (select count(*) from ledger.attachments where store_id=any($1::uuid[])) +
         (select count(*) from ledger.devices where store_id=any($1::uuid[])) +
         (select count(*) from platform.store_memberships where store_id=any($1::uuid[])) +
         (select count(*) from platform.users where id=any($2::uuid[])) +
         (select count(*) from ledger.stores where id=any($1::uuid[]))
       )::integer as count`,
      [Object.values(fixture.stores), Object.values(fixture.users)],
    );
    expect(residue.rows[0]?.count).toBe(0);
    await Promise.all([runtimePool.end(), fixturePool.end()]);
  }, 30_000);

  it('installs the narrow 0032 functions, triggers, grants, and forced-RLS boundary', async () => {
    const result = await fixturePool.query<{
      migrationCount: number;
      removerOwner: string;
      removerSecurityDefiner: boolean;
      removerConfig: string[] | null;
      runtimeExecute: boolean;
      publicExecute: boolean;
      runtimeUpdate: boolean;
      runtimeDelete: boolean;
      runtimeAuditSelect: boolean;
      rlsEnabled: boolean;
      rlsForced: boolean;
      insertTrigger: boolean;
      removalTrigger: boolean;
    }>(`
      select
        (select count(*)::integer from platform.schema_migrations
         where filename='0032_attachment_lifecycle_audit.sql') as "migrationCount",
        (select pg_get_userbyid(proowner) from pg_proc
         where oid='ledger.remove_attachment_v1(uuid)'::regprocedure) as "removerOwner",
        (select prosecdef from pg_proc
         where oid='ledger.remove_attachment_v1(uuid)'::regprocedure) as "removerSecurityDefiner",
        (select proconfig from pg_proc
         where oid='ledger.remove_attachment_v1(uuid)'::regprocedure) as "removerConfig",
        has_function_privilege('shop_app_runtime','ledger.remove_attachment_v1(uuid)','execute')
          as "runtimeExecute",
        has_function_privilege('public','ledger.remove_attachment_v1(uuid)','execute')
          as "publicExecute",
        has_table_privilege('shop_app_runtime','ledger.attachments','update') as "runtimeUpdate",
        has_table_privilege('shop_app_runtime','ledger.attachments','delete') as "runtimeDelete",
        has_table_privilege('shop_app_runtime','audit.central_audit_logs','select')
          as "runtimeAuditSelect",
        (select relrowsecurity from pg_class where oid='ledger.attachments'::regclass)
          as "rlsEnabled",
        (select relforcerowsecurity from pg_class where oid='ledger.attachments'::regclass)
          as "rlsForced",
        exists(select 1 from pg_trigger where tgrelid='ledger.attachments'::regclass
          and tgname='trg_attachments_created_central_audit' and not tgisinternal)
          as "insertTrigger",
        exists(select 1 from pg_trigger where tgrelid='ledger.attachments'::regclass
          and tgname='trg_attachments_removed_central_audit' and not tgisinternal)
          as "removalTrigger"
    `);
    expect(result.rows[0]).toEqual({
      migrationCount: 1,
      removerOwner: 'shop_app_migrator',
      removerSecurityDefiner: true,
      removerConfig: ['search_path=pg_catalog, pg_temp'],
      runtimeExecute: true,
      publicExecute: false,
      runtimeUpdate: false,
      runtimeDelete: false,
      runtimeAuditSelect: false,
      rlsEnabled: true,
      rlsForced: true,
      insertTrigger: true,
      removalTrigger: true,
    });
  });

  it('captures creation and logical removal once and exposes only sanitized Owner evidence', async () => {
    const attachmentId = randomUUID();
    const remoteKey = `stores/${ownerA.storeId}/attachments/${attachmentId}`;
    await withRuntimeTransaction(ownerA, (client) =>
      insertAttachment(client, {
        id: attachmentId,
        fileName: 'receipt/unsafe\r\n.pdf',
        remoteKey,
      }),
    );

    const removal = await withRuntimeTransaction(ownerA, (client) =>
      client.query<{
        attachmentId: string;
        removedAt: Date;
        removedByUserId: string;
      }>(
        `select attachment_id as "attachmentId", removed_at as "removedAt",
                removed_by_user_id as "removedByUserId"
         from ledger.remove_attachment_v1($1)`,
        [attachmentId],
      ),
    );
    expect(removal.rows[0]).toMatchObject({
      attachmentId,
      removedByUserId: ownerA.userId,
    });
    expect(removal.rows[0]?.removedAt).toBeInstanceOf(Date);

    const replay = await withRuntimeTransaction(ownerA, (client) =>
      client.query(`select * from ledger.remove_attachment_v1($1)`, [attachmentId]),
    );
    expect(replay.rowCount).toBe(0);

    const central = await fixturePool.query<{ action: string; count: number }>(
      `select action,count(*)::integer as count from audit.central_audit_logs
       where store_id=$1 and entity_type='ledger.attachments' and entity_id=$2
       group by action order by action`,
      [ownerA.storeId, attachmentId],
    );
    expect(central.rows).toEqual([
      { action: 'insert', count: 1 },
      { action: 'update', count: 1 },
    ]);

    const ownerEvents = await withRuntimeTransaction(ownerA, (client) =>
      client.query<{
        action: string;
        entityType: string;
        context: Record<string, unknown>;
      }>(
        `select business_action as action, business_entity_type as "entityType",
                safe_context as context
         from ledger.read_owner_business_audit_v1(
           10,null,null,null,null,null,null,'attachment',$1
         )`,
        [attachmentId],
      ),
    );
    expect(ownerEvents.rows.map((row) => row.action).sort()).toEqual([
      'ATTACHMENT_ADDED',
      'ATTACHMENT_REMOVED',
    ]);
    for (const row of ownerEvents.rows) {
      expect(row.entityType).toBe('attachment');
      expect(row.context).toEqual({
        attachmentId,
        parentEntityType: 'customer',
        parentEntityId: fixture.parents.a,
        filename: 'receipt_unsafe__.pdf',
      });
      expect(JSON.stringify(row)).not.toContain(remoteKey);
      expect(JSON.stringify(row)).not.toContain('scanner');
      expect(JSON.stringify(row)).not.toContain('bucket');
    }
  });

  it('rolls back attachment audit atomically and blocks direct evidence rewriting', async () => {
    const rolledBackCreateId = randomUUID();
    const client = await runtimePool.connect();
    try {
      await client.query('begin');
      await setContext(client, ownerA);
      await insertAttachment(client, { id: rolledBackCreateId });
      await client.query('rollback');
    } finally {
      client.release();
    }
    const rolledBackCreate = await fixturePool.query<{ count: number }>(
      `select (
         (select count(*) from ledger.attachments where id=$1) +
         (select count(*) from audit.central_audit_logs
          where entity_type='ledger.attachments' and entity_id=$1)
       )::integer as count`,
      [rolledBackCreateId],
    );
    expect(rolledBackCreate.rows[0]?.count).toBe(0);

    const attachmentId = randomUUID();
    await withRuntimeTransaction(ownerA, (runtimeClient) =>
      insertAttachment(runtimeClient, { id: attachmentId }),
    );
    const removeClient = await runtimePool.connect();
    try {
      await removeClient.query('begin');
      await setContext(removeClient, ownerA);
      await removeClient.query(`select * from ledger.remove_attachment_v1($1)`, [attachmentId]);
      await removeClient.query('rollback');
    } finally {
      removeClient.release();
    }
    const state = await fixturePool.query<{ removedAt: Date | null; removalAudits: number }>(
      `select attachment.removed_at as "removedAt",
         (select count(*)::integer from audit.central_audit_logs
          where entity_type='ledger.attachments' and entity_id=$1 and action='update')
            as "removalAudits"
       from ledger.attachments as attachment where attachment.id=$1`,
      [attachmentId],
    );
    expect(state.rows[0]).toEqual({ removedAt: null, removalAudits: 0 });

    await expect(
      withRuntimeTransaction(ownerA, (runtimeClient) =>
        runtimeClient.query(
          `update ledger.attachments
           set removed_at=clock_timestamp(),removed_by_user_id=$2 where id=$1`,
          [attachmentId, fixture.users.managerA],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withRuntimeTransaction(managerA, (runtimeClient) =>
        runtimeClient.query(`select * from ledger.remove_attachment_v1($1)`, [attachmentId]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('fails closed across Stores for metadata, removal, and sanitized audit reads', async () => {
    const attachmentId = randomUUID();
    await withRuntimeTransaction(ownerA, (client) =>
      insertAttachment(client, { id: attachmentId }),
    );

    const foreignRead = await withRuntimeTransaction(ownerB, (client) =>
      client.query(`select id from ledger.attachments where id=$1`, [attachmentId]),
    );
    expect(foreignRead.rowCount).toBe(0);
    const foreignRemove = await withRuntimeTransaction(ownerB, (client) =>
      client.query(`select * from ledger.remove_attachment_v1($1)`, [attachmentId]),
    );
    expect(foreignRemove.rowCount).toBe(0);
    const foreignAudit = await withRuntimeTransaction(ownerB, (client) =>
      client.query(
        `select * from ledger.read_owner_business_audit_v1(
           10,null,null,null,null,null,null,'attachment',$1
         )`,
        [attachmentId],
      ),
    );
    expect(foreignAudit.rowCount).toBe(0);
  });
});
