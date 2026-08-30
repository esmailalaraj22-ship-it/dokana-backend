import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import type { AuthenticatedPrincipal, MembershipRole } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type { AppSettingsReadRepository } from './app-settings-read.repository';
import { AppSettingsReadService } from './app-settings-read.service';
import type { AppSettingsReadRow } from './app-settings.types';

const context: TenantTransactionContext = {
  storeId: '71000000-0000-4000-8000-000000000001',
  userId: '71000000-0000-4000-8000-000000000002',
  deviceId: '71000000-0000-4000-8000-000000000003',
  requestId: '71000000-0000-4000-8000-000000000004',
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

const row: AppSettingsReadRow = {
  dailyReportTimeMinutes: 1170,
  defaultCreditPolicy: 'allow',
  defaultCreditLimitMinor: 9_007_199_254_740_993n,
  allowNegativeStock: false,
  lowStockAlertEnabled: true,
  debtAgeAlertDays: 60,
  backupEnabled: true,
  backupIntervalHours: 12,
  timezoneName: 'Asia/Hebron',
  version: 9_007_199_254_740_995n,
  createdAt: new Date('2026-08-01T10:00:00.000Z'),
  updatedAt: new Date('2026-08-20T12:30:00.000Z'),
};

describe('AppSettingsReadService', () => {
  const repository = {
    findForCurrentStore: jest.fn(),
  } as jest.Mocked<Pick<AppSettingsReadRepository, 'findForCurrentStore'>>;
  const service = new AppSettingsReadService(repository as unknown as AppSettingsReadRepository);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the approved projection with lossless bigint and legacy allow compatibility', async () => {
    repository.findForCurrentStore.mockResolvedValue(row);

    await expect(service.get(principal, context)).resolves.toEqual({
      dailyReportTimeMinutes: 1170,
      defaultCreditPolicy: 'allow',
      defaultCreditLimitMinor: '9007199254740993',
      allowNegativeStock: false,
      lowStockAlertEnabled: true,
      debtAgeAlertDays: 60,
      backupEnabled: true,
      backupIntervalHours: 12,
      timezoneName: 'Asia/Hebron',
      version: '9007199254740995',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-20T12:30:00.000Z',
    });
    expect(repository.findForCurrentStore).toHaveBeenCalledWith(context);
  });

  it('preserves a null Store-wide credit limit', async () => {
    repository.findForCurrentStore.mockResolvedValue({
      ...row,
      defaultCreditLimitMinor: null,
    });

    await expect(service.get(principal, context)).resolves.toMatchObject({
      defaultCreditLimitMinor: null,
    });
  });

  it.each<MembershipRole>(['manager', 'viewer', 'support'])(
    'rejects the %s role before persistence access',
    async (membershipRole) => {
      await expect(service.get({ ...principal, membershipRole }, context)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(repository.findForCurrentStore).not.toHaveBeenCalled();
    },
  );

  it.each(['storeId', 'userId', 'deviceId'] as const)(
    'rejects mismatched trusted %s context before persistence access',
    async (field) => {
      await expect(
        service.get({ ...principal, [field]: '71000000-0000-4000-8000-000000000099' }, context),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.findForCurrentStore).not.toHaveBeenCalled();
    },
  );

  it('returns the stable missing-singleton error without synthesizing settings', async () => {
    repository.findForCurrentStore.mockResolvedValue(undefined);

    await expect(service.get(principal, context)).rejects.toMatchObject({
      status: 404,
      response: {
        code: 'SETTINGS_NOT_INITIALIZED',
        message: 'Store settings are not initialized.',
      },
    });
    await expect(service.get(principal, context)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('fails closed when physical timezone state differs from the MVP contract', async () => {
    repository.findForCurrentStore.mockResolvedValue({ ...row, timezoneName: 'UTC' });

    await expect(service.get(principal, context)).rejects.toMatchObject({
      status: 503,
      response: {
        code: 'SETTINGS_TIMEZONE_UNSUPPORTED',
        message: 'Store settings are unavailable.',
      },
    });
    await expect(service.get(principal, context)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
