import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { isUuid } from '../common/logging/request-id';
import type { TenantTransactionContext } from '../database/database.types';
import { AuthenticationDatabaseService } from './auth-database.service';
import type { SyncAuthenticatedPrincipal } from './auth.types';
import { TokenService } from './token.service';

export interface SyncAuthenticatedRequest extends Request {
  principal: SyncAuthenticatedPrincipal;
  tenantContext: TenantTransactionContext;
}

@Injectable()
export class SyncAuthenticationGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly database: AuthenticationDatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractBearerToken(request.headers.authorization);

    try {
      const claims = await this.tokens.verifySyncPushToken(token);
      const principal = await this.database.validateSyncSession(
        claims.userId,
        claims.sessionId,
        claims.storeId,
        claims.deviceId,
      );
      if (!principal) throw new Error('Sync session validation failed.');

      const requestId = request.id;
      if (typeof requestId !== 'string' || !isUuid(requestId)) {
        throw new Error('Request context validation failed.');
      }

      const authenticatedRequest = request as SyncAuthenticatedRequest;
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
        code: 'SYNC_AUTHENTICATION_REQUIRED',
        message: 'Sync authentication is required.',
      });
    }
  }

  private extractBearerToken(authorization: string | undefined): string {
    if (!authorization) return '';
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization);
    return match?.[1] ?? '';
  }
}
