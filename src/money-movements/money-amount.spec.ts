import {
  assertMoneyAmountDeltaMinor,
  MAX_MONEY_MINOR,
  MIN_MONEY_MINOR,
  MoneyAmountError,
  parseMoneyMinorString,
  serializeMoneyMinor,
} from './money-amount';

describe('money amount safety', () => {
  it('accepts the maximum representable positive bigint magnitude', () => {
    expect(() => assertMoneyAmountDeltaMinor(MAX_MONEY_MINOR)).not.toThrow();
    expect(MAX_MONEY_MINOR).toBe(9_223_372_036_854_775_807n);
  });

  it('accepts the negatable minimum magnitude', () => {
    expect(() => assertMoneyAmountDeltaMinor(MIN_MONEY_MINOR)).not.toThrow();
  });

  it('rejects a zero movement delta', () => {
    expect(() => assertMoneyAmountDeltaMinor(0n)).toThrow(MoneyAmountError);
  });

  it('rejects the non-negatable PostgreSQL bigint minimum', () => {
    expect(() => assertMoneyAmountDeltaMinor(-9_223_372_036_854_775_808n)).toThrow(
      MoneyAmountError,
    );
  });

  it('rejects magnitudes above the signed bigint maximum', () => {
    expect(() => assertMoneyAmountDeltaMinor(MAX_MONEY_MINOR + 1n)).toThrow(MoneyAmountError);
  });

  it('parses exact integer minor strings without floating-point arithmetic', () => {
    expect(parseMoneyMinorString('1250')).toBe(1250n);
    expect(parseMoneyMinorString('-4200')).toBe(-4200n);
    expect(serializeMoneyMinor(-4200n)).toBe('-4200');
  });

  it.each(['12.50', '1e3', '  10', '', '+5', '01', 'abc'])(
    'rejects non-integer monetary string %s',
    (value) => {
      expect(() => parseMoneyMinorString(value)).toThrow(MoneyAmountError);
    },
  );
});
