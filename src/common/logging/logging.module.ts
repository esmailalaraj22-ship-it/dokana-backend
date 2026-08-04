import { Module } from '@nestjs/common';
import { LoggerModule, type Params } from 'nestjs-pino';

import { AppConfigService } from '../../config/app-config.service';
import { ApplicationConfigModule } from '../../config/config.module';
import { isUuid, resolveRequestId } from './request-id';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function serializeRequest(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }

  return {
    id: value.id,
    method: value.method,
    url: value.url,
  };
}

function serializeResponse(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }

  return {
    statusCode: value.statusCode,
  };
}

@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [ApplicationConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): Params => ({
        pinoHttp: {
          level: config.logLevel,
          quietReqLogger: true,
          genReqId: (request, response) => {
            const existingRequestId =
              typeof request.id === 'string' && isUuid(request.id) ? request.id : undefined;
            const requestId =
              existingRequestId ??
              resolveRequestId(
                request.headers[config.requestIdHeader],
                config.trustIncomingRequestId,
              );
            response.setHeader(config.requestIdHeader, requestId);
            return requestId;
          },
          customProps: (request) => ({
            requestId: request.id,
          }),
          serializers: {
            req: serializeRequest,
            res: serializeResponse,
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
        },
      }),
    }),
  ],
  exports: [LoggerModule],
})
export class LoggingModule {}
