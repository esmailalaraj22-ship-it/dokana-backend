import { GUARDS_METADATA } from '@nestjs/common/constants';

import type { SyncAuthenticatedRequest } from '../auth/sync-authentication.guard';
import { SyncAuthenticationGuard } from '../auth/sync-authentication.guard';
import type { SyncAuthenticationService } from '../auth/sync-authentication.service';
import type { PushOfflineOperationsDto } from './dto/push-offline-operations.dto';
import { OfflineOperationController } from './offline-operation.controller';
import type { OfflineOperationService } from './offline-operation.service';

describe('OfflineOperationController', () => {
  const authentication = {
    issueFromRefreshToken: jest.fn(),
  } as jest.Mocked<Pick<SyncAuthenticationService, 'issueFromRefreshToken'>>;
  const operations = {
    push: jest.fn(),
  } as jest.Mocked<Pick<OfflineOperationService, 'push'>>;
  const controller = new OfflineOperationController(
    authentication as unknown as SyncAuthenticationService,
    operations as unknown as OfflineOperationService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('delegates token issuance without exposing ordinary authentication behavior', async () => {
    authentication.issueFromRefreshToken.mockResolvedValue({
      tokenType: 'Bearer',
      syncToken: 'sync-token',
      syncTokenExpiresInSeconds: 900,
      sessionExpiresAt: '2026-01-10T00:00:00.000Z',
      store: { id: '59e90f52-05aa-4bf4-af84-242686f712a8', status: 'suspended' },
      deviceId: '873ef648-a779-4aaf-bf8b-936b092ecb93',
      sessionId: '18dcbf0a-acbe-48d6-88ed-cd1b078ddf41',
    });

    await expect(
      controller.issueSyncToken({ refreshToken: 'refresh-token' }),
    ).resolves.toMatchObject({
      syncToken: 'sync-token',
    });
    expect(authentication.issueFromRefreshToken).toHaveBeenCalledWith('refresh-token');
  });

  it('protects push with the dedicated guard and delegates trusted identity/context', async () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      OfflineOperationController.prototype.push,
    ) as unknown[];
    expect(guards).toContain(SyncAuthenticationGuard);

    const input = { operations: [] } as PushOfflineOperationsDto;
    const request = {
      principal: { userId: 'principal-user' },
      tenantContext: { storeId: 'trusted-store' },
    } as unknown as SyncAuthenticatedRequest;
    operations.push.mockResolvedValue({ results: [] });

    await expect(controller.push(input, request)).resolves.toEqual({ results: [] });
    expect(operations.push).toHaveBeenCalledWith(input, request.principal, request.tenantContext);
  });
});
