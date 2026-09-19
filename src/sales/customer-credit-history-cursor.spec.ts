import {
  assertCustomerCreditHistoryCursorScope,
  customerCreditHistoryScopeHash,
  decodeCustomerCreditHistoryCursor,
  encodeCustomerCreditHistoryCursor,
} from './customer-credit-history-cursor';

const customerId = '15450000-0000-4000-8000-000000000001';
const otherCustomerId = '15450000-0000-4000-8000-000000000002';
const entryId = '15450000-0000-4000-8000-00000000a003';

describe('S15.4 Customer Credit history cursor', () => {
  it('round-trips a scoped canonical keyset anchor', () => {
    const cursor = {
      scopeHash: customerCreditHistoryScopeHash(customerId),
      anchor: { id: entryId, occurredAt: '2026-09-15T10:00:00.000Z' },
    };
    expect(decodeCustomerCreditHistoryCursor(encodeCustomerCreditHistoryCursor(cursor))).toEqual(
      cursor,
    );
  });

  it('rejects malformed, non-canonical, and cross-Customer cursors', () => {
    expect(() => decodeCustomerCreditHistoryCursor('not+base64')).toThrow();
    expect(() =>
      encodeCustomerCreditHistoryCursor({
        scopeHash: customerCreditHistoryScopeHash(customerId),
        anchor: { id: entryId.toUpperCase(), occurredAt: '2026-09-15T10:00:00.000Z' },
      }),
    ).toThrow();
    const decoded = decodeCustomerCreditHistoryCursor(
      encodeCustomerCreditHistoryCursor({
        scopeHash: customerCreditHistoryScopeHash(customerId),
        anchor: { id: entryId, occurredAt: '2026-09-15T10:00:00.000Z' },
      }),
    );
    expect(() => assertCustomerCreditHistoryCursorScope(decoded, otherCustomerId)).toThrow();
  });
});
