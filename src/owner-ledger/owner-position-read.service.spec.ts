import { ForbiddenException } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type { OwnerPositionReadRepository } from './owner-position-read.repository';
import { OwnerPositionReadService } from './owner-position-read.service';

describe('OwnerPositionReadService', () => {
  const context: TenantTransactionContext = {
    storeId: '20000000-0000-4000-8000-000000000001',
    userId: '20000000-0000-4000-8000-000000000002',
    deviceId: '20000000-0000-4000-8000-000000000003',
    requestId: '20000000-0000-4000-8000-000000000004',
  };
  const principal: Pick<
    AuthenticatedPrincipal,
    'membershipRole' | 'storeId' | 'userId' | 'deviceId'
  > = {
    membershipRole: 'owner',
    storeId: context.storeId,
    userId: context.userId,
    deviceId: context.deviceId,
  };
  const repository = {
    read: jest.fn().mockResolvedValue({
      storeOwesOwnerMinor: '15',
      ownerEquityMovementMinor: '-4',
    }),
  };
  const service = new OwnerPositionReadService(
    repository as unknown as OwnerPositionReadRepository,
  );

  beforeEach(() => repository.read.mockClear());

  it('returns the exact lossless owner position for the trusted owner', async () => {
    await expect(service.read(principal, context)).resolves.toEqual({
      storeOwesOwnerMinor: '15',
      ownerEquityMovementMinor: '-4',
    });
    expect(repository.read).toHaveBeenCalledWith(context);
  });

  it('rejects non-owner and mismatched contexts', () => {
    expect(() => service.read({ ...principal, membershipRole: 'viewer' }, context)).toThrow(
      ForbiddenException,
    );
    expect(() => service.read({ ...principal, storeId: crypto.randomUUID() }, context)).toThrow(
      ForbiddenException,
    );
    expect(repository.read).not.toHaveBeenCalled();
  });
});
