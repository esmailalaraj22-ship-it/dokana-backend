import { ForbiddenException } from '@nestjs/common';

import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { deriveAccountingPeriodId } from './accounting-period-identity';
import { resolveAccountingPeriodBoundaries } from './accounting-period-month';
import type { AccountingPeriodPostingContextRepository } from './accounting-period-posting-context.repository';
import {
  AccountingPeriodNotPostingEligibleError,
  AccountingPeriodPostingContextService,
} from './accounting-period-posting-context.service';
import {
  AccountingPeriodIntegrityError,
  type AccountingPeriodProvisioningService,
} from './accounting-period-provisioning.service';
import type { AccountingPeriodRow, AccountingPeriodStatus } from './accounting-period.types';

const context: TenantTransactionContext = {
  storeId: '96000000-0000-4000-8000-000000000001',
  userId: '96000000-0000-4000-8000-000000000002',
  deviceId: '96000000-0000-4000-8000-000000000003',
  requestId: '96000000-0000-4000-8000-000000000004',
};
const operationId = '96000000-0000-4000-8000-000000000005';
const transaction = {} as DatabaseTransaction;
const boundaries = resolveAccountingPeriodBoundaries(2026, 9);

function periodRow(status: AccountingPeriodStatus): AccountingPeriodRow {
  return {
    id: deriveAccountingPeriodId(context.storeId, 2026, 9),
    storeId: context.storeId,
    periodYear: 2026,
    periodMonth: 9,
    startsAt: boundaries.startsAt,
    endsAt: boundaries.endsAt,
    status,
    closedAt: status === 'closed' ? new Date('2026-10-01T08:00:00.000Z') : null,
    deviceId: context.deviceId,
    operationId,
    createdAt: new Date('2026-09-01T08:00:00.000Z'),
    updatedAt: new Date('2026-09-01T08:00:00.000Z'),
    version: 1n,
  };
}

describe('AccountingPeriodPostingContextService', () => {
  const repository = {
    assertActiveStoreForPosting: jest.fn(),
    lockCanonicalPeriod: jest.fn(),
  } as jest.Mocked<
    Pick<
      AccountingPeriodPostingContextRepository,
      'assertActiveStoreForPosting' | 'lockCanonicalPeriod'
    >
  >;
  const provisioning = {
    ensureMonthlyAccountingPeriod: jest.fn(),
    assertCanonicalExistingRow: jest.fn(),
  } as jest.Mocked<
    Pick<
      AccountingPeriodProvisioningService,
      'ensureMonthlyAccountingPeriod' | 'assertCanonicalExistingRow'
    >
  >;
  const service = new AccountingPeriodPostingContextService(
    repository,
    provisioning as unknown as AccountingPeriodProvisioningService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    repository.assertActiveStoreForPosting.mockResolvedValue();
    repository.lockCanonicalPeriod.mockResolvedValue(periodRow('open'));
    provisioning.ensureMonthlyAccountingPeriod.mockResolvedValue(periodRow('open'));
  });

  it('resolves, locks, and validates one canonical open period in the caller transaction', async () => {
    await expect(
      service.resolveForWrite(transaction, context, {
        postingDate: '2026-09-18',
        operationId,
      }),
    ).resolves.toEqual({
      storeId: context.storeId,
      postingDate: '2026-09-18',
      accountingPeriodId: deriveAccountingPeriodId(context.storeId, 2026, 9),
      periodYear: 2026,
      periodMonth: 9,
    });

    expect(repository.assertActiveStoreForPosting).toHaveBeenCalledWith(
      transaction,
      context.storeId,
    );
    expect(provisioning.ensureMonthlyAccountingPeriod).toHaveBeenCalledWith(transaction, context, {
      periodYear: 2026,
      periodMonth: 9,
      operationId,
    });
    expect(repository.lockCanonicalPeriod).toHaveBeenCalledWith(
      transaction,
      context.storeId,
      deriveAccountingPeriodId(context.storeId, 2026, 9),
    );
    expect(provisioning.assertCanonicalExistingRow).toHaveBeenCalledWith(
      periodRow('open'),
      context.storeId,
    );

    const storeCall = repository.assertActiveStoreForPosting.mock.invocationCallOrder[0];
    const ensureCall = provisioning.ensureMonthlyAccountingPeriod.mock.invocationCallOrder[0];
    const periodCall = repository.lockCanonicalPeriod.mock.invocationCallOrder[0];
    expect(storeCall).toBeLessThan(ensureCall ?? 0);
    expect(ensureCall).toBeLessThan(periodCall ?? 0);
  });

  it.each<AccountingPeriodStatus>(['closing', 'closed'])(
    'rejects a locked %s period',
    async (status) => {
      repository.lockCanonicalPeriod.mockResolvedValue(periodRow(status));

      await expect(
        service.resolveForWrite(transaction, context, {
          postingDate: '2026-09-18',
          operationId,
        }),
      ).rejects.toMatchObject({
        code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE',
        periodStatus: status,
      });
    },
  );

  it.each(['read-only Store', 'missing trusted database context'])(
    'fails closed for %s before provisioning',
    async () => {
      repository.assertActiveStoreForPosting.mockRejectedValue(
        new ForbiddenException({
          code: 'BUSINESS_WRITE_NOT_ALLOWED',
          message: 'Business writes are not allowed.',
        }),
      );

      await expect(
        service.resolveForWrite(transaction, context, {
          postingDate: '2026-09-18',
          operationId,
        }),
      ).rejects.toMatchObject({ response: { code: 'BUSINESS_WRITE_NOT_ALLOWED' } });
      expect(provisioning.ensureMonthlyAccountingPeriod).not.toHaveBeenCalled();
      expect(repository.lockCanonicalPeriod).not.toHaveBeenCalled();
    },
  );

  it('fails closed when the canonical period cannot be locked after ensure', async () => {
    repository.lockCanonicalPeriod.mockResolvedValue(undefined);

    await expect(
      service.resolveForWrite(transaction, context, {
        postingDate: '2026-09-18',
        operationId,
      }),
    ).rejects.toBeInstanceOf(AccountingPeriodIntegrityError);
  });

  it('fails closed when the locked period violates canonical identity', async () => {
    provisioning.assertCanonicalExistingRow.mockImplementation(() => {
      throw new AccountingPeriodIntegrityError();
    });

    await expect(
      service.resolveForWrite(transaction, context, {
        postingDate: '2026-09-18',
        operationId,
      }),
    ).rejects.toBeInstanceOf(AccountingPeriodIntegrityError);
  });

  it('uses the stable posting-eligibility error type', () => {
    expect(new AccountingPeriodNotPostingEligibleError('closed')).toMatchObject({
      code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE',
      periodStatus: 'closed',
    });
  });
});
