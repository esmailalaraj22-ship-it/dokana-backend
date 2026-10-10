import { createHash, randomUUID } from 'node:crypto';

import { Injectable, UnauthorizedException } from '@nestjs/common';

import { AuthenticationDatabaseService } from './auth-database.service';
import type { SyncAuthenticationResponse } from './auth.types';
import { TokenService } from './token.service';

const syncAuthenticationFailure = {
  code: 'SYNC_AUTHENTICATION_FAILED',
  message: 'Sync authentication failed.',
};

@Injectable()
export class SyncAuthenticationService {
  constructor(
    private readonly database: AuthenticationDatabaseService,
    private readonly tokens: TokenService,
  ) {}

  async issueFromRefreshToken(refreshToken: string): Promise<SyncAuthenticationResponse> {
    let principal;
    try {
      const tokenHash = createHash('sha256').update(refreshToken, 'utf8').digest('hex');
      principal = await this.database.validateSyncRefreshToken(tokenHash);
    } catch {
      throw new UnauthorizedException(syncAuthenticationFailure);
    }

    if (!principal) {
      throw new UnauthorizedException(syncAuthenticationFailure);
    }

    const syncToken = await this.tokens.issueSyncPushToken(principal, randomUUID());
    return {
      tokenType: 'Bearer',
      syncToken,
      syncTokenExpiresInSeconds: this.tokens.accessTokenTtlSeconds,
      sessionExpiresAt: principal.sessionExpiresAt.toISOString(),
      store: {
        id: principal.storeId,
        status: principal.storeStatus,
      },
      deviceId: principal.deviceId,
      sessionId: principal.sessionId,
    };
  }
}
