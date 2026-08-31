export const MONEY_ACCOUNT_NAME_NORMALIZATION_VERSION = 1;

export const MONEY_ACCOUNT_NAME_V1_WHITESPACE_CODE_POINTS = Object.freeze([
  ...Array.from({ length: 5 }, (_, index) => 0x0009 + index),
  0x0020,
  0x0085,
  0x00a0,
  0x1680,
  ...Array.from({ length: 11 }, (_, index) => 0x2000 + index),
  0x2028,
  0x2029,
  0x202f,
  0x205f,
  0x3000,
]);

export type MoneyAccountNameValidationField = 'name' | 'normalizedName';

export type MoneyAccountNameValidationErrorCode =
  | 'MONEY_ACCOUNT_NAME_VALUE_TYPE_INVALID'
  | 'MONEY_ACCOUNT_NAME_NOT_POSTGRESQL_REPRESENTABLE'
  | 'MONEY_ACCOUNT_DISPLAY_NAME_EMPTY'
  | 'MONEY_ACCOUNT_NORMALIZED_NAME_EMPTY';

const errorMessages: Readonly<Record<MoneyAccountNameValidationErrorCode, string>> = {
  MONEY_ACCOUNT_NAME_VALUE_TYPE_INVALID: 'The Money Account name must be a string.',
  MONEY_ACCOUNT_NAME_NOT_POSTGRESQL_REPRESENTABLE:
    'The Money Account name is not representable by PostgreSQL text.',
  MONEY_ACCOUNT_DISPLAY_NAME_EMPTY: 'The Money Account display name must not be empty.',
  MONEY_ACCOUNT_NORMALIZED_NAME_EMPTY: 'The normalized Money Account name must not be empty.',
};

export class MoneyAccountNameValidationError extends Error {
  constructor(
    public readonly code: MoneyAccountNameValidationErrorCode,
    public readonly field: MoneyAccountNameValidationField,
  ) {
    super(errorMessages[code]);
    this.name = 'MoneyAccountNameValidationError';
  }
}

export interface CanonicalMoneyAccountNameV1 {
  readonly name: string;
  readonly normalizedName: string;
}

const moneyAccountNameV1WhitespaceCodePoints = new Set(
  MONEY_ACCOUNT_NAME_V1_WHITESPACE_CODE_POINTS,
);

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) {
        return false;
      }
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }

  return true;
}

function requirePostgreSqlText(value: unknown): string {
  if (typeof value !== 'string') {
    throw new MoneyAccountNameValidationError('MONEY_ACCOUNT_NAME_VALUE_TYPE_INVALID', 'name');
  }
  if (value.includes('\u0000') || !isWellFormedUnicode(value)) {
    throw new MoneyAccountNameValidationError(
      'MONEY_ACCOUNT_NAME_NOT_POSTGRESQL_REPRESENTABLE',
      'name',
    );
  }

  return value;
}

function collapseMoneyAccountNameV1Whitespace(value: string): string {
  let output = '';
  let pendingSpace = false;

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? -1;
    if (moneyAccountNameV1WhitespaceCodePoints.has(codePoint)) {
      pendingSpace = output.length > 0;
      continue;
    }

    if (pendingSpace) {
      output += ' ';
      pendingSpace = false;
    }
    output += character;
  }

  return output;
}

export function canonicalizeMoneyAccountDisplayNameV1(value: unknown): string {
  const canonical = collapseMoneyAccountNameV1Whitespace(requirePostgreSqlText(value));
  if (canonical.length === 0) {
    throw new MoneyAccountNameValidationError('MONEY_ACCOUNT_DISPLAY_NAME_EMPTY', 'name');
  }

  return canonical;
}

/**
 * Version 1 identity: NFKC, locale-independent ECMAScript lowercase, then the
 * explicit Unicode White_Space set collapsed to ASCII spaces. JavaScript does
 * not expose Unicode full case folding; `toLowerCase()` is the deterministic
 * locale-independent runtime equivalent selected by this contract.
 */
export function normalizeMoneyAccountNameV1(value: unknown): string {
  const normalized = collapseMoneyAccountNameV1Whitespace(
    requirePostgreSqlText(value).normalize('NFKC').toLowerCase(),
  );
  if (normalized.length === 0) {
    throw new MoneyAccountNameValidationError(
      'MONEY_ACCOUNT_NORMALIZED_NAME_EMPTY',
      'normalizedName',
    );
  }

  return normalized;
}

export function canonicalizeMoneyAccountNameV1(value: unknown): CanonicalMoneyAccountNameV1 {
  const name = canonicalizeMoneyAccountDisplayNameV1(value);
  return {
    name,
    normalizedName: normalizeMoneyAccountNameV1(name),
  };
}
