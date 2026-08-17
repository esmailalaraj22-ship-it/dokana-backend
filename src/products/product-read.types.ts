import type { ProductMeasurementType } from './product-validation';

export type ProductStatus = 'active' | 'archived';
export type ProductUnitStatus = 'active' | 'archived';

export interface ProductSearchScope {
  normalizedNamePrefix: string;
  canonicalSku: string;
  canonicalBarcode: string;
}

export interface ProductCursorAnchor {
  id: string;
  version: bigint;
}

export interface ProductListPosition {
  isPinned: boolean;
  normalizedName: string;
  id: string;
}

export interface ProductListCriteria {
  status: ProductStatus;
  search: ProductSearchScope | null;
  anchor: ProductCursorAnchor | null;
  limit: number;
}

export interface ProductListRow {
  id: string;
  name: string;
  normalizedName: string;
  sku: string | null;
  barcode: string | null;
  measurementType: ProductMeasurementType;
  trackInventory: boolean;
  allowNegativeStockOverride: boolean | null;
  lowStockThresholdMilli: bigint | null;
  isPinned: boolean;
  status: ProductStatus;
  archivedAt: Date | null;
  updatedAt: Date;
  version: bigint;
}

export interface ProductDetailRow extends ProductListRow {
  description: string | null;
  createdAt: Date;
}

export interface ProductUnitRow {
  id: string;
  measurementType: ProductMeasurementType;
  unitName: string;
  unitCode: string | null;
  isBase: boolean;
  factorNum: number;
  factorDen: number;
  salePriceMinor: bigint | null;
  purchasePriceMinor: bigint | null;
  status: ProductUnitStatus;
  createdAt: Date;
  updatedAt: Date;
  version: bigint;
}

export interface ProductDetailRecord {
  product: ProductDetailRow;
  units: ProductUnitRow[];
}

export interface ProductListItemResponse {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  measurementType: ProductMeasurementType;
  trackInventory: boolean;
  allowNegativeStockOverride: boolean | null;
  lowStockThresholdMilli: string | null;
  isPinned: boolean;
  status: ProductStatus;
  archivedAt: string | null;
  updatedAt: string;
  version: string;
}

export interface ProductUnitResponse {
  id: string;
  measurementType: ProductMeasurementType;
  unitName: string;
  unitCode: string | null;
  isBase: boolean;
  factorNum: number;
  factorDen: number;
  salePriceMinor: string | null;
  purchasePriceMinor: string | null;
  status: ProductUnitStatus;
  createdAt: string;
  updatedAt: string;
  version: string;
}

export interface ProductDetailResponse extends ProductListItemResponse {
  description: string | null;
  createdAt: string;
  units: ProductUnitResponse[];
}

export interface ProductListResponse {
  items: ProductListItemResponse[];
  nextCursor: string | null;
}
