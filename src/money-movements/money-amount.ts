// Money is always exact bigint minor units. Floating-point is never monetary authority.
// The representable posting-delta domain excludes the non-negatable PostgreSQL bigint
// minimum so that reversal and transfer opposite-sign generation are always representable
// (D10-P2 of the Money Posting Contract v1).

export const MAX_MONEY_MINOR = 9_223_372_036_854_775_807n;
export const MIN_MONEY_MINOR = -9_223_372_036_854_775_807n;

const integerStringPattern = /^-?(0|[1-9]\d*)$/;

export class MoneyAmountError extends Error {
  constructor(
    readonly field: string,
    readonly code: 'notBigint' | 'nonZero' | 'outOfRange' | 'notIntegerString',
  ) {
    super('Money amount is invalid.');
    this.name = 'MoneyAmountError';
  }
}

export function assertMoneyAmountDeltaMinor(value: bigint, field = 'amountDeltaMinor'): void {
  if (typeof value !== 'bigint') {
    throw new MoneyAmountError(field, 'notBigint');
  }
  if (value === 0n) {
    throw new MoneyAmountError(field, 'nonZero');
  }
  if (value > MAX_MONEY_MINOR || value < MIN_MONEY_MINOR) {
    throw new MoneyAmountError(field, 'outOfRange');
  }
}

// Exact decimal-string boundary representation of an already-integer minor amount.
// It rejects floats, scientific notation, whitespace, and empty input; there is no
// currency-scale conversion here (that belongs to whichever future public API adopts a
// scale) and never any Number/parseFloat arithmetic.
export function parseMoneyMinorString(value: string, field = 'amountDeltaMinor'): bigint {
  if (typeof value !== 'string' || !integerStringPattern.test(value)) {
    throw new MoneyAmountError(field, 'notIntegerString');
  }
  return BigInt(value);
}

export function serializeMoneyMinor(value: bigint): string {
  return value.toString();
}
