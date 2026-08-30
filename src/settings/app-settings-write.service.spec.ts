import { BadRequestException, ForbiddenException } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type { UpdateAppSettingsDto } from './dto/update-app-settings.dto';
import type { AppSettingsWriteRepository } from './app-settings-write.repository';
import { AppSettingsWriteService } from './app-settings-write.service';
import type { AppSettingsMutationResponse } from './app-settings.types';

const context: TenantTransactionContext = {
  storeId: '74000000-0000-4000-8000-000000000001',
  userId: '74100000-0000-4000-8000-000000000001',
  deviceId: '74200000-0000-4000-8000-000000000001',
  requestId: '74300000-0000-4000-8000-000000000001',
};

const owner: Pick<AuthenticatedPrincipal, 'membershipRole' | 'storeId' | 'userId' | 'deviceId'> = {
  membershipRole: 'owner',
  storeId: context.storeId,
  userId: context.userId,
  deviceId: context.deviceId,
};

const response: AppSettingsMutationResponse = {
  dailyReportTimeMinutes: 1200,
  defaultCreditPolicy: 'warn',
  defaultCreditLimitMinor: '9007199254740993',
  allowNegativeStock: false,
  lowStockAlertEnabled: true,
  debtAgeAlertDays: 90,
  backupEnabled: true,
  backupIntervalHours: 24,
  timezoneName: 'Asia/Hebron',
  version: '9007199254740994',
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-31T10:00:00.000Z',
  operationId: '74400000-0000-4000-8000-000000000001',
};

function dto(overrides: Partial<UpdateAppSettingsDto> = {}): UpdateAppSettingsDto {
  return {
    operationId: response.operationId,
    expectedVersion: '9007199254740993',
    defaultCreditLimitMinor: '9007199254740993',
    ...overrides,
  };
}

describe('AppSettingsWriteService', () => {
  const repository = {
    update: jest.fn(),
  } as jest.Mocked<Pick<AppSettingsWriteRepository, 'update'>>;
  const service = new AppSettingsWriteService(repository as unknown as AppSettingsWriteRepository);

  beforeEach(() => {
    jest.clearAllMocks();
    repository.update.mockResolvedValue({ ok: true, response });
  });

  it('prepares lossless bigint values and canonicalizes operation UUID case', async () => {
    await expect(
      service.update(owner, context, dto({ operationId: response.operationId.toUpperCase() })),
    ).resolves.toEqual(response);

    const prepared = repository.update.mock.calls[0]?.[1];
    expect(prepared).toMatchObject({
      operationId: response.operationId,
      expectedVersion: 9_007_199_254_740_993n,
      values: { defaultCreditLimitMinor: 9_007_199_254_740_993n },
    });
  });

  it('uses stable field order and excludes operation/request identity from the fingerprint', async () => {
    const first = dto({
      operationId: '74400000-0000-4000-8000-000000000011',
      defaultCreditLimitMinor: undefined,
      backupEnabled: false,
      dailyReportTimeMinutes: 900,
    });
    const reordered = {
      dailyReportTimeMinutes: 900,
      backupEnabled: false,
      expectedVersion: first.expectedVersion,
      operationId: '74400000-0000-4000-8000-000000000012',
    } as UpdateAppSettingsDto;

    await service.update(owner, context, first);
    await service.update(
      owner,
      { ...context, requestId: '74300000-0000-4000-8000-000000000099' },
      reordered,
    );

    const prepared = repository.update.mock.calls.map((call) => call[1]);
    expect(prepared[0]?.requestHash).toBe(prepared[1]?.requestHash);
    expect(prepared[0]?.operationId).not.toBe(prepared[1]?.operationId);
  });

  it('distinguishes omission, explicit null, values, and expectedVersion in the fingerprint', async () => {
    const requests: UpdateAppSettingsDto[] = [
      dto({ defaultCreditLimitMinor: undefined, backupEnabled: true }),
      dto({ defaultCreditLimitMinor: null, backupEnabled: true }),
      dto({ defaultCreditLimitMinor: '0', backupEnabled: true }),
      dto({ defaultCreditLimitMinor: undefined, backupEnabled: true, expectedVersion: '2' }),
    ];
    for (const request of requests) {
      await service.update(owner, context, request);
    }

    const hashes = repository.update.mock.calls.map((call) => call[1].requestHash);
    expect(new Set(hashes).size).toBe(requests.length);
  });

  it('rejects a command with no mutable field before persistence access', async () => {
    await expect(
      service.update(owner, context, {
        operationId: response.operationId,
        expectedVersion: '1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('rejects non-owner and mismatched trusted context before persistence access', async () => {
    await expect(
      service.update({ ...owner, membershipRole: 'manager' }, context, dto()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.update(
        { ...owner, deviceId: '74200000-0000-4000-8000-000000000099' },
        context,
        dto(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('rejects invalid direct-call values without unsafe numeric conversion', async () => {
    const invalidRequests = [
      dto({ expectedVersion: '9223372036854775808' }),
      dto({ defaultCreditLimitMinor: '9223372036854775808' }),
      dto({ defaultCreditPolicy: 'allow' as unknown as 'warn' }),
      dto({ dailyReportTimeMinutes: 1440 }),
      dto({ allowNegativeStock: null as unknown as boolean }),
    ];
    for (const request of invalidRequests) {
      await expect(service.update(owner, context, request)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('maps stable repository failures to public HTTP errors', async () => {
    repository.update.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'SETTINGS_NOT_INITIALIZED',
        message: 'Store settings are not initialized.',
        statusCode: 404,
      },
    });
    await expect(service.update(owner, context, dto())).rejects.toMatchObject({
      status: 404,
      response: { code: 'SETTINGS_NOT_INITIALIZED' },
    });
  });
});
