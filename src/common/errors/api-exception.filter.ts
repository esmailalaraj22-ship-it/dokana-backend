import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  type ExceptionFilter,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Request, Response } from 'express';

import type { ApiErrorResponse } from './api-error-response';

interface ErrorPayload {
  code?: unknown;
  message?: unknown;
  details?: unknown;
}

const statusCodes: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'INVALID_REQUEST',
  [HttpStatus.UNAUTHORIZED]: 'AUTHENTICATION_REQUIRED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'PAYLOAD_TOO_LARGE',
  [HttpStatus.TOO_MANY_REQUESTS]: 'TOO_MANY_REQUESTS',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request & { id?: string }>();
    const response = context.getResponse<Response>();
    const isHttpException = exception instanceof HttpException;
    const statusCode = this.getStatusCode(exception);
    const payload = isHttpException ? exception.getResponse() : undefined;
    const parsedPayload = this.parsePayload(payload);
    const requestId = request.id;
    const code =
      parsedPayload.code ??
      statusCodes[statusCode] ??
      (statusCode >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR');

    if (statusCode >= 500) {
      this.logger.error({
        event: 'request_failed',
        requestId,
        path: request.originalUrl,
        method: request.method,
        statusCode,
        code,
        errorType: exception instanceof Error ? exception.name : 'UnknownError',
      });
    }

    const body: ApiErrorResponse = {
      statusCode,
      code,
      message:
        statusCode >= 500
          ? 'An unexpected error occurred.'
          : (parsedPayload.message ?? 'The request could not be completed.'),
      requestId,
      timestamp: new Date().toISOString(),
      path: request.originalUrl,
    };

    if (statusCode < 500 && parsedPayload.details !== undefined) {
      body.details = parsedPayload.details;
    }

    response.status(statusCode).json(body);
  }

  private parsePayload(payload: string | object | undefined): {
    code?: string;
    message?: string;
    details?: unknown;
  } {
    if (typeof payload === 'string') {
      return { message: payload };
    }

    if (!payload) {
      return {};
    }

    const errorPayload = payload as ErrorPayload;

    return {
      code: typeof errorPayload.code === 'string' ? errorPayload.code : undefined,
      message: typeof errorPayload.message === 'string' ? errorPayload.message : undefined,
      details: errorPayload.details,
    };
  }

  private getStatusCode(exception: unknown): number {
    if (exception instanceof HttpException) {
      return exception.getStatus();
    }

    if (typeof exception !== 'object' || exception === null) {
      return HttpStatus.INTERNAL_SERVER_ERROR;
    }

    const statusCandidate = 'status' in exception ? exception.status : undefined;
    const statusCodeCandidate = 'statusCode' in exception ? exception.statusCode : undefined;

    for (const candidate of [statusCandidate, statusCodeCandidate]) {
      if (
        typeof candidate === 'number' &&
        Number.isInteger(candidate) &&
        candidate >= 400 &&
        candidate <= 599
      ) {
        return candidate;
      }
    }

    return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}
