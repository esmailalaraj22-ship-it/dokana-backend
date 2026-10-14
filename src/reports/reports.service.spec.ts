import { randomUUID } from 'node:crypto';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import { decodeReportCursor, reportCursorScopeHash } from './report-cursor';
import { ReportsRepository } from './reports.repository';
import { ReportsService } from './reports.service';
import type { SalesReportRow } from './reports.types';

const storeId = randomUUID();
const userId = randomUUID();
const deviceId = randomUUID();
const context: TenantTransactionContext = {
  storeId,
  userId,
  deviceId,
  requestId: randomUUID(),
};
const principal = {
  storeId,
  userId,
  deviceId,
  membershipRole: 'owner',
} as AuthenticatedPrincipal;

function sale(id: string): SalesReportRow {
  return {
    id,
    displayNumber: 'S-1',
    customerId: null,
    customerName: null,
    status: 'posted',
    paymentStatus: 'paid',
    totalMinor: '9007199254740993',
    paidTotalMinor: '9007199254740993',
    creditTotalMinor: '0',
    returnedTotalMinor: '0',
    knownCostTotalMinor: '12',
    pendingCostLineCount: 0,
    unknownCostLineCount: 0,
    businessDate: '2026-01-10',
    postingDate: '2026-01-10',
    accountingPeriodId: randomUUID(),
    occurredAt: '2026-01-10T10:00:00.000Z',
    correctionOfId: null,
    reversedById: null,
  };
}

describe('ReportsService', () => {
  let repository: jest.Mocked<ReportsRepository>;
  let service: ReportsService;

  beforeEach(() => {
    repository = {
      readSales: jest.fn(),
      readOwnerLedger: jest.fn(),
    } as unknown as jest.Mocked<ReportsRepository>;
    service = new ReportsService(repository);
  });

  it('maps exact values, page/full totals, and a scope-bound next cursor', async () => {
    const firstId = randomUUID();
    repository.readSales.mockResolvedValue({
      asOf: new Date('2026-01-11T00:00:00.000Z'),
      items: [sale(firstId)],
      hasMore: true,
      pageTotals: {
        rowCount: 1,
        postedTotalMinor: '9007199254740993',
        cancelledTotalMinor: '0',
        correctedTotalMinor: '0',
        paidTotalMinor: '9007199254740993',
        creditTotalMinor: '0',
        returnedTotalMinor: '0',
        netPostedSalesMinor: '9007199254740993',
      },
      filteredTotals: {
        rowCount: 2,
        postedTotalMinor: '9007199254740994',
        cancelledTotalMinor: '0',
        correctedTotalMinor: '0',
        paidTotalMinor: '9007199254740994',
        creditTotalMinor: '0',
        returnedTotalMinor: '0',
        netPostedSalesMinor: '9007199254740994',
      },
    });

    const response = await service.readSales(principal, context, {
      fromDate: '2026-01-01',
      toDate: '2026-01-31',
      limit: 1,
    });

    expect(response.items[0]?.totalMinor).toBe('9007199254740993');
    expect(response.totals.page.rowCount).toBe(1);
    expect(response.totals.filtered.rowCount).toBe(2);
    expect(response.pagination.nextCursor).not.toBeNull();
    expect(
      decodeReportCursor(
        response.pagination.nextCursor ?? '',
        reportCursorScopeHash('sales', ['2026-01-01', '2026-01-31', null, null, 'all']),
      ),
    ).toMatchObject({ anchorId: firstId, anchorType: null });
  });

  it('rejects invalid calendar ranges before querying PostgreSQL', () => {
    expect(() =>
      service.readSales(principal, context, {
        fromDate: '2026-02-30',
        toDate: '2026-03-01',
      }),
    ).toThrow('Report query is invalid.');
    expect(repository.readSales).not.toHaveBeenCalled();
  });

  it('allows only the authenticated Store owner', () => {
    expect(() =>
      service.readSales({ ...principal, membershipRole: 'manager' }, context, {
        fromDate: '2026-01-01',
        toDate: '2026-01-31',
      }),
    ).toThrow('Report reads are not allowed.');
  });
});
