import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Injectable, UnauthorizedException } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import { REFRESH_TOKEN_BYTES } from './auth.constants';
import { AuthenticationDatabaseService } from './auth-database.service';
import type { AuthenticatedPrincipal, AuthenticationResponse, AuthorizedStore } from './auth.types';
import type { LoginDto } from './dto/login.dto';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

const authenticationFailure = {
  code: 'AUTHENTICATION_FAILED',
  message: 'Authentication failed.',
};

@Injectable()
export class AuthenticationService {
  private readonly refreshTokenTtlSeconds: number;
  private readonly sessionTtlSeconds: number;

  constructor(
    config: AppConfigService,
    private readonly database: AuthenticationDatabaseService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {
    const tokenConfig = config.authenticationTokens;
    this.refreshTokenTtlSeconds = tokenConfig.refreshTokenTtlSeconds;
    this.sessionTtlSeconds = tokenConfig.sessionTtlSeconds;
  }

  async login(
    input: LoginDto,
    requestMetadata: { ip?: string; userAgent?: string },
  ): Promise<AuthenticationResponse> {
    const normalizedEmail = input.email.trim().toLowerCase();
    const credentials = await this.safeCredentialLookup(normalizedEmail);
    const passwordMatches = await this.passwords.verify(input.password, credentials?.passwordHash);

    if (!passwordMatches || credentials?.userStatus !== 'active') {
      throw new UnauthorizedException(authenticationFailure);
    }

    const now = Date.now();
    const sessionId = randomUUID();
    const tokenId = randomUUID();
    const refreshTokenId = randomUUID();
    const refreshFamilyId = randomUUID();
    const refreshToken = this.createRefreshToken();
    const sessionExpiresAt = new Date(now + this.sessionTtlSeconds * 1_000);
    const refreshExpiresAt = new Date(now + this.refreshTokenTtlSeconds * 1_000);

    const unsignedPrincipal = {
      userId: credentials.userId,
      sessionId,
      storeId: input.storeId,
      deviceId: input.deviceId,
    };
    const accessToken = await this.tokens.issueAccessToken(unsignedPrincipal, tokenId);

    let principal: AuthenticatedPrincipal | undefined;
    try {
      principal = await this.database.issueSession({
        ...unsignedPrincipal,
        deviceName: input.deviceName,
        devicePlatform: input.devicePlatform,
        accessTokenJti: tokenId,
        refreshTokenId,
        refreshTokenHash: this.hashOpaqueValue(refreshToken),
        refreshFamilyId,
        sessionExpiresAt,
        refreshExpiresAt,
        ipHash: this.hashOptionalMetadata(requestMetadata.ip),
        userAgentHash: this.hashOptionalMetadata(requestMetadata.userAgent),
      });
    } catch {
      throw new UnauthorizedException(authenticationFailure);
    }

    if (!principal) {
      throw new UnauthorizedException(authenticationFailure);
    }

    return this.authenticationResponse(principal, accessToken, refreshToken);
  }

  async refresh(refreshToken: string): Promise<AuthenticationResponse> {
    const newRefreshToken = this.createRefreshToken();
    const newAccessTokenJti = randomUUID();
    const rotation = await this.database.rotateRefreshToken({
      currentTokenHash: this.hashOpaqueValue(refreshToken),
      newTokenId: randomUUID(),
      newTokenHash: this.hashOpaqueValue(newRefreshToken),
      newAccessTokenJti,
      refreshTtlSeconds: this.refreshTokenTtlSeconds,
    });

    if (
      rotation.outcome !== 'rotated' ||
      !rotation.userId ||
      !rotation.email ||
      !rotation.fullName ||
      !rotation.storeId ||
      !rotation.storeName ||
      !rotation.storeStatus ||
      (rotation.storeStatus !== 'active' && rotation.storeStatus !== 'read_only') ||
      !rotation.membershipRole ||
      !rotation.membershipVersion ||
      !rotation.deviceId ||
      !rotation.sessionId ||
      !rotation.sessionExpiresAt
    ) {
      throw new UnauthorizedException(authenticationFailure);
    }

    const principal: AuthenticatedPrincipal = {
      userId: rotation.userId,
      email: rotation.email,
      fullName: rotation.fullName,
      storeId: rotation.storeId,
      storeName: rotation.storeName,
      storeStatus: rotation.storeStatus,
      membershipRole: rotation.membershipRole,
      membershipVersion: rotation.membershipVersion,
      deviceId: rotation.deviceId,
      sessionId: rotation.sessionId,
      sessionExpiresAt: rotation.sessionExpiresAt,
    };
    const accessToken = await this.tokens.issueAccessToken(principal, newAccessTokenJti);

    return this.authenticationResponse(principal, accessToken, newRefreshToken);
  }

  async logout(principal: AuthenticatedPrincipal): Promise<void> {
    await this.database.revokeSession(principal.userId, principal.sessionId);
  }

  async listAuthorizedStores(userId: string): Promise<AuthorizedStore[]> {
    return this.database.listAuthorizedStores(userId);
  }

  private async safeCredentialLookup(
    normalizedEmail: string,
  ): Promise<Awaited<ReturnType<AuthenticationDatabaseService['lookupCredentials']>>> {
    try {
      return await this.database.lookupCredentials(normalizedEmail);
    } catch {
      throw new UnauthorizedException(authenticationFailure);
    }
  }

  private createRefreshToken(): string {
    return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  }

  private hashOpaqueValue(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private hashOptionalMetadata(value: string | undefined): string | undefined {
    return value ? this.hashOpaqueValue(value) : undefined;
  }

  private authenticationResponse(
    principal: AuthenticatedPrincipal,
    accessToken: string,
    refreshToken: string,
  ): AuthenticationResponse {
    return {
      tokenType: 'Bearer',
      accessToken,
      accessTokenExpiresInSeconds: this.tokens.accessTokenTtlSeconds,
      refreshToken,
      sessionExpiresAt: principal.sessionExpiresAt.toISOString(),
      identity: {
        id: principal.userId,
        email: principal.email,
        fullName: principal.fullName,
      },
      store: {
        id: principal.storeId,
        name: principal.storeName,
        status: principal.storeStatus,
      },
      membership: {
        role: principal.membershipRole,
        version: principal.membershipVersion,
      },
      deviceId: principal.deviceId,
      sessionId: principal.sessionId,
    };
  }
}
