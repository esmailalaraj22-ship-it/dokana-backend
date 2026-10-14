import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type { DashboardRepository } from './dashboard.repository';
import { DashboardService } from './dashboard.service';
import type { DashboardSnapshot } from './dashboard.types';

describe('DashboardService', () => {
  const context: TenantTransactionContext = {
    storeId: '18dcbf0a-acbe-48d6-88ed-cd1b078ddf41',
    userId: 'a417fabd-b3c8-409c-9db3-2d62fdce21fd',
    deviceId: '59e90f52-05aa-4bf4-af84-242686f712a8',
    requestId: '9f97bb10-b68a-4474-888e-7244fc581bcb',
  };
  const principal = {
    membershipRole: 'owner',
    storeId: context.storeId,
    userId: context.userId,
    deviceId: context.deviceId,
  } satisfies Pick<AuthenticatedPrincipal, 'membershipRole' | 'storeId' | 'userId' | 'deviceId'>;
  const occurredAt = new Date('2026-10-14T08:00:00.000Z');
  const snapshot: DashboardSnapshot = {
    asOf: occurredAt,
    timezoneName: 'Asia/Hebron',
    businessDate: '2026-10-14',
    today: {
      salesMinor: '9007199254740993',
      immediateSaleCollectionsMinor: '1',
      customerCollectionsMinor: '2',
      customerReceivableAllocationsMinor: '2',
      totalCollectedMinor: '3',
      creditSalesMinor: '4',
      expensesRecognizedMinor: '5',
      supplierPaymentsMinor: '6',
    },
    money: { accounts: [], totalMinor: '0' },
    obligations: { customerReceivablesMinor: '7', supplierPayablesMinor: '8' },
    inventory: {
      trackedProductCount: 1,
      projectedProductCount: 1,
      missingProjectionCount: 0,
      positiveStockProductCount: 1,
      zeroStockProductCount: 0,
      negativeStockProductCount: 0,
      knownCostProductCount: 0,
      unknownCostProductCount: 1,
      pendingCostProductCount: 0,
      knownValueMinor: '0',
      totalValueMinor: null,
      valuationStatus: 'unknown',
    },
    recentActivity: [
      {
        activityType: 'inventory_movement',
        resourceId: 'd6339f6f-a043-4138-8f39-3de1c584073a',
        subtype: 'adjustment_in',
        status: null,
        displayNumber: null,
        amountMinor: null,
        quantityDeltaMilli: '9007199254740995',
        businessDate: '2026-10-14',
        postingDate: '2026-10-14',
        accountingPeriodId: '4ad36ba4-8f20-43fe-9f3a-a6ccbe85a62d',
        occurredAt,
      },
    ],
  };
  const repository = {
    read: jest.fn().mockResolvedValue(snapshot),
  } as unknown as DashboardRepository;
  const service = new DashboardService(repository);

  beforeEach(() => jest.clearAllMocks());

  it('returns exact decimal strings and bounded chronological activity', async () => {
    await expect(service.read(principal, context)).resolves.toMatchObject({
      asOf: occurredAt.toISOString(),
      today: { salesMinor: '9007199254740993' },
      inventory: { totalValueMinor: null, valuationStatus: 'unknown' },
      recentActivity: {
        limit: 20,
        items: [
          {
            quantityDeltaMilli: '9007199254740995',
            occurredAt: occurredAt.toISOString(),
          },
        ],
      },
    });
    expect(repository.read).toHaveBeenCalledWith(context);
  });

  it.each([
    { ...principal, membershipRole: 'manager' as const },
    { ...principal, storeId: '3d840d9a-d42e-4bdf-b71f-e0d4d9f05441' },
    { ...principal, userId: '4ad36ba4-8f20-43fe-9f3a-a6ccbe85a62d' },
    { ...principal, deviceId: '873ef648-a779-4aaf-bf8b-936b092ecb93' },
  ])('fails closed for an unauthorized principal or context', async (unauthorized) => {
    await expect(service.read(unauthorized, context)).rejects.toMatchObject({
      status: 403,
      response: { code: 'DASHBOARD_READ_NOT_ALLOWED' },
    });
    expect(repository.read).not.toHaveBeenCalled();
  });
});
