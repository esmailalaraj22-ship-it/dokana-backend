export type CustomerStatus = 'active' | 'archived';

export interface CustomerSearchScope {
  normalizedNamePrefix: string;
  canonicalPhone: string | null;
}

export interface CustomerCursorPosition {
  normalizedName: string;
  id: string;
}

export interface CustomerListCriteria {
  status: CustomerStatus;
  search: CustomerSearchScope | null;
  position: CustomerCursorPosition | null;
  limit: number;
}

export interface CustomerListRow {
  id: string;
  name: string;
  normalizedName: string;
  phone: string;
  status: CustomerStatus;
  archivedAt: Date | null;
  updatedAt: Date;
}

export interface CustomerDetailRow extends CustomerListRow {
  notes: string | null;
  createdAt: Date;
  version: bigint;
}

export interface CustomerListItemResponse {
  id: string;
  name: string;
  phone: string;
  status: CustomerStatus;
  archivedAt: string | null;
  updatedAt: string;
}

export interface CustomerDetailResponse extends CustomerListItemResponse {
  notes: string | null;
  createdAt: string;
  version: string;
}

export interface CustomerListResponse {
  items: CustomerListItemResponse[];
  nextCursor: string | null;
}
