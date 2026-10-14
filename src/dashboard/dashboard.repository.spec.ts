import type { DatabaseService } from '../database/database.service';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { DashboardRepository } from './dashboard.repository';

describe('DashboardRepository', () => {
  const context: TenantTransactionContext = {
    storeId: '18dcbf0a-acbe-48d6-88ed-cd1b078ddf41',
    userId: 'a417fabd-b3c8-409c-9db3-2d62fdce21fd',
    deviceId: '59e90f52-05aa-4bf4-af84-242686f712a8',
    requestId: '9f97bb10-b68a-4474-888e-7244fc581bcb',
  };
  const asOf = new Date('2026-10-14T09:00:00.000Z');
  const execute = jest.fn();
  const transaction = { execute } as unknown as DatabaseTransaction;
  const database = {
    withTenantSnapshotTransaction: jest.fn(
      async (
        _context: TenantTransactionContext,
        work: (value: DatabaseTransaction) => Promise<unknown>,
      ) => work(transaction),
    ),
  } as unknown as DatabaseService;
  const repository = new DashboardRepository(database);

  beforeEach(() => {
    jest.clearAllMocks();
    execute
      .mockResolvedValueOnce({
        rows: [
          {
            asOf,
            businessDate: '2026-10-14',
            salesMinor: '9007199254740993',
            immediateSaleCollectionsMinor: '100',
            customerCollectionsMinor: '200',
            customerReceivableAllocationsMinor: '150',
            totalCollectedMinor: '300',
            creditSalesMinor: '400',
            expensesRecognizedMinor: '500',
            supplierPaymentsMinor: '600',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: '3d840d9a-d42e-4bdf-b71f-e0d4d9f05441',
            name: 'Cash',
            accountType: 'cash',
            isDefault: true,
            balanceMinor: '9007199254740995',
            totalMinor: '9007199254740995',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            customerReceivablesMinor: '700',
            supplierPayablesMinor: '800',
            trackedProductCount: 3,
            projectedProductCount: 2,
            missingProjectionCount: 1,
            positiveStockProductCount: 2,
            zeroStockProductCount: 0,
            negativeStockProductCount: 0,
            knownCostProductCount: 1,
            unknownCostProductCount: 1,
            pendingCostProductCount: 0,
            uncertainValueProductCount: 2,
            knownValueMinor: '9007199254740997',
            totalValueMinor: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            activityType: 'inventory_movement',
            resourceId: 'd6339f6f-a043-4138-8f39-3de1c584073a',
            subtype: 'adjustment_in',
            status: null,
            displayNumber: null,
            amountMinor: null,
            quantityDeltaMilli: '9007199254740999',
            businessDate: '2026-10-14',
            postingDate: '2026-10-14',
            accountingPeriodId: '4ad36ba4-8f20-43fe-9f3a-a6ccbe85a62d',
            occurredAt: asOf,
          },
        ],
      });
  });

  it('assembles exact authoritative reads inside one tenant snapshot', async () => {
    await expect(repository.read(context)).resolves.toMatchObject({
      asOf,
      timezoneName: 'Asia/Hebron',
      businessDate: '2026-10-14',
      today: {
        salesMinor: '9007199254740993',
        totalCollectedMinor: '300',
      },
      money: {
        totalMinor: '9007199254740995',
        accounts: [{ balanceMinor: '9007199254740995' }],
      },
      obligations: {
        customerReceivablesMinor: '700',
        supplierPayablesMinor: '800',
      },
      inventory: {
        valuationStatus: 'partial',
        knownValueMinor: '9007199254740997',
        totalValueMinor: null,
      },
      recentActivity: [{ quantityDeltaMilli: '9007199254740999' }],
    });
    expect(database.withTenantSnapshotTransaction).toHaveBeenCalledTimes(1);
    expect(database.withTenantSnapshotTransaction).toHaveBeenCalledWith(
      context,
      expect.any(Function),
    );
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('reports a fully known zero inventory position without inventing uncertainty', async () => {
    execute.mockReset();
    execute
      .mockResolvedValueOnce({
        rows: [
          {
            asOf,
            businessDate: '2026-10-14',
            salesMinor: '0',
            immediateSaleCollectionsMinor: '0',
            customerCollectionsMinor: '0',
            customerReceivableAllocationsMinor: '0',
            totalCollectedMinor: '0',
            creditSalesMinor: '0',
            expensesRecognizedMinor: '0',
            supplierPaymentsMinor: '0',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            customerReceivablesMinor: '0',
            supplierPayablesMinor: '0',
            trackedProductCount: 0,
            projectedProductCount: 0,
            missingProjectionCount: 0,
            positiveStockProductCount: 0,
            zeroStockProductCount: 0,
            negativeStockProductCount: 0,
            knownCostProductCount: 0,
            unknownCostProductCount: 0,
            pendingCostProductCount: 0,
            uncertainValueProductCount: 0,
            knownValueMinor: '0',
            totalValueMinor: '0',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(repository.read(context)).resolves.toMatchObject({
      money: { accounts: [], totalMinor: '0' },
      inventory: { valuationStatus: 'known', totalValueMinor: '0' },
    });
  });
});
