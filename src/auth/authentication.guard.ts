import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { isUuid } from '../common/logging/request-id';
import type { TenantTransactionContext } from '../database/database.types';
import { AuthenticationDatabaseService } from './auth-database.service';
import type { AuthenticatedPrincipal } from './auth.types';
import { TokenService } from './token.service';

export interface AuthenticatedRequest extends Request {
  principal: AuthenticatedPrincipal;
  tenantContext: TenantTransactionContext;
}

@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly database: AuthenticationDatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const authorization = request.headers.authorization;
    const token = this.extractBearerToken(authorization);

    try {
      const claims = await this.tokens.verifyAccessToken(token);
      const principal = await this.database.validateSession(
        claims.userId,
        claims.sessionId,
        claims.storeId,
        claims.deviceId,
        claims.tokenId,
      );
      if (!principal) {
        throw new Error('Session validation failed.');
      }

      const requestId = request.id;
      if (typeof requestId !== 'string' || !isUuid(requestId)) {
        throw new Error('Request context validation failed.');
      }

      const authenticatedRequest = request as AuthenticatedRequest;
      authenticatedRequest.principal = principal;
      authenticatedRequest.tenantContext = {
        storeId: principal.storeId,
        userId: principal.userId,
        deviceId: principal.deviceId,
        requestId,
      };
      return true;
    } catch {
      throw new UnauthorizedException({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication is required.',
      });
    }
  }

  private extractBearerToken(authorization: string | undefined): string {
    if (!authorization) {
      return '';
    }

    const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization);
    return match?.[1] ?? '';
  }
}
