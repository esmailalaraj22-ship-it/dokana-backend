import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { applyMigration, verifyMigrationSession } from '../scripts/migrate';
import {
  createInventoryTestDatabase,
  setInventoryContext,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const migrationFilename = '0025_fix_offline_operation_terminal_outcomes.sql';
const authorityMigrationFilename = '0024_offline_operation_push_authority.sql';
const refreshTokenHash = 'a'.repeat(64);
const provenanceHash = 'b'.repeat(64);
const canonicalHash = 'c'.repeat(64);
const issuedAt = new Date('2026-01-01T00:00:00.000Z');
const expiresAt = new Date('2026-01-08T00:00:00.000Z');
const clientRecordedAt = new Date('2026-01-02T00:00:00.000Z');
const knownStatusAt = new Date('2026-01-01T00:00:00.000Z');

interface FixtureIds {
  storeId: string;
  deviceId: string;
  userId: string;
  sessionId: string;
  accessTokenJti: string;
  subscriptionId: string;
  licenseId: string;
}

interface BeginInput {
  operationId: string;
  localSequence: string;
  provenanceHash?: string;
  clockState?: 'trusted' | 'clock_rollback_suspected';
  knownStoreStatus?: 'active' | 'read_only' | 'suspended';
  dependencies?: string[];
}

describe('S19.5 offline operation database authority', () => {
  let database: InventoryTestDatabase | undefined;
  let authPool: Pool | undefined;
  let ids: FixtureIds;

  const db = (): InventoryTestDatabase => {
    if (!database) throw new Error('Disposable S19.5 database is unavailable.');
    return database;
  };

  const auth = (): Pool => {
    if (!authPool) throw new Error('Disposable S19.5 auth pool is unavailable.');
    return authPool;
  };

  beforeAll(async () => {
    database = await createInventoryTestDatabase(migrationFilename);
    const migrationClient = await db().migration.connect();
    try {
      await verifyMigrationSession(migrationClient);
      await applyMigration(migrationClient, db().file);
    } finally {
      await migrationClient.query('reset role');
      migrationClient.release();
    }

    const environment = readLocalPostgresTestEnvironment();
    if (!environment)
      throw new Error('The approved local PostgreSQL test environment is required.');
    const currentDatabase = await db().admin.query<{ name: string }>(
      'select current_database() as name',
    );
    const databaseName = currentDatabase.rows[0]?.name;
    if (!databaseName) throw new Error('Disposable database name is unavailable.');
    const authUrl = new URL(environment.authUrl);
    authUrl.pathname = '/' + databaseName;
    authPool = createTestPool(authUrl.toString(), 'dokana-s195-auth', 2);

    ids = {
      storeId: randomUUID(),
      deviceId: randomUUID(),
      userId: randomUUID(),
      sessionId: randomUUID(),
      accessTokenJti: randomUUID(),
      subscriptionId: randomUUID(),
      licenseId: randomUUID(),
    };
    const planId = randomUUID();

    await db().admin.query('insert into ledger.stores (id, name, status) values ($1, $2, $3)', [
      ids.storeId,
      'S19.5 Store',
      'active',
    ]);
    await db().admin.query(
      'insert into ledger.devices ' +
        '(id, store_id, device_name, platform, installation_id, device_prefix, status) ' +
        'values ($1, $2, $3, $4, $5, $6, $7)',
      [ids.deviceId, ids.storeId, 'S19.5 Device', 'android', randomUUID(), 'S195', 'active'],
    );
    await db().admin.query(
      'insert into platform.users ' +
        '(id, email, normalized_email, password_hash, full_name, status) ' +
        'values ($1, $2, $2, $3, $4, $5)',
      [ids.userId, 's195@example.test', 'unused-test-hash', 'S19.5 Owner', 'active'],
    );
    await db().admin.query(
      'insert into platform.store_memberships ' +
        '(id, store_id, user_id, role, status) values ($1, $2, $3, $4, $5)',
      [randomUUID(), ids.storeId, ids.userId, 'owner', 'active'],
    );
    await db().admin.query(
      'insert into platform.subscription_plans ' +
        '(id, code, name, duration_days, price_minor, max_devices, offline_grace_days, status) ' +
        'values ($1, $2, $3, 365, 0, 1, 7, $4)',
      [planId, 's195-' + planId, 'S19.5 Plan', 'active'],
    );
    await db().admin.query(
      'insert into platform.subscriptions ' +
        '(id, store_id, plan_id, status, starts_at, expires_at, version) ' +
        'values ($1, $2, $3, $4, $5, $6, 1)',
      [
        ids.subscriptionId,
        ids.storeId,
        planId,
        'active',
        new Date('2025-12-01T00:00:00.000Z'),
        new Date('2026-12-01T00:00:00.000Z'),
      ],
    );
    await db().admin.query(
      'insert into platform.license_issuances ' +
        '(id, store_id, device_id, subscription_id, signed_payload, signature, key_id, ' +
        'issued_at, expires_at) values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)',
      [
        ids.licenseId,
        ids.storeId,
        ids.deviceId,
        ids.subscriptionId,
        JSON.stringify({
          licenseId: ids.licenseId,
          storeId: ids.storeId,
          deviceId: ids.deviceId,
          subscriptionId: ids.subscriptionId,
          subscriptionVersion: '1',
        }),
        'integration-signature',
        'integration-key',
        issuedAt,
        expiresAt,
      ],
    );
    await db().admin.query(
      'insert into platform.auth_sessions ' +
        '(id, user_id, store_id, device_id, access_token_jti, issued_at, expires_at) ' +
        "values ($1, $2, $3, $4, $5, clock_timestamp() - interval '1 minute', " +
        "clock_timestamp() + interval '1 day')",
      [ids.sessionId, ids.userId, ids.storeId, ids.deviceId, ids.accessTokenJti],
    );
    await db().admin.query(
      'insert into platform.refresh_tokens ' +
        '(id, session_id, token_hash, family_id, issued_at, expires_at) ' +
        "values ($1, $2, $3, $4, clock_timestamp() - interval '1 minute', " +
        "clock_timestamp() + interval '1 day')",
      [randomUUID(), ids.sessionId, refreshTokenHash, randomUUID()],
    );
  }, 120_000);

  afterAll(async () => {
    await authPool?.end();
    await database?.close();
  }, 30_000);

  async function beginOperation(client: PoolClient, input: BeginInput) {
    return client.query<{
      disposition: string;
      reasonCode: string | null;
      processedOperationPreexisted: boolean;
    }>(
      'select disposition, reason_code as "reasonCode", ' +
        'processed_operation_preexisted as "processedOperationPreexisted" ' +
        'from sync.begin_offline_operation_v1(' +
        '$1::uuid, $2::uuid, $3::uuid, $4, $5::bigint, $6, $7::uuid, $8::uuid, $9::bigint, ' +
        '$10::timestamptz, $11::timestamptz, $12::timestamptz, $13, $14, ' +
        '$15::timestamptz, $16::uuid[])',
      [
        ids.storeId,
        ids.deviceId,
        input.operationId,
        'customers.create.v1',
        input.localSequence,
        input.provenanceHash ?? provenanceHash,
        ids.licenseId,
        ids.subscriptionId,
        '1',
        clientRecordedAt,
        issuedAt,
        clientRecordedAt,
        input.clockState ?? 'trusted',
        input.knownStoreStatus ?? 'active',
        knownStatusAt,
        input.dependencies ?? [],
      ],
    );
  }

  async function completeApplied(client: PoolClient, operationId: string): Promise<void> {
    await client.query(
      'select sync.claim_operation($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7)',
      [ids.storeId, operationId, ids.deviceId, 'customers', randomUUID(), 'create', canonicalHash],
    );
    await client.query(
      'update sync.processed_operations set status = $3, response_body = $4::jsonb, ' +
        'completed_at = clock_timestamp() where store_id = $1 and operation_id = $2',
      [ids.storeId, operationId, 'applied', JSON.stringify({ customerId: randomUUID() })],
    );
    await client.query(
      'select * from sync.finish_offline_operation_v1($1::uuid, $2::uuid, $3, $4::jsonb)',
      [ids.storeId, operationId, 'applied', JSON.stringify({ status: 'APPLIED' })],
    );
  }

  it('applies 0024 through 0026 with pinned owners, narrow grants, forced RLS, and no direct table access', async () => {
    const state = await db().admin.query<{
      applied: boolean;
      correctionApplied: boolean;
      forcedRls: boolean;
      runtimeSelect: boolean;
      runtimeInsert: boolean;
      runtimePlatformUsage: boolean;
      syncOwner: string;
      authOwner: string;
      syncPath: string[] | null;
      authPath: string[] | null;
      runtimeExecute: boolean;
      authExecute: boolean;
    }>(
      'select ' +
        'exists(select 1 from platform.schema_migrations where filename = $1) as applied, ' +
        'exists(select 1 from platform.schema_migrations where filename = $2) ' +
        'as "correctionApplied", ' +
        '(select relrowsecurity and relforcerowsecurity from pg_class ' +
        'where oid = \'sync.offline_operation_provenance_v1\'::regclass) as "forcedRls", ' +
        "has_table_privilege('shop_app_runtime', " +
        "'sync.offline_operation_provenance_v1', 'SELECT') as \"runtimeSelect\", " +
        "has_table_privilege('shop_app_runtime', " +
        "'sync.offline_operation_provenance_v1', 'INSERT') as \"runtimeInsert\", " +
        "has_schema_privilege('shop_app_runtime', 'platform', 'USAGE') " +
        'as "runtimePlatformUsage", ' +
        '(select pg_get_userbyid(proowner) from pg_proc where oid = ' +
        "'sync.begin_offline_operation_v1(uuid,uuid,uuid,text,bigint,text,uuid,uuid,bigint," +
        "timestamptz,timestamptz,timestamptz,text,text,timestamptz,uuid[])'::regprocedure) " +
        'as "syncOwner", ' +
        '(select pg_get_userbyid(proowner) from pg_proc where oid = ' +
        '\'auth_api.validate_sync_session(uuid,uuid,uuid,uuid)\'::regprocedure) as "authOwner", ' +
        '(select proconfig from pg_proc where oid = ' +
        "'sync.begin_offline_operation_v1(uuid,uuid,uuid,text,bigint,text,uuid,uuid,bigint," +
        "timestamptz,timestamptz,timestamptz,text,text,timestamptz,uuid[])'::regprocedure) " +
        'as "syncPath", ' +
        '(select proconfig from pg_proc where oid = ' +
        '\'auth_api.validate_sync_session(uuid,uuid,uuid,uuid)\'::regprocedure) as "authPath", ' +
        "has_function_privilege('shop_app_runtime', " +
        "'sync.begin_offline_operation_v1(uuid,uuid,uuid,text,bigint,text,uuid,uuid,bigint," +
        "timestamptz,timestamptz,timestamptz,text,text,timestamptz,uuid[])', 'EXECUTE') " +
        'as "runtimeExecute", ' +
        "has_function_privilege('shop_app_auth', " +
        "'auth_api.validate_sync_session(uuid,uuid,uuid,uuid)', 'EXECUTE') as \"authExecute\"",
      [authorityMigrationFilename, migrationFilename],
    );
    expect(state.rows[0]).toEqual({
      applied: true,
      correctionApplied: true,
      forcedRls: true,
      runtimeSelect: false,
      runtimeInsert: false,
      runtimePlatformUsage: false,
      syncOwner: 'shop_app_migrator',
      authOwner: 'shop_app_auth_owner',
      syncPath: ['search_path=pg_catalog, pg_temp'],
      authPath: ['search_path=pg_catalog, pg_temp'],
      runtimeExecute: true,
      authExecute: true,
    });
    await expect(
      db().runtime.query('select * from sync.offline_operation_provenance_v1'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(auth().query('select * from platform.auth_sessions')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it.each(['active', 'read_only'] as const)(
    'preserves ordinary and sync authentication for a %s Store',
    async (status) => {
      await db().admin.query('update ledger.stores set status = $2 where id = $1', [
        ids.storeId,
        status,
      ]);
      const ordinary = await auth().query(
        'select * from auth_api.validate_session($1, $2, $3, $4, $5)',
        [ids.userId, ids.sessionId, ids.storeId, ids.deviceId, ids.accessTokenJti],
      );
      const syncSession = await auth().query<{ store_status: string }>(
        'select * from auth_api.validate_sync_session($1, $2, $3, $4)',
        [ids.userId, ids.sessionId, ids.storeId, ids.deviceId],
      );
      expect(ordinary.rowCount).toBe(1);
      expect(syncSession.rows[0]?.store_status).toBe(status);
    },
  );

  it('blocks ordinary suspended access while allowing only sync authentication, and blocks archived', async () => {
    await db().admin.query('update ledger.stores set status = $2 where id = $1', [
      ids.storeId,
      'suspended',
    ]);
    const ordinary = await auth().query(
      'select * from auth_api.validate_session($1, $2, $3, $4, $5)',
      [ids.userId, ids.sessionId, ids.storeId, ids.deviceId, ids.accessTokenJti],
    );
    const syncSession = await auth().query<{ store_status: string }>(
      'select * from auth_api.validate_sync_session($1, $2, $3, $4)',
      [ids.userId, ids.sessionId, ids.storeId, ids.deviceId],
    );
    const syncRefresh = await auth().query<{ store_status: string }>(
      'select * from auth_api.validate_sync_refresh_token($1)',
      [refreshTokenHash],
    );
    expect(ordinary.rowCount).toBe(0);
    expect(syncSession.rows[0]?.store_status).toBe('suspended');
    expect(syncRefresh.rows[0]?.store_status).toBe('suspended');

    await db().admin.query('update ledger.stores set status = $2 where id = $1', [
      ids.storeId,
      'archived',
    ]);
    const archivedSession = await auth().query(
      'select * from auth_api.validate_sync_session($1, $2, $3, $4)',
      [ids.userId, ids.sessionId, ids.storeId, ids.deviceId],
    );
    const archivedRefresh = await auth().query(
      'select * from auth_api.validate_sync_refresh_token($1)',
      [refreshTokenHash],
    );
    expect(archivedSession.rowCount).toBe(0);
    expect(archivedRefresh.rowCount).toBe(0);
    await db().admin.query('update ledger.stores set status = $2 where id = $1', [
      ids.storeId,
      'active',
    ]);
  });

  it('binds historical authorization to the exact transaction and returns exact replay', async () => {
    const operationId = randomUUID();
    const client = await db().runtime.connect();
    let storeTransition: Promise<unknown> | undefined;
    let storeTransitionSettled = false;
    try {
      await client.query('begin');
      await setInventoryContext(client, ids.storeId, ids.deviceId, ids.userId);
      const ordinaryGate = await client.query<{ allowed: boolean }>(
        'select ledger.lock_business_write_authority_v1($1, null, null) as allowed',
        [ids.storeId],
      );
      expect(ordinaryGate.rows[0]?.allowed).toBe(true);
      const begin = await beginOperation(client, { operationId, localSequence: '1' });
      expect(begin.rows[0]).toEqual({
        disposition: 'authorized',
        reasonCode: null,
        processedOperationPreexisted: false,
      });
      storeTransition = db()
        .admin.query('update ledger.stores set status = $2 where id = $1', [
          ids.storeId,
          'suspended',
        ])
        .then((result) => {
          storeTransitionSettled = true;
          return result;
        });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(storeTransitionSettled).toBe(false);
      await client.query('savepoint s19_offline_domain');
      const gate = await client.query<{ allowed: boolean }>(
        'select ledger.lock_business_write_authority_v1($1, $2, $3) as allowed',
        [ids.storeId, operationId, 'customers.create.v1'],
      );
      expect(gate.rows[0]?.allowed).toBe(true);
      await client.query('release savepoint s19_offline_domain');
      await completeApplied(client, operationId);
      await client.query('commit');
      await storeTransition;
      expect(storeTransitionSettled).toBe(true);

      await client.query('begin');
      await setInventoryContext(client, ids.storeId, ids.deviceId, ids.userId);
      const replay = await beginOperation(client, { operationId, localSequence: '1' });
      expect(replay.rows[0]?.disposition).toBe('exact_replay');
      const staleGate = await client.query<{ allowed: boolean }>(
        'select ledger.lock_business_write_authority_v1($1, $2, $3) as allowed',
        [ids.storeId, operationId, 'customers.create.v1'],
      );
      expect(staleGate.rows[0]?.allowed).toBe(false);
      await client.query('rollback');
    } finally {
      await client.query('rollback').catch(() => undefined);
      await storeTransition?.catch(() => undefined);
      await db().admin.query('update ledger.stores set status = $2 where id = $1', [
        ids.storeId,
        'active',
      ]);
      client.release();
    }
  });

  it('preserves historical upload after later suspension but rejects invalid historical evidence', async () => {
    await db().admin.query(
      'update platform.subscriptions set status = $2, expires_at = $3, version = 2 where id = $1',
      [ids.subscriptionId, 'expired', new Date('2026-02-01T00:00:00.000Z')],
    );
    await db().admin.query('update ledger.stores set status = $2 where id = $1', [
      ids.storeId,
      'suspended',
    ]);

    const client = await db().runtime.connect();
    try {
      const historicalOperationId = randomUUID();
      await client.query('begin');
      await setInventoryContext(client, ids.storeId, ids.deviceId, ids.userId);
      const historical = await beginOperation(client, {
        operationId: historicalOperationId,
        localSequence: '2',
      });
      expect(historical.rows[0]?.disposition).toBe('authorized');
      await client.query('savepoint s19_historical_domain');
      const historicalGate = await client.query<{ allowed: boolean }>(
        'select ledger.lock_business_write_authority_v1($1, $2, $3) as allowed',
        [ids.storeId, historicalOperationId, 'customers.create.v1'],
      );
      expect(historicalGate.rows[0]?.allowed).toBe(true);

      const separateTransaction = await db().runtime.connect();
      try {
        await separateTransaction.query('begin');
        await setInventoryContext(separateTransaction, ids.storeId, ids.deviceId, ids.userId);
        const separateGate = await separateTransaction.query<{ allowed: boolean }>(
          'select ledger.lock_business_write_authority_v1($1, $2, $3) as allowed',
          [ids.storeId, historicalOperationId, 'customers.create.v1'],
        );
        expect(separateGate.rows[0]?.allowed).toBe(false);
        await separateTransaction.query('rollback');
      } finally {
        await separateTransaction.query('rollback').catch(() => undefined);
        separateTransaction.release();
      }
      await client.query('release savepoint s19_historical_domain');
      await client.query('select * from sync.finish_offline_operation_v1($1, $2, $3, $4::jsonb)', [
        ids.storeId,
        historicalOperationId,
        'rejected',
        JSON.stringify({ code: 'TEST_ONLY' }),
      ]);
      await client.query('commit');

      await client.query('begin');
      await setInventoryContext(client, ids.storeId, ids.deviceId, ids.userId);
      const quarantined = await beginOperation(client, {
        operationId: randomUUID(),
        localSequence: '3',
        clockState: 'clock_rollback_suspected',
      });
      expect(quarantined.rows[0]).toMatchObject({
        disposition: 'quarantined',
        reasonCode: 'OFFLINE_CLOCK_ROLLBACK_SUSPECTED',
      });
      await client.query('commit');

      await client.query('begin');
      await setInventoryContext(client, ids.storeId, ids.deviceId, ids.userId);
      const invalidStatus = await beginOperation(client, {
        operationId: randomUUID(),
        localSequence: '4',
        knownStoreStatus: 'suspended',
      });
      expect(invalidStatus.rows[0]).toMatchObject({
        disposition: 'rejected',
        reasonCode: 'OFFLINE_CREATED_AFTER_KNOWN_SUSPENSION',
      });
      await client.query('commit');
    } finally {
      await db().admin.query('update ledger.stores set status = $2 where id = $1', [
        ids.storeId,
        'active',
      ]);
      client.release();
    }
  });

  it('rejects centrally revoked License evidence without weakening the ordinary gate', async () => {
    await db().admin.query(
      'update platform.license_issuances set revoked_at = clock_timestamp(), ' +
        'revoke_reason = $2 where id = $1',
      [ids.licenseId, 'Focused S19.5 revocation test'],
    );
    const client = await db().runtime.connect();
    try {
      await client.query('begin');
      await setInventoryContext(client, ids.storeId, ids.deviceId, ids.userId);
      const revoked = await beginOperation(client, {
        operationId: randomUUID(),
        localSequence: '5',
      });
      expect(revoked.rows[0]).toMatchObject({
        disposition: 'rejected',
        reasonCode: 'OFFLINE_LICENSE_REVOKED',
      });
      await client.query('commit');
    } finally {
      await db().admin.query(
        'update platform.license_issuances set revoked_at = null, revoke_reason = null where id = $1',
        [ids.licenseId],
      );
      client.release();
    }
  });

  it('rejects changed operation provenance, sequence collisions, and missing dependencies', async () => {
    const operationId = randomUUID();
    const client = await db().runtime.connect();
    try {
      await client.query('begin');
      await setInventoryContext(client, ids.storeId, ids.deviceId, ids.userId);
      const first = await beginOperation(client, { operationId, localSequence: '10' });
      expect(first.rows[0]?.disposition).toBe('authorized');
      await client.query('select * from sync.finish_offline_operation_v1($1, $2, $3, $4::jsonb)', [
        ids.storeId,
        operationId,
        'rejected',
        JSON.stringify({ code: 'DOMAIN_REJECTED' }),
      ]);
      await client.query('commit');

      await client.query('begin');
      await setInventoryContext(client, ids.storeId, ids.deviceId, ids.userId);
      const changed = await beginOperation(client, {
        operationId,
        localSequence: '10',
        provenanceHash: 'd'.repeat(64),
      });
      expect(changed.rows[0]).toMatchObject({
        disposition: 'conflict',
        reasonCode: 'OFFLINE_OPERATION_ID_CONFLICT',
      });
      const collision = await beginOperation(client, {
        operationId: randomUUID(),
        localSequence: '10',
      });
      expect(collision.rows[0]).toMatchObject({
        disposition: 'conflict',
        reasonCode: 'OFFLINE_LOCAL_SEQUENCE_CONFLICT',
      });
      const dependency = await beginOperation(client, {
        operationId: randomUUID(),
        localSequence: '11',
        dependencies: [randomUUID()],
      });
      expect(dependency.rows[0]).toMatchObject({
        disposition: 'dependency_pending',
        reasonCode: 'OFFLINE_DEPENDENCY_PENDING',
      });
      await client.query('commit');
    } finally {
      client.release();
    }
  });

  it('serializes concurrent reuse of one device local sequence', async () => {
    const firstOperationId = randomUUID();
    const secondOperationId = randomUUID();
    const first = await db().runtime.connect();
    const second = await db().runtime.connect();
    try {
      await first.query('begin');
      await second.query('begin');
      await setInventoryContext(first, ids.storeId, ids.deviceId, ids.userId);
      await setInventoryContext(second, ids.storeId, ids.deviceId, ids.userId);
      expect(
        (
          await beginOperation(first, {
            operationId: firstOperationId,
            localSequence: '12',
          })
        ).rows[0]?.disposition,
      ).toBe('authorized');

      const collisionPromise = beginOperation(second, {
        operationId: secondOperationId,
        localSequence: '12',
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await first.query(
        'select * from sync.finish_offline_operation_v1($1::uuid, $2::uuid, $3, $4::jsonb)',
        [ids.storeId, firstOperationId, 'rejected', JSON.stringify({ code: 'TEST_ONLY' })],
      );
      await first.query('commit');

      expect((await collisionPromise).rows[0]).toMatchObject({
        disposition: 'conflict',
        reasonCode: 'OFFLINE_LOCAL_SEQUENCE_CONFLICT',
      });
      await second.query('commit');

      const state = await db().admin.query<{
        sequenceRows: number;
        secondProvenance: number;
        processed: number;
      }>(
        `select
           (select count(*)::integer from sync.offline_operation_provenance_v1
            where store_id = $1 and device_id = $2 and local_sequence = 12) as "sequenceRows",
           (select count(*)::integer from sync.offline_operation_provenance_v1
            where store_id = $1 and operation_id = $3) as "secondProvenance",
           (select count(*)::integer from sync.processed_operations
            where store_id = $1 and operation_id in ($4, $3)) as processed`,
        [ids.storeId, ids.deviceId, secondOperationId, firstOperationId],
      );
      expect(state.rows[0]).toEqual({
        sequenceRows: 1,
        secondProvenance: 0,
        processed: 0,
      });
    } finally {
      await first.query('rollback').catch(() => undefined);
      await second.query('rollback').catch(() => undefined);
      first.release();
      second.release();
    }
  });

  it('re-evaluates a dependent operation after its concurrent prerequisite commits', async () => {
    const prerequisiteId = randomUUID();
    const dependentId = randomUUID();
    const prerequisite = await db().runtime.connect();
    const dependent = await db().runtime.connect();
    try {
      await prerequisite.query('begin');
      await dependent.query('begin');
      await setInventoryContext(prerequisite, ids.storeId, ids.deviceId, ids.userId);
      await setInventoryContext(dependent, ids.storeId, ids.deviceId, ids.userId);

      expect(
        (
          await beginOperation(prerequisite, {
            operationId: prerequisiteId,
            localSequence: '13',
          })
        ).rows[0]?.disposition,
      ).toBe('authorized');
      await completeApplied(prerequisite, prerequisiteId);

      const pending = await beginOperation(dependent, {
        operationId: dependentId,
        localSequence: '14',
        dependencies: [prerequisiteId],
      });
      expect(pending.rows[0]).toMatchObject({
        disposition: 'dependency_pending',
        reasonCode: 'OFFLINE_DEPENDENCY_PENDING',
      });
      await dependent.query('commit');
      await prerequisite.query('commit');

      await dependent.query('begin');
      await setInventoryContext(dependent, ids.storeId, ids.deviceId, ids.userId);
      const resumed = await beginOperation(dependent, {
        operationId: dependentId,
        localSequence: '14',
        dependencies: [prerequisiteId],
      });
      expect(resumed.rows[0]?.disposition).toBe('authorized');
      await dependent.query(
        'select * from sync.finish_offline_operation_v1($1::uuid, $2::uuid, $3, $4::jsonb)',
        [ids.storeId, dependentId, 'rejected', JSON.stringify({ code: 'TEST_ONLY' })],
      );
      await dependent.query('commit');

      const state = await db().admin.query<{
        prerequisiteProvenance: number;
        dependentProvenance: number;
        prerequisiteProcessed: number;
        dependentProcessed: number;
      }>(
        `select
           (select count(*)::integer from sync.offline_operation_provenance_v1
            where store_id = $1 and operation_id = $2) as "prerequisiteProvenance",
           (select count(*)::integer from sync.offline_operation_provenance_v1
            where store_id = $1 and operation_id = $3) as "dependentProvenance",
           (select count(*)::integer from sync.processed_operations
            where store_id = $1 and operation_id = $2) as "prerequisiteProcessed",
           (select count(*)::integer from sync.processed_operations
            where store_id = $1 and operation_id = $3) as "dependentProcessed"`,
        [ids.storeId, prerequisiteId, dependentId],
      );
      expect(state.rows[0]).toEqual({
        prerequisiteProvenance: 1,
        dependentProvenance: 1,
        prerequisiteProcessed: 1,
        dependentProcessed: 0,
      });
    } finally {
      await prerequisite.query('rollback').catch(() => undefined);
      await dependent.query('rollback').catch(() => undefined);
      prerequisite.release();
      dependent.release();
    }
  });

  it('serializes concurrent duplicate submission and returns one canonical replay', async () => {
    const operationId = randomUUID();
    const first = await db().runtime.connect();
    const second = await db().runtime.connect();
    try {
      await first.query('begin');
      await second.query('begin');
      await setInventoryContext(first, ids.storeId, ids.deviceId, ids.userId);
      await setInventoryContext(second, ids.storeId, ids.deviceId, ids.userId);
      const firstBegin = await beginOperation(first, { operationId, localSequence: '20' });
      expect(firstBegin.rows[0]?.disposition).toBe('authorized');
      await completeApplied(first, operationId);

      const secondBeginPromise = beginOperation(second, {
        operationId,
        localSequence: '20',
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await first.query('commit');
      const secondBegin = await secondBeginPromise;
      expect(secondBegin.rows[0]).toMatchObject({
        disposition: 'exact_replay',
        processedOperationPreexisted: true,
      });
      await second.query('rollback');

      const counts = await db().admin.query<{ provenance: string; processed: string }>(
        'select ' +
          '(select count(*) from sync.offline_operation_provenance_v1 ' +
          'where store_id = $1 and operation_id = $2) as provenance, ' +
          '(select count(*) from sync.processed_operations ' +
          'where store_id = $1 and operation_id = $2) as processed',
        [ids.storeId, operationId],
      );
      expect(counts.rows[0]).toEqual({ provenance: '1', processed: '1' });
    } finally {
      await first.query('rollback').catch(() => undefined);
      await second.query('rollback').catch(() => undefined);
      first.release();
      second.release();
    }
  });

  it('distinguishes unresolved, rejected, conflicted, quarantined, and successful dependencies', async () => {
    const client = await db().runtime.connect();
    try {
      const unresolvedId = randomUUID();
      const unresolvedDependentId = randomUUID();
      await client.query('begin');
      await setInventoryContext(client, ids.storeId, ids.deviceId, ids.userId);
      const unresolved = await beginOperation(client, {
        operationId: unresolvedDependentId,
        localSequence: '30',
        dependencies: [unresolvedId],
      });
      expect(unresolved.rows[0]).toMatchObject({
        disposition: 'dependency_pending',
        reasonCode: 'OFFLINE_DEPENDENCY_PENDING',
      });
      await client.query('commit');

      const finalCases = [
        ['rejected', 'OFFLINE_DEPENDENCY_REJECTED'],
        ['conflict', 'OFFLINE_DEPENDENCY_CONFLICT'],
        ['quarantined', 'OFFLINE_DEPENDENCY_QUARANTINED'],
      ] as const;
      let sequence = 31;
      for (const [disposition, reasonCode] of finalCases) {
        const prerequisiteId = randomUUID();
        await client.query('begin');
        await setInventoryContext(client, ids.storeId, ids.deviceId, ids.userId);
        expect(
          (
            await beginOperation(client, {
              operationId: prerequisiteId,
              localSequence: String(sequence++),
            })
          ).rows[0]?.disposition,
        ).toBe('authorized');
        await client.query(
          'select * from sync.finish_offline_operation_v1($1::uuid, $2::uuid, $3, $4::jsonb)',
          [
            ids.storeId,
            prerequisiteId,
            disposition,
            JSON.stringify({ code: `TEST_${disposition}` }),
          ],
        );
        await client.query('commit');

        const dependentId = randomUUID();
        await client.query('begin');
        await setInventoryContext(client, ids.storeId, ids.deviceId, ids.userId);
        const dependent = await beginOperation(client, {
          operationId: dependentId,
          localSequence: String(sequence++),
          dependencies: [prerequisiteId],
        });
        expect(dependent.rows[0]).toMatchObject({ disposition, reasonCode });
        await client.query('commit');
        const noPartialEffect = await db().admin.query<{ count: number }>(
          `select count(*)::integer as count from sync.processed_operations
           where store_id = $1 and operation_id = $2`,
          [ids.storeId, dependentId],
        );
        expect(noPartialEffect.rows[0]?.count).toBe(0);
      }

      await client.query('begin');
      await setInventoryContext(client, ids.storeId, ids.deviceId, ids.userId);
      expect(
        (
          await beginOperation(client, {
            operationId: unresolvedId,
            localSequence: String(sequence++),
          })
        ).rows[0]?.disposition,
      ).toBe('authorized');
      await completeApplied(client, unresolvedId);
      await client.query('commit');

      await client.query('begin');
      await setInventoryContext(client, ids.storeId, ids.deviceId, ids.userId);
      const resumed = await beginOperation(client, {
        operationId: unresolvedDependentId,
        localSequence: '30',
        dependencies: [unresolvedId],
      });
      expect(resumed.rows[0]?.disposition).toBe('authorized');
      await client.query(
        'select * from sync.finish_offline_operation_v1($1::uuid, $2::uuid, $3, $4::jsonb)',
        [ids.storeId, unresolvedDependentId, 'rejected', JSON.stringify({ code: 'TEST_ONLY' })],
      );
      await client.query('commit');
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });

  it('durably conflicts a changed request without altering the original applied result', async () => {
    const operationId = randomUUID();
    const canonicalResponse = { customerId: randomUUID(), version: '1' };
    const client = await db().runtime.connect();
    try {
      await client.query('begin');
      await setInventoryContext(client, ids.storeId, ids.deviceId, ids.userId);
      await client.query(
        'select sync.claim_operation($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7)',
        [
          ids.storeId,
          operationId,
          ids.deviceId,
          'customers',
          canonicalResponse.customerId,
          'create',
          canonicalHash,
        ],
      );
      await client.query(
        `update sync.processed_operations
         set status = 'applied', response_body = $3::jsonb, completed_at = clock_timestamp()
         where store_id = $1 and operation_id = $2`,
        [ids.storeId, operationId, JSON.stringify(canonicalResponse)],
      );
      await client.query('commit');

      await client.query('begin');
      await setInventoryContext(client, ids.storeId, ids.deviceId, ids.userId);
      const beginning = await beginOperation(client, {
        operationId,
        localSequence: '40',
        provenanceHash: 'd'.repeat(64),
      });
      expect(beginning.rows[0]).toMatchObject({
        disposition: 'authorized',
        processedOperationPreexisted: true,
      });
      const conflict = await client.query<{
        disposition: string;
        responseBody: Record<string, unknown>;
      }>(
        `select disposition, response_body as "responseBody"
         from sync.finish_offline_operation_v1($1::uuid, $2::uuid, 'conflict', $3::jsonb)`,
        [ids.storeId, operationId, JSON.stringify({ code: 'OPERATION_ID_CONFLICT' })],
      );
      expect(conflict.rows[0]).toEqual({
        disposition: 'conflict',
        responseBody: { code: 'OPERATION_ID_CONFLICT' },
      });
      await client.query('commit');

      await client.query('begin');
      await setInventoryContext(client, ids.storeId, ids.deviceId, ids.userId);
      const replay = await beginOperation(client, {
        operationId,
        localSequence: '40',
        provenanceHash: 'd'.repeat(64),
      });
      expect(replay.rows[0]).toMatchObject({
        disposition: 'conflict',
        reasonCode: 'OPERATION_ID_CONFLICT',
      });
      await client.query('rollback');

      const state = await db().admin.query<{
        count: number;
        status: string;
        requestHash: string;
        responseBody: Record<string, unknown>;
        provenanceDisposition: string;
      }>(
        `select count(*)::integer as count,
                min(operation.status) as status,
                min(operation.request_hash) as "requestHash",
                (jsonb_agg(operation.response_body)->0) as "responseBody",
                min(provenance.disposition) as "provenanceDisposition"
         from sync.processed_operations as operation
         join sync.offline_operation_provenance_v1 as provenance
           on provenance.store_id = operation.store_id
          and provenance.operation_id = operation.operation_id
         where operation.store_id = $1 and operation.operation_id = $2`,
        [ids.storeId, operationId],
      );
      expect(state.rows[0]).toEqual({
        count: 1,
        status: 'applied',
        requestHash: canonicalHash,
        responseBody: canonicalResponse,
        provenanceDisposition: 'conflict',
      });
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });

  it('serializes concurrent changed replay to one durable conflict and zero new effects', async () => {
    const operationId = randomUUID();
    const aggregateId = randomUUID();
    await db().admin.query(
      `insert into sync.processed_operations (
         store_id, operation_id, device_id, aggregate_type, aggregate_id, action,
         request_hash, status, response_body, completed_at
       ) values ($1, $2, $3, 'customers', $4, 'create', $5, 'applied', $6::jsonb, clock_timestamp())`,
      [
        ids.storeId,
        operationId,
        ids.deviceId,
        aggregateId,
        canonicalHash,
        JSON.stringify({ customerId: aggregateId }),
      ],
    );
    const first = await db().runtime.connect();
    const second = await db().runtime.connect();
    try {
      await first.query('begin');
      await second.query('begin');
      await setInventoryContext(first, ids.storeId, ids.deviceId, ids.userId);
      await setInventoryContext(second, ids.storeId, ids.deviceId, ids.userId);
      expect(
        (
          await beginOperation(first, {
            operationId,
            localSequence: '41',
            provenanceHash: 'e'.repeat(64),
          })
        ).rows[0]?.disposition,
      ).toBe('authorized');
      const secondBeginning = beginOperation(second, {
        operationId,
        localSequence: '41',
        provenanceHash: 'e'.repeat(64),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await first.query(
        `select * from sync.finish_offline_operation_v1(
           $1::uuid, $2::uuid, 'conflict', $3::jsonb
         )`,
        [ids.storeId, operationId, JSON.stringify({ code: 'OPERATION_ID_CONFLICT' })],
      );
      await first.query('commit');
      expect((await secondBeginning).rows[0]).toMatchObject({
        disposition: 'conflict',
        reasonCode: 'OPERATION_ID_CONFLICT',
      });
      await second.query('commit');

      const counts = await db().admin.query<{ processed: number; provenance: number }>(
        `select
           (select count(*)::integer from sync.processed_operations
            where store_id = $1 and operation_id = $2) as processed,
           (select count(*)::integer from sync.offline_operation_provenance_v1
            where store_id = $1 and operation_id = $2 and disposition = 'conflict') as provenance`,
        [ids.storeId, operationId],
      );
      expect(counts.rows[0]).toEqual({ processed: 1, provenance: 1 });
    } finally {
      await first.query('rollback').catch(() => undefined);
      await second.query('rollback').catch(() => undefined);
      first.release();
      second.release();
    }
  });
});
