import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { AppConfigService } from '../../config/app-config.service';
import { resolveRequestId } from './request-id';

export function createRequestIdMiddleware(config: AppConfigService): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    const requestId = resolveRequestId(
      request.headers[config.requestIdHeader],
      config.trustIncomingRequestId,
    );
    request.id = requestId;
    response.setHeader(config.requestIdHeader, requestId);
    next();
  };
}
