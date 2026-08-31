import {
  canonicalizeMoneyAccountDisplayNameV1,
  canonicalizeMoneyAccountNameV1,
  MONEY_ACCOUNT_NAME_NORMALIZATION_VERSION,
  MoneyAccountNameValidationError,
  normalizeMoneyAccountNameV1,
} from './money-account-normalization';

function expectValidationError(
  work: () => unknown,
  code: MoneyAccountNameValidationError['code'],
  field: MoneyAccountNameValidationError['field'],
): void {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(MoneyAccountNameValidationError);
    expect(error).toMatchObject({ code, field });
    return;
  }

  throw new Error(`Expected ${code}.`);
}

describe('Money Account name normalization v1', () => {
  it('publishes an explicit version and normalizes Unicode whitespace deterministically', () => {
    expect(MONEY_ACCOUNT_NAME_NORMALIZATION_VERSION).toBe(1);
    expect(normalizeMoneyAccountNameV1('  بنك فلسطين  ')).toBe('بنك فلسطين');
    expect(normalizeMoneyAccountNameV1('بنك   فلسطين')).toBe('بنك فلسطين');
    expect(normalizeMoneyAccountNameV1('\u00a0بنك\u2003فلسطين\u3000')).toBe('بنك فلسطين');
  });

  it('uses NFKC and locale-independent lowercase for deterministic Latin identity', () => {
    for (const value of ['Bank Account', 'BANK ACCOUNT', 'bank account']) {
      expect(normalizeMoneyAccountNameV1(value)).toBe('bank account');
    }

    expect(normalizeMoneyAccountNameV1('CAFÉ')).toBe(normalizeMoneyAccountNameV1('Cafe\u0301'));
    expect(normalizeMoneyAccountNameV1('ＢＡＮＫ ①')).toBe('bank 1');
  });

  it('preserves readable Arabic, mixed content, digits, punctuation, and meaningful marks', () => {
    for (const value of [
      'الصندوق',
      'بنك فلسطين الخاص بي',
      'محفظة جوال باي',
      'حساب بنك فلسطين أبو محمد',
      'حساب Bank 24',
    ]) {
      expect(normalizeMoneyAccountNameV1(value)).toBe(value.toLowerCase());
    }

    expect(normalizeMoneyAccountNameV1('حساب-1')).not.toBe(normalizeMoneyAccountNameV1('حساب 1'));
    expect(normalizeMoneyAccountNameV1('أَب')).toBe('أَب');
    expect(normalizeMoneyAccountNameV1('اَب')).toBe('اَب');
    expect(normalizeMoneyAccountNameV1('حساب\u200bخاص')).toBe('حساب\u200bخاص');
  });

  it('keeps display identity separate while returning a canonical pair', () => {
    expect(canonicalizeMoneyAccountDisplayNameV1('  BANK\u00a0Account  ')).toBe('BANK Account');
    expect(canonicalizeMoneyAccountNameV1('  BANK\u00a0Account  ')).toEqual({
      name: 'BANK Account',
      normalizedName: 'bank account',
    });
  });

  it('rejects empty and PostgreSQL-unrepresentable names without arbitrary length limits', () => {
    expectValidationError(
      () => canonicalizeMoneyAccountDisplayNameV1('\u00a0\u2003\t'),
      'MONEY_ACCOUNT_DISPLAY_NAME_EMPTY',
      'name',
    );
    expectValidationError(
      () => normalizeMoneyAccountNameV1('\u00a0\u2003\t'),
      'MONEY_ACCOUNT_NORMALIZED_NAME_EMPTY',
      'normalizedName',
    );
    expectValidationError(
      () => normalizeMoneyAccountNameV1(42),
      'MONEY_ACCOUNT_NAME_VALUE_TYPE_INVALID',
      'name',
    );
    expectValidationError(
      () => normalizeMoneyAccountNameV1('invalid\u0000name'),
      'MONEY_ACCOUNT_NAME_NOT_POSTGRESQL_REPRESENTABLE',
      'name',
    );
    expectValidationError(
      () => normalizeMoneyAccountNameV1('\ud800'),
      'MONEY_ACCOUNT_NAME_NOT_POSTGRESQL_REPRESENTABLE',
      'name',
    );

    const unboundedByProductPolicy = 'ح'.repeat(10_000);
    expect(normalizeMoneyAccountNameV1(unboundedByProductPolicy)).toBe(unboundedByProductPolicy);
  });

  it('returns the same normalized identity on every invocation', () => {
    const input = '  محفظة Bank ①\u2003الخاصة  ';
    const first = normalizeMoneyAccountNameV1(input);

    for (let iteration = 0; iteration < 10; iteration += 1) {
      expect(normalizeMoneyAccountNameV1(input)).toBe(first);
    }
  });
});
