import type { DatabaseService } from '../database/database.service';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { AppSettingsInitializationService } from './app-settings-initialization.service';
import type { AppSettingsInitializationValues } from './app-settings.types';

const context: TenantTransactionContext = {
  storeId: '75000000-0000-4000-8000-000000000001',
  userId: '75100000-0000-4000-8000-000000000001',
  deviceId: '75200000-0000-4000-8000-000000000001',
  requestId: '75300000-0000-4000-8000-000000000001',
};

const values: AppSettingsInitializationValues = {
  dailyReportTimeMinutes: 1110,
  defaultCreditPolicy: 'block',
  defaultCreditLimitMinor: 9_007_199_254_740_993n,
  allowNegativeStock: false,
  lowStockAlertEnabled: true,
  debtAgeAlertDays: 45,
  backupEnabled: true,
  backupIntervalHours: 12,
  timezoneName: 'Asia/Hebron',
  businessDayMode: 'fixed_24h',
};

describe('AppSettingsInitializationService', () => {
  const onConflictDoNothing = jest.fn(async (options: { target: unknown }) => {
    void options;
  });
  const insertValues = jest.fn((valuesArgument: Record<string, unknown>) => {
    void valuesArgument;
    return { onConflictDoNothing };
  });
  const transaction = {
    insert: jest.fn(() => ({ values: insertValues })),
  } as unknown as DatabaseTransaction;
  const database = {
    withBusinessWriteTransaction: jest.fn(
      async (
        _context: TenantTransactionContext,
        work: (value: DatabaseTransaction) => Promise<unknown>,
      ) => work(transaction),
    ),
  } as unknown as DatabaseService;
  const service = new AppSettingsInitializationService(database);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('inserts explicit policy values, fixed time state, and null device URIs', async () => {
    await service.ensureForStore(context, values);

    expect(insertValues).toHaveBeenCalledWith({
      storeId: context.storeId,
      dailyReportTimeMinutes: 1110,
      defaultCreditPolicy: 'block',
      defaultCreditLimitMinor: 9_007_199_254_740_993n,
      allowNegativeStock: false,
      lowStockAlertEnabled: true,
      debtAgeAlertDays: 45,
      backupEnabled: true,
      backupIntervalHours: 12,
      exportDirectoryUri: null,
      attachmentsDirectoryUri: null,
      timezoneName: 'Asia/Hebron',
      businessDayStartMinutes: 720,
      businessDayEndMinutes: 720,
      businessDayMode: 'fixed_24h',
    });
    expect(onConflictDoNothing.mock.calls[0]?.[0]).toHaveProperty('target');
    const inserted = insertValues.mock.calls[0]?.[0];
    expect(inserted).toBeDefined();
    expect(inserted).not.toHaveProperty('version');
    expect(inserted).not.toHaveProperty('createdAt');
    expect(inserted).not.toHaveProperty('updatedAt');
  });

  it('rejects invalid policy, bigint, time, and primitive values before opening a transaction', async () => {
    const invalidValues: AppSettingsInitializationValues[] = [
      { ...values, defaultCreditPolicy: 'allow' as unknown as 'warn' },
      { ...values, defaultCreditLimitMinor: 9_223_372_036_854_775_808n },
      { ...values, timezoneName: 'UTC' as unknown as 'Asia/Hebron' },
      { ...values, backupIntervalHours: 0 },
      { ...values, backupEnabled: null as unknown as boolean },
    ];
    for (const invalid of invalidValues) {
      await expect(service.ensureForStore(context, invalid)).rejects.toBeInstanceOf(TypeError);
    }
    expect((database.withBusinessWriteTransaction as unknown as jest.Mock).mock.calls).toHaveLength(
      0,
    );
  });
});
