import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

export const CUSTOMER_NORMALIZATION_VERSION = 1;

export type CustomerNormalizationErrorCode =
  | 'CUSTOMER_DISPLAY_NAME_EMPTY'
  | 'CUSTOMER_NORMALIZED_NAME_EMPTY'
  | 'CUSTOMER_DISPLAY_PHONE_EMPTY'
  | 'CUSTOMER_PHONE_EMPTY'
  | 'CUSTOMER_PHONE_INVALID'
  | 'CUSTOMER_PHONE_EXTENSION_UNSUPPORTED';

const customerNormalizationErrorMessages: Readonly<Record<CustomerNormalizationErrorCode, string>> =
  {
    CUSTOMER_DISPLAY_NAME_EMPTY: 'Customer display name must not be empty.',
    CUSTOMER_NORMALIZED_NAME_EMPTY: 'Customer normalized name must not be empty.',
    CUSTOMER_DISPLAY_PHONE_EMPTY: 'Customer display phone must not be empty.',
    CUSTOMER_PHONE_EMPTY: 'Customer phone must not be empty.',
    CUSTOMER_PHONE_INVALID: 'Customer phone is invalid.',
    CUSTOMER_PHONE_EXTENSION_UNSUPPORTED: 'Customer phone extensions are not supported.',
  };

export class CustomerNormalizationError extends Error {
  constructor(public readonly code: CustomerNormalizationErrorCode) {
    super(customerNormalizationErrorMessages[code]);
    this.name = 'CustomerNormalizationError';
  }
}

function isV1Whitespace(codePoint: number): boolean {
  return (
    (codePoint >= 0x0009 && codePoint <= 0x000d) ||
    codePoint === 0x0020 ||
    codePoint === 0x0085 ||
    codePoint === 0x00a0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000
  );
}

function collapseV1Whitespace(input: string): string {
  let output = '';
  let pendingSpace = false;

  for (const character of input) {
    const codePoint = character.codePointAt(0) ?? -1;
    if (isV1Whitespace(codePoint)) {
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

function trimV1Whitespace(input: string): string {
  const characters = Array.from(input);
  let start = 0;
  let end = characters.length;

  while (start < end && isV1Whitespace(characters[start]?.codePointAt(0) ?? -1)) {
    start += 1;
  }
  while (end > start && isV1Whitespace(characters[end - 1]?.codePointAt(0) ?? -1)) {
    end -= 1;
  }

  return characters.slice(start, end).join('');
}

function isV1ArabicVocalizationMark(codePoint: number): boolean {
  return (codePoint >= 0x064b && codePoint <= 0x065f) || codePoint === 0x0670;
}

function foldV1AlefVariant(character: string): string {
  return character === '\u0623' ||
    character === '\u0625' ||
    character === '\u0622' ||
    character === '\u0671'
    ? '\u0627'
    : character;
}

export function cleanCustomerDisplayName(input: string): string {
  const cleaned = collapseV1Whitespace(input);

  if (cleaned.length === 0) {
    throw new CustomerNormalizationError('CUSTOMER_DISPLAY_NAME_EMPTY');
  }

  return cleaned;
}

export function normalizeCustomerName(input: string): string {
  const normalizedWhitespace = collapseV1Whitespace(input.normalize('NFKC')).toLowerCase();
  let normalized = '';

  for (const character of normalizedWhitespace) {
    const codePoint = character.codePointAt(0) ?? -1;
    if (codePoint === 0x0640 || isV1ArabicVocalizationMark(codePoint)) {
      continue;
    }
    normalized += foldV1AlefVariant(character);
  }

  if (normalized.length === 0) {
    throw new CustomerNormalizationError('CUSTOMER_NORMALIZED_NAME_EMPTY');
  }

  return normalized;
}

export function normalizeCustomerPhoneDigits(input: string): string {
  let normalized = '';

  for (const character of input) {
    const codePoint = character.codePointAt(0) ?? -1;
    if (codePoint >= 0x0660 && codePoint <= 0x0669) {
      normalized += String(codePoint - 0x0660);
    } else if (codePoint >= 0x06f0 && codePoint <= 0x06f9) {
      normalized += String(codePoint - 0x06f0);
    } else {
      normalized += character;
    }
  }

  return normalized;
}

export function cleanCustomerDisplayPhone(input: string): string {
  const cleaned = trimV1Whitespace(input);

  if (cleaned.length === 0) {
    throw new CustomerNormalizationError('CUSTOMER_DISPLAY_PHONE_EMPTY');
  }

  return cleaned;
}

export function normalizeCustomerPhone(input: string): string {
  const trimmed = trimV1Whitespace(input);
  if (trimmed.length === 0) {
    throw new CustomerNormalizationError('CUSTOMER_PHONE_EMPTY');
  }

  const normalizedDigits = normalizeCustomerPhoneDigits(trimmed);
  const phoneNumber = parsePhoneNumberFromString(normalizedDigits, {
    defaultCountry: 'PS',
    extract: false,
  });

  if (phoneNumber?.ext !== undefined) {
    throw new CustomerNormalizationError('CUSTOMER_PHONE_EXTENSION_UNSUPPORTED');
  }
  if (!phoneNumber?.isValid()) {
    throw new CustomerNormalizationError('CUSTOMER_PHONE_INVALID');
  }

  return phoneNumber.number;
}
