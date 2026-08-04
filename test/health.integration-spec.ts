import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';

import type { AppConfigService } from '../src/config/app-config.service';
import { AppConfigService as AppConfigToken } from '../src/config/app-config.service';
import type { DatabaseService } from '../src/database/database.service';
import { DatabaseService as DatabaseToken } from '../src/database/database.service';
import { HealthController } from '../src/health/health.controller';
import { HealthService } from '../src/health/health.service';

describe('health endpoints', () => {
  let app: INestApplication;
  let server: Server;
  const database = {
    checkReadiness: jest.fn(),
  } as unknown as DatabaseService;
  const config = {
    environment: 'test',
    healthCheckTimeoutMs: 250,
  } as AppConfigService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        { provide: DatabaseToken, useValue: database },
        { provide: AppConfigToken, useValue: config },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
    server = app.getHttpServer() as Server;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live remains up without checking PostgreSQL', async () => {
    const response = await request(server).get('/health/live').expect(200);

    expect(response.body).toMatchObject({
      status: 'up',
      checks: {
        application: { status: 'up' },
      },
    });
    expect(database.checkReadiness).not.toHaveBeenCalled();
  });

  it('GET /health/ready returns 503 when PostgreSQL is not ready', async () => {
    jest.mocked(database.checkReadiness).mockResolvedValue({ ready: false, latencyMs: 251 });

    const response = await request(server).get('/health/ready').expect(503);

    expect(response.body).toMatchObject({
      status: 'down',
      checks: {
        database: { status: 'down', latencyMs: 251 },
      },
    });
  });

  it('GET /health returns 200 when all readiness checks pass', async () => {
    jest.mocked(database.checkReadiness).mockResolvedValue({ ready: true, latencyMs: 4 });

    const response = await request(server).get('/health').expect(200);

    expect(response.body).toMatchObject({
      status: 'up',
      checks: {
        application: { status: 'up' },
        database: { status: 'up', latencyMs: 4 },
      },
    });
  });
});
