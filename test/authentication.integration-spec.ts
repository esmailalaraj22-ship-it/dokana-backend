import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import type { Pool } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';

import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { AppConfigService } from '../src/config/app-config.service';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const describeWithAuthenticationDatabase = environment ? describe : describe.skip;

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
  }, 60_000);

  beforeEach(async () => {
    await cleanTransientState();
  });

  afterAll(async () => {
    await app?.close();
    if (adminPoolInitialized) {
      await removeFixtures();
      await adminPool.end();
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
});
