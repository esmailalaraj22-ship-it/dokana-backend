import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import normalizationVectors from '../../docs/contracts/customer-normalization-v1.json';
import {
  cleanCustomerDisplayName,
  cleanCustomerDisplayPhone,
  CUSTOMER_NORMALIZATION_VERSION,
  CustomerNormalizationError,
  type CustomerNormalizationErrorCode,
  normalizeCustomerName,
  normalizeCustomerPhone,
  normalizeCustomerPhoneDigits,
} from './customer-normalization';

function expectNormalizationError(
  work: () => unknown,
  expectedCode: CustomerNormalizationErrorCode,
): void {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(CustomerNormalizationError);
    if (!(error instanceof CustomerNormalizationError)) {
      throw error;
    }
    expect(error.code).toBe(expectedCode);
    return;
  }

  throw new Error(`Expected Customer normalization error ${expectedCode}.`);
}

describe('Customer normalization v1', () => {
  it('loads the language-neutral static golden-vector artifact', () => {
    const artifactPath = resolve(process.cwd(), 'docs/contracts/customer-normalization-v1.json');
    const parsed: unknown = JSON.parse(readFileSync(artifactPath, 'utf8'));

    expect(parsed).toEqual(normalizationVectors);
    expect(normalizationVectors.normalizationVersion).toBe(CUSTOMER_NORMALIZATION_VERSION);
  });

  it('matches every static name golden vector and keeps canonical output idempotent', () => {
    for (const vector of normalizationVectors.nameCases) {
      if (vector.displayError) {
        expectNormalizationError(
          () => cleanCustomerDisplayName(vector.input),
          vector.displayError as CustomerNormalizationErrorCode,
        );
      } else {
        expect(cleanCustomerDisplayName(vector.input)).toBe(vector.display);
      }

      if (vector.normalizedError) {
        expectNormalizationError(
          () => normalizeCustomerName(vector.input),
          vector.normalizedError as CustomerNormalizationErrorCode,
        );
      } else {
        const normalized = normalizeCustomerName(vector.input);
        expect(normalized).toBe(vector.normalized);
        expect(normalizeCustomerName(normalized)).toBe(normalized);
      }
    }
  });

  it('recognizes exactly the v1 whitespace code points', () => {
    const whitespaceCodePoints = [
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
    ];

    for (const codePoint of whitespaceCodePoints) {
      expect(cleanCustomerDisplayName(`A${String.fromCodePoint(codePoint)}B`)).toBe('A B');
      expect(cleanCustomerDisplayPhone(`${String.fromCodePoint(codePoint)}123`)).toBe('123');
    }

    for (const codePoint of [0x0008, 0x000e, 0x180e, 0x200b, 0x2060, 0xfeff]) {
      const character = String.fromCodePoint(codePoint);
      expect(cleanCustomerDisplayName(`A${character}B`)).toBe(`A${character}B`);
      expect(cleanCustomerDisplayPhone(`${character}123`)).toBe(`${character}123`);
    }
  });

  it('removes only the approved Arabic vocalization marks and preserves other combining marks', () => {
    const approvedMarks = [
      ...Array.from({ length: 21 }, (_, index) => String.fromCodePoint(0x064b + index)),
      String.fromCodePoint(0x0670),
    ].join('');

    expect(normalizeCustomerName(`ب${approvedMarks}ت`)).toBe('بت');
    expect(normalizeCustomerName('ب\u0301ت')).toBe('ب\u0301ت');
  });

  it('preserves distinct display names that intentionally share one canonical name', () => {
    const plain = cleanCustomerDisplayName('أحمد');
    const decorated = cleanCustomerDisplayName('أحمــد');

    expect(plain).not.toBe(decorated);
    expect(normalizeCustomerName(plain)).toBe(normalizeCustomerName(decorated));
  });

  it('maps only the supported Customer phone digit sets', () => {
    expect(normalizeCustomerPhoneDigits('0123456789')).toBe('0123456789');
    expect(normalizeCustomerPhoneDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
    expect(normalizeCustomerPhoneDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
    expect(normalizeCustomerPhoneDigits('0١۲3٤۵6٧۸9')).toBe('0123456789');
    expect(normalizeCustomerPhoneDigits('+ (0599)-ABC')).toBe('+ (0599)-ABC');
    expect(normalizeCustomerPhoneDigits('०१२३')).toBe('०१२३');
  });

  it('matches every static phone golden vector and keeps E.164 output idempotent', () => {
    for (const vector of normalizationVectors.phoneCases) {
      if (vector.displayError) {
        expectNormalizationError(
          () => cleanCustomerDisplayPhone(vector.input),
          vector.displayError as CustomerNormalizationErrorCode,
        );
      } else {
        expect(cleanCustomerDisplayPhone(vector.input)).toBe(vector.display);
      }

      if (vector.normalizedError) {
        expectNormalizationError(
          () => normalizeCustomerPhone(vector.input),
          vector.normalizedError as CustomerNormalizationErrorCode,
        );
      } else {
        const normalized = normalizeCustomerPhone(vector.input);
        expect(normalized).toBe(vector.normalized);
        expect(normalizeCustomerPhone(normalized)).toBe(normalized);
      }
    }
  });

  it('keeps explicit +970 and +972 country calling codes distinct', () => {
    expect(normalizeCustomerPhone('+970 599 123 456')).toBe('+970599123456');
    expect(normalizeCustomerPhone('+972 50 234 5678')).toBe('+972502345678');
  });
});
