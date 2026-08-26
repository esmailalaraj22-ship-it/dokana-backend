export type SupplierStatus = 'active' | 'archived';

export interface SupplierSearchScope {
  normalizedNamePrefix: string;
  canonicalPhone: string | null;
}

export interface SupplierCursorAnchor {
  id: string;
  version: bigint;
}

export interface SupplierListPosition {
  normalizedName: string;
  id: string;
}

export interface SupplierListCriteria {
  status: SupplierStatus;
  search: SupplierSearchScope | null;
  anchor: SupplierCursorAnchor | null;
  limit: number;
}

export interface SupplierListRow {
  id: string;
  name: string;
  normalizedName: string;
  phone: string | null;
  status: SupplierStatus;
  archivedAt: Date | null;
  updatedAt: Date;
  version: bigint;
}

export interface SupplierDetailRow extends SupplierListRow {
  notes: string | null;
  createdAt: Date;
}

export interface SupplierListItemResponse {
  id: string;
  name: string;
  phone: string | null;
  status: SupplierStatus;
  archivedAt: string | null;
  updatedAt: string;
  version: string;
}

export interface SupplierDetailResponse extends SupplierListItemResponse {
  notes: string | null;
  createdAt: string;
}

export interface SupplierListResponse {
  items: SupplierListItemResponse[];
  nextCursor: string | null;
}
