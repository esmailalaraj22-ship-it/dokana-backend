import { Module } from '@nestjs/common';
import { LoggerModule, type Params } from 'nestjs-pino';
import type { DestinationStream } from 'pino';

import { AppConfigService } from '../../config/app-config.service';
import { ApplicationConfigModule } from '../../config/config.module';
import { isUuid, resolveRequestId } from './request-id';
import { requestPathForObservability } from './request-path';

type PinoHttpOptions = Exclude<
  NonNullable<Params['pinoHttp']>,
  DestinationStream | [unknown, DestinationStream]
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function serializeRequestForLogging(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }

  return {
    id: value.id,
    method: value.method,
    url: requestPathForObservability(value.url),
  };
}

export function serializeResponseForLogging(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }

  return {
    statusCode: value.statusCode,
  };
}

export function createLoggingParams(
  config: AppConfigService,
  destination?: DestinationStream,
): Params {
  const pinoHttp: PinoHttpOptions = {
    level: config.logLevel,
    quietReqLogger: true,
    genReqId: (request, response) => {
      const existingRequestId =
        typeof request.id === 'string' && isUuid(request.id) ? request.id : undefined;
      const requestId =
        existingRequestId ??
        resolveRequestId(request.headers[config.requestIdHeader], config.trustIncomingRequestId);
      response.setHeader(config.requestIdHeader, requestId);
      return requestId;
    },
    customProps: (request) => ({
      requestId: request.id,
    }),
    serializers: {
      req: serializeRequestForLogging,
      res: serializeResponseForLogging,
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.body.password',
        'req.body.accessToken',
        'req.body.refreshToken',
        'req.body.licenseKey',
        'password',
        'token',
        'databaseUrl',
        'connectionString',
      ],
      censor: '[REDACTED]',
    },
  };

  return {
    pinoHttp: destination === undefined ? pinoHttp : [pinoHttp, destination],
  };
}

@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [ApplicationConfigModule],
      inject: [AppConfigService],
      useFactory: createLoggingParams,
    }),
  ],
  exports: [LoggerModule],
})
export class LoggingModule {}
