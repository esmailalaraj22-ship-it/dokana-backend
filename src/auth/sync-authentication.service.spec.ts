import { createHash } from 'node:crypto';

import type { AuthenticationDatabaseService } from './auth-database.service';
import { SyncAuthenticationService } from './sync-authentication.service';
import type { SyncAuthenticatedPrincipal } from './auth.types';
import type { TokenService } from './token.service';

const principal: SyncAuthenticatedPrincipal = {
  userId: 'a417fabd-b3c8-409c-9db3-2d62fdce21fd',
  email: 'owner@example.test',
  fullName: 'Store Owner',
  storeId: '59e90f52-05aa-4bf4-af84-242686f712a8',
  storeName: 'Suspended Store',
  storeStatus: 'suspended',
  membershipRole: 'owner',
  membershipVersion: '1',
  deviceId: '873ef648-a779-4aaf-bf8b-936b092ecb93',
  sessionId: '18dcbf0a-acbe-48d6-88ed-cd1b078ddf41',
  sessionExpiresAt: new Date('2026-01-10T00:00:00.000Z'),
};

describe('SyncAuthenticationService', () => {
  const database = {
    validateSyncRefreshToken: jest.fn(),
  } as jest.Mocked<Pick<AuthenticationDatabaseService, 'validateSyncRefreshToken'>>;
  const tokens = {
    issueSyncPushToken: jest.fn(),
    accessTokenTtlSeconds: 900,
  } as unknown as jest.Mocked<Pick<TokenService, 'issueSyncPushToken'>> & {
    accessTokenTtlSeconds: number;
  };
  const service = new SyncAuthenticationService(
    database as unknown as AuthenticationDatabaseService,
    tokens as unknown as TokenService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('hashes the refresh credential and returns only a sync-scoped token', async () => {
    database.validateSyncRefreshToken.mockResolvedValue(principal);
    tokens.issueSyncPushToken.mockResolvedValue('signed-sync-token');
    const refreshToken = 'local-refresh-token-sentinel';

    await expect(service.issueFromRefreshToken(refreshToken)).resolves.toEqual({
      tokenType: 'Bearer',
      syncToken: 'signed-sync-token',
      syncTokenExpiresInSeconds: 900,
      sessionExpiresAt: principal.sessionExpiresAt.toISOString(),
      store: { id: principal.storeId, status: 'suspended' },
      deviceId: principal.deviceId,
      sessionId: principal.sessionId,
    });
    expect(database.validateSyncRefreshToken).toHaveBeenCalledWith(
      createHash('sha256').update(refreshToken, 'utf8').digest('hex'),
    );
    expect(database.validateSyncRefreshToken).not.toHaveBeenCalledWith(refreshToken);
    expect(tokens.issueSyncPushToken).toHaveBeenCalledWith(principal, expect.any(String));
  });

  it.each(['missing principal', 'database failure'])('fails closed for %s', async (scenario) => {
    if (scenario === 'missing principal') {
      database.validateSyncRefreshToken.mockResolvedValue(undefined);
    } else {
      database.validateSyncRefreshToken.mockRejectedValue(new Error('database unavailable'));
    }

    await expect(service.issueFromRefreshToken('invalid-refresh-token')).rejects.toMatchObject({
      status: 401,
      response: { code: 'SYNC_AUTHENTICATION_FAILED' },
    });
    expect(tokens.issueSyncPushToken).not.toHaveBeenCalled();
  });
});
