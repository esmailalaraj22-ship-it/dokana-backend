import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { DatabaseService } from '../database/database.service';
import type { DatabaseTransaction } from '../database/database.types';
import { NotificationRepository } from './notification.repository';
import type { NotificationCause } from './notification.types';

interface CanonicalCauseReader {
  readCanonicalCauses(
    transaction: DatabaseTransaction,
    storeId: string,
  ): Promise<NotificationCause[]>;
}

describe('NotificationRepository canonical cause mapping', () => {
  const dialect = new PgDialect();
  const repository = new NotificationRepository({} as DatabaseService);
  const storeId = '24000000-0000-4000-8000-000000000001';

  it('maps every approved canonical cause without creating a second accounting authority', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            customerDebtAmountAlertMinor: '50000',
            debtAgeAlertDays: 30,
            defaultCreditLimitMinor: '60000',
            lowStockAlertEnabled: true,
            timezoneName: 'Asia/Hebron',
            businessDate: '2026-10-16',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: '24000000-0000-4000-8000-000000000010',
            name: 'Debt Customer',
            netDueMinor: '60000',
            effectiveCreditLimitMinor: '60000',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: '24000000-0000-4000-8000-000000000010',
            name: 'Debt Customer',
            oldestOccurredAt: '2026-08-01T10:00:00.000Z',
            ageDays: 76,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: '24000000-0000-4000-8000-000000000020',
            displayNumber: 'PI-20',
            supplierName: 'Due Supplier',
            outstandingMinor: '70000',
            dueDate: '2026-10-15',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: '24000000-0000-4000-8000-000000000021',
            name: 'Credit Supplier',
            creditMinor: '12000',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: '24000000-0000-4000-8000-000000000030',
            name: 'Out Product',
            quantityMilli: '0',
            lowStockThresholdMilli: '5000',
          },
          {
            id: '24000000-0000-4000-8000-000000000031',
            name: 'Negative Product',
            quantityMilli: '-1000',
            lowStockThresholdMilli: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: '24000000-0000-4000-8000-000000000040',
            description: 'Rent',
            dueMinor: '90000',
            dueDate: '2026-10-16',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            subscriptionId: '24000000-0000-4000-8000-000000000050',
            entitlementEndsAt: '2026-10-20T10:00:00.000Z',
            warningActive: true,
          },
        ],
      });
    const transaction = { execute } as unknown as DatabaseTransaction;

    const causes = await (repository as unknown as CanonicalCauseReader).readCanonicalCauses(
      transaction,
      storeId,
    );

    expect(causes.map((cause) => cause.type).sort()).toEqual(
      [
        'customer_debt_amount',
        'customer_debt_age',
        'customer_credit_limit',
        'supplier_due',
        'review_required',
        'low_stock',
        'negative_stock',
        'expense_due',
        'subscription_expiry',
      ].sort(),
    );
    expect(causes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 's21:v1:customer_debt_amount:customer:24000000-0000-4000-8000-000000000010',
          severity: 'warning',
        }),
        expect.objectContaining({
          key: 's21:v1:customer_credit_limit:customer:24000000-0000-4000-8000-000000000010',
          severity: 'critical',
        }),
        expect.objectContaining({
          key: 's21:v1:negative_stock:product:24000000-0000-4000-8000-000000000031',
          severity: 'critical',
        }),
      ]),
    );
    expect(execute).toHaveBeenCalledTimes(8);
    const executeCalls = execute.mock.calls as unknown as readonly (readonly [unknown])[];
    const supplierQuery = dialect.sqlToQuery(executeCalls[3]?.[0] as SQL).sql.replace(/\s+/gu, ' ');
    expect(supplierQuery).toContain("invoice.status in ('open', 'closed')");
    expect(supplierQuery).toContain('allocation.purchase_invoice_id=invoice.id');
    expect(supplierQuery).toContain("payment.status='posted'");
    expect(supplierQuery).toContain('where outstanding_minor > 0');
  });

  it('does not create a subscription warning when trusted database time is outside the window', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            customerDebtAmountAlertMinor: '50000',
            debtAgeAlertDays: 30,
            defaultCreditLimitMinor: null,
            lowStockAlertEnabled: false,
            timezoneName: 'Asia/Hebron',
            businessDate: '2026-10-16',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            subscriptionId: '24000000-0000-4000-8000-000000000050',
            entitlementEndsAt: '2027-10-20T10:00:00.000Z',
            warningActive: false,
          },
        ],
      });

    await expect(
      (repository as unknown as CanonicalCauseReader).readCanonicalCauses(
        { execute } as unknown as DatabaseTransaction,
        storeId,
      ),
    ).resolves.toEqual([]);
  });
});
