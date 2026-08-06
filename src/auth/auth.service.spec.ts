import { randomUUID } from 'node:crypto';

import { UnauthorizedException } from '@nestjs/common';

import type { AppConfigService } from '../config/app-config.service';
import type { AuthenticationDatabaseService } from './auth-database.service';
import { AuthenticationService } from './auth.service';
import type {
  AuthenticatedPrincipal,
  AuthorizedStore,
  CredentialRecord,
  RefreshRotationResult,
} from './auth.types';
import type { LoginDto } from './dto/login.dto';
import type { PasswordService } from './password.service';
import type { TokenService } from './token.service';

const tokenConfiguration = {
  issuer: 'dokana-test',
  audience: 'dokana-test-client',
  activeKeyId: 'test-v1',
  activeSecret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  previousSecrets: {},
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  sessionTtlSeconds: 2_592_000,
};

const credentials: CredentialRecord = {
  userId: randomUUID(),
  passwordHash: '$argon2id$test',
  userStatus: 'active',
};

const loginInput: LoginDto = {
  email: ' Owner@Example.com ',
  password: 'correct-password',
  storeId: randomUUID(),
  deviceId: randomUUID(),
  deviceName: 'Owner phone',
  devicePlatform: 'android',
};

const principal: AuthenticatedPrincipal = {
  userId: credentials.userId,
  email: 'owner@example.com',
  fullName: 'Store Owner',
  storeId: loginInput.storeId,
  storeName: 'Test Store',
  storeStatus: 'active',
  membershipRole: 'owner',
  membershipVersion: '1',
  deviceId: loginInput.deviceId,
  sessionId: randomUUID(),
  sessionExpiresAt: new Date(Date.now() + 86_400_000),
};

function createHarness(): {
  service: AuthenticationService;
  database: jest.Mocked<
    Pick<
      AuthenticationDatabaseService,
      | 'lookupCredentials'
      | 'issueSession'
      | 'rotateRefreshToken'
      | 'revokeSession'
      | 'listAuthorizedStores'
    >
  >;
  passwords: jest.Mocked<Pick<PasswordService, 'verify'>>;
  tokens: jest.Mocked<Pick<TokenService, 'issueAccessToken'>> & {
    accessTokenTtlSeconds: number;
  };
} {
  const database = {
    lookupCredentials: jest.fn(),
    issueSession: jest.fn(),
    rotateRefreshToken: jest.fn(),
    revokeSession: jest.fn(),
    listAuthorizedStores: jest.fn(),
  };
  const passwords = {
    verify: jest.fn(),
  };
  const tokens = {
    issueAccessToken: jest.fn(),
    accessTokenTtlSeconds: 900,
  };
  const service = new AuthenticationService(
    { authenticationTokens: tokenConfiguration } as AppConfigService,
    database as unknown as AuthenticationDatabaseService,
    passwords as unknown as PasswordService,
    tokens as unknown as TokenService,
  );

  return { service, database, passwords, tokens };
}

function rotatedResult(overrides: Partial<RefreshRotationResult> = {}): RefreshRotationResult {
  return {
    outcome: 'rotated',
    userId: principal.userId,
    email: principal.email,
    fullName: principal.fullName,
    storeId: principal.storeId,
    storeName: principal.storeName,
    storeStatus: principal.storeStatus,
    membershipRole: principal.membershipRole,
    membershipVersion: principal.membershipVersion,
    deviceId: principal.deviceId,
    sessionId: principal.sessionId,
    sessionExpiresAt: principal.sessionExpiresAt,
    ...overrides,
  };
}

describe('AuthenticationService', () => {
  it('authenticates credentials and delegates atomic session/device issuance', async () => {
    const { service, database, passwords, tokens } = createHarness();
    database.lookupCredentials.mockResolvedValue(credentials);
    database.issueSession.mockResolvedValue(principal);
    passwords.verify.mockResolvedValue(true);
    tokens.issueAccessToken.mockResolvedValue('signed-access-token');

    const result = await service.login(loginInput, {
      ip: '127.0.0.1',
      userAgent: 'test-agent',
    });

    expect(database.lookupCredentials).toHaveBeenCalledWith('owner@example.com');
    expect(passwords.verify).toHaveBeenCalledWith(loginInput.password, credentials.passwordHash);
    const sessionInput = database.issueSession.mock.calls[0]?.[0];
    expect(sessionInput).toBeDefined();
    expect(sessionInput?.userId).toBe(credentials.userId);
    expect(sessionInput?.storeId).toBe(loginInput.storeId);
    expect(sessionInput?.deviceId).toBe(loginInput.deviceId);
    expect(sessionInput?.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionInput?.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionInput?.userAgentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result).toMatchObject({
      tokenType: 'Bearer',
      accessToken: 'signed-access-token',
      identity: { id: principal.userId },
      store: { id: principal.storeId },
      membership: { role: 'owner', version: '1' },
    });
    expect(result.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it.each([
    ['unknown identity', undefined, false, undefined],
    ['invalid password', credentials, false, undefined],
    ['disabled user', { ...credentials, userStatus: 'disabled' as const }, true, undefined],
    ['unauthorized store or device', credentials, true, undefined],
  ])(
    'returns the same generic rejection for %s',
    async (_label, credentialResult, passwordMatches, issuedPrincipal) => {
      const { service, database, passwords } = createHarness();
      database.lookupCredentials.mockResolvedValue(credentialResult);
      database.issueSession.mockResolvedValue(issuedPrincipal);
      passwords.verify.mockResolvedValue(passwordMatches);

      await expect(service.login(loginInput, {})).rejects.toMatchObject({
        response: {
          code: 'AUTHENTICATION_FAILED',
          message: 'Authentication failed.',
        },
        status: 401,
      });
    },
  );

  it('does not issue a session after failed credentials', async () => {
    const { service, database, passwords } = createHarness();
    database.lookupCredentials.mockResolvedValue(undefined);
    passwords.verify.mockResolvedValue(false);

    await expect(service.login(loginInput, {})).rejects.toBeInstanceOf(UnauthorizedException);
    expect(database.issueSession).not.toHaveBeenCalled();
  });

  it('rotates a refresh token and returns only the new raw token', async () => {
    const { service, database, tokens } = createHarness();
    database.rotateRefreshToken.mockResolvedValue(rotatedResult());
    tokens.issueAccessToken.mockResolvedValue('rotated-access-token');

    const result = await service.refresh('A'.repeat(43));

    const rotationInput = database.rotateRefreshToken.mock.calls[0]?.[0];
    expect(rotationInput).toBeDefined();
    expect(rotationInput?.currentTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rotationInput?.newTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rotationInput?.refreshTtlSeconds).toBe(2_592_000);
    expect(result.accessToken).toBe('rotated-access-token');
    expect(result.refreshToken).not.toBe('A'.repeat(43));
  });

  it.each(['invalid', 'reused'] as const)(
    'rejects the %s refresh outcome generically',
    async (outcome) => {
      const { service, database } = createHarness();
      database.rotateRefreshToken.mockResolvedValue(
        rotatedResult({
          outcome,
          userId: null,
          email: null,
          fullName: null,
          storeId: null,
          storeName: null,
          storeStatus: null,
          membershipRole: null,
          membershipVersion: null,
          deviceId: null,
          sessionId: null,
          sessionExpiresAt: null,
        }),
      );

      await expect(service.refresh('A'.repeat(43))).rejects.toMatchObject({
        status: 401,
      });
    },
  );

  it('revokes the authoritative session and lists only database-authorized stores', async () => {
    const { service, database } = createHarness();
    const stores: AuthorizedStore[] = [
      {
        storeId: principal.storeId,
        storeName: principal.storeName,
        currencyCode: 'ILS',
        storeStatus: 'active',
        membershipRole: 'owner',
        membershipVersion: '1',
      },
    ];
    database.revokeSession.mockResolvedValue(true);
    database.listAuthorizedStores.mockResolvedValue(stores);

    await expect(service.logout(principal)).resolves.toBeUndefined();
    await expect(service.listAuthorizedStores(principal.userId)).resolves.toEqual(stores);
    expect(database.revokeSession).toHaveBeenCalledWith(principal.userId, principal.sessionId);
  });
});
