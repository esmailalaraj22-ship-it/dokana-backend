import type { PinoLogger } from 'nestjs-pino';
import type { Pool, PoolClient } from 'pg';

import { AuthenticationDatabaseService } from './auth-database.service';
import type {
  AuthenticatedPrincipal,
  SessionIssueInput,
  RefreshRotationResult,
} from './auth.types';

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

describe('AuthenticationDatabaseService refresh commit boundary', () => {
  const input = {
    currentTokenHash: 'a'.repeat(64),
    newTokenId: 'b1cf8f6c-d1e2-4a58-b6dd-7294fb98a220',
    newTokenHash: 'b'.repeat(64),
    newAccessTokenJti: 'fc8b9fb8-7c18-4551-a6f8-624cb26e5e33',
    refreshTtlSeconds: 3600,
  };
  function harness(outcome: RefreshRotationResult['outcome']) {
    const events: string[] = [];
    const query = jest.fn(async (statement: string) => {
      events.push(statement.trim().startsWith('select') ? 'rotate' : statement);
      return { rows: statement.trim().startsWith('select') ? [{ outcome }] : [] };
    });
    const release = jest.fn();
    const pool = {
      connect: jest.fn().mockResolvedValue({ query, release }),
      on: jest.fn(),
    } as unknown as Pool;
    const logger = { error: jest.fn() } as unknown as PinoLogger;
    return { service: new AuthenticationDatabaseService(pool, logger), query, release, events };
  }

  it.each(['invalid', 'reused'] as const)(
    'commits %s authority effects without signing a token',
    async (outcome) => {
      const { service, events, release } = harness(outcome);
      const prepare = jest.fn();
      await expect(service.rotateRefreshToken(input, prepare)).resolves.toBeUndefined();
      expect(events).toEqual(['begin', 'rotate', 'commit']);
      expect(prepare).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it('prepares the response before committing and returning it', async () => {
    const { service, events } = harness('rotated');
    await expect(
      service.rotateRefreshToken(input, async () => {
        events.push('prepare');
        return 'prepared';
      }),
    ).resolves.toBe('prepared');
    expect(events).toEqual(['begin', 'rotate', 'prepare', 'commit']);
  });

  it('preserves committed refresh response when release fails and discards the client', async () => {
    const { service, release, events } = harness('rotated');
    release.mockImplementationOnce(() => {
      throw new Error('release failed');
    });
    await expect(service.rotateRefreshToken(input, async () => 'prepared')).resolves.toBe(
      'prepared',
    );
    expect(events).toEqual(['begin', 'rotate', 'commit']);
    expect(release.mock.calls).toEqual([[], [true]]);
  });

  it('preserves refresh COMMIT failure when rollback also fails', async () => {
    const { service, query, release } = harness('rotated');
    const original = query.getMockImplementation();
    const primary = new Error('COMMIT failed');
    query.mockImplementation(async (statement) => {
      if (statement === 'commit') throw primary;
      if (statement === 'rollback') throw new Error('rollback failed');
      if (!original) throw new Error('Missing query implementation');
      return original(statement);
    });
    await expect(service.rotateRefreshToken(input, async () => 'prepared')).rejects.toBe(primary);
    expect(release).toHaveBeenCalledWith(true);
  });

  it('preserves signing failure when rollback and release also fail', async () => {
    const { service, query, release, events } = harness('rotated');
    const original = query.getMockImplementation();
    query.mockImplementation(async (statement) => {
      if (statement === 'rollback') throw new Error('rollback failure');
      if (!original) throw new Error('Missing query implementation');
      return original(statement);
    });
    release.mockImplementation(() => {
      throw new Error('release failure');
    });
    const primary = new Error('signing failure');
    await expect(
      service.rotateRefreshToken(input, async () => {
        throw primary;
      }),
    ).rejects.toBe(primary);
    expect(events).not.toContain('commit');
    expect(release).toHaveBeenCalledWith(true);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('discards an acquired client when BEGIN fails and preserves that error', async () => {
    const { service, query, release } = harness('rotated');
    const primary = new Error('BEGIN failure');
    query.mockRejectedValueOnce(primary);
    const prepare = jest.fn();
    await expect(service.rotateRefreshToken(input, prepare)).rejects.toBe(primary);
    expect(query).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(true);
  });
});

describe('AuthenticationDatabaseService recovery-aware session issuance', () => {
  const query = jest.fn<
    Promise<{ rows: unknown[] }>,
    [text: string, values?: readonly unknown[]]
  >();
  const release = jest.fn((error?: Error | boolean) => {
    void error;
  });
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
    query.mockReset();
    release.mockReset();
    connect.mockResolvedValue(client);
  });

  it('preserves committed issuance when release fails and discards the client', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...principal, deviceStatus: 'active' }] })
      .mockResolvedValueOnce({ rows: [principal] })
      .mockResolvedValueOnce({ rows: [] });
    release.mockImplementationOnce(() => {
      throw new Error('release failed');
    });
    await expect(service.issueSession(input)).resolves.toEqual(principal);
    expect(query).toHaveBeenLastCalledWith('commit');
    expect(release.mock.calls).toEqual([[], [true]]);
  });

  it('discards after BEGIN failure without masking it with a release failure', async () => {
    const primary = new Error('BEGIN failed');
    query.mockRejectedValueOnce(primary);
    release.mockImplementationOnce(() => {
      throw new Error('release failed');
    });
    await expect(service.issueSession(input)).rejects.toBe(primary);
    expect(query).toHaveBeenCalledTimes(1);
    expect(release.mock.calls).toEqual([[true], [true]]);
  });

  it('preserves issuance COMMIT failure when rollback and release also fail', async () => {
    const primary = new Error('COMMIT failed');
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...principal, deviceStatus: 'active' }] })
      .mockResolvedValueOnce({ rows: [principal] })
      .mockRejectedValueOnce(primary)
      .mockRejectedValueOnce(new Error('rollback failed'));
    release.mockImplementationOnce(() => {
      throw new Error('release failed');
    });
    await expect(service.issueSession(input)).rejects.toBe(primary);
    expect(query).toHaveBeenLastCalledWith('rollback');
    expect(release).toHaveBeenCalledWith(true);
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
    expect(release).toHaveBeenCalledWith(true);
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
    expect(release).toHaveBeenCalledWith(true);
  });

  it('discards the uncertain client while preserving the original error when rollback fails', async () => {
    const originalError = Object.assign(new Error('platform fenced'), { code: '55000' });
    const rollbackError = new Error(
      'rollback failed for postgresql://user:secret@localhost:5432/DOCANA',
    );
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(originalError)
      .mockRejectedValueOnce(rollbackError);

    await expect(service.issueSession(input)).rejects.toBe(originalError);

    expect(query).toHaveBeenLastCalledWith('rollback');
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(true);
    expect(logger.error).toHaveBeenCalledWith({
      event: 'authentication_transaction_rollback_failed',
      clientDiscarded: true,
    });
    expect(JSON.stringify(jest.mocked(logger.error).mock.calls)).not.toContain('postgresql://');
    expect(JSON.stringify(jest.mocked(logger.error).mock.calls)).not.toContain('secret');
  });
});
