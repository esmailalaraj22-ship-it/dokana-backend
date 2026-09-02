import {
  ACCOUNTING_PERIOD_UUID_NAMESPACE,
  deriveAccountingPeriodId,
} from './accounting-period-identity';

describe('accounting period deterministic identity', () => {
  const storeId = '10000000-0000-0000-0000-000000000001';

  it('pins the frozen namespace and approved cross-platform test vector', () => {
    expect(ACCOUNTING_PERIOD_UUID_NAMESPACE).toBe('2c9aa30a-c026-5003-93f8-8e2e921c76ff');
    expect(deriveAccountingPeriodId(storeId, 2026, 9)).toBe('7a85230d-bcbe-55ab-94a9-e7e8daedfacd');
  });

  it('returns the same UUID for the same canonical Store month', () => {
    const first = deriveAccountingPeriodId(storeId, 2026, 9);
    const second = deriveAccountingPeriodId(storeId.toUpperCase(), 2026, 9);

    expect(second).toBe(first);
  });

  it('changes identity when the month or Store changes', () => {
    const expected = deriveAccountingPeriodId(storeId, 2026, 9);

    expect(deriveAccountingPeriodId(storeId, 2026, 10)).not.toBe(expected);
    expect(deriveAccountingPeriodId('20000000-0000-0000-0000-000000000001', 2026, 9)).not.toBe(
      expected,
    );
  });

  it.each(['not-a-uuid', '10000000-0000-0000-0000-00000000000'])(
    'rejects malformed Store identity %s',
    (value) => {
      expect(() => deriveAccountingPeriodId(value, 2026, 9)).toThrow(TypeError);
    },
  );

  it.each([
    [2019, 1],
    [2026, 0],
    [2026, 13],
  ])('rejects malformed period input (%s, %s)', (year, month) => {
    expect(() => deriveAccountingPeriodId(storeId, year, month)).toThrow(RangeError);
  });
});
