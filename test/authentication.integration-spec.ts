import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { decodeJwt, SignJWT } from 'jose';
import type { Pool } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';

import { applyMigration, runMigrationCommand, verifyMigrationSession } from '../scripts/migrate';
import { readCatalogFingerprint } from '../scripts/migrations/catalog-fingerprint';
import { sha256 } from '../scripts/migrations/migration-files';
import { withDatabase } from '../scripts/recovery/recovery-target';
import {
  createInventoryTestDatabase,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';

import { PasswordService } from '../src/auth/password.service';
import { TokenService } from '../src/auth/token.service';
import { AuthenticationDatabaseService } from '../src/auth/auth-database.service';
import { AUTH_DATABASE_POOL } from '../src/auth/auth.constants';
import { configureApplication } from '../src/bootstrap';
import { AppConfigService } from '../src/config/app-config.service';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

let environment = readLocalPostgresTestEnvironment();
const describeWithAuthenticationDatabase = environment ? describe : describe.skip;
const lockOrderMigration = '0037_auth_refresh_session_lock_order.sql';

const fixture = {
  storeId: randomUUID(),
  otherStoreId: randomUUID(),
  userId: randomUUID(),
  otherUserId: randomUUID(),
  membershipId: randomUUID(),
  otherMembershipId: randomUUID(),
  email: `station3-${randomUUID()}@example.test`,
  otherEmail: `station3-other-${randomUUID()}@example.test`,
  password: 'Station3-Test-Password!',
};

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

interface SessionState {
  id: string;
  expires_at: Date;
  revoked_at: Date | null;
  revoke_reason: string | null;
}

interface RefreshState {
  id: string;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readTokenPair(response: Response): TokenPair {
  const body: unknown = response.body;
  if (
    !isRecord(body) ||
    typeof body.accessToken !== 'string' ||
    typeof body.refreshToken !== 'string'
  ) {
    throw new Error('Expected an authentication token pair.');
  }
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
  };
}

describeWithAuthenticationDatabase('authentication API with real PostgreSQL', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let adminPool: Pool;
  let adminPoolInitialized = false;
  let database: InventoryTestDatabase | undefined;
  let catalogBefore: Record<string, unknown>;
  let catalogAfter: Record<string, unknown>;

  const loginBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    email: fixture.email,
    password: fixture.password,
    storeId: fixture.storeId,
    deviceId: randomUUID(),
    deviceName: 'Station 3 test device',
    devicePlatform: 'android',
    ...overrides,
  });

  async function cleanTransientState(): Promise<void> {
    await adminPool.query(`delete from platform.auth_sessions where user_id = any($1::uuid[])`, [
      [fixture.userId, fixture.otherUserId],
    ]);
    await adminPool.query(`delete from ledger.devices where store_id = any($1::uuid[])`, [
      [fixture.storeId, fixture.otherStoreId],
    ]);
    await adminPool.query(
      `
        update platform.users
        set status = 'active'
        where id = any($1::uuid[])
      `,
      [[fixture.userId, fixture.otherUserId]],
    );
    await adminPool.query(
      `
        update platform.store_memberships
        set status = 'active'
        where id = any($1::uuid[])
      `,
      [[fixture.membershipId, fixture.otherMembershipId]],
    );
    await adminPool.query(
      `
        update ledger.stores
        set status = 'active'
        where id = any($1::uuid[])
      `,
      [[fixture.storeId, fixture.otherStoreId]],
    );
    await adminPool.query(`delete from sync.change_events where store_id = any($1::uuid[])`, [
      [fixture.storeId, fixture.otherStoreId],
    ]);
  }

  async function removeFixtures(): Promise<void> {
    await cleanTransientState();
    await adminPool.query(`delete from platform.store_memberships where id = any($1::uuid[])`, [
      [fixture.membershipId, fixture.otherMembershipId],
    ]);
    await adminPool.query(`delete from platform.users where id = any($1::uuid[])`, [
      [fixture.userId, fixture.otherUserId],
    ]);
    await adminPool.query(`delete from ledger.stores where id = any($1::uuid[])`, [
      [fixture.storeId, fixture.otherStoreId],
    ]);
  }

  beforeAll(async () => {
    if (!environment) {
      throw new Error('The local PostgreSQL test environment is unavailable.');
    }

    // Isolate migration/recovery-control tests from the developer database.
    database = await createInventoryTestDatabase(lockOrderMigration);
    environment = {
      ...environment,
      databaseName: database.databaseName,
      runtimeUrl: withDatabase(environment.runtimeUrl, database.databaseName),
      adminUrl: withDatabase(environment.adminUrl, database.databaseName),
      authUrl: withDatabase(environment.authUrl, database.databaseName),
      migrationUrl: withDatabase(environment.migrationUrl, database.databaseName),
    };
    const before = await readCatalogFingerprint(database.admin);
    catalogBefore = JSON.parse(before.canonicalJson) as Record<string, unknown>;
    const history = (
      await database.admin.query('select * from platform.schema_migrations order by filename')
    ).rows;
    expect(history).toHaveLength(36);
    const migrator = await database.migration.connect();
    try {
      await verifyMigrationSession(migrator);
      const contents =
        database.file.contents +
        "\nDO $failure$ BEGIN RAISE EXCEPTION 'stage2a forced migration failure'; END $failure$;";
      await expect(
        applyMigration(migrator, { ...database.file, contents, checksumSha256: sha256(contents) }),
      ).rejects.toThrow('stage2a forced migration failure');
    } finally {
      await migrator.query('reset role');
      migrator.release();
    }
    expect((await readCatalogFingerprint(database.admin)).sha256).toBe(before.sha256);
    expect(
      (await database.admin.query('select * from platform.schema_migrations order by filename'))
        .rows,
    ).toEqual(history);
    await runMigrationCommand('apply', environment.migrationUrl);
    await runMigrationCommand('verify', environment.migrationUrl);
    catalogAfter = JSON.parse(
      (await readCatalogFingerprint(database.admin)).canonicalJson,
    ) as Record<string, unknown>;
    const upgraded = (
      await database.admin.query('select * from platform.schema_migrations order by filename')
    ).rows;
    expect(upgraded).toHaveLength(37);
    expect(upgraded.slice(0, 36)).toEqual(history);
    await runMigrationCommand('apply', environment.migrationUrl);
    expect(
      (await database.admin.query('select * from platform.schema_migrations order by filename'))
        .rows,
    ).toEqual(upgraded);

    process.env.APP_ENV = 'test';
    process.env.LOG_LEVEL = 'silent';
    process.env.DATABASE_URL = environment.runtimeUrl;
    process.env.AUTH_DATABASE_URL = environment.authUrl;

    adminPool = createTestPool(
      environment.adminUrl,
      'dokana-auth-fixture-admin',
      1,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    adminPoolInitialized = true;
    const databaseState = await adminPool.query<{
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
      databaseState.rows[0]?.databaseName !== environment.databaseName ||
      !databaseState.rows[0].isSuperuser
    ) {
      throw new Error('The local authentication fixture database is not approved.');
    }

    const passwordHash = await new PasswordService().hash(fixture.password);
    await removeFixtures();
    await adminPool.query(
      `
        insert into ledger.stores (id, name, status)
        values ($1, 'Station 3 Store', 'active'), ($2, 'Other Station 3 Store', 'active')
      `,
      [fixture.storeId, fixture.otherStoreId],
    );
    await adminPool.query(
      `
        insert into platform.users (
          id,
          email,
          normalized_email,
          password_hash,
          full_name,
          status
        )
        values
          ($1, $2, $3, $4, 'Station 3 Owner', 'active'),
          ($5, $6, $7, $4, 'Other Station 3 Owner', 'active')
      `,
      [
        fixture.userId,
        fixture.email,
        fixture.email.toLowerCase(),
        passwordHash,
        fixture.otherUserId,
        fixture.otherEmail,
        fixture.otherEmail.toLowerCase(),
      ],
    );
    await adminPool.query(
      `
        insert into platform.store_memberships (id, store_id, user_id, role, status)
        values
          ($1, $2, $3, 'owner', 'active'),
          ($4, $5, $6, 'owner', 'active')
      `,
      [
        fixture.membershipId,
        fixture.storeId,
        fixture.userId,
        fixture.otherMembershipId,
        fixture.otherStoreId,
        fixture.otherUserId,
      ],
    );

    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const nestApp = module.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    nestApp.useLogger(nestApp.get(Logger));
    configureApplication(nestApp, nestApp.get(AppConfigService));
    await nestApp.init();
    app = nestApp;
    server = nestApp.getHttpServer();
  }, 120_000);

  beforeEach(async () => {
    await cleanTransientState();
  });

  async function authState() {
    return {
      sessions: (
        await adminPool.query<SessionState>(
          'select * from platform.auth_sessions where user_id=$1 order by id',
          [fixture.userId],
        )
      ).rows,
      refresh: (
        await adminPool.query<RefreshState>(
          'select * from platform.refresh_tokens where session_id in (select id from platform.auth_sessions where user_id=$1) order by id',
          [fixture.userId],
        )
      ).rows,
    };
  }

  async function waitForAuthLock(pool: Pool, queryFragment: string, expected: number) {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const result = await pool.query<{ count: number }>(
        `select count(*)::int as count from pg_stat_activity where datname=current_database()
         and application_name='dokana-auth-test' and wait_event_type='Lock' and query like $1`,
        [`%${queryFragment}%`],
      );
      if (result.rows[0]?.count === expected) return;
      await nextTurn();
    }
    throw new Error('Expected authentication lock barrier was not reached.');
  }

  it('upgrades 0036 to 0037 with only the internal refresh body changed and all security catalog state preserved', () => {
    expect(
      Object.keys(catalogBefore).filter(
        (key) => JSON.stringify(catalogBefore[key]) !== JSON.stringify(catalogAfter[key]),
      ),
    ).toEqual(['routines']);
    const before = catalogBefore.routines as Record<string, unknown>[];
    const after = catalogAfter.routines as Record<string, unknown>[];
    expect(after).toHaveLength(before.length);
    const changed = after.filter(
      (row, index) => JSON.stringify(row) !== JSON.stringify(before[index]),
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      schema: 'auth_api',
      name: 'rotate_refresh_token',
      owner: 'shop_app_auth_owner',
      securityDefiner: true,
    });
    if (!changed[0]) throw new Error('Expected one changed routine.');
    const prior = before[after.indexOf(changed[0])];
    expect(changed[0].arguments).toEqual(expect.stringContaining('timestamp with time zone'));
    expect({ ...changed[0], definition: prior?.definition }).toEqual(prior);
  });

  it('rejects manipulated signed identity, algorithm, purpose, expiry, and malformed headers without mutation', async () => {
    if (!app) throw new Error('Application unavailable.');
    const login = await request(server).post('/v1/auth/login').send(loginBody()).expect(200);
    const pair = readTokenPair(login);
    const original = decodeJwt(pair.accessToken);
    const config = app.get(AppConfigService).authenticationTokens;
    const key = Buffer.from(config.activeSecret, 'base64url');
    const before = await authState();
    const variants = [
      { ...original, sid: randomUUID() },
      { ...original, device_id: randomUUID() },
      { ...original, store_id: fixture.otherStoreId },
      { ...original, sub: fixture.otherUserId },
      { ...original, jti: randomUUID() },
      { ...original, typ: 'sync_push' },
      { ...original, exp: Math.floor(Date.now() / 1000) - 60 },
      { ...original, iss: 'wrong-issuer' },
      { ...original, aud: 'wrong-audience' },
      { ...original, device_id: undefined },
    ];
    for (const payload of variants) {
      const token = await new SignJWT(payload)
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT', kid: config.activeKeyId })
        .sign(key);
      await request(server).get('/v1/auth/me').set('Authorization', `Bearer ${token}`).expect(401);
    }
    const wrongSignature = await new SignJWT(original)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT', kid: config.activeKeyId })
      .sign(Buffer.alloc(32, 123));
    const wrongAlgorithm = await new SignJWT(original)
      .setProtectedHeader({ alg: 'HS512', typ: 'JWT', kid: config.activeKeyId })
      .sign(Buffer.alloc(64, 123));
    for (const authorization of [
      `Bearer ${wrongSignature}`,
      `Bearer ${wrongAlgorithm}`,
      'Basic invalid',
      'Bearer invalid',
      `Bearer ${pair.accessToken} extra`,
    ]) {
      await request(server).get('/v1/auth/me').set('Authorization', authorization).expect(401);
    }
    expect(await authState()).toEqual(before);
    await request(server)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${pair.accessToken}`)
      .expect(200);
  });

  it('stores only the refresh hash and keeps rotation within the fixed session expiry', async () => {
    const pair = readTokenPair(
      await request(server).post('/v1/auth/login').send(loginBody()).expect(200),
    );
    const before = await authState();
    expect(before.sessions).toHaveLength(1);
    expect(before.refresh).toHaveLength(1);
    expect(before.refresh[0]).toMatchObject({
      token_hash: createHash('sha256').update(pair.refreshToken).digest('hex'),
      used_at: null,
      revoked_at: null,
    });
    expect(JSON.stringify(before)).not.toContain(pair.refreshToken);
    const rotated = readTokenPair(
      await request(server)
        .post('/v1/auth/refresh')
        .send({ refreshToken: pair.refreshToken })
        .expect(200),
    );
    const after = await authState();
    expect(after.sessions).toHaveLength(1);
    expect(after.refresh).toHaveLength(2);
    expect(after.sessions[0]?.expires_at).toEqual(before.sessions[0]?.expires_at);
    expect(
      after.refresh.filter((row) => row.used_at === null && row.revoked_at === null),
    ).toHaveLength(1);
    const session = after.sessions[0];
    if (!session) throw new Error('Expected the persisted session.');
    for (const row of after.refresh)
      expect(row.expires_at.getTime()).toBeLessThanOrEqual(session.expires_at.getTime());
    await request(server)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${pair.accessToken}`)
      .expect(401);
    await request(server)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${rotated.accessToken}`)
      .expect(200);
  });

  it('accepts equivalent UUID casing throughout login and current-session validation', async () => {
    const deviceId = randomUUID();
    const pair = readTokenPair(
      await request(server)
        .post('/v1/auth/login')
        .send(
          loginBody({ storeId: fixture.storeId.toUpperCase(), deviceId: deviceId.toUpperCase() }),
        )
        .expect(200),
    );
    const me = await request(server)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${pair.accessToken}`)
      .expect(200);
    expect(me.body).toMatchObject({ storeId: fixture.storeId, deviceId });
    expect((await authState()).sessions).toHaveLength(1);
  });

  it.each(['00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff'])(
    'rejects unusable identity UUID %s before session creation',
    async (deviceId) => {
      await request(server).post('/v1/auth/login').send(loginBody({ deviceId })).expect(400);
      expect(await authState()).toEqual({ sessions: [], refresh: [] });
      expect(
        (await adminPool.query('select id from ledger.devices where id=$1', [deviceId])).rowCount,
      ).toBe(0);
    },
  );

  it('serializes concurrent refresh with exactly one rotation and committed reuse revocation', async () => {
    if (!environment) throw new Error('PostgreSQL unavailable.');
    const pair = readTokenPair(
      await request(server).post('/v1/auth/login').send(loginBody()).expect(200),
    );
    const coordination = createTestPool(environment.adminUrl, 'stage2a-refresh-barrier', 2);
    const lock = await coordination.connect();
    let attempts: Promise<Response>[] = [];
    try {
      await lock.query('begin');
      await lock.query('select id from platform.auth_sessions where user_id=$1 for update', [
        fixture.userId,
      ]);
      attempts = [1, 2].map(() =>
        request(server)
          .post('/v1/auth/refresh')
          .send({ refreshToken: pair.refreshToken })
          .then((response) => response),
      );
      await waitForAuthLock(coordination, 'rotate_refresh_token_recovery_v1', 2);
      await lock.query('commit');
      const results = await Promise.all(attempts);
      expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
      const state = await authState();
      expect(state.sessions).toHaveLength(1);
      expect(state.sessions[0]?.revoke_reason).toBe('refresh_token_reuse');
      expect(state.refresh).toHaveLength(2);
      expect(state.refresh.every((row) => row.revoked_at !== null)).toBe(true);
      const success = results.find((result) => result.status === 200);
      if (!success) throw new Error('Expected one rotation response.');
      await request(server)
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${readTokenPair(success).accessToken}`)
        .expect(401);
    } finally {
      await lock.query('rollback');
      await Promise.allSettled(attempts);
      lock.release();
      await coordination.end();
    }
  });

  it('safely requires reauthentication when a committed refresh response is lost and its parent is retried', async () => {
    const pair = readTokenPair(
      await request(server).post('/v1/auth/login').send(loginBody()).expect(200),
    );
    // Deliberately discard the successful response; retry only the credential the client retained.
    await request(server)
      .post('/v1/auth/refresh')
      .send({ refreshToken: pair.refreshToken })
      .expect(200);
    await request(server)
      .post('/v1/auth/refresh')
      .send({ refreshToken: pair.refreshToken })
      .expect(401);
    const state = await authState();
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]?.revoke_reason).toBe('refresh_token_reuse');
    expect(state.refresh).toHaveLength(2);
    expect(state.refresh.every((row) => row.revoked_at !== null)).toBe(true);
  });

  it.each([false, true])(
    'serializes logout and refresh without a database deadlock (refresh first: %s)',
    async (refreshFirst) => {
      if (!environment) throw new Error('PostgreSQL unavailable.');
      const pair = readTokenPair(
        await request(server).post('/v1/auth/login').send(loginBody()).expect(200),
      );
      const coordination = createTestPool(environment.adminUrl, 'stage2a-revoke-barrier', 2);
      const lock = await coordination.connect();
      const deadlocks = async () =>
        (
          await coordination.query<{ count: number }>(
            'select deadlocks::int as count from pg_stat_database where datname=current_database()',
          )
        ).rows[0]?.count ?? 0;
      const before = await deadlocks();
      const attempts: Promise<Response>[] = [];
      try {
        await lock.query('begin');
        await lock.query('select id from platform.auth_sessions where user_id=$1 for update', [
          fixture.userId,
        ]);
        const logout = () =>
          request(server)
            .post('/v1/auth/logout')
            .set('Authorization', `Bearer ${pair.accessToken}`)
            .then((response) => response);
        const refresh = () =>
          request(server)
            .post('/v1/auth/refresh')
            .send({ refreshToken: pair.refreshToken })
            .then((response) => response);
        attempts.push(refreshFirst ? refresh() : logout());
        await waitForAuthLock(
          coordination,
          refreshFirst ? 'rotate_refresh_token_recovery_v1' : 'revoke_session',
          1,
        );
        attempts.push(refreshFirst ? logout() : refresh());
        await waitForAuthLock(
          coordination,
          refreshFirst ? 'revoke_session' : 'rotate_refresh_token_recovery_v1',
          1,
        );
        await lock.query('commit');
        const results = await Promise.all(attempts);
        const state = await authState();
        expect({
          statuses: results.map((result) => result.status),
          deadlocks: (await deadlocks()) - before,
          sessionRevoked: state.sessions[0]?.revoked_at !== null,
          activeRefresh: state.refresh.filter(
            (row) => row.used_at === null && row.revoked_at === null,
          ).length,
        }).toEqual({
          statuses: refreshFirst ? [200, 204] : [204, 401],
          deadlocks: 0,
          sessionRevoked: true,
          activeRefresh: 0,
        });
        expect(state.sessions[0]?.revoked_at).not.toBeNull();
        expect(state.refresh.every((row) => row.revoked_at !== null)).toBe(true);
        if (!results[0]) throw new Error('Missing first concurrent response.');
        const finalPair = refreshFirst ? readTokenPair(results[0]) : pair;
        await request(server)
          .get('/v1/auth/me')
          .set('Authorization', `Bearer ${finalPair.accessToken}`)
          .expect(401);
        await request(server)
          .post('/v1/auth/refresh')
          .send({ refreshToken: finalPair.refreshToken })
          .expect(401);
      } finally {
        await lock.query('rollback');
        await Promise.allSettled(attempts);
        lock.release();
        await coordination.end();
      }
    },
  );

  it.each([false, true])(
    'serializes parent replay against child rotation without a deadlock (child first: %s)',
    async (childFirst) => {
      if (!environment) throw new Error('PostgreSQL unavailable.');
      const parent = readTokenPair(
        await request(server).post('/v1/auth/login').send(loginBody()).expect(200),
      );
      const child = readTokenPair(
        await request(server)
          .post('/v1/auth/refresh')
          .send({ refreshToken: parent.refreshToken })
          .expect(200),
      );
      const coordination = createTestPool(environment.adminUrl, 'stage2a-family-barrier', 2);
      const lock = await coordination.connect();
      const deadlocks = async () => {
        const state = (
          await coordination.query<{ count: number }>(
            'select deadlocks::int as count from pg_stat_database where datname=current_database()',
          )
        ).rows[0];
        if (!state) throw new Error('Database deadlock statistics unavailable.');
        return state.count;
      };
      const before = await deadlocks();
      const attempts: Promise<Response>[] = [];
      const rotate = (pair: TokenPair) =>
        request(server)
          .post('/v1/auth/refresh')
          .send({ refreshToken: pair.refreshToken })
          .then((response) => response);
      try {
        await lock.query('begin');
        await lock.query('select id from platform.auth_sessions where user_id=$1 for update', [
          fixture.userId,
        ]);
        attempts.push(rotate(childFirst ? child : parent));
        await waitForAuthLock(coordination, 'rotate_refresh_token_recovery_v1', 1);
        attempts.push(rotate(childFirst ? parent : child));
        await waitForAuthLock(coordination, 'rotate_refresh_token_recovery_v1', 2);
        await lock.query('commit');
        const results = await Promise.all(attempts);
        expect(results.map((result) => result.status)).toEqual(
          childFirst ? [200, 401] : [401, 401],
        );
        expect((await deadlocks()) - before).toBe(0);
        const state = await authState();
        expect(state.sessions).toHaveLength(1);
        expect(state.sessions[0]?.revoke_reason).toBe('refresh_token_reuse');
        expect(state.refresh).toHaveLength(childFirst ? 3 : 2);
        expect(state.refresh.every((row) => row.revoked_at !== null)).toBe(true);
        if (!results[0]) throw new Error('Missing first concurrent response.');
        const last = childFirst ? readTokenPair(results[0]) : child;
        await request(server)
          .get('/v1/auth/me')
          .set('Authorization', `Bearer ${last.accessToken}`)
          .expect(401);
        await request(server)
          .post('/v1/auth/refresh')
          .send({ refreshToken: last.refreshToken })
          .expect(401);
      } finally {
        await lock.query('rollback');
        await Promise.allSettled(attempts);
        lock.release();
        await coordination.end();
      }
    },
  );

  it('separates sync identity and rejects both token channels after logout without affecting another session', async () => {
    if (!app) throw new Error('Application unavailable.');
    const pair = readTokenPair(
      await request(server).post('/v1/auth/login').send(loginBody()).expect(200),
    );
    const other = readTokenPair(
      await request(server).post('/v1/auth/login').send(loginBody()).expect(200),
    );
    const sync = await request(server)
      .post('/v1/sync/auth/token')
      .send({ refreshToken: pair.refreshToken })
      .expect(200);
    const syncToken = (sync.body as { syncToken: string }).syncToken;
    const before = await authState();
    await request(server)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${syncToken}`)
      .expect(401);
    await request(server)
      .post('/v1/sync/push')
      .set('Authorization', `Bearer ${pair.accessToken}`)
      .send({})
      .expect(401);
    // A valid sync credential reaches DTO validation; no business operation is submitted.
    await request(server)
      .post('/v1/sync/push')
      .set('Authorization', `Bearer ${syncToken}`)
      .send({})
      .expect(400);
    expect(await authState()).toEqual(before);
    await request(server)
      .post('/v1/auth/logout')
      .set('Authorization', `Bearer ${pair.accessToken}`)
      .expect(204);
    const after = await authState();
    expect(after.sessions.filter((row) => row.revoked_at !== null)).toHaveLength(1);
    expect(after.refresh.filter((row) => row.revoked_at !== null)).toHaveLength(1);
    await request(server)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${pair.accessToken}`)
      .expect(401);
    await request(server)
      .post('/v1/auth/refresh')
      .send({ refreshToken: pair.refreshToken })
      .expect(401);
    await request(server)
      .post('/v1/sync/auth/token')
      .send({ refreshToken: pair.refreshToken })
      .expect(401);
    await request(server)
      .post('/v1/sync/push')
      .set('Authorization', `Bearer ${syncToken}`)
      .send({})
      .expect(401);
    await request(server)
      .post('/v1/auth/logout')
      .set('Authorization', `Bearer ${pair.accessToken}`)
      .expect(401);
    const claims = decodeJwt(pair.accessToken);
    expect(
      await app
        .get(AuthenticationDatabaseService)
        .revokeSession(fixture.userId, String(claims.sid)),
    ).toBe(true);
    expect(await authState()).toEqual(after);
    await request(server)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${other.accessToken}`)
      .expect(200);
  });

  afterAll(async () => {
    try {
      await app?.close();
      if (adminPoolInitialized) {
        try {
          await removeFixtures();
        } finally {
          await adminPool.end();
        }
      }
    } finally {
      await database?.close();
    }
  });

  it('logs in, bootstraps a device, validates /me, and lists only authorized stores', async () => {
    const deviceId = randomUUID();
    const login = await request(server)
      .post('/v1/auth/login')
      .send(loginBody({ deviceId }))
      .expect(200);
    const tokens = readTokenPair(login);

    const currentIdentity = await request(server)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);
    const currentBody: unknown = currentIdentity.body;
    expect(currentBody).toMatchObject({
      userId: fixture.userId,
      storeId: fixture.storeId,
      deviceId,
      membershipRole: 'owner',
    });

    const stores = await request(server)
      .get('/v1/auth/stores')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);
    const storesBody: unknown = stores.body;
    expect(storesBody).toEqual([
      expect.objectContaining({
        storeId: fixture.storeId,
        storeStatus: 'active',
        membershipRole: 'owner',
      }),
    ]);

    const persisted = await adminPool.query<{ deviceCount: number; sessionCount: number }>(
      `
        select
          (select count(*)::integer from ledger.devices where id = $1) as "deviceCount",
          (
            select count(*)::integer
            from platform.auth_sessions
            where user_id = $2 and store_id = $3 and device_id = $1
          ) as "sessionCount"
      `,
      [deviceId, fixture.userId, fixture.storeId],
    );
    expect(persisted.rows[0]).toEqual({
      deviceCount: 1,
      sessionCount: 1,
    });
  });

  it('uses the same non-enumerating rejection for an unknown user and invalid password', async () => {
    const invalidPassword = await request(server)
      .post('/v1/auth/login')
      .send(loginBody({ password: 'incorrect-password' }))
      .expect(401);
    const unknownUser = await request(server)
      .post('/v1/auth/login')
      .send(loginBody({ email: `unknown-${randomUUID()}@example.test` }))
      .expect(401);

    const invalidBody: unknown = invalidPassword.body;
    const unknownBody: unknown = unknownUser.body;
    if (!isRecord(invalidBody) || !isRecord(unknownBody)) {
      throw new Error('Expected structured authentication errors.');
    }
    expect({
      code: invalidBody.code,
      message: invalidBody.message,
    }).toEqual({
      code: unknownBody.code,
      message: unknownBody.message,
    });

    const devices = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.devices where store_id = $1`,
      [fixture.storeId],
    );
    expect(devices.rows[0]?.count).toBe(0);
  });

  it('rejects disabled users and inactive memberships before device creation', async () => {
    await adminPool.query(`update platform.users set status = 'disabled' where id = $1`, [
      fixture.userId,
    ]);
    await request(server).post('/v1/auth/login').send(loginBody()).expect(401);

    await adminPool.query(`update platform.users set status = 'active' where id = $1`, [
      fixture.userId,
    ]);
    await adminPool.query(
      `update platform.store_memberships set status = 'disabled' where id = $1`,
      [fixture.membershipId],
    );
    await request(server).post('/v1/auth/login').send(loginBody()).expect(401);

    const devices = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.devices where store_id = $1`,
      [fixture.storeId],
    );
    expect(devices.rows[0]?.count).toBe(0);
  });

  it('rejects an unrelated store without revealing whether it exists', async () => {
    const response = await request(server)
      .post('/v1/auth/login')
      .send(loginBody({ storeId: fixture.otherStoreId }))
      .expect(401);
    const body: unknown = response.body;
    expect(body).toMatchObject({
      code: 'AUTHENTICATION_FAILED',
      message: 'Authentication failed.',
    });
  });

  it('allows read-only stores and rejects suspended or archived stores', async () => {
    await adminPool.query(`update ledger.stores set status = 'read_only' where id = $1`, [
      fixture.storeId,
    ]);
    const readOnlyLogin = await request(server)
      .post('/v1/auth/login')
      .send(loginBody())
      .expect(200);
    const readOnlyTokens = readTokenPair(readOnlyLogin);
    await request(server)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${readOnlyTokens.accessToken}`)
      .expect(200);
    await request(server)
      .post('/v1/auth/refresh')
      .send({ refreshToken: readOnlyTokens.refreshToken })
      .expect(200);

    await cleanTransientState();
    for (const status of ['suspended', 'archived']) {
      await adminPool.query(`update ledger.stores set status = $2 where id = $1`, [
        fixture.storeId,
        status,
      ]);
      await request(server).post('/v1/auth/login').send(loginBody()).expect(401);
    }
  });

  it('makes first-device registration idempotent and concurrency safe', async () => {
    const deviceId = randomUUID();
    await request(server).post('/v1/auth/login').send(loginBody({ deviceId })).expect(200);
    await request(server).post('/v1/auth/login').send(loginBody({ deviceId })).expect(200);

    let deviceCount = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.devices where id = $1`,
      [deviceId],
    );
    expect(deviceCount.rows[0]?.count).toBe(1);

    await cleanTransientState();
    const concurrentDeviceId = randomUUID();
    const attempts = await Promise.all([
      request(server)
        .post('/v1/auth/login')
        .send(
          loginBody({
            deviceId: concurrentDeviceId,
          }),
        ),
      request(server)
        .post('/v1/auth/login')
        .send(
          loginBody({
            deviceId: concurrentDeviceId,
          }),
        ),
    ]);
    expect(attempts.map((attempt) => attempt.status)).toEqual([200, 200]);

    deviceCount = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.devices where id = $1`,
      [concurrentDeviceId],
    );
    expect(deviceCount.rows[0]?.count).toBe(1);
  });

  it('rejects cross-store, revoked, and replaced device identifiers', async () => {
    const deviceId = randomUUID();
    await adminPool.query(
      `
        insert into ledger.devices (
          id,
          store_id,
          device_name,
          platform,
          installation_id,
          device_prefix,
          status
        )
        values ($1, $2, 'Other device', 'android', $1, $3, 'active')
      `,
      [deviceId, fixture.otherStoreId, deviceId.replaceAll('-', '').slice(0, 12)],
    );
    await request(server).post('/v1/auth/login').send(loginBody({ deviceId })).expect(401);

    await adminPool.query(`delete from ledger.devices where id = $1`, [deviceId]);
    for (const status of ['revoked', 'replaced']) {
      await adminPool.query(
        `
          insert into ledger.devices (
            id,
            store_id,
            device_name,
            platform,
            installation_id,
            device_prefix,
            status
          )
          values ($1, $2, 'Blocked device', 'android', $1, $3, $4)
        `,
        [deviceId, fixture.storeId, deviceId.replaceAll('-', '').slice(0, 12), status],
      );
      await request(server).post('/v1/auth/login').send(loginBody({ deviceId })).expect(401);
      await adminPool.query(`delete from ledger.devices where id = $1`, [deviceId]);
    }
  });

  it('rotates refresh tokens and revokes the family on confirmed reuse', async () => {
    const login = await request(server).post('/v1/auth/login').send(loginBody()).expect(200);
    const originalTokens = readTokenPair(login);

    const refresh = await request(server)
      .post('/v1/auth/refresh')
      .send({ refreshToken: originalTokens.refreshToken })
      .expect(200);
    const rotatedTokens = readTokenPair(refresh);
    expect(rotatedTokens.refreshToken).not.toBe(originalTokens.refreshToken);

    await request(server)
      .post('/v1/auth/refresh')
      .send({ refreshToken: originalTokens.refreshToken })
      .expect(401);
    await request(server)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${rotatedTokens.accessToken}`)
      .expect(401);

    const sessionState = await adminPool.query<{
      revoked: boolean;
      activeRefreshTokens: number;
    }>(
      `
        select
          sessions.revoked_at is not null as revoked,
          (
            select count(*)::integer
            from platform.refresh_tokens
            where session_id = sessions.id and revoked_at is null
          ) as "activeRefreshTokens"
        from platform.auth_sessions as sessions
        where sessions.user_id = $1
      `,
      [fixture.userId],
    );
    expect(sessionState.rows[0]).toEqual({
      revoked: true,
      activeRefreshTokens: 0,
    });
  });

  it('rolls back refresh rotation if replacement access-token signing fails', async () => {
    if (!app) throw new Error('Application unavailable.');
    const login = await request(server).post('/v1/auth/login').send(loginBody()).expect(200);
    const tokens = readTokenPair(login);
    const snapshot = async () => ({
      sessions: (
        await adminPool.query('select * from platform.auth_sessions where user_id=$1', [
          fixture.userId,
        ])
      ).rows,
      refresh: (
        await adminPool.query(
          'select * from platform.refresh_tokens where session_id in (select id from platform.auth_sessions where user_id=$1) order by id',
          [fixture.userId],
        )
      ).rows,
    });
    const before = await snapshot();
    const signing = jest
      .spyOn(app.get(TokenService), 'issueAccessToken')
      .mockRejectedValueOnce(new Error('Injected signing failure'));
    try {
      const failure = await request(server)
        .post('/v1/auth/refresh')
        .send({ refreshToken: tokens.refreshToken })
        .expect(500);
      expect(failure.body).toMatchObject({
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
      });
      expect(await snapshot()).toEqual(before);
    } finally {
      signing.mockRestore();
    }
    await request(server)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);
    await request(server)
      .post('/v1/auth/refresh')
      .send({ refreshToken: tokens.refreshToken })
      .expect(200);
  });

  it('creates no session or device when login token signing fails', async () => {
    if (!app) throw new Error('Application unavailable.');
    const deviceId = randomUUID();
    const signing = jest
      .spyOn(app.get(TokenService), 'issueAccessToken')
      .mockRejectedValueOnce(new Error('Injected login signing failure'));
    try {
      const failure = await request(server)
        .post('/v1/auth/login')
        .send(loginBody({ deviceId }))
        .expect(500);
      expect(failure.body).toMatchObject({
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
      });
      expect(await authState()).toEqual({ sessions: [], refresh: [] });
      expect(
        (await adminPool.query('select id from ledger.devices where id=$1', [deviceId])).rowCount,
      ).toBe(0);
    } finally {
      signing.mockRestore();
    }
  });

  it('discards repeated real connection failures before refresh BEGIN without consuming the credential', async () => {
    if (!app) throw new Error('Application unavailable.');
    const pair = readTokenPair(
      await request(server).post('/v1/auth/login').send(loginBody()).expect(200),
    );
    const before = await authState();
    const pool = app.get<Pool>(AUTH_DATABASE_POOL);
    const connect = pool.connect.bind(pool);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const acquisition = jest.spyOn(pool, 'connect').mockImplementationOnce(async () => {
        const client = await connect();
        client.on('error', () => undefined);
        const pid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]
          ?.pid;
        const ended = new Promise<void>((resolve) => {
          client.once('end', resolve);
        });
        await adminPool.query('select pg_terminate_backend($1)', [pid]);
        await ended;
        return client;
      });
      try {
        await request(server)
          .post('/v1/auth/refresh')
          .send({ refreshToken: pair.refreshToken })
          .expect(500);
        expect(pool.totalCount).toBe(0);
        expect(pool.idleCount).toBe(0);
        expect(await authState()).toEqual(before);
      } finally {
        acquisition.mockRestore();
      }
    }
    await request(server)
      .post('/v1/auth/refresh')
      .send({ refreshToken: pair.refreshToken })
      .expect(200);
  });

  it('rolls back a real refresh statement timeout and releases the transaction connection', async () => {
    if (!app || !environment) throw new Error('Application unavailable.');
    const pair = readTokenPair(
      await request(server).post('/v1/auth/login').send(loginBody()).expect(200),
    );
    const before = await authState();
    const coordination = createTestPool(environment.adminUrl, 'stage2a-refresh-timeout', 1);
    const lock = await coordination.connect();
    const pool = app.get<Pool>(AUTH_DATABASE_POOL);
    const connect = pool.connect.bind(pool);
    const acquisition = jest.spyOn(pool, 'connect').mockImplementationOnce(async () => {
      const client = await connect();
      await client.query("set statement_timeout='50ms'");
      return client;
    });
    try {
      await lock.query('begin');
      await lock.query('select id from platform.auth_sessions where user_id=$1 for update', [
        fixture.userId,
      ]);
      const failure = await request(server)
        .post('/v1/auth/refresh')
        .send({ refreshToken: pair.refreshToken })
        .expect(500);
      expect(failure.body).toMatchObject({
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
      });
      expect(pool.totalCount).toBe(0);
      expect(await authState()).toEqual(before);
    } finally {
      acquisition.mockRestore();
      await lock.query('rollback');
      lock.release();
      await coordination.end();
    }
    await request(server)
      .post('/v1/auth/refresh')
      .send({ refreshToken: pair.refreshToken })
      .expect(200);
  });

  it('rejects unknown, expired, and revoked refresh tokens', async () => {
    await request(server)
      .post('/v1/auth/refresh')
      .send({ refreshToken: 'A'.repeat(43) })
      .expect(401);

    const expiredLogin = await request(server).post('/v1/auth/login').send(loginBody()).expect(200);
    const expiredTokens = readTokenPair(expiredLogin);
    await adminPool.query(
      `
        update platform.refresh_tokens
        set issued_at = clock_timestamp() - interval '2 days',
            expires_at = clock_timestamp() - interval '1 day'
        where session_id = (
          select id from platform.auth_sessions where user_id = $1 order by issued_at desc limit 1
        )
      `,
      [fixture.userId],
    );
    await request(server)
      .post('/v1/auth/refresh')
      .send({ refreshToken: expiredTokens.refreshToken })
      .expect(401);

    await cleanTransientState();
    const revokedLogin = await request(server).post('/v1/auth/login').send(loginBody()).expect(200);
    const revokedTokens = readTokenPair(revokedLogin);
    await adminPool.query(
      `
        update platform.refresh_tokens
        set revoked_at = clock_timestamp()
        where session_id = (
          select id from platform.auth_sessions where user_id = $1 order by issued_at desc limit 1
        )
      `,
      [fixture.userId],
    );
    await request(server)
      .post('/v1/auth/refresh')
      .send({ refreshToken: revokedTokens.refreshToken })
      .expect(401);
  });

  it('revokes logout immediately and rejects revoked or expired sessions', async () => {
    const login = await request(server).post('/v1/auth/login').send(loginBody()).expect(200);
    const tokens = readTokenPair(login);

    await request(server)
      .post('/v1/auth/logout')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(204);
    await request(server)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(401);

    await cleanTransientState();
    const expiringLogin = await request(server)
      .post('/v1/auth/login')
      .send(loginBody())
      .expect(200);
    const expiringTokens = readTokenPair(expiringLogin);
    await adminPool.query(
      `
        update platform.auth_sessions
        set issued_at = clock_timestamp() - interval '2 days',
            expires_at = clock_timestamp() - interval '1 day'
        where user_id = $1
      `,
      [fixture.userId],
    );
    await request(server)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${expiringTokens.accessToken}`)
      .expect(401);
  });

  it('checks current membership and store status on access and refresh', async () => {
    const deviceId = randomUUID();
    const deviceLogin = await request(server)
      .post('/v1/auth/login')
      .send(loginBody({ deviceId }))
      .expect(200);
    const deviceTokens = readTokenPair(deviceLogin);
    await adminPool.query(`update ledger.devices set status = 'revoked' where id = $1`, [deviceId]);
    await request(server)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${deviceTokens.accessToken}`)
      .expect(401);
    await request(server)
      .post('/v1/auth/refresh')
      .send({ refreshToken: deviceTokens.refreshToken })
      .expect(401);

    for (const status of ['suspended', 'archived']) {
      await cleanTransientState();
      const storeLogin = await request(server).post('/v1/auth/login').send(loginBody()).expect(200);
      const storeTokens = readTokenPair(storeLogin);
      await adminPool.query(`update ledger.stores set status = $2 where id = $1`, [
        fixture.storeId,
        status,
      ]);
      await request(server)
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${storeTokens.accessToken}`)
        .expect(401);
      await request(server)
        .post('/v1/auth/refresh')
        .send({ refreshToken: storeTokens.refreshToken })
        .expect(401);
    }

    await cleanTransientState();
    const membershipLogin = await request(server)
      .post('/v1/auth/login')
      .send(loginBody())
      .expect(200);
    const membershipTokens = readTokenPair(membershipLogin);
    await adminPool.query(
      `update platform.store_memberships set status = 'removed' where id = $1`,
      [fixture.membershipId],
    );
    await request(server)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${membershipTokens.accessToken}`)
      .expect(401);
  });

  it('reports full readiness including the verified authentication boundary', async () => {
    const response = await request(server).get('/health/ready').expect(200);

    expect(response.body).toMatchObject({
      status: 'up',
      checks: {
        application: { status: 'up' },
        database: { status: 'up' },
        authenticationDatabase: { status: 'up' },
      },
    });
  });

  it('rejects malformed login and refresh requests before database effects', async () => {
    await request(server)
      .post('/v1/auth/login')
      .send(loginBody({ deviceId: 'not-a-uuid', unexpected: true }))
      .expect(400);
    await request(server).post('/v1/auth/refresh').send({ refreshToken: 'not-valid!' }).expect(400);

    const devices = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.devices where store_id = $1`,
      [fixture.storeId],
    );
    expect(devices.rows[0]?.count).toBe(0);
  });

  it('rejects both identity channels across recovery fencing and admits only fresh sessions after activation', async () => {
    if (!database) throw new Error('Disposable PostgreSQL unavailable.');
    const body = loginBody();
    const pair = readTokenPair(await request(server).post('/v1/auth/login').send(body).expect(200));
    const sync = await request(server)
      .post('/v1/sync/auth/token')
      .send({ refreshToken: pair.refreshToken })
      .expect(200);
    const syncToken = (sync.body as { syncToken: string }).syncToken;
    const before = await authState();
    const devicesBefore = (
      await adminPool.query('select * from ledger.devices where store_id=$1 order by id', [
        fixture.storeId,
      ])
    ).rows;
    const operator = await database.migration.connect();
    try {
      await verifyMigrationSession(operator);
      const initial = (
        await operator.query<{ generation: string }>(
          'select recovery_generation_id as generation from platform.read_platform_recovery_control_v1()',
        )
      ).rows[0];
      if (!initial) throw new Error('Recovery generation unavailable.');
      await operator.query('select * from platform.fence_platform_recovery_v1($1::uuid)', [
        initial.generation,
      ]);
      await request(server).post('/v1/auth/login').send(body).expect(401);
      await request(server)
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${pair.accessToken}`)
        .expect(401);
      await request(server)
        .post('/v1/sync/push')
        .set('Authorization', `Bearer ${syncToken}`)
        .send({})
        .expect(401);
      await request(server)
        .post('/v1/sync/auth/token')
        .send({ refreshToken: pair.refreshToken })
        .expect(401);
      const fencedRefresh = await request(server)
        .post('/v1/auth/refresh')
        .send({ refreshToken: pair.refreshToken })
        .expect(500);
      expect(fencedRefresh.body).toMatchObject({
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
      });
      expect(await authState()).toEqual(before);
      expect(
        (
          await adminPool.query('select * from ledger.devices where store_id=$1 order by id', [
            fixture.storeId,
          ])
        ).rows,
      ).toEqual(devicesBefore);
      const activated = (
        await operator.query<{ generation: string }>(
          'select recovery_generation_id as generation from platform.activate_new_recovery_generation_v1($1::uuid)',
          [initial.generation],
        )
      ).rows[0];
      if (!activated) throw new Error('Activated recovery generation unavailable.');
      expect(activated.generation).not.toBe(initial.generation);
      await request(server)
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${pair.accessToken}`)
        .expect(401);
      await request(server)
        .post('/v1/sync/push')
        .set('Authorization', `Bearer ${syncToken}`)
        .send({})
        .expect(401);
      await request(server)
        .post('/v1/sync/auth/token')
        .send({ refreshToken: pair.refreshToken })
        .expect(401);
      await request(server)
        .post('/v1/auth/refresh')
        .send({ refreshToken: pair.refreshToken })
        .expect(500);
      expect(await authState()).toEqual(before);
      const freshLogin = await request(server).post('/v1/auth/login').send(body).expect(200);
      expect(freshLogin.body).toMatchObject({ recoveryGenerationId: activated.generation });
      const fresh = readTokenPair(freshLogin);
      await request(server)
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${fresh.accessToken}`)
        .expect(200);
      const rotated = readTokenPair(
        await request(server)
          .post('/v1/auth/refresh')
          .send({ refreshToken: fresh.refreshToken })
          .expect(200),
      );
      await request(server)
        .post('/v1/sync/auth/token')
        .send({ refreshToken: rotated.refreshToken })
        .expect(200);
    } finally {
      await operator.query('reset role');
      operator.release();
    }
  });
});
