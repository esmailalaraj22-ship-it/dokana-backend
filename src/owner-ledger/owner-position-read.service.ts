import { ForbiddenException, Injectable } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type { OwnerPositionResponse } from './owner-ledger.types';
import { OwnerPositionReadRepository } from './owner-position-read.repository';

type OwnerLedgerPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class OwnerPositionReadService {
  constructor(private readonly repository: OwnerPositionReadRepository) {}

  read(
    principal: OwnerLedgerPrincipal,
    context: TenantTransactionContext,
  ): Promise<OwnerPositionResponse> {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'OWNER_LEDGER_READ_NOT_ALLOWED',
        message: 'Owner Ledger reads are not allowed.',
      });
    }
    return this.repository.read(context);
  }
}
