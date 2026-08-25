import normalizationVectors from '../../docs/contracts/customer-normalization-v1.json';
import type { CustomerNormalizationErrorCode } from '../customers/customer-normalization';
import {
  canonicalizeSupplierName,
  canonicalizeSupplierNotes,
  canonicalizeSupplierPhone,
  canonicalizeSupplierUuid,
  cleanSupplierDisplayName,
  cleanSupplierDisplayPhone,
  normalizeSupplierName,
  normalizeSupplierPhone,
  SUPPLIER_NORMALIZATION_VERSION,
  SUPPLIER_VALIDATION_CONTRACT_VERSION,
  SupplierValidationError,
  type SupplierValidationErrorCode,
  type SupplierValidationField,
} from './supplier-validation';

const supplierErrorByCustomerError: Readonly<
  Record<CustomerNormalizationErrorCode, SupplierValidationErrorCode>
> = {
  CUSTOMER_DISPLAY_NAME_EMPTY: 'SUPPLIER_DISPLAY_NAME_EMPTY',
  CUSTOMER_NORMALIZED_NAME_EMPTY: 'SUPPLIER_NORMALIZED_NAME_EMPTY',
  CUSTOMER_DISPLAY_PHONE_EMPTY: 'SUPPLIER_DISPLAY_PHONE_EMPTY',
  CUSTOMER_PHONE_EMPTY: 'SUPPLIER_PHONE_EMPTY',
  CUSTOMER_PHONE_INVALID: 'SUPPLIER_PHONE_INVALID',
  CUSTOMER_PHONE_EXTENSION_UNSUPPORTED: 'SUPPLIER_PHONE_EXTENSION_UNSUPPORTED',
};

function expectSupplierValidationError(
  work: () => unknown,
  expectedCode: SupplierValidationErrorCode,
  expectedField: SupplierValidationField,
): void {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(SupplierValidationError);
    if (!(error instanceof SupplierValidationError)) {
      throw error;
    }
    expect(error.code).toBe(expectedCode);
    expect(error.field).toBe(expectedField);
    expect(error.code).toMatch(/^SUPPLIER_/);
    expect(error.code).not.toMatch(/^CUSTOMER_/);
    expect(error.message).not.toMatch(/Customer/);
    return;
  }

  throw new Error(`Expected Supplier validation error ${expectedCode}.`);
}

describe('Supplier validation and normalization v1', () => {
  it('uses the approved contract and Customer normalization versions', () => {
    expect(SUPPLIER_VALIDATION_CONTRACT_VERSION).toBe(1);
    expect(SUPPLIER_NORMALIZATION_VERSION).toBe(normalizationVectors.normalizationVersion);
  });

  it('matches every Customer-v1 name vector without leaking Customer errors', () => {
    for (const vector of normalizationVectors.nameCases) {
      if (vector.displayError) {
        expectSupplierValidationError(
          () => cleanSupplierDisplayName(vector.input),
          supplierErrorByCustomerError[vector.displayError as CustomerNormalizationErrorCode],
          'name',
        );
      } else {
        expect(cleanSupplierDisplayName(vector.input)).toBe(vector.display);
      }

      if (vector.normalizedError) {
        expectSupplierValidationError(
          () => normalizeSupplierName(vector.input),
          supplierErrorByCustomerError[vector.normalizedError as CustomerNormalizationErrorCode],
          'normalizedName',
        );
      } else {
        const normalizedName = normalizeSupplierName(vector.input);
        expect(normalizedName).toBe(vector.normalized);
        expect(normalizeSupplierName(normalizedName)).toBe(normalizedName);
      }
    }
  });

  it('returns canonical display and normalized names without changing display semantics', () => {
    expect(
      canonicalizeSupplierName('  AHMAD   \u0623\u064e\u062d\u0645\u0640\u0640\u062f-01  '),
    ).toEqual({
      name: 'AHMAD \u0623\u064e\u062d\u0645\u0640\u0640\u062f-01',
      normalizedName: 'ahmad \u0627\u062d\u0645\u062f-01',
    });
  });

  it('recognizes the exact v1 whitespace set and preserves excluded zero-width characters', () => {
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
      expect(cleanSupplierDisplayName(`A${String.fromCodePoint(codePoint)}B`)).toBe('A B');
      expect(cleanSupplierDisplayPhone(`${String.fromCodePoint(codePoint)}0599123456`)).toBe(
        '0599123456',
      );
    }

    for (const codePoint of [0x0008, 0x000e, 0x180e, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]) {
      const character = String.fromCodePoint(codePoint);
      expect(cleanSupplierDisplayName(`A${character}B`)).toBe(`A${character}B`);
      expect(cleanSupplierDisplayPhone(`${character}0599123456`)).toBe(`${character}0599123456`);
    }
  });

  it('applies only the approved Arabic removal and folding rules', () => {
    const approvedMarks = [
      ...Array.from({ length: 21 }, (_, index) => String.fromCodePoint(0x064b + index)),
      String.fromCodePoint(0x0670),
    ].join('');

    expect(normalizeSupplierName(`\u0628${approvedMarks}\u062a`)).toBe('\u0628\u062a');
    expect(normalizeSupplierName('\u0623 \u0625 \u0622 \u0671')).toBe(
      '\u0627 \u0627 \u0627 \u0627',
    );
    expect(normalizeSupplierName('\u0629 \u0649 \u0624 \u0626')).toBe(
      '\u0629 \u0649 \u0624 \u0626',
    );
    expect(normalizeSupplierName('\u0628\u0301\u062a')).toBe('\u0628\u0301\u062a');
    expect(normalizeSupplierName('\u0635\u0646\u0641\u060c (\u0623)! 12')).toBe(
      '\u0635\u0646\u0641\u060c (\u0627)! 12',
    );
  });

  it('rejects invalid name types, empty results, and non-PostgreSQL text', () => {
    expectSupplierValidationError(
      () => canonicalizeSupplierName(null),
      'SUPPLIER_VALUE_TYPE_INVALID',
      'name',
    );
    expectSupplierValidationError(
      () => cleanSupplierDisplayName(' \u00a0\u2003 '),
      'SUPPLIER_DISPLAY_NAME_EMPTY',
      'name',
    );
    expectSupplierValidationError(
      () => normalizeSupplierName('\u0640\u064b'),
      'SUPPLIER_NORMALIZED_NAME_EMPTY',
      'normalizedName',
    );

    for (const value of ['before\u0000after', '\ud800', '\udc00']) {
      expectSupplierValidationError(
        () => canonicalizeSupplierName(value),
        'SUPPLIER_TEXT_NOT_POSTGRESQL_REPRESENTABLE',
        'name',
      );
    }
  });

  it('requires a non-null phone for the new-Supplier validation primitive', () => {
    for (const value of [undefined, null]) {
      expectSupplierValidationError(
        () => canonicalizeSupplierPhone(value),
        'SUPPLIER_PHONE_REQUIRED',
        'phone',
      );
    }

    expectSupplierValidationError(
      () => canonicalizeSupplierPhone(599123456),
      'SUPPLIER_VALUE_TYPE_INVALID',
      'phone',
    );
  });

  it('matches every Customer-v1 phone vector without leaking Customer errors', () => {
    for (const vector of normalizationVectors.phoneCases) {
      if (vector.displayError) {
        expectSupplierValidationError(
          () => cleanSupplierDisplayPhone(vector.input),
          supplierErrorByCustomerError[vector.displayError as CustomerNormalizationErrorCode],
          'phone',
        );
      } else {
        expect(cleanSupplierDisplayPhone(vector.input)).toBe(vector.display);
      }

      if (vector.normalizedError) {
        expectSupplierValidationError(
          () => normalizeSupplierPhone(vector.input),
          supplierErrorByCustomerError[vector.normalizedError as CustomerNormalizationErrorCode],
          'phone',
        );
      } else {
        const normalizedPhone = normalizeSupplierPhone(vector.input);
        expect(normalizedPhone).toBe(vector.normalized);
        expect(normalizeSupplierPhone(normalizedPhone)).toBe(normalizedPhone);
      }
    }
  });

  it('returns canonical display and E.164 phone values without custom country-code rewriting', () => {
    expect(canonicalizeSupplierPhone(' \u00a0(0599) 123 456\u2003')).toEqual({
      phone: '(0599) 123 456',
      normalizedPhone: '+970599123456',
    });
    expect(canonicalizeSupplierPhone('+970 599 123 456').normalizedPhone).toBe('+970599123456');
    expect(canonicalizeSupplierPhone('+972 50 234 5678').normalizedPhone).toBe('+972502345678');
    expect(canonicalizeSupplierPhone('00442079460958').normalizedPhone).toBe('+442079460958');
  });

  it('rejects phone text-safety violations before Customer normalization can observe them', () => {
    for (const value of ['0599\u0000123456', '\ud800', '\udc00']) {
      expectSupplierValidationError(
        () => canonicalizeSupplierPhone(value),
        'SUPPLIER_TEXT_NOT_POSTGRESQL_REPRESENTABLE',
        'phone',
      );
    }
  });

  it('preserves every valid notes string exactly and keeps null distinct', () => {
    expect(canonicalizeSupplierNotes(null)).toBeNull();
    expect(canonicalizeSupplierNotes('')).toBe('');
    expect(canonicalizeSupplierNotes(' \u00a0\u2003 ')).toBe(' \u00a0\u2003 ');
    expect(
      canonicalizeSupplierNotes(
        '  \u0645\u064f\u0648\u0631\u0651\u062f\u064c \u0622\u062e\u0631  ',
      ),
    ).toBe('  \u0645\u064f\u0648\u0631\u0651\u062f\u064c \u0622\u062e\u0631  ');
  });

  it('rejects invalid notes types and non-PostgreSQL notes text', () => {
    expectSupplierValidationError(
      () => canonicalizeSupplierNotes(undefined),
      'SUPPLIER_VALUE_TYPE_INVALID',
      'notes',
    );

    for (const value of ['before\u0000after', '\ud800', '\udc00']) {
      expectSupplierValidationError(
        () => canonicalizeSupplierNotes(value),
        'SUPPLIER_TEXT_NOT_POSTGRESQL_REPRESENTABLE',
        'notes',
      );
    }
  });

  it('uses the established persistent UUID domain and lowercase canonical text', () => {
    for (const value of [
      '10000000-0000-1000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-8000-8000-000000000001',
      '00000000-0000-0000-0000-000000000000',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
      'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
    ]) {
      expect(canonicalizeSupplierUuid(value, 'id')).toBe(value.toLowerCase());
      expect(canonicalizeSupplierUuid(value, 'operationId')).toBe(value.toLowerCase());
    }
  });

  it('rejects values outside the established UUID domain with Supplier errors', () => {
    for (const value of [
      'not-a-uuid',
      '10000000-0000-0000-8000-000000000001',
      '10000000-0000-4000-7000-000000000001',
      '10000000-0000-4000-c000-000000000001',
      null,
    ]) {
      expectSupplierValidationError(
        () => canonicalizeSupplierUuid(value, 'id'),
        'SUPPLIER_UUID_INVALID',
        'id',
      );
      expectSupplierValidationError(
        () => canonicalizeSupplierUuid(value, 'operationId'),
        'SUPPLIER_UUID_INVALID',
        'operationId',
      );
    }
  });
});
