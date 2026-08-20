import type { ProductMeasurementType } from './product-validation';
import type { ProductDetailResponse, ProductUnitResponse } from './product-read.types';

export interface ProductMutationResponse extends ProductDetailResponse {
  operationId: string;
}

export interface ProductUnitMutationResponse extends ProductUnitResponse {
  productId: string;
  operationId: string;
}

export interface PreparedBaseUnitInput {
  unitId: string;
  unitName: string;
  unitCode: string | null;
  salePriceMinor: bigint | null;
  purchasePriceMinor: bigint | null;
}

export interface PreparedProductCreate {
  productId: string;
  operationId: string;
  name: string;
  normalizedName: string;
  sku: string | null;
  barcode: string | null;
  description: string | null;
  measurementType: ProductMeasurementType;
  trackInventory: boolean;
  allowNegativeStockOverride: boolean | null;
  lowStockThresholdMilli: bigint | null;
  isPinned: boolean;
  baseUnit: PreparedBaseUnitInput;
  requestHash: string;
}

export interface PreparedProductUpdate {
  productId: string;
  operationId: string;
  expectedVersion: bigint;
  name?: string;
  normalizedName?: string;
  sku?: string | null;
  barcode?: string | null;
  description?: string | null;
  isPinned?: boolean;
  lowStockThresholdMilli?: bigint | null;
  allowNegativeStockOverride?: boolean | null;
  requestHash: string;
}

export interface PreparedProductUnitCreate {
  unitId: string;
  operationId: string;
  productId: string;
  unitName: string;
  unitCode: string | null;
  factorNum: number;
  factorDen: number;
  salePriceMinor: bigint | null;
  purchasePriceMinor: bigint | null;
  requestHash: string;
}

export interface PreparedProductUnitUpdate {
  unitId: string;
  operationId: string;
  expectedVersion: bigint;
  unitName?: string;
  unitCode?: string | null;
  salePriceMinor?: bigint | null;
  purchasePriceMinor?: bigint | null;
  requestHash: string;
}

export type ProductMutationFailureCode =
  | 'CONFLICT'
  | 'PRODUCT_NOT_FOUND'
  | 'PRODUCT_ARCHIVED'
  | 'PRODUCT_UNIT_NOT_FOUND'
  | 'PRODUCT_UNIT_ARCHIVED'
  | 'PRODUCT_SKU_CONFLICT'
  | 'PRODUCT_BARCODE_CONFLICT'
  | 'PRODUCT_UNIT_NAME_CONFLICT'
  | 'PRODUCT_BASE_UNIT_REQUIRED'
  | 'PRODUCT_VERSION_CONFLICT'
  | 'PRODUCT_UNIT_VERSION_CONFLICT'
  | 'OPERATION_ID_CONFLICT'
  | 'OPERATION_IN_PROGRESS';

export interface ProductMutationFailure {
  code: ProductMutationFailureCode;
  message: string;
  statusCode: 404 | 409;
}

export type ProductMutationResult<T> =
  { ok: true; response: T } | { ok: false; error: ProductMutationFailure };
