import { Injectable } from '@nestjs/common';
import { jwtVerify, SignJWT, type JWTVerifyGetKey } from 'jose';

import { isUuid } from '../common/logging/request-id';
import { AppConfigService } from '../config/app-config.service';
import type {
  AuthenticatedPrincipal,
  SyncAuthenticatedPrincipal,
  VerifiedAccessToken,
  VerifiedSyncPushToken,
} from './auth.types';

export class InvalidAccessTokenError extends Error {
  constructor() {
    super('The access token is invalid.');
    this.name = 'InvalidAccessTokenError';
  }
}

export class InvalidSyncPushTokenError extends Error {
  constructor() {
    super('The sync push token is invalid.');
    this.name = 'InvalidSyncPushTokenError';
  }
}

@Injectable()
export class TokenService {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly activeKeyId: string;
  private readonly signingKeys: ReadonlyMap<string, Uint8Array>;
  readonly accessTokenTtlSeconds: number;

  constructor(config: AppConfigService) {
    const tokenConfig = config.authenticationTokens;
    this.issuer = tokenConfig.issuer;
    this.audience = tokenConfig.audience;
    this.activeKeyId = tokenConfig.activeKeyId;
    this.accessTokenTtlSeconds = tokenConfig.accessTokenTtlSeconds;
    this.signingKeys = new Map([
      [
        tokenConfig.activeKeyId,
        Uint8Array.from(Buffer.from(tokenConfig.activeSecret, 'base64url')),
      ],
      ...Object.entries(tokenConfig.previousSecrets).map(
        ([keyId, secret]) => [keyId, Uint8Array.from(Buffer.from(secret, 'base64url'))] as const,
      ),
    ]);
  }

  async issueAccessToken(
    principal: Pick<AuthenticatedPrincipal, 'userId' | 'sessionId' | 'storeId' | 'deviceId'>,
    tokenId: string,
  ): Promise<string> {
    return this.issueToken(principal, tokenId, 'access');
  }

  async issueSyncPushToken(
    principal: Pick<SyncAuthenticatedPrincipal, 'userId' | 'sessionId' | 'storeId' | 'deviceId'>,
    tokenId: string,
  ): Promise<string> {
    return this.issueToken(principal, tokenId, 'sync_push');
  }

  async verifyAccessToken(token: string): Promise<VerifiedAccessToken> {
    return this.verifyToken(token, 'access', () => new InvalidAccessTokenError());
  }

  async verifySyncPushToken(token: string): Promise<VerifiedSyncPushToken> {
    return this.verifyToken(token, 'sync_push', () => new InvalidSyncPushTokenError());
  }

  private async issueToken(
    principal: Pick<AuthenticatedPrincipal, 'userId' | 'sessionId' | 'storeId' | 'deviceId'>,
    tokenId: string,
    tokenType: 'access' | 'sync_push',
  ): Promise<string> {
    const signingKey = this.signingKeys.get(this.activeKeyId);
    if (!signingKey) {
      throw new Error('The active access-token signing key is unavailable.');
    }

    return new SignJWT({
      typ: tokenType,
      sid: principal.sessionId,
      store_id: principal.storeId,
      device_id: principal.deviceId,
    })
      .setProtectedHeader({
        alg: 'HS256',
        kid: this.activeKeyId,
        typ: 'JWT',
      })
      .setSubject(principal.userId)
      .setJti(tokenId)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt()
      .setExpirationTime(`${String(this.accessTokenTtlSeconds)}s`)
      .sign(signingKey);
  }

  private async verifyToken(
    token: string,
    expectedType: 'access' | 'sync_push',
    invalidToken: () => Error,
  ): Promise<VerifiedAccessToken> {
    if (token.length < 64 || token.length > 4_096) {
      throw invalidToken();
    }

    const resolveKey: JWTVerifyGetKey = (protectedHeader) => {
      if (
        protectedHeader.alg !== 'HS256' ||
        protectedHeader.typ !== 'JWT' ||
        typeof protectedHeader.kid !== 'string'
      ) {
        throw invalidToken();
      }

      const key = this.signingKeys.get(protectedHeader.kid);
      if (!key) {
        throw invalidToken();
      }
      return key;
    };

    try {
      const result = await jwtVerify(token, resolveKey, {
        algorithms: ['HS256'],
        issuer: this.issuer,
        audience: this.audience,
        requiredClaims: ['sub', 'jti', 'exp', 'iat', 'sid', 'store_id', 'device_id', 'typ'],
        clockTolerance: 5,
      });
      const { payload } = result;

      if (
        payload.typ !== expectedType ||
        typeof payload.sub !== 'string' ||
        typeof payload.sid !== 'string' ||
        typeof payload.store_id !== 'string' ||
        typeof payload.device_id !== 'string' ||
        typeof payload.jti !== 'string' ||
        typeof payload.exp !== 'number' ||
        ![payload.sub, payload.sid, payload.store_id, payload.device_id, payload.jti].every(isUuid)
      ) {
        throw invalidToken();
      }

      return {
        userId: payload.sub,
        sessionId: payload.sid,
        storeId: payload.store_id,
        deviceId: payload.device_id,
        tokenId: payload.jti,
        expiresAt: payload.exp,
      };
    } catch {
      throw invalidToken();
    }
  }
}
