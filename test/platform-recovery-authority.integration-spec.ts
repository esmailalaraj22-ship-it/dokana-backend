import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type { PinoLogger } from 'nestjs-pino';
import type { Pool, PoolClient } from 'pg';

import { applyMigration, verifyMigrationSession } from '../scripts/migrate';
import { withDatabase } from '../scripts/recovery/recovery-target';
import { AuthenticationDatabaseService } from '../src/auth/auth-database.service';
import type { AuthenticatedPrincipal, SessionIssueInput } from '../src/auth/auth.types';
import {
  createInventoryTestDatabase,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const migrationFilename = '0033_platform_recovery_generation_fencing.sql';
const environment = readLocalPostgresTestEnvironment();
const describeWithPostgres = environment ? describe : describe.skip;

jest.setTimeout(300_000);

interface RecoveryControlRow {
  recoveryGenerationId: string;
  serviceState: 'ACTIVE' | 'FENCED';
  authorityNotBefore: Date | null;
  fencedAt: Date | null;
}

function postgresErrorCode(error: unknown): string | undefined {
  let candidate: unknown = error;
  for (
    let depth = 0;
    depth < 5 && typeof candidate === 'object' && candidate !== null;
    depth += 1
  ) {
    if ('code' in candidate && typeof candidate.code === 'string') return candidate.code;
    candidate = 'cause' in candidate ? candidate.cause : undefined;
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

async function readControl(client: PoolClient): Promise<RecoveryControlRow> {
  const result = await client.query<RecoveryControlRow>(`
    select
      recovery_generation_id as "recoveryGenerationId",
      service_state as "serviceState",
      authority_not_before as "authorityNotBefore",
      fenced_at as "fencedAt"
    from platform.read_platform_recovery_control_v1()
  `);
  const row = result.rows[0];
  if (!row) throw new Error('Recovery control is unavailable.');
  return row;
}

describeWithPostgres('S22.4 platform recovery authority', () => {
  let database: InventoryTestDatabase;
  let migration: PoolClient;
  let auth: Pool;
  let authDatabase: AuthenticationDatabaseService;
  let initial: RecoveryControlRow;
  let authFixture: AuthFixture;

  beforeAll(async () => {
    if (!environment) throw new Error('Local PostgreSQL integration environment is unavailable.');
    database = await createInventoryTestDatabase(migrationFilename);
    migration = await database.migration.connect();
    await verifyMigrationSession(migration);
    await applyMigration(migration, database.file);
    auth = createTestPool(
      withDatabase(environment.authUrl, database.databaseName),
      'dokana-recovery-auth',
      4,
    );
    authDatabase = new AuthenticationDatabaseService(auth, {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as PinoLogger);
    initial = await readControl(migration);
  });

  afterAll(async () => {
    migration.release();
    await auth.end();
    await database.close();
  });

  it('applies 32 to 33 without a false recovery cutover and hardens the singleton', async () => {
    const ledger = await database.admin.query<{ count: number; latest: string }>(`
      select count(*)::integer as count, max(filename) as latest
      from platform.schema_migrations
    `);
    expect(ledger.rows[0]).toEqual({ count: 33, latest: migrationFilename });
    expect(initial).toMatchObject({
      serviceState: 'ACTIVE',
      authorityNotBefore: null,
      fencedAt: null,
    });
    expect(initial.recoveryGenerationId).toMatch(/^[0-9a-f-]{36}$/);

    const security = await database.admin.query<{
      rowSecurity: boolean;
      forceRowSecurity: boolean;
      runtimeTableAccess: boolean;
      runtimeFenceExecute: boolean;
      runtimeAssertExecute: boolean;
    }>(`
      select
        relation.relrowsecurity as "rowSecurity",
        relation.relforcerowsecurity as "forceRowSecurity",
        has_table_privilege('shop_app_runtime', relation.oid, 'SELECT,INSERT,UPDATE,DELETE')
          as "runtimeTableAccess",
        has_function_privilege(
          'shop_app_runtime', 'platform.fence_platform_recovery_v1(uuid)', 'EXECUTE'
        ) as "runtimeFenceExecute",
        has_function_privilege(
          'shop_app_runtime', 'ledger.assert_platform_write_authority_v1(uuid)', 'EXECUTE'
        ) as "runtimeAssertExecute"
      from pg_class as relation
      where relation.oid = 'platform.recovery_control'::regclass
    `);
    expect(security.rows[0]).toEqual({
      rowSecurity: true,
      forceRowSecurity: true,
      runtimeTableAccess: false,
      runtimeFenceExecute: false,
      runtimeAssertExecute: true,
    });
    await expectPostgresError(
      database.runtime.query(`select * from platform.recovery_control`),
      '42501',
    );
    await expectPostgresError(
      database.runtime.query(`select * from platform.fence_platform_recovery_v1($1::uuid)`, [
        initial.recoveryGenerationId,
      ]),
      '42501',
    );
  });

  it('rolls back fencing without changing committed authority', async () => {
    await migration.query('begin');
    await migration.query(`select * from platform.fence_platform_recovery_v1($1::uuid)`, [
      initial.recoveryGenerationId,
    ]);
    await migration.query('rollback');
    expect(await readControl(migration)).toEqual(initial);
  });

  it('issues an authoritative session before a true recovery cutover', async () => {
    authFixture = await createAuthFixture(database.admin, authDatabase);
  });

  it('serializes login, fencing, activation, and fresh post-recovery authority', async () => {
    const admitted = await database.runtime.connect();
    let admittedReleased = false;
    const operator = migration;
    const fenceRace = await auth.connect();
    let fenceRaceReleased = false;
    const fenceRaceFixture = nextAuthAttempt(authFixture, { deviceId: randomUUID() });
    try {
      await admitted.query('begin');
      await admitted.query(`select * from ledger.assert_platform_write_authority_v1($1::uuid)`, [
        initial.recoveryGenerationId,
      ]);
      await beginLegacySession(fenceRace, fenceRaceFixture);

      let fenceResolved = false;
      const fence = operator
        .query(
          `select service_state as "serviceState"
           from platform.fence_platform_recovery_v1($1::uuid)`,
          [initial.recoveryGenerationId],
        )
        .then((result) => {
          fenceResolved = true;
          return result;
        });
      await delay(150);
      expect(fenceResolved).toBe(false);
      await admitted.query('commit');
      admitted.release();
      admittedReleased = true;
      const fenced = (await fence).rows[0] as RecoveryControlRow | undefined;
      expect(fenced?.serviceState).toBe('FENCED');

      await expectPostgresError(validateIssuedSession(fenceRace, fenceRaceFixture), '55000');
      await fenceRace.query('rollback');
      fenceRace.release();
      fenceRaceReleased = true;
      await expectNoAuthResidue(database.admin, fenceRaceFixture);

      const deviceBefore = await readDeviceMutation(database.admin, authFixture.deviceId);
      const fencedAttempt = nextAuthAttempt(authFixture);
      await expectPostgresError(issueAuthSession(authDatabase, fencedAttempt), '55000');
      expect(await readDeviceMutation(database.admin, authFixture.deviceId)).toEqual(deviceBefore);
      await expectNoSessionResidue(database.admin, fencedAttempt);

      await expectPostgresError(
        database.runtime.query(
          `select * from ledger.assert_platform_write_authority_v1($1::uuid)`,
          [initial.recoveryGenerationId],
        ),
        '55000',
      );
      await expectPostgresError(
        operator.query(`select * from platform.activate_new_recovery_generation_v1($1::uuid)`, [
          '00000000-0000-4000-8000-000000000000',
        ]),
        '55000',
      );
      expect((await readControl(operator)).serviceState).toBe('FENCED');

      const activationRace = await auth.connect();
      let activationRaceReleased = false;
      const activationRaceFixture = nextAuthAttempt(authFixture, { deviceId: randomUUID() });
      try {
        await beginLegacySession(activationRace, activationRaceFixture);

        const activation = await operator.query<RecoveryControlRow>(
          `select
             recovery_generation_id as "recoveryGenerationId",
             service_state as "serviceState",
             authority_not_before as "authorityNotBefore",
             fenced_at as "fencedAt"
           from platform.activate_new_recovery_generation_v1($1::uuid)`,
          [initial.recoveryGenerationId],
        );
        const activated = activation.rows[0];
        expect(activated?.serviceState).toBe('ACTIVE');
        expect(activated?.recoveryGenerationId).not.toBe(initial.recoveryGenerationId);
        expect(activated?.authorityNotBefore).toBeInstanceOf(Date);
        expect(activated?.fencedAt).toBeInstanceOf(Date);

        await expectPostgresError(
          validateIssuedSession(activationRace, activationRaceFixture),
          '28000',
        );
        await activationRace.query('rollback');
        activationRace.release();
        activationRaceReleased = true;
        await expectNoAuthResidue(database.admin, activationRaceFixture);

        await expectPostgresError(
          auth.query(
            `select * from auth_api.validate_session_recovery_v1(
               $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid
             )`,
            [
              authFixture.userId,
              authFixture.sessionId,
              authFixture.storeId,
              authFixture.deviceId,
              authFixture.accessTokenJti,
            ],
          ),
          '28000',
        );
        await expectPostgresError(
          auth.query(
            `select * from auth_api.rotate_refresh_token_recovery_v1(
               $1::text,$2::uuid,$3::text,$4::uuid,$5::integer
             )`,
            [authFixture.refreshTokenHash, randomUUID(), opaqueHash(), randomUUID(), 3600],
          ),
          '28000',
        );

        const freshSession = await issueAuthSession(authDatabase, nextAuthAttempt(authFixture));
        expect(freshSession.recoveryGenerationId).toBe(activated?.recoveryGenerationId);

        const concurrent = await Promise.all([
          issueAuthSession(authDatabase, nextAuthAttempt(authFixture)),
          issueAuthSession(authDatabase, nextAuthAttempt(authFixture)),
        ]);
        expect(concurrent.map((principal) => principal.recoveryGenerationId)).toEqual([
          activated?.recoveryGenerationId,
          activated?.recoveryGenerationId,
        ]);

        await expectPostgresError(
          database.runtime.query(
            `select * from ledger.assert_platform_write_authority_v1($1::uuid)`,
            [initial.recoveryGenerationId],
          ),
          '55000',
        );
        await expect(
          database.runtime.query(
            `select * from ledger.assert_platform_write_authority_v1($1::uuid)`,
            [activated?.recoveryGenerationId],
          ),
        ).resolves.toMatchObject({ rowCount: 1 });
        await expectPostgresError(
          operator.query(`select * from platform.activate_new_recovery_generation_v1($1::uuid)`, [
            activated?.recoveryGenerationId,
          ]),
          '55000',
        );
      } finally {
        if (!activationRaceReleased) {
          await activationRace.query('rollback').catch(() => undefined);
          activationRace.release();
        }
      }
    } finally {
      if (!admittedReleased) {
        await admitted.query('rollback').catch(() => undefined);
        admitted.release();
      }
      if (!fenceRaceReleased) {
        await fenceRace.query('rollback').catch(() => undefined);
        fenceRace.release();
      }
    }
  });
});

interface AuthFixture {
  userId: string;
  storeId: string;
  deviceId: string;
  sessionId: string;
  accessTokenJti: string;
  refreshTokenId: string;
  refreshTokenHash: string;
  refreshFamilyId: string;
}

async function createAuthFixture(
  admin: Pool,
  authDatabase: AuthenticationDatabaseService,
): Promise<AuthFixture> {
  const fixture: AuthFixture = {
    userId: randomUUID(),
    storeId: randomUUID(),
    deviceId: randomUUID(),
    sessionId: randomUUID(),
    accessTokenJti: randomUUID(),
    refreshTokenId: randomUUID(),
    refreshTokenHash: opaqueHash(),
    refreshFamilyId: randomUUID(),
  };
  await admin.query(
    `insert into ledger.stores (id,name,status) values ($1,'Recovery Auth','active')`,
    [fixture.storeId],
  );
  await admin.query(
    `insert into platform.users (
       id,email,normalized_email,password_hash,full_name,status
     ) values ($1,$2,$2,'not-used','Recovery Auth','active')`,
    [fixture.userId, `recovery-${fixture.userId}@example.test`],
  );
  await admin.query(
    `insert into platform.store_memberships (id,store_id,user_id,role,status)
     values ($1,$2,$3,'owner','active')`,
    [randomUUID(), fixture.storeId, fixture.userId],
  );
  const issued = await issueAuthSession(authDatabase, fixture);
  expect(issued.recoveryGenerationId).toMatch(/^[0-9a-f-]{36}$/);
  return fixture;
}

async function issueAuthSession(
  authDatabase: AuthenticationDatabaseService,
  fixture: AuthFixture,
): Promise<AuthenticatedPrincipal> {
  const issued = await authDatabase.issueSession(sessionInput(fixture));
  if (!issued) throw new Error('Recovery auth fixture session was not issued.');
  return issued;
}

async function beginLegacySession(client: PoolClient, fixture: AuthFixture): Promise<void> {
  const input = sessionInput(fixture);
  await client.query('begin');
  await client.query(
    `select session_id
     from auth_api.issue_session(
       $1::uuid,$2::uuid,$3::uuid,$4::text,$5::text,$6::uuid,$7::uuid,
       $8::uuid,$9::text,$10::uuid,$11::timestamptz,$12::timestamptz,$13::text,$14::text
     )`,
    [
      input.userId,
      input.storeId,
      input.deviceId,
      input.deviceName,
      input.devicePlatform,
      input.sessionId,
      input.accessTokenJti,
      input.refreshTokenId,
      input.refreshTokenHash,
      input.refreshFamilyId,
      input.sessionExpiresAt,
      input.refreshExpiresAt,
      null,
      null,
    ],
  );
}

function validateIssuedSession(client: PoolClient, fixture: AuthFixture): Promise<unknown> {
  return client.query(
    `select * from auth_api.validate_session_recovery_v1(
       $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid
     )`,
    [fixture.userId, fixture.sessionId, fixture.storeId, fixture.deviceId, fixture.accessTokenJti],
  );
}

function sessionInput(fixture: AuthFixture): SessionIssueInput {
  return {
    ...fixture,
    deviceName: 'Recovery auth device',
    devicePlatform: 'android',
    sessionExpiresAt: new Date(Date.now() + 48 * 60 * 60 * 1_000),
    refreshExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
  };
}

function nextAuthAttempt(fixture: AuthFixture, overrides: Partial<AuthFixture> = {}): AuthFixture {
  return {
    ...fixture,
    sessionId: randomUUID(),
    accessTokenJti: randomUUID(),
    refreshTokenId: randomUUID(),
    refreshTokenHash: opaqueHash(),
    refreshFamilyId: randomUUID(),
    ...overrides,
  };
}

function opaqueHash(): string {
  return `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
}

async function expectNoSessionResidue(admin: Pool, fixture: AuthFixture): Promise<void> {
  const residue = await admin.query<{ sessions: number; refreshTokens: number }>(
    `select
       (select count(*)::integer from platform.auth_sessions where id = $1) as sessions,
       (select count(*)::integer from platform.refresh_tokens where id = $2) as "refreshTokens"`,
    [fixture.sessionId, fixture.refreshTokenId],
  );
  expect(residue.rows[0]).toEqual({ sessions: 0, refreshTokens: 0 });
}

async function expectNoAuthResidue(admin: Pool, fixture: AuthFixture): Promise<void> {
  await expectNoSessionResidue(admin, fixture);
  const device = await admin.query<{ count: number }>(
    `select count(*)::integer as count from ledger.devices where id = $1`,
    [fixture.deviceId],
  );
  expect(device.rows[0]?.count).toBe(0);
}

async function readDeviceMutation(
  admin: Pool,
  deviceId: string,
): Promise<{ version: string; lastSeenAt: Date | null }> {
  const state = await admin.query<{ version: string; lastSeenAt: Date | null }>(
    `select version::text as version, last_seen_at as "lastSeenAt"
     from ledger.devices where id = $1`,
    [deviceId],
  );
  const row = state.rows[0];
  if (!row) throw new Error('Recovery auth fixture device is unavailable.');
  return row;
}
