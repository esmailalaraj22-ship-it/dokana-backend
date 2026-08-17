import { isUUID } from 'class-validator';

export const PRODUCT_VALIDATION_CONTRACT_VERSION = 1;
export const PRODUCT_NORMALIZATION_VERSION = 1;
export const POSTGRESQL_INT4_MAX = 2_147_483_647;
export const POSTGRESQL_BIGINT_MAX = 9_223_372_036_854_775_807n;

export const PRODUCT_MEASUREMENT_TYPES = ['count', 'weight', 'volume', 'length'] as const;

export type ProductMeasurementType = (typeof PRODUCT_MEASUREMENT_TYPES)[number];

export type ProductValidationField =
  | 'id'
  | 'productId'
  | 'operationId'
  | 'name'
  | 'normalizedName'
  | 'sku'
  | 'barcode'
  | 'description'
  | 'measurementType'
  | 'productMeasurementType'
  | 'unitMeasurementType'
  | 'trackInventory'
  | 'allowNegativeStockOverride'
  | 'lowStockThresholdMilli'
  | 'isPinned'
  | 'unitName'
  | 'unitCode'
  | 'isBase'
  | 'factorNum'
  | 'factorDen'
  | 'salePriceMinor'
  | 'purchasePriceMinor';

export type ProductValidationErrorCode =
  | 'PRODUCT_UUID_INVALID'
  | 'PRODUCT_VALUE_TYPE_INVALID'
  | 'PRODUCT_TEXT_NOT_POSTGRESQL_REPRESENTABLE'
  | 'PRODUCT_DISPLAY_NAME_EMPTY'
  | 'PRODUCT_NORMALIZED_NAME_EMPTY'
  | 'PRODUCT_UNIT_NAME_EMPTY'
  | 'PRODUCT_MEASUREMENT_TYPE_INVALID'
  | 'PRODUCT_MEASUREMENT_TYPE_MISMATCH'
  | 'PRODUCT_UNIT_FACTOR_OUT_OF_RANGE'
  | 'PRODUCT_UNIT_BASE_RATIO_INVALID'
  | 'PRODUCT_BIGINT_OUT_OF_RANGE';

const errorMessages: Readonly<Record<ProductValidationErrorCode, string>> = {
  PRODUCT_UUID_INVALID: 'The identifier is not a valid UUID.',
  PRODUCT_VALUE_TYPE_INVALID: 'The supplied value has an invalid type.',
  PRODUCT_TEXT_NOT_POSTGRESQL_REPRESENTABLE:
    'The supplied text is not representable by PostgreSQL text.',
  PRODUCT_DISPLAY_NAME_EMPTY: 'Product display name must not be empty.',
  PRODUCT_NORMALIZED_NAME_EMPTY: 'Product normalized name must not be empty.',
  PRODUCT_UNIT_NAME_EMPTY: 'Product Unit name must not be empty.',
  PRODUCT_MEASUREMENT_TYPE_INVALID: 'Product measurement type is invalid.',
  PRODUCT_MEASUREMENT_TYPE_MISMATCH: 'Product Unit measurement type must match its Product.',
  PRODUCT_UNIT_FACTOR_OUT_OF_RANGE: 'Product Unit factor is outside the PostgreSQL int4 range.',
  PRODUCT_UNIT_BASE_RATIO_INVALID: 'A base Product Unit must use the ratio 1/1.',
  PRODUCT_BIGINT_OUT_OF_RANGE: 'The value is outside the supported PostgreSQL bigint range.',
};

export class ProductValidationError extends Error {
  constructor(
    public readonly code: ProductValidationErrorCode,
    public readonly field: ProductValidationField,
  ) {
    super(errorMessages[code]);
    this.name = 'ProductValidationError';
  }
}

export const PRODUCT_V1_WHITESPACE_CODE_POINTS = Object.freeze([
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

const productV1WhitespaceCodePoints = new Set(PRODUCT_V1_WHITESPACE_CODE_POINTS);
const productMeasurementTypes = new Set<string>(PRODUCT_MEASUREMENT_TYPES);

export interface CanonicalProductName {
  readonly name: string;
  readonly normalizedName: string;
}

export interface ProductUnitRatioInput {
  readonly isBase: unknown;
  readonly factorNum: unknown;
  readonly factorDen: unknown;
}

export interface ProductUnitRatio {
  readonly isBase: boolean;
  readonly factorNum: number;
  readonly factorDen: number;
}

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

function requirePostgreSqlText(value: unknown, field: ProductValidationField): string {
  if (typeof value !== 'string') {
    throw new ProductValidationError('PRODUCT_VALUE_TYPE_INVALID', field);
  }
  if (value.includes('\u0000') || !isWellFormedUnicode(value)) {
    throw new ProductValidationError('PRODUCT_TEXT_NOT_POSTGRESQL_REPRESENTABLE', field);
  }

  return value;
}

export function isProductV1Whitespace(character: string): boolean {
  const codePoints = Array.from(character);
  return (
    codePoints.length === 1 &&
    productV1WhitespaceCodePoints.has(codePoints[0]?.codePointAt(0) ?? -1)
  );
}

function collapseProductV1Whitespace(value: string): string {
  let output = '';
  let pendingSpace = false;

  for (const character of value) {
    if (isProductV1Whitespace(character)) {
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

function trimProductV1Whitespace(value: string): string {
  const characters = Array.from(value);
  let start = 0;
  let end = characters.length;

  while (start < end && isProductV1Whitespace(characters[start] ?? '')) {
    start += 1;
  }
  while (end > start && isProductV1Whitespace(characters[end - 1] ?? '')) {
    end -= 1;
  }

  return characters.slice(start, end).join('');
}

function isApprovedArabicVocalizationMark(codePoint: number): boolean {
  return (codePoint >= 0x064b && codePoint <= 0x065f) || codePoint === 0x0670;
}

function foldApprovedAlefVariant(character: string): string {
  return character === '\u0623' ||
    character === '\u0625' ||
    character === '\u0622' ||
    character === '\u0671'
    ? '\u0627'
    : character;
}

export function canonicalizeProductDisplayName(value: unknown): string {
  const canonical = collapseProductV1Whitespace(requirePostgreSqlText(value, 'name'));
  if (canonical.length === 0) {
    throw new ProductValidationError('PRODUCT_DISPLAY_NAME_EMPTY', 'name');
  }

  return canonical;
}

export function normalizeProductName(value: unknown): string {
  const text = requirePostgreSqlText(value, 'name');
  const normalizedWhitespace = collapseProductV1Whitespace(text.normalize('NFKC')).toLowerCase();
  let normalized = '';

  for (const character of normalizedWhitespace) {
    const codePoint = character.codePointAt(0) ?? -1;
    if (codePoint === 0x0640 || isApprovedArabicVocalizationMark(codePoint)) {
      continue;
    }
    normalized += foldApprovedAlefVariant(character);
  }

  if (normalized.length === 0) {
    throw new ProductValidationError('PRODUCT_NORMALIZED_NAME_EMPTY', 'normalizedName');
  }

  return normalized;
}

export function canonicalizeProductName(value: unknown): CanonicalProductName {
  const name = canonicalizeProductDisplayName(value);
  return {
    name,
    normalizedName: normalizeProductName(name),
  };
}

function canonicalizeNullableTrimmedText(
  value: unknown,
  field: 'sku' | 'barcode' | 'unitCode',
): string | null {
  if (value === null) {
    return null;
  }

  const canonical = trimProductV1Whitespace(requirePostgreSqlText(value, field));
  return canonical.length === 0 ? null : canonical;
}

export function canonicalizeProductSku(value: unknown): string | null {
  return canonicalizeNullableTrimmedText(value, 'sku');
}

export function canonicalizeProductBarcode(value: unknown): string | null {
  return canonicalizeNullableTrimmedText(value, 'barcode');
}

export function canonicalizeProductDescription(value: unknown): string | null {
  return value === null ? null : requirePostgreSqlText(value, 'description');
}

export function canonicalizeProductUnitName(value: unknown): string {
  const canonical = collapseProductV1Whitespace(requirePostgreSqlText(value, 'unitName'));
  if (canonical.length === 0) {
    throw new ProductValidationError('PRODUCT_UNIT_NAME_EMPTY', 'unitName');
  }

  return canonical;
}

export function canonicalizeProductUnitCode(value: unknown): string | null {
  return canonicalizeNullableTrimmedText(value, 'unitCode');
}

export function validateProductMeasurementType(value: unknown): ProductMeasurementType {
  if (typeof value !== 'string' || !productMeasurementTypes.has(value)) {
    throw new ProductValidationError('PRODUCT_MEASUREMENT_TYPE_INVALID', 'measurementType');
  }

  return value as ProductMeasurementType;
}

export function validateProductUnitMeasurementCompatibility(
  productMeasurementType: unknown,
  unitMeasurementType: unknown,
): ProductMeasurementType {
  const productType = validateProductMeasurementType(productMeasurementType);
  const unitType = validateProductMeasurementType(unitMeasurementType);

  if (productType !== unitType) {
    throw new ProductValidationError('PRODUCT_MEASUREMENT_TYPE_MISMATCH', 'unitMeasurementType');
  }

  return unitType;
}

function validateProductUnitFactor(value: unknown, field: 'factorNum' | 'factorDen'): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > POSTGRESQL_INT4_MAX
  ) {
    throw new ProductValidationError('PRODUCT_UNIT_FACTOR_OUT_OF_RANGE', field);
  }

  return value;
}

function validateRequiredBoolean(
  value: unknown,
  field: 'isBase' | 'trackInventory' | 'isPinned',
): boolean {
  if (typeof value !== 'boolean') {
    throw new ProductValidationError('PRODUCT_VALUE_TYPE_INVALID', field);
  }

  return value;
}

export function validateProductUnitRatio(input: Readonly<ProductUnitRatioInput>): ProductUnitRatio {
  const isBase = validateRequiredBoolean(input.isBase, 'isBase');
  const factorNum = validateProductUnitFactor(input.factorNum, 'factorNum');
  const factorDen = validateProductUnitFactor(input.factorDen, 'factorDen');

  if (isBase && (factorNum !== 1 || factorDen !== 1)) {
    throw new ProductValidationError('PRODUCT_UNIT_BASE_RATIO_INVALID', 'isBase');
  }

  return { isBase, factorNum, factorDen };
}

function validateNullableNonnegativePostgreSqlBigint(
  value: unknown,
  field: 'salePriceMinor' | 'purchasePriceMinor' | 'lowStockThresholdMilli',
): bigint | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'bigint') {
    throw new ProductValidationError('PRODUCT_VALUE_TYPE_INVALID', field);
  }
  if (value < 0n || value > POSTGRESQL_BIGINT_MAX) {
    throw new ProductValidationError('PRODUCT_BIGINT_OUT_OF_RANGE', field);
  }

  return value;
}

export function validateProductUnitSalePriceMinor(value: unknown): bigint | null {
  return validateNullableNonnegativePostgreSqlBigint(value, 'salePriceMinor');
}

export function validateProductUnitPurchasePriceMinor(value: unknown): bigint | null {
  return validateNullableNonnegativePostgreSqlBigint(value, 'purchasePriceMinor');
}

export function validateProductLowStockThresholdMilli(value: unknown): bigint | null {
  return validateNullableNonnegativePostgreSqlBigint(value, 'lowStockThresholdMilli');
}

export function validateProductTrackInventory(value: unknown): boolean {
  return validateRequiredBoolean(value, 'trackInventory');
}

export function validateProductPinned(value: unknown): boolean {
  return validateRequiredBoolean(value, 'isPinned');
}

export function validateProductNegativeStockOverride(value: unknown): boolean | null {
  if (value !== null && typeof value !== 'boolean') {
    throw new ProductValidationError('PRODUCT_VALUE_TYPE_INVALID', 'allowNegativeStockOverride');
  }

  return value;
}

export function canonicalizeProductUuid(
  value: unknown,
  field: 'id' | 'productId' | 'operationId',
): string {
  if (typeof value !== 'string' || !isUUID(value)) {
    throw new ProductValidationError('PRODUCT_UUID_INVALID', field);
  }

  return value.toLowerCase();
}
