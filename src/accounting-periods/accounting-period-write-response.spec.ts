import {
  mapAccountingPeriodMutationResponse,
  parseStoredAccountingPeriodMutationResponse,
} from './accounting-period-write-response';
import type { AccountingPeriodMutationRow } from './accounting-period-write.types';

const row: AccountingPeriodMutationRow = {
  id: '94200000-0000-4000-8000-000000000001',
  storeId: '94200000-0000-4000-8000-000000000002',
  periodYear: 2026,
  periodMonth: 9,
  startsAt: new Date('2026-08-31T21:00:00.000Z'),
  endsAt: new Date('2026-09-30T21:00:00.000Z'),
  status: 'closed',
  closedAt: new Date('2026-09-30T21:05:00.000Z'),
  deviceId: '94200000-0000-4000-8000-000000000003',
  operationId: '94200000-0000-4000-8000-000000000004',
  createdAt: new Date('2026-08-31T08:00:00.000Z'),
  updatedAt: new Date('2026-09-30T21:05:00.000Z'),
  version: 9_007_199_254_740_993n,
};

describe('Accounting Period close response', () => {
  it('stores the exact minimal UTC response with a lossless version and operation ID', () => {
    const response = mapAccountingPeriodMutationResponse(row, row.operationId);

    expect(response).toEqual({
      id: row.id,
      periodYear: 2026,
      periodMonth: 9,
      startsAt: '2026-08-31T21:00:00.000Z',
      endsAt: '2026-09-30T21:00:00.000Z',
      status: 'closed',
      closedAt: '2026-09-30T21:05:00.000Z',
      createdAt: '2026-08-31T08:00:00.000Z',
      updatedAt: '2026-09-30T21:05:00.000Z',
      version: '9007199254740993',
      operationId: row.operationId,
    });
    expect(parseStoredAccountingPeriodMutationResponse(response)).toEqual(response);
  });

  it('rejects open, malformed, or numeric-version stored snapshots', () => {
    const response = mapAccountingPeriodMutationResponse(row, row.operationId);
    for (const invalid of [
      { ...response, status: 'open', closedAt: null },
      { ...response, id: 'invalid' },
      { ...response, version: 1 },
    ]) {
      expect(() => parseStoredAccountingPeriodMutationResponse(invalid)).toThrow();
    }
  });
});
