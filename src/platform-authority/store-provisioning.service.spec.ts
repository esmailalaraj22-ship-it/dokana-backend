import { randomUUID } from 'node:crypto';

import type { DatabaseService } from '../database/database.service';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import type { SystemCashProvisioningService } from '../money-accounts/system-cash-provisioning.service';
import { SYSTEM_CASH_MONEY_ACCOUNT } from '../money-accounts/money-account.types';
import { SYSTEM_CASH_NORMALIZED_NAME } from '../money-accounts/system-cash-invariants';
import type { AppSettingsInitializationService } from '../settings/app-settings-initialization.service';
import { MVP_TIMEZONE_NAME } from '../settings/app-settings.types';
import { StoreProvisioningService } from './store-provisioning.service';
import type { SubscriptionLifecycleRepository } from './subscription-lifecycle.repository';
import type {
  StoreProvisioningCommand,
  StoreProvisioningIdentityResult,
  StoreProvisioningState,
} from './subscription-lifecycle.types';

const execute = jest.fn().mockResolvedValue({ rows: [] });
const transaction = { execute } as unknown as DatabaseTransaction;
const actor = {
  userId: randomUUID(),
  deviceId: randomUUID(),
  requestId: randomUUID(),
};

function command(operationId = randomUUID()): StoreProvisioningCommand {
  return {
    operationId,
    ownerUserId: randomUUID(),
    name: '  New Store  ',
    phone: '  0599000000  ',
    reason: '  Approved onboarding  ',
    activateSubscription: false,
    settings: {
      dailyReportTimeMinutes: 1200,
      defaultCreditPolicy: 'warn',
      defaultCreditLimitMinor: null,
      allowNegativeStock: false,
      lowStockAlertEnabled: true,
      debtAgeAlertDays: 90,
      backupEnabled: true,
      backupIntervalHours: 24,
      timezoneName: MVP_TIMEZONE_NAME,
      businessDayMode: 'fixed_24h',
    },
  };
}

describe('StoreProvisioningService', () => {
  let database: DatabaseService;
  let withTenantTransaction: jest.Mock;
  let repository: jest.Mocked<
    Pick<SubscriptionLifecycleRepository, 'provisionIdentity' | 'readProvisioningState'>
  >;
  let settings: jest.Mocked<Pick<AppSettingsInitializationService, 'ensureForStoreInTransaction'>>;
  let cash: jest.Mocked<Pick<SystemCashProvisioningService, 'ensureForStoreInTransaction'>>;
  let service: StoreProvisioningService;
  let identity: StoreProvisioningIdentityResult;
  let state: StoreProvisioningState;

  beforeEach(() => {
    execute.mockClear();
    withTenantTransaction = jest.fn(
      async (
        _context: TenantTransactionContext,
        work: (value: DatabaseTransaction) => Promise<unknown>,
      ) => work(transaction),
    );
    database = { withTenantTransaction } as unknown as DatabaseService;
    identity = {
      storeId: '',
      ownerUserId: '',
      membershipId: randomUUID(),
      subscriptionId: null,
      subscriptionStatus: null,
      startsAt: null,
      endsAt: null,
      subscriptionVersion: null,
      changedAt: new Date('2026-10-03T00:00:00Z'),
      replayed: false,
    };
    state = {
      storeId: '',
      storeName: 'New Store',
      storeStatus: 'active',
      ownerCount: 1n,
      ownerUserId: '',
      settingsCount: 1n,
      systemCashCount: 1n,
      subscriptionCount: 0n,
      currentSubscriptionId: null,
    };
    repository = {
      provisionIdentity: jest.fn(async (_transaction, input) => ({
        ...identity,
        storeId: input.storeId,
        ownerUserId: input.ownerUserId,
      })),
      readProvisioningState: jest.fn(async (_transaction, storeId) => ({
        ...state,
        storeId,
        ownerUserId: repository.provisionIdentity.mock.calls[0]?.[1].ownerUserId ?? null,
      })),
    };
    settings = { ensureForStoreInTransaction: jest.fn().mockResolvedValue(undefined) };
    const cashTimestamp = new Date('2026-10-03T00:00:00Z');
    cash = {
      ensureForStoreInTransaction: jest.fn().mockResolvedValue({
        id: randomUUID(),
        name: SYSTEM_CASH_MONEY_ACCOUNT.name,
        normalizedName: SYSTEM_CASH_NORMALIZED_NAME,
        accountType: 'cash',
        availability: 'available',
        isDefault: true,
        status: 'active',
        archivedAt: null,
        createdAt: cashTimestamp,
        updatedAt: cashTimestamp,
        version: 1n,
      }),
    };
    service = new StoreProvisioningService(
      database,
      repository as unknown as SubscriptionLifecycleRepository,
      settings as unknown as AppSettingsInitializationService,
      cash as unknown as SystemCashProvisioningService,
    );
  });

  it('orchestrates identity, Settings, and System Cash inside one transaction', async () => {
    const input = command();
    const response = await service.provision(actor, input);
    const prepared = repository.provisionIdentity.mock.calls[0]?.[1];

    expect(prepared).toMatchObject({
      ownerUserId: input.ownerUserId,
      name: 'New Store',
      phone: '0599000000',
      reason: 'Approved onboarding',
      activateSubscription: false,
    });
    expect(prepared?.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(withTenantTransaction).toHaveBeenCalledWith(
      { ...actor, storeId: prepared?.storeId },
      expect.any(Function),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(settings.ensureForStoreInTransaction).toHaveBeenCalledWith(
      transaction,
      prepared?.storeId,
      input.settings,
    );
    expect(cash.ensureForStoreInTransaction).toHaveBeenCalledWith(transaction, prepared?.storeId);
    expect(response.state.ownerUserId).toBe(input.ownerUserId);
  });

  it('derives stable Store and request identities independent of settings key order', async () => {
    const input = command();
    await service.provision(actor, input);
    const first = repository.provisionIdentity.mock.calls[0]?.[1];
    jest.clearAllMocks();
    await service.provision(actor, input);
    const second = repository.provisionIdentity.mock.calls[0]?.[1];
    await service.provision(actor, {
      ...input,
      settings: {
        businessDayMode: input.settings.businessDayMode,
        timezoneName: input.settings.timezoneName,
        backupIntervalHours: input.settings.backupIntervalHours,
        backupEnabled: input.settings.backupEnabled,
        debtAgeAlertDays: input.settings.debtAgeAlertDays,
        lowStockAlertEnabled: input.settings.lowStockAlertEnabled,
        allowNegativeStock: input.settings.allowNegativeStock,
        defaultCreditLimitMinor: input.settings.defaultCreditLimitMinor,
        defaultCreditPolicy: input.settings.defaultCreditPolicy,
        dailyReportTimeMinutes: input.settings.dailyReportTimeMinutes,
      },
    });
    const reordered = repository.provisionIdentity.mock.calls[1]?.[1];
    expect(first?.storeId).toBe(second?.storeId);
    expect(first?.storeId).not.toBe(input.operationId);
    expect(first?.requestHash).toBe(second?.requestHash);
    expect(first?.requestHash).toBe(reordered?.requestHash);
  });

  it('rejects an incomplete foundation so the outer transaction can roll back', async () => {
    repository.readProvisioningState.mockResolvedValue({ ...state, settingsCount: 0n });
    await expect(service.provision(actor, command())).rejects.toThrow(
      'Store provisioning foundation is incomplete.',
    );
  });

  it('rejects invalid identifiers and empty required text before database work', async () => {
    expect(() => service.provision(actor, { ...command(), ownerUserId: 'invalid' })).toThrow(
      TypeError,
    );
    expect(() => service.provision(actor, { ...command(), reason: ' ' })).toThrow(TypeError);
    expect(withTenantTransaction).not.toHaveBeenCalled();
  });
});
