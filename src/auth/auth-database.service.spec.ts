import type { PinoLogger } from 'nestjs-pino';
import type { Pool, PoolClient } from 'pg';

import { AuthenticationDatabaseService } from './auth-database.service';
import type { AuthenticatedPrincipal, SessionIssueInput } from './auth.types';

interface InspectionRow {
  sessionUser: string;
  currentUser: string;
  isSuperuser: boolean;
  bypassesRls: boolean;
  canCreateDatabases: boolean;
  canCreateRoles: boolean;
  canReplicate: boolean;
  rowSecurityEnabled: boolean;
  isAuthMember: boolean;
  canSetAuth: boolean;
  canSetAuthOwner: boolean;
  canSetMigrator: boolean;
  canSetRuntime: boolean;
  hasAuthSchemaUsage: boolean;
  hasAuthSchemaCreate: boolean;
  hasRestrictedSchemaUsage: boolean;
  hasProtectedTableAccess: boolean;
  ownsApplicationObjects: boolean;
}

function safeInspection(overrides: Partial<InspectionRow> = {}): InspectionRow {
  return {
    sessionUser: 'dokana_auth_login',
    currentUser: 'dokana_auth_login',
    isSuperuser: false,
    bypassesRls: false,
    canCreateDatabases: false,
    canCreateRoles: false,
    canReplicate: false,
    rowSecurityEnabled: true,
    isAuthMember: true,
    canSetAuth: false,
    canSetAuthOwner: false,
    canSetMigrator: false,
    canSetRuntime: false,
    hasAuthSchemaUsage: true,
    hasAuthSchemaCreate: false,
    hasRestrictedSchemaUsage: false,
    hasProtectedTableAccess: false,
    ownsApplicationObjects: false,
    ...overrides,
  };
}

describe('AuthenticationDatabaseService readiness', () => {
  const query = jest.fn();
  const pool = { query, on: jest.fn(), end: jest.fn() } as unknown as Pool;
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as PinoLogger;
  const service = new AuthenticationDatabaseService(pool, logger);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reports ready for the expected least-privileged authentication role', async () => {
    query.mockResolvedValue({ rows: [safeInspection()] });

    await expect(service.checkReadiness(250)).resolves.toMatchObject({ ready: true });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ query_timeout: 250 }));
  });

  it('reports not ready when the authentication database is unavailable', async () => {
    query.mockRejectedValue(new Error('connection refused'));

    await expect(service.checkReadiness(250)).resolves.toMatchObject({ ready: false });
  });

  it('reports not ready for an unexpected login identity', async () => {
    query.mockResolvedValue({
      rows: [safeInspection({ sessionUser: 'postgres', currentUser: 'postgres' })],
    });

    await expect(service.checkReadiness(250)).resolves.toMatchObject({ ready: false });
  });

  it('reports not ready for every over-privileged inspection deviation', async () => {
    const deviations: Partial<InspectionRow>[] = [
      { isSuperuser: true },
      { bypassesRls: true },
      { rowSecurityEnabled: false },
      { isAuthMember: false },
      { canSetAuthOwner: true },
      { canSetMigrator: true },
      { hasAuthSchemaUsage: false },
      { hasAuthSchemaCreate: true },
      { hasRestrictedSchemaUsage: true },
      { hasProtectedTableAccess: true },
      { ownsApplicationObjects: true },
    ];

    for (const deviation of deviations) {
      query.mockResolvedValue({ rows: [safeInspection(deviation)] });
      await expect(service.checkReadiness(250)).resolves.toMatchObject({ ready: false });
    }
  });

  it('verifies the boundary later even when the bootstrap check was unavailable', async () => {
    query.mockRejectedValueOnce(new Error('connection refused'));
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith({
      event: 'authentication_database_startup_check',
      status: 'unavailable',
    });

    query.mockResolvedValue({ rows: [safeInspection()] });
    await expect(service.checkReadiness(250)).resolves.toMatchObject({ ready: true });
  });

  it('never logs connection strings or credentials from readiness failures', async () => {
    query.mockRejectedValue(
      new Error('connect failed for postgresql://user:secret@localhost:5432/DOCANA'),
    );
    await service.onApplicationBootstrap();
    await service.checkReadiness(250);

    const loggedPayloads = [
      ...jest.mocked(logger.info).mock.calls,
      ...jest.mocked(logger.warn).mock.calls,
      ...jest.mocked(logger.error).mock.calls,
    ].flat();
    expect(JSON.stringify(loggedPayloads)).not.toContain('postgresql://');
    expect(JSON.stringify(loggedPayloads)).not.toContain('secret');
  });
});

describe('AuthenticationDatabaseService recovery-aware session issuance', () => {
  const query = jest.fn<
    Promise<{ rows: unknown[] }>,
    [text: string, values?: readonly unknown[]]
  >();
  const release = jest.fn();
  const client = { query, release } as unknown as PoolClient;
  const connect = jest.fn().mockResolvedValue(client);
  const pool = { connect, on: jest.fn(), end: jest.fn() } as unknown as Pool;
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as PinoLogger;
  const service = new AuthenticationDatabaseService(pool, logger);
  const input: SessionIssueInput = {
    userId: '9f97bb10-b68a-4474-888e-7244fc581bcb',
    storeId: '18dcbf0a-acde-48d6-88ed-cd1b078ddf41',
    deviceId: '59e90f52-05aa-4bf4-af84-242686f712a8',
    deviceName: 'Test device',
    devicePlatform: 'android',
    sessionId: '4b1c2573-f894-4da3-a795-349ae622aa2c',
    accessTokenJti: 'fc8b9fb8-7c18-4551-a6f8-624cb26e5e33',
    refreshTokenId: 'b1cf8f6c-d1e2-4a58-b6dd-7294fb98a220',
    refreshTokenHash: 'a'.repeat(64),
    refreshFamilyId: '59919848-6601-4e82-9e93-2a1d7580a53f',
    sessionExpiresAt: new Date('2026-10-22T00:00:00.000Z'),
    refreshExpiresAt: new Date('2026-10-23T00:00:00.000Z'),
  };
  const principal: AuthenticatedPrincipal = {
    userId: input.userId,
    email: 'owner@example.test',
    fullName: 'Owner',
    storeId: input.storeId,
    storeName: 'Store',
    storeStatus: 'active',
    membershipRole: 'owner',
    membershipVersion: '1',
    deviceId: input.deviceId,
    sessionId: input.sessionId,
    sessionExpiresAt: input.sessionExpiresAt,
    recoveryGenerationId: '7292c1b5-0f9a-44e1-9ef6-3b3b84e9c7a4',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    connect.mockResolvedValue(client);
  });

  it('issues and recovery-validates on one connection before committing', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            userId: input.userId,
            storeId: input.storeId,
            deviceId: input.deviceId,
            deviceStatus: 'active',
            sessionId: input.sessionId,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [principal] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(service.issueSession(input)).resolves.toEqual(principal);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenNthCalledWith(1, 'begin');
    expect(query.mock.calls[1]?.[0]).toContain('from auth_api.issue_session(');
    expect(query.mock.calls[1]?.[0]).not.toContain('issue_session_recovery_v1');
    expect(query.mock.calls[2]?.[0]).toContain('auth_api.validate_session_recovery_v1');
    expect(query).toHaveBeenNthCalledWith(4, 'commit');
    expect(query.mock.calls.some(([statement]) => statement === 'rollback')).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and releases the connection when recovery validation fails', async () => {
    const recoveryError = Object.assign(new Error('platform fenced'), { code: '55000' });
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            userId: input.userId,
            storeId: input.storeId,
            deviceId: input.deviceId,
            deviceStatus: 'active',
            sessionId: input.sessionId,
          },
        ],
      })
      .mockRejectedValueOnce(recoveryError)
      .mockResolvedValueOnce({ rows: [] });

    await expect(service.issueSession(input)).rejects.toBe(recoveryError);

    expect(query).toHaveBeenLastCalledWith('rollback');
    expect(query.mock.calls.some(([statement]) => statement === 'commit')).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rolls back malformed issuance results before recovery validation', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(service.issueSession(input)).rejects.toThrow(
      'Authentication session issuance returned an invalid result.',
    );

    expect(query).toHaveBeenLastCalledWith('rollback');
    expect(query.mock.calls.some(([statement]) => statement === 'commit')).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
