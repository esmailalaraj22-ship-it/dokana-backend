import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import validationVectors from '../../docs/contracts/product-unit-validation-v1.json';
import {
  canonicalizeProductBarcode,
  canonicalizeProductDescription,
  canonicalizeProductDisplayName,
  canonicalizeProductName,
  canonicalizeProductSku,
  canonicalizeProductUnitCode,
  canonicalizeProductUnitName,
  canonicalizeProductUuid,
  isProductV1Whitespace,
  normalizeProductName,
  POSTGRESQL_BIGINT_MAX,
  POSTGRESQL_INT4_MAX,
  PRODUCT_MEASUREMENT_TYPES,
  PRODUCT_NORMALIZATION_VERSION,
  PRODUCT_VALIDATION_CONTRACT_VERSION,
  PRODUCT_V1_WHITESPACE_CODE_POINTS,
  ProductValidationError,
  type ProductValidationErrorCode,
  type ProductValidationField,
  validateProductLowStockThresholdMilli,
  validateProductMeasurementType,
  validateProductNegativeStockOverride,
  validateProductPinned,
  validateProductTrackInventory,
  validateProductUnitMeasurementCompatibility,
  validateProductUnitPurchasePriceMinor,
  validateProductUnitRatio,
  validateProductUnitSalePriceMinor,
} from './product-validation';

function expectValidationError(
  work: () => unknown,
  expectedCode: ProductValidationErrorCode,
  expectedField?: ProductValidationField,
): void {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(ProductValidationError);
    if (!(error instanceof ProductValidationError)) {
      throw error;
    }
    expect(error.code).toBe(expectedCode);
    if (expectedField !== undefined) {
      expect(error.field).toBe(expectedField);
    }
    expect(error.message).not.toMatch(/001234|SKU|كرتونة/);
    return;
  }

  throw new Error(`Expected Product validation error ${expectedCode}.`);
}

describe('Product and Unit validation contract v1', () => {
  it('loads the static language-neutral golden-vector artifact', () => {
    const artifactPath = resolve(process.cwd(), 'docs/contracts/product-unit-validation-v1.json');
    const parsed: unknown = JSON.parse(readFileSync(artifactPath, 'utf8'));

    expect(parsed).toEqual(validationVectors);
    expect(validationVectors.validationContractVersion).toBe(PRODUCT_VALIDATION_CONTRACT_VERSION);
    expect(validationVectors.productNormalizationVersion).toBe(PRODUCT_NORMALIZATION_VERSION);
  });

  it('matches Product-name vectors with deterministic and idempotent canonical output', () => {
    for (const vector of validationVectors.productNameCases) {
      if (vector.displayError !== null) {
        expectValidationError(
          () => canonicalizeProductDisplayName(vector.input),
          vector.displayError as ProductValidationErrorCode,
        );
      } else {
        const display = canonicalizeProductDisplayName(vector.input);
        expect(display).toBe(vector.display);
        expect(canonicalizeProductDisplayName(display)).toBe(display);
      }

      if (vector.normalizedError !== null) {
        expectValidationError(
          () => normalizeProductName(vector.input),
          vector.normalizedError as ProductValidationErrorCode,
        );
      } else {
        const normalized = normalizeProductName(vector.input);
        expect(normalized).toBe(vector.normalized);
        expect(normalizeProductName(vector.input)).toBe(normalized);
        expect(normalizeProductName(normalized)).toBe(normalized);

        const canonical = canonicalizeProductName(vector.input);
        expect(canonical).toEqual({ name: vector.display, normalizedName: vector.normalized });
      }
    }
  });

  it('recognizes exactly the approved Product-v1 whitespace set', () => {
    expect(PRODUCT_V1_WHITESPACE_CODE_POINTS).toHaveLength(25);

    for (const codePoint of PRODUCT_V1_WHITESPACE_CODE_POINTS) {
      const character = String.fromCodePoint(codePoint);
      expect(isProductV1Whitespace(character)).toBe(true);
      expect(canonicalizeProductDisplayName(`A${character}B`)).toBe('A B');
      expect(canonicalizeProductSku(`${character}SKU${character}`)).toBe('SKU');
    }

    for (const codePoint of [0x0008, 0x000e, 0x180e, 0x200b, 0x2060, 0xfeff]) {
      const character = String.fromCodePoint(codePoint);
      expect(isProductV1Whitespace(character)).toBe(false);
      expect(canonicalizeProductDisplayName(`A${character}B`)).toBe(`A${character}B`);
      expect(canonicalizeProductSku(`${character}SKU${character}`)).toBe(
        `${character}SKU${character}`,
      );
    }

    expect(isProductV1Whitespace('AB')).toBe(false);
  });

  it('removes only approved Arabic marks and folds only approved Alef variants', () => {
    const approvedMarks = [
      ...Array.from({ length: 21 }, (_, index) => String.fromCodePoint(0x064b + index)),
      String.fromCodePoint(0x0670),
    ].join('');

    expect(normalizeProductName(`ب${approvedMarks}ت`)).toBe('بت');
    expect(normalizeProductName('أ إ آ ٱ')).toBe('ا ا ا ا');
    expect(normalizeProductName('ة ى ؤ ئ')).toBe('ة ى ؤ ئ');
    expect(normalizeProductName('ب\u0301ت')).toBe('ب\u0301ت');
    expect(normalizeProductName('صنف، (أ)!')).toBe('صنف، (ا)!');
  });

  it('canonicalizes SKU and barcode vectors without changing identifier identity', () => {
    for (const vector of validationVectors.skuCases) {
      const canonical = canonicalizeProductSku(vector.input);
      expect(canonical).toBe(vector.canonical);
      expect(canonicalizeProductSku(canonical)).toBe(canonical);
    }

    for (const vector of validationVectors.barcodeCases) {
      const canonical = canonicalizeProductBarcode(vector.input);
      expect(canonical).toBe(vector.canonical);
      expect(canonicalizeProductBarcode(canonical)).toBe(canonical);
    }

    expect(canonicalizeProductSku('ABC')).not.toBe(canonicalizeProductSku('abc'));
    expect(canonicalizeProductBarcode(' 001234 ')).toBe('001234');
    expectValidationError(
      () => canonicalizeProductBarcode(1234),
      'PRODUCT_VALUE_TYPE_INVALID',
      'barcode',
    );
    expectValidationError(
      () => canonicalizeProductSku(undefined),
      'PRODUCT_VALUE_TYPE_INVALID',
      'sku',
    );
  });

  it('canonicalizes Unit name/code vectors independently from Product-name rules', () => {
    for (const vector of validationVectors.unitNameCases) {
      if (vector.error !== null) {
        expectValidationError(
          () => canonicalizeProductUnitName(vector.input),
          vector.error as ProductValidationErrorCode,
        );
      } else {
        const canonical = canonicalizeProductUnitName(vector.input);
        expect(canonical).toBe(vector.canonical);
        expect(canonicalizeProductUnitName(canonical)).toBe(canonical);
      }
    }

    for (const vector of validationVectors.unitCodeCases) {
      const canonical = canonicalizeProductUnitCode(vector.input);
      expect(canonical).toBe(vector.canonical);
      expect(canonicalizeProductUnitCode(canonical)).toBe(canonical);
    }

    expect(canonicalizeProductUnitName('أُوقِيَّة')).toBe('أُوقِيَّة');
    expect(canonicalizeProductUnitCode('AbC')).toBe('AbC');
  });

  it('preserves nullable description text and rejects non-representable PostgreSQL text', () => {
    expect(canonicalizeProductDescription(null)).toBeNull();
    expect(canonicalizeProductDescription('')).toBe('');
    expect(canonicalizeProductDescription('  وصفٌ (خاص)  ')).toBe('  وصفٌ (خاص)  ');

    for (const work of [
      () => canonicalizeProductDescription('before\u0000after'),
      () => canonicalizeProductSku('\ud800'),
      () => canonicalizeProductBarcode('\udc00'),
      () => canonicalizeProductDisplayName('\ud800'),
    ]) {
      expectValidationError(work, 'PRODUCT_TEXT_NOT_POSTGRESQL_REPRESENTABLE');
    }
  });

  it('validates the closed measurement domain and same-payload compatibility', () => {
    for (const measurementType of PRODUCT_MEASUREMENT_TYPES) {
      expect(validateProductMeasurementType(measurementType)).toBe(measurementType);
      expect(validateProductUnitMeasurementCompatibility(measurementType, measurementType)).toBe(
        measurementType,
      );
    }

    for (const value of ['pieces', 'COUNT', '', null, 1]) {
      expectValidationError(
        () => validateProductMeasurementType(value),
        'PRODUCT_MEASUREMENT_TYPE_INVALID',
      );
    }
    expectValidationError(
      () => validateProductUnitMeasurementCompatibility('count', 'weight'),
      'PRODUCT_MEASUREMENT_TYPE_MISMATCH',
      'unitMeasurementType',
    );
  });

  it('preserves exact positive int4 ratio identity and enforces the base 1/1 rule', () => {
    expect(validateProductUnitRatio({ isBase: false, factorNum: 1, factorDen: 1 })).toEqual({
      isBase: false,
      factorNum: 1,
      factorDen: 1,
    });
    expect(validateProductUnitRatio({ isBase: false, factorNum: 2, factorDen: 4 })).toEqual({
      isBase: false,
      factorNum: 2,
      factorDen: 4,
    });
    expect(
      validateProductUnitRatio({
        isBase: false,
        factorNum: POSTGRESQL_INT4_MAX,
        factorDen: POSTGRESQL_INT4_MAX,
      }),
    ).toEqual({
      isBase: false,
      factorNum: POSTGRESQL_INT4_MAX,
      factorDen: POSTGRESQL_INT4_MAX,
    });
    expect(validateProductUnitRatio({ isBase: true, factorNum: 1, factorDen: 1 })).toEqual({
      isBase: true,
      factorNum: 1,
      factorDen: 1,
    });

    for (const invalidFactor of [
      0,
      -1,
      POSTGRESQL_INT4_MAX + 1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '1',
      1n,
    ]) {
      expectValidationError(
        () => validateProductUnitRatio({ isBase: false, factorNum: invalidFactor, factorDen: 1 }),
        'PRODUCT_UNIT_FACTOR_OUT_OF_RANGE',
        'factorNum',
      );
      expectValidationError(
        () => validateProductUnitRatio({ isBase: false, factorNum: 1, factorDen: invalidFactor }),
        'PRODUCT_UNIT_FACTOR_OUT_OF_RANGE',
        'factorDen',
      );
    }

    expectValidationError(
      () => validateProductUnitRatio({ isBase: true, factorNum: 2, factorDen: 1 }),
      'PRODUCT_UNIT_BASE_RATIO_INVALID',
      'isBase',
    );
  });

  it('preserves PostgreSQL bigint precision, null, and explicit zero', () => {
    const largeExact = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    const validators = [
      validateProductUnitSalePriceMinor,
      validateProductUnitPurchasePriceMinor,
      validateProductLowStockThresholdMilli,
    ];

    for (const validate of validators) {
      expect(validate(null)).toBeNull();
      expect(validate(0n)).toBe(0n);
      expect(validate(largeExact)).toBe(largeExact);
      expect(validate(POSTGRESQL_BIGINT_MAX)).toBe(POSTGRESQL_BIGINT_MAX);
      expectValidationError(() => validate(-1n), 'PRODUCT_BIGINT_OUT_OF_RANGE');
      expectValidationError(
        () => validate(POSTGRESQL_BIGINT_MAX + 1n),
        'PRODUCT_BIGINT_OUT_OF_RANGE',
      );
      expectValidationError(
        () => validate(Number.MAX_SAFE_INTEGER + 2),
        'PRODUCT_VALUE_TYPE_INVALID',
      );
      expectValidationError(() => validate(1), 'PRODUCT_VALUE_TYPE_INVALID');
      expectValidationError(() => validate('1'), 'PRODUCT_VALUE_TYPE_INVALID');
      expectValidationError(() => validate(undefined), 'PRODUCT_VALUE_TYPE_INVALID');
    }
  });

  it('keeps nullable configuration states distinct and rejects truthy coercion', () => {
    expect(validateProductNegativeStockOverride(null)).toBeNull();
    expect(validateProductNegativeStockOverride(false)).toBe(false);
    expect(validateProductNegativeStockOverride(true)).toBe(true);
    expect(validateProductTrackInventory(false)).toBe(false);
    expect(validateProductTrackInventory(true)).toBe(true);
    expect(validateProductPinned(false)).toBe(false);
    expect(validateProductPinned(true)).toBe(true);

    for (const invalid of [undefined, 0, 1, '', 'false']) {
      expectValidationError(
        () => validateProductNegativeStockOverride(invalid),
        'PRODUCT_VALUE_TYPE_INVALID',
        'allowNegativeStockOverride',
      );
      expectValidationError(
        () => validateProductTrackInventory(invalid),
        'PRODUCT_VALUE_TYPE_INVALID',
        'trackInventory',
      );
    }
  });

  it('uses the established UUID domain and canonical lowercase representation', () => {
    for (const value of [
      '10000000-0000-1000-8000-000000000001',
      '10000000-0000-8000-8000-000000000001',
      '00000000-0000-0000-0000-000000000000',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
      'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
    ]) {
      expect(canonicalizeProductUuid(value, 'id')).toBe(value.toLowerCase());
    }

    for (const value of [
      'not-a-uuid',
      '10000000-0000-0000-8000-000000000001',
      '10000000-0000-4000-7000-000000000001',
      null,
    ]) {
      expectValidationError(
        () => canonicalizeProductUuid(value, 'operationId'),
        'PRODUCT_UUID_INVALID',
        'operationId',
      );
    }
  });

  it('returns new canonical ratio/name values without mutating caller input', () => {
    const ratioInput = Object.freeze({ isBase: false, factorNum: 2, factorDen: 4 });
    const ratioSnapshot = { ...ratioInput };
    const ratio = validateProductUnitRatio(ratioInput);

    expect(ratioInput).toEqual(ratioSnapshot);
    expect(ratio).not.toBe(ratioInput);

    const nameInput = Object.freeze({ value: '  أحمــد   1L  ' });
    const nameSnapshot = { ...nameInput };
    const first = canonicalizeProductName(nameInput.value);
    const second = canonicalizeProductName(nameInput.value);

    expect(nameInput).toEqual(nameSnapshot);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });
});
