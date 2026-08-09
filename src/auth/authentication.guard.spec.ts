import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthenticationDatabaseService } from './auth-database.service';
import type { AuthenticatedPrincipal, VerifiedAccessToken } from './auth.types';
import { AuthenticationGuard, type AuthenticatedRequest } from './authentication.guard';
import type { TokenService } from './token.service';

const requestId = '9f97bb10-b68a-4474-888e-7244fc581bcb';
const claims: VerifiedAccessToken = {
  userId: 'a417fabd-b3c8-409c-9db3-2d62fdce21fd',
  sessionId: '18dcbf0a-acbe-48d6-88ed-cd1b078ddf41',
  storeId: '59e90f52-05aa-4bf4-af84-242686f712a8',
  deviceId: '873ef648-a779-4aaf-bf8b-936b092ecb93',
  tokenId: '71085fe4-f593-4f68-8c0f-d46afc36769b',
  expiresAt: Math.floor(Date.now() / 1_000) + 900,
};
const principal: AuthenticatedPrincipal = {
  userId: claims.userId,
  email: 'owner@example.test',
  fullName: 'Store Owner',
  storeId: claims.storeId,
  storeName: 'Authorized Store',
  storeStatus: 'active',
  membershipRole: 'owner',
  membershipVersion: '1',
  deviceId: claims.deviceId,
  sessionId: claims.sessionId,
  sessionExpiresAt: new Date(Date.now() + 86_400_000),
};

function executionContext(request: Request): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('AuthenticationGuard tenant context', () => {
  const tokens = {
    verifyAccessToken: jest.fn(),
  } as jest.Mocked<Pick<TokenService, 'verifyAccessToken'>>;
  const database = {
    validateSession: jest.fn(),
  } as jest.Mocked<Pick<AuthenticationDatabaseService, 'validateSession'>>;
  const guard = new AuthenticationGuard(
    tokens as unknown as TokenService,
    database as unknown as AuthenticationDatabaseService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('derives tenant context from the verified session and server request ID', async () => {
    tokens.verifyAccessToken.mockResolvedValue(claims);
    database.validateSession.mockResolvedValue(principal);
    const request = {
      id: requestId,
      headers: {
        authorization: 'Bearer signed-access-token',
        'x-store-id': '690f778f-dab6-4837-9a92-0a4f876285fb',
      },
      body: {
        storeId: '690f778f-dab6-4837-9a92-0a4f876285fb',
      },
      query: {
        storeId: '690f778f-dab6-4837-9a92-0a4f876285fb',
      },
      params: {
        storeId: '690f778f-dab6-4837-9a92-0a4f876285fb',
      },
    } as unknown as Request;

    await expect(guard.canActivate(executionContext(request))).resolves.toBe(true);

    const authenticatedRequest = request as AuthenticatedRequest;
    expect(authenticatedRequest.principal).toBe(principal);
    expect(authenticatedRequest.tenantContext).toEqual({
      storeId: principal.storeId,
      userId: principal.userId,
      deviceId: principal.deviceId,
      requestId,
    });
  });
});
