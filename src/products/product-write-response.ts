import { isUUID } from 'class-validator';

import { PRODUCT_MEASUREMENT_TYPES, type ProductMeasurementType } from './product-validation';
import type { ProductMutationResponse, ProductUnitMutationResponse } from './product-write.types';
import type { ProductDetailRow, ProductUnitRow } from './product-read.types';

const nonNegativeDecimalPattern = /^(?:0|[1-9]\d*)$/;
const positiveDecimalPattern = /^[1-9]\d*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isMeasurementType(value: unknown): value is ProductMeasurementType {
  return (
    typeof value === 'string' && (PRODUCT_MEASUREMENT_TYPES as readonly string[]).includes(value)
  );
}

export function mapProductUnitRow(row: ProductUnitRow): {
  id: string;
  measurementType: ProductMeasurementType;
  unitName: string;
  unitCode: string | null;
  isBase: boolean;
  factorNum: number;
  factorDen: number;
  salePriceMinor: string | null;
  purchasePriceMinor: string | null;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
  version: string;
} {
  return {
    id: row.id,
    measurementType: row.measurementType,
    unitName: row.unitName,
    unitCode: row.unitCode,
    isBase: row.isBase,
    factorNum: row.factorNum,
    factorDen: row.factorDen,
    salePriceMinor: row.salePriceMinor?.toString() ?? null,
    purchasePriceMinor: row.purchasePriceMinor?.toString() ?? null,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version.toString(),
  };
}

export function mapProductMutationResponse(
  product: ProductDetailRow,
  units: ProductUnitRow[],
  operationId: string,
): ProductMutationResponse {
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    barcode: product.barcode,
    measurementType: product.measurementType,
    trackInventory: product.trackInventory,
    allowNegativeStockOverride: product.allowNegativeStockOverride,
    lowStockThresholdMilli: product.lowStockThresholdMilli?.toString() ?? null,
    isPinned: product.isPinned,
    status: product.status,
    archivedAt: product.archivedAt?.toISOString() ?? null,
    updatedAt: product.updatedAt.toISOString(),
    version: product.version.toString(),
    description: product.description,
    createdAt: product.createdAt.toISOString(),
    units: units.map((unit) => mapProductUnitRow(unit)),
    operationId,
  };
}

export function mapProductUnitMutationResponse(
  unit: ProductUnitRow,
  productId: string,
  operationId: string,
): ProductUnitMutationResponse {
  return {
    ...mapProductUnitRow(unit),
    productId,
    operationId,
  };
}

function isStoredUnit(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const sale = value.salePriceMinor;
  const purchase = value.purchasePriceMinor;
  return (
    typeof value.id === 'string' &&
    isUUID(value.id) &&
    isMeasurementType(value.measurementType) &&
    typeof value.unitName === 'string' &&
    (value.unitCode === null || typeof value.unitCode === 'string') &&
    typeof value.isBase === 'boolean' &&
    Number.isInteger(value.factorNum) &&
    Number.isInteger(value.factorDen) &&
    (sale === null || (typeof sale === 'string' && nonNegativeDecimalPattern.test(sale))) &&
    (purchase === null ||
      (typeof purchase === 'string' && nonNegativeDecimalPattern.test(purchase))) &&
    (value.status === 'active' || value.status === 'archived') &&
    isIsoDate(value.createdAt) &&
    isIsoDate(value.updatedAt) &&
    typeof value.version === 'string' &&
    positiveDecimalPattern.test(value.version)
  );
}

export function parseStoredProductMutationResponse(value: unknown): ProductMutationResponse {
  if (!isRecord(value) || !Array.isArray(value.units) || !value.units.every(isStoredUnit)) {
    throw new Error('Stored Product mutation response is invalid.');
  }
  const threshold = value.lowStockThresholdMilli;
  if (
    typeof value.id !== 'string' ||
    !isUUID(value.id) ||
    typeof value.name !== 'string' ||
    (value.sku !== null && typeof value.sku !== 'string') ||
    (value.barcode !== null && typeof value.barcode !== 'string') ||
    (value.description !== null && typeof value.description !== 'string') ||
    !isMeasurementType(value.measurementType) ||
    typeof value.trackInventory !== 'boolean' ||
    (value.allowNegativeStockOverride !== null &&
      typeof value.allowNegativeStockOverride !== 'boolean') ||
    (threshold !== null &&
      (typeof threshold !== 'string' || !nonNegativeDecimalPattern.test(threshold))) ||
    typeof value.isPinned !== 'boolean' ||
    (value.status !== 'active' && value.status !== 'archived') ||
    (value.archivedAt !== null && !isIsoDate(value.archivedAt)) ||
    !isIsoDate(value.updatedAt) ||
    typeof value.version !== 'string' ||
    !positiveDecimalPattern.test(value.version) ||
    !isIsoDate(value.createdAt) ||
    typeof value.operationId !== 'string' ||
    !isUUID(value.operationId)
  ) {
    throw new Error('Stored Product mutation response is invalid.');
  }
  return value as unknown as ProductMutationResponse;
}

export function parseStoredProductUnitMutationResponse(
  value: unknown,
): ProductUnitMutationResponse {
  if (
    !isStoredUnit(value) ||
    !isRecord(value) ||
    typeof value.productId !== 'string' ||
    !isUUID(value.productId) ||
    typeof value.operationId !== 'string' ||
    !isUUID(value.operationId)
  ) {
    throw new Error('Stored Product Unit mutation response is invalid.');
  }
  return value as unknown as ProductUnitMutationResponse;
}
