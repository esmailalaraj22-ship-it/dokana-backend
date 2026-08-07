import type { AuthenticationDatabaseService } from '../auth/auth-database.service';
import type { AppConfigService } from '../config/app-config.service';
import type { DatabaseService } from '../database/database.service';
import { HealthService } from './health.service';

describe('HealthService', () => {
  const database = {
    checkReadiness: jest.fn(),
  } as unknown as DatabaseService;
  const authenticationDatabase = {
    checkReadiness: jest.fn(),
  } as unknown as AuthenticationDatabaseService;
  const config = {
    environment: 'test',
    healthCheckTimeoutMs: 500,
  } as AppConfigService;
  const service = new HealthService(database, authenticationDatabase, config);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reports liveness without querying PostgreSQL', () => {
    expect(service.getLiveness()).toMatchObject({
      status: 'up',
      environment: 'test',
      checks: {
        application: { status: 'up' },
      },
    });
    expect(database.checkReadiness).not.toHaveBeenCalled();
    expect(authenticationDatabase.checkReadiness).not.toHaveBeenCalled();
  });

  it('reports readiness when the runtime and authentication boundaries are safe', async () => {
    jest.mocked(database.checkReadiness).mockResolvedValue({ ready: true, latencyMs: 7 });
    jest
      .mocked(authenticationDatabase.checkReadiness)
      .mockResolvedValue({ ready: true, latencyMs: 9 });

    await expect(service.getReadiness()).resolves.toMatchObject({
      status: 'up',
      checks: {
        database: { status: 'up', latencyMs: 7 },
        authenticationDatabase: { status: 'up', latencyMs: 9 },
      },
    });
    expect(authenticationDatabase.checkReadiness).toHaveBeenCalledWith(500);
  });

  it('reports not ready without exposing a database error', async () => {
    jest.mocked(database.checkReadiness).mockResolvedValue({ ready: false, latencyMs: 501 });
    jest
      .mocked(authenticationDatabase.checkReadiness)
      .mockResolvedValue({ ready: true, latencyMs: 3 });

    await expect(service.getReadiness()).resolves.toMatchObject({
      status: 'down',
      checks: {
        database: { status: 'down', latencyMs: 501 },
        authenticationDatabase: { status: 'up', latencyMs: 3 },
      },
    });
  });

  it('reports not ready while the authentication boundary is unverified', async () => {
    jest.mocked(database.checkReadiness).mockResolvedValue({ ready: true, latencyMs: 4 });
    jest
      .mocked(authenticationDatabase.checkReadiness)
      .mockResolvedValue({ ready: false, latencyMs: 502 });

    const readiness = await service.getReadiness();
    expect(readiness).toMatchObject({
      status: 'down',
      checks: {
        database: { status: 'up', latencyMs: 4 },
        authenticationDatabase: { status: 'down', latencyMs: 502 },
      },
    });
    expect(JSON.stringify(readiness)).not.toMatch(/postgres(ql)?:\/\//);
  });
});
