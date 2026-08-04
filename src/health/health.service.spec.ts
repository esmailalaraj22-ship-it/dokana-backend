import type { AppConfigService } from '../config/app-config.service';
import type { DatabaseService } from '../database/database.service';
import { HealthService } from './health.service';

describe('HealthService', () => {
  const database = {
    checkReadiness: jest.fn(),
  } as unknown as DatabaseService;
  const config = {
    environment: 'test',
    healthCheckTimeoutMs: 500,
  } as AppConfigService;
  const service = new HealthService(database, config);

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
  });

  it('reports readiness when the runtime connection is safe', async () => {
    jest.mocked(database.checkReadiness).mockResolvedValue({ ready: true, latencyMs: 7 });

    await expect(service.getReadiness()).resolves.toMatchObject({
      status: 'up',
      checks: {
        database: { status: 'up', latencyMs: 7 },
      },
    });
  });

  it('reports not ready without exposing a database error', async () => {
    jest.mocked(database.checkReadiness).mockResolvedValue({ ready: false, latencyMs: 501 });

    await expect(service.getReadiness()).resolves.toMatchObject({
      status: 'down',
      checks: {
        database: { status: 'down', latencyMs: 501 },
      },
    });
  });
});
