import { BadRequestException } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type { AppSettingsReadService } from '../settings/app-settings-read.service';
import type { AppSettingsWriteService } from '../settings/app-settings-write.service';
import type {
  AppSettingsMutationResponse,
  AppSettingsReadModel,
} from '../settings/app-settings.types';
import { NotificationSettingsService } from './notification-settings.service';

const context: TenantTransactionContext = {
  storeId: '23000000-0000-4000-8000-000000000001',
  userId: '23000000-0000-4000-8000-000000000002',
  deviceId: '23000000-0000-4000-8000-000000000003',
  requestId: '23000000-0000-4000-8000-000000000004',
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
const readModel: AppSettingsReadModel = {
  dailyReportTimeMinutes: 1200,
  defaultCreditPolicy: 'warn',
  defaultCreditLimitMinor: null,
  allowNegativeStock: false,
  lowStockAlertEnabled: true,
  debtAgeAlertDays: 30,
  customerDebtAmountAlertMinor: '50000',
  backupEnabled: true,
  backupIntervalHours: 24,
  timezoneName: 'Asia/Hebron',
  version: '4',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-16T00:00:00.000Z',
};

describe('NotificationSettingsService', () => {
  const reads = { get: jest.fn() } as jest.Mocked<Pick<AppSettingsReadService, 'get'>>;
  const writes = { update: jest.fn() } as jest.Mocked<Pick<AppSettingsWriteService, 'update'>>;
  const service = new NotificationSettingsService(
    reads as unknown as AppSettingsReadService,
    writes as unknown as AppSettingsWriteService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('returns only the approved notification settings projection', async () => {
    reads.get.mockResolvedValue(readModel);

    await expect(service.get(principal, context)).resolves.toEqual({
      customerDebtAmountAlertMinor: '50000',
      debtAgeAlertDays: 30,
      lowStockAlertEnabled: true,
      version: '4',
      updatedAt: '2026-10-16T00:00:00.000Z',
    });
  });

  it('delegates mutations to the established idempotent settings authority', async () => {
    const operationId = '23000000-0000-4000-8000-000000000005';
    const mutation: AppSettingsMutationResponse = { ...readModel, operationId, version: '5' };
    writes.update.mockResolvedValue(mutation);

    await expect(
      service.update(principal, context, {
        operationId,
        expectedVersion: '4',
        customerDebtAmountAlertMinor: '75000',
        debtAgeAlertDays: 45,
        lowStockAlertEnabled: false,
      }),
    ).resolves.toEqual({
      customerDebtAmountAlertMinor: '50000',
      debtAgeAlertDays: 30,
      lowStockAlertEnabled: true,
      version: '5',
      updatedAt: mutation.updatedAt,
      operationId,
    });
    expect(writes.update).toHaveBeenCalledWith(principal, context, {
      operationId,
      expectedVersion: '4',
      customerDebtAmountAlertMinor: '75000',
      debtAgeAlertDays: 45,
      lowStockAlertEnabled: false,
    });
  });

  it('rejects an empty notification settings mutation before persistence', async () => {
    await expect(
      service.update(principal, context, {
        operationId: '23000000-0000-4000-8000-000000000005',
        expectedVersion: '4',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(writes.update).not.toHaveBeenCalled();
  });
});
