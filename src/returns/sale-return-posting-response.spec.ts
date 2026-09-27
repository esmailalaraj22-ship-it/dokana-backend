import { randomUUID } from 'node:crypto';

import { deriveMoneyFactId } from '../money-movements/money-movement-identity';
import { parseStoredSaleReturnPostingResponse } from './sale-return-posting-response';
import type { SaleReturnPostingResponse } from './sale-return-posting.types';

function response(): SaleReturnPostingResponse {
  const operationId = randomUUID();
  return {
    operationId,
    transactionGroupId: operationId,
    return: {
      id: deriveMoneyFactId(operationId, 'sale-return'),
      displayNumber: `SR-${operationId}`,
      saleId: randomUUID(),
      saleDisplayNumber: 'SALE-1',
      customerId: null,
      totalMinor: '0',
      status: 'posted',
      returnAt: '2026-09-27T10:00:00.000Z',
      createdAt: '2026-09-27T10:00:00.000Z',
      version: '1',
    },
    lines: [],
    settlements: [],
    settlementSummary: {
      receivableReductionMinor: '0',
      originalCustomerCreditRestorationMinor: '0',
      refundMinor: '0',
      newCustomerCreditMinor: '0',
      residualChoice: null,
    },
    posting: {
      businessDate: '2026-09-27',
      postingDate: '2026-09-27',
      accountingPeriodId: randomUUID(),
    },
  };
}

describe('S17.3 stored Sale Return response', () => {
  it('accepts an exact canonical applied response', () => {
    const stored = response();
    expect(parseStoredSaleReturnPostingResponse(stored)).toEqual(stored);
  });

  it('rejects tampered root and transaction identities', () => {
    const stored = response();
    expect(() =>
      parseStoredSaleReturnPostingResponse({
        ...stored,
        return: { ...stored.return, id: randomUUID() },
      }),
    ).toThrow('Stored Sale Return response identity is invalid.');
    expect(() =>
      parseStoredSaleReturnPostingResponse({ ...stored, transactionGroupId: randomUUID() }),
    ).toThrow('Stored Sale Return response identity is invalid.');
  });

  it('rejects stored totals that do not reconcile', () => {
    const stored = response();
    expect(() =>
      parseStoredSaleReturnPostingResponse({
        ...stored,
        return: { ...stored.return, totalMinor: '1' },
      }),
    ).toThrow('Stored Sale Return totals are invalid.');
  });
});
