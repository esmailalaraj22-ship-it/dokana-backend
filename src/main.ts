import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { configureApplication } from './bootstrap';
import { AppConfigService } from './config/app-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    bufferLogs: true,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);

  const config = app.get(AppConfigService);
  configureApplication(app, config);

  await app.listen(config.port);

  logger.log({
    event: 'application_started',
    environment: config.environment,
    port: config.port,
    apiVersion: config.apiVersion,
  });
}

void bootstrap().catch((error: unknown) => {
  const message =
    error instanceof Error && error.message.startsWith('Environment validation failed:')
      ? error.message
      : 'Application startup failed.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
