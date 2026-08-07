import type { PinoLogger } from 'nestjs-pino';
import type { Pool } from 'pg';

import { AuthenticationDatabaseService } from './auth-database.service';

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
