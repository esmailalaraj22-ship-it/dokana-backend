import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import helmet from 'helmet';

import { createValidationException } from './common/errors/validation-exception.factory';
import { createRequestIdMiddleware } from './common/logging/request-id.middleware';
import type { AppConfigService } from './config/app-config.service';

export function configureApplication(app: NestExpressApplication, config: AppConfigService): void {
  app.set('trust proxy', config.trustProxy ? 1 : false);

  app.use(createRequestIdMiddleware(config));
  app.use(helmet());
  app.use(
    json({
      limit: config.requestBodyLimitBytes,
      strict: true,
    }),
  );
  app.use(
    urlencoded({
      extended: false,
      limit: config.requestBodyLimitBytes,
    }),
  );

  if (config.corsOrigins.length > 0) {
    app.enableCors({
      origin: config.corsOrigins,
      credentials: false,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['accept', 'authorization', 'content-type', config.requestIdHeader],
      exposedHeaders: [config.requestIdHeader],
      maxAge: 600,
    });
  }

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      disableErrorMessages: false,
      exceptionFactory: createValidationException,
    }),
  );
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: config.apiVersion,
    prefix: 'v',
  });
  app.enableShutdownHooks();
}
