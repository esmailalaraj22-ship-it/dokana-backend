import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthenticationDatabaseService } from './auth-database.service';
import type { SyncAuthenticatedPrincipal, VerifiedSyncPushToken } from './auth.types';
import {
  SyncAuthenticationGuard,
  type SyncAuthenticatedRequest,
} from './sync-authentication.guard';
import type { TokenService } from './token.service';

const requestId = '9f97bb10-b68a-4474-888e-7244fc581bcb';
const claims: VerifiedSyncPushToken = {
  userId: 'a417fabd-b3c8-409c-9db3-2d62fdce21fd',
  sessionId: '18dcbf0a-acbe-48d6-88ed-cd1b078ddf41',
  storeId: '59e90f52-05aa-4bf4-af84-242686f712a8',
  deviceId: '873ef648-a779-4aaf-bf8b-936b092ecb93',
  tokenId: '71085fe4-f593-4f68-8c0f-d46afc36769b',
  expiresAt: Math.floor(Date.now() / 1_000) + 900,
};
const principal: SyncAuthenticatedPrincipal = {
  userId: claims.userId,
  email: 'owner@example.test',
  fullName: 'Store Owner',
  storeId: claims.storeId,
  storeName: 'Suspended Store',
  storeStatus: 'suspended',
  membershipRole: 'owner',
  membershipVersion: '1',
  deviceId: claims.deviceId,
  sessionId: claims.sessionId,
  sessionExpiresAt: new Date(Date.now() + 86_400_000),
};

function executionContext(request: Request): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('SyncAuthenticationGuard', () => {
  const tokens = {
    verifySyncPushToken: jest.fn(),
  } as jest.Mocked<Pick<TokenService, 'verifySyncPushToken'>>;
  const database = {
    validateSyncSession: jest.fn(),
  } as jest.Mocked<Pick<AuthenticationDatabaseService, 'validateSyncSession'>>;
  const guard = new SyncAuthenticationGuard(
    tokens as unknown as TokenService,
    database as unknown as AuthenticationDatabaseService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('accepts a suspended Store only through a valid sync-scoped session', async () => {
    tokens.verifySyncPushToken.mockResolvedValue(claims);
    database.validateSyncSession.mockResolvedValue(principal);
    const request = {
      id: requestId,
      headers: { authorization: 'Bearer signed-sync-token' },
    } as unknown as Request;

    await expect(guard.canActivate(executionContext(request))).resolves.toBe(true);
    expect((request as SyncAuthenticatedRequest).tenantContext).toEqual({
      storeId: principal.storeId,
      userId: principal.userId,
      deviceId: principal.deviceId,
      requestId,
    });
  });

  it('fails closed when the sync-specific session validator rejects the principal', async () => {
    tokens.verifySyncPushToken.mockResolvedValue(claims);
    database.validateSyncSession.mockResolvedValue(undefined);
    const request = {
      id: requestId,
      headers: { authorization: 'Bearer signed-sync-token' },
    } as unknown as Request;

    await expect(guard.canActivate(executionContext(request))).rejects.toMatchObject({
      status: 401,
      response: { code: 'SYNC_AUTHENTICATION_REQUIRED' },
    });
  });
});
