import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { deriveAccountingPeriodId } from './accounting-period-identity';
import { resolveAccountingPeriodBoundaries } from './accounting-period-month';
import {
  AccountingPeriodProvisioningConflictError,
  type AccountingPeriodProvisioningRepository,
} from './accounting-period-provisioning.repository';
import {
  AccountingPeriodIntegrityError,
  AccountingPeriodProvisioningService,
} from './accounting-period-provisioning.service';
import type { AccountingPeriodRow, AccountingPeriodStatus } from './accounting-period.types';

const context: TenantTransactionContext = {
  storeId: '94000000-0000-4000-8000-000000000001',
  userId: '94000000-0000-4000-8000-000000000002',
  deviceId: '94000000-0000-4000-8000-000000000003',
  requestId: '94000000-0000-4000-8000-000000000004',
};
const operationId = '94000000-0000-4000-8000-000000000005';
const transaction = {} as DatabaseTransaction;
const boundaries = resolveAccountingPeriodBoundaries(2026, 10);

function periodRow(status: AccountingPeriodStatus): AccountingPeriodRow {
  return {
    id: deriveAccountingPeriodId(context.storeId, 2026, 10),
    storeId: context.storeId,
    periodYear: 2026,
    periodMonth: 10,
    startsAt: boundaries.startsAt,
    endsAt: boundaries.endsAt,
    status,
    closedAt: status === 'closed' ? new Date('2026-11-02T08:00:00.000Z') : null,
    deviceId: context.deviceId,
    operationId,
    createdAt: new Date('2026-09-01T08:00:00.000Z'),
    updatedAt: new Date('2026-09-01T08:00:00.000Z'),
    version: 1n,
  };
}

describe('AccountingPeriodProvisioningService', () => {
  const repository = {
    ensure: jest.fn(),
  } as jest.Mocked<Pick<AccountingPeriodProvisioningRepository, 'ensure'>>;
  const service = new AccountingPeriodProvisioningService(
    repository as unknown as AccountingPeriodProvisioningRepository,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('derives the canonical UUID and Asia/Hebron boundaries inside the caller transaction', async () => {
    repository.ensure.mockResolvedValue(periodRow('open'));

    const result = await service.ensureMonthlyAccountingPeriod(transaction, context, {
      periodYear: 2026,
      periodMonth: 10,
      operationId: operationId.toUpperCase(),
    });

    expect(result.status).toBe('open');
    expect(repository.ensure).toHaveBeenCalledWith(transaction, context, {
      accountingPeriodId: deriveAccountingPeriodId(context.storeId, 2026, 10),
      periodYear: 2026,
      periodMonth: 10,
      startsAt: boundaries.startsAt,
      endsAt: boundaries.endsAt,
      operationId,
    });
  });

  it.each<AccountingPeriodStatus>(['open', 'closed', 'closing'])(
    'preserves an existing %s lifecycle state',
    async (status) => {
      const row = periodRow(status);
      repository.ensure.mockResolvedValue(row);

      await expect(
        service.ensureMonthlyAccountingPeriod(transaction, context, {
          periodYear: 2026,
          periodMonth: 10,
          operationId,
        }),
      ).resolves.toBe(row);
    },
  );

  it.each([
    { id: '94000000-0000-4000-8000-000000000099' },
    { storeId: '94000000-0000-4000-8000-000000000099' },
    { startsAt: new Date('2026-09-30T22:00:00.000Z') },
    { endsAt: new Date('2026-10-31T23:00:00.000Z') },
  ])('fails closed when an existing row violates canonical identity', async (change) => {
    repository.ensure.mockResolvedValue({ ...periodRow('open'), ...change });

    await expect(
      service.ensureMonthlyAccountingPeriod(transaction, context, {
        periodYear: 2026,
        periodMonth: 10,
        operationId,
      }),
    ).rejects.toBeInstanceOf(AccountingPeriodIntegrityError);
  });

  it('maps a conflicting physical insert with no canonical winner to the stable integrity outcome', async () => {
    repository.ensure.mockRejectedValue(new AccountingPeriodProvisioningConflictError());

    await expect(
      service.ensureMonthlyAccountingPeriod(transaction, context, {
        periodYear: 2026,
        periodMonth: 10,
        operationId,
      }),
    ).rejects.toBeInstanceOf(AccountingPeriodIntegrityError);
  });
});
