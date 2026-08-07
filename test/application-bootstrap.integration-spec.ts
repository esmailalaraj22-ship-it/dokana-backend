import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Server } from 'node:http';
import { Logger } from 'nestjs-pino';
import request from 'supertest';

import { configureApplication } from '../src/bootstrap';
import { AppConfigService } from '../src/config/app-config.service';
import { isUuid } from '../src/common/logging/request-id';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

describe('application bootstrap', () => {
  let app: INestApplication | undefined;
  let server: Server;

  beforeAll(async () => {
    process.env.APP_ENV = 'test';
    process.env.APP_PORT = '3108';
    process.env.DATABASE_URL = 'postgresql://runtime:password@127.0.0.1:1/dokana';
    process.env.AUTH_DATABASE_URL = 'postgresql://auth:password@127.0.0.1:1/dokana';
    process.env.DATABASE_SSL_MODE = 'disable';
    process.env.DB_CONNECTION_TIMEOUT_MS = '100';
    process.env.HEALTH_CHECK_TIMEOUT_MS = '100';
    process.env.LOG_LEVEL = 'silent';
    process.env.REQUEST_BODY_LIMIT_BYTES = '1024';
    process.env.AUTH_ACCESS_TOKEN_ACTIVE_KID = 'test-v1';
    process.env.AUTH_ACCESS_TOKEN_ACTIVE_SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

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
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it('starts the complete module graph and serves liveness without PostgreSQL', async () => {
    const response = await request(server).get('/health/live').expect(200);

    expect(response.body).toMatchObject({
      status: 'up',
      environment: 'test',
    });
    const requestIdHeader: unknown = response.headers['x-request-id'];
    if (typeof requestIdHeader !== 'string') {
      throw new Error('Expected x-request-id response header.');
    }
    expect(isUuid(requestIdHeader)).toBe(true);
  });

  it('reports not ready while runtime and authentication databases are unavailable', async () => {
    const response = await request(server).get('/health/ready').expect(503);

    expect(response.body).toMatchObject({
      status: 'down',
      checks: {
        application: { status: 'up' },
        database: { status: 'down' },
        authenticationDatabase: { status: 'down' },
      },
    });
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toMatch(/postgres(ql)?:\/\//);
    expect(serialized).not.toContain('password');
  }, 15_000);

  it('returns a traced structured 413 response for oversized JSON', async () => {
    const response = await request(server)
      .post('/v1/not-found')
      .send({ payload: 'x'.repeat(2_048) })
      .expect(413);

    expect(response.body).toMatchObject({
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
      path: '/v1/not-found',
    });
    const responseBody: unknown = response.body;
    if (!isRecord(responseBody) || typeof responseBody.requestId !== 'string') {
      throw new Error('Expected request ID in the error response.');
    }
    expect(isUuid(responseBody.requestId)).toBe(true);
  });
});
