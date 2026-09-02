import { createHash } from 'node:crypto';

import { BadRequestException, ForbiddenException } from '@nestjs/common';

import type { AuthenticatedPrincipal, MembershipRole } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type { AccountingPeriodWriteRepository } from './accounting-period-write.repository';
import {
  ACCOUNTING_PERIOD_CLOSE_REQUEST_VERSION,
  AccountingPeriodWriteService,
} from './accounting-period-write.service';
import type { AccountingPeriodMutationResponse } from './accounting-period-write.types';

const context: TenantTransactionContext = {
  storeId: '94100000-0000-4000-8000-000000000001',
  userId: '94100000-0000-4000-8000-000000000002',
  deviceId: '94100000-0000-4000-8000-000000000003',
  requestId: '94100000-0000-4000-8000-000000000004',
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
const accountingPeriodId = '94100000-0000-4000-8000-000000000005';
const operationId = '94100000-0000-4000-8000-000000000006';
const response: AccountingPeriodMutationResponse = {
  id: accountingPeriodId,
  periodYear: 2026,
  periodMonth: 9,
  startsAt: '2026-08-31T21:00:00.000Z',
  endsAt: '2026-09-30T21:00:00.000Z',
  status: 'closed',
  closedAt: '2026-09-30T21:05:00.000Z',
  createdAt: '2026-08-31T08:00:00.000Z',
  updatedAt: '2026-09-30T21:05:00.000Z',
  version: '9007199254740994',
  operationId,
};

describe('AccountingPeriodWriteService', () => {
  const repository = {
    close: jest.fn(),
  } as jest.Mocked<Pick<AccountingPeriodWriteRepository, 'close'>>;
  const service = new AccountingPeriodWriteService(
    repository as unknown as AccountingPeriodWriteRepository,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    repository.close.mockResolvedValue({ ok: true, response });
  });

  it('builds the exact close intent fingerprint with lossless expectedVersion', async () => {
    await service.close(principal, context, accountingPeriodId.toUpperCase(), {
      operationId: operationId.toUpperCase(),
      expectedVersion: '9007199254740993',
    });

    const call = repository.close.mock.calls[0];
    if (!call) {
      throw new Error('Expected the Accounting Period close repository call.');
    }
    expect(call[0]).toBe(context);
    expect(call[1]).toEqual({
      accountingPeriodId,
      operationId,
      expectedVersion: 9_007_199_254_740_993n,
      action: 'close',
      requestHash: createHash('sha256')
        .update(
          JSON.stringify({
            v: ACCOUNTING_PERIOD_CLOSE_REQUEST_VERSION,
            action: 'accounting_period.close',
            accountingPeriodId,
            expectedVersion: '9007199254740993',
          }),
          'utf8',
        )
        .digest('hex'),
    });
  });

  it.each<MembershipRole>(['manager', 'viewer', 'support'])(
    'rejects %s before repository access',
    async (membershipRole) => {
      await expect(
        service.close({ ...principal, membershipRole }, context, accountingPeriodId, {
          operationId,
          expectedVersion: '1',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.close).not.toHaveBeenCalled();
    },
  );

  it.each(['storeId', 'userId', 'deviceId'] as const)(
    'rejects a mismatched trusted %s before repository access',
    async (field) => {
      await expect(
        service.close(
          { ...principal, [field]: '94100000-0000-4000-8000-000000000099' },
          context,
          accountingPeriodId,
          { operationId, expectedVersion: '1' },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.close).not.toHaveBeenCalled();
    },
  );

  it.each(['0', '-1', '9007199254740993.0', '9223372036854775808'])(
    'rejects non-lossless or out-of-range expectedVersion %s before repository access',
    async (expectedVersion) => {
      await expect(
        service.close(principal, context, accountingPeriodId, { operationId, expectedVersion }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.close).not.toHaveBeenCalled();
    },
  );
});
