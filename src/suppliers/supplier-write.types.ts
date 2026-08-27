import type { SupplierDetailResponse, SupplierDetailRow } from './supplier-read.types';

export interface SupplierMutationResponse extends SupplierDetailResponse {
  operationId: string;
}

export interface PreparedSupplierCreate {
  supplierId: string;
  operationId: string;
  name: string;
  normalizedName: string;
  phone: string;
  normalizedPhone: string;
  notes: string | null;
  requestHash: string;
}

export interface PreparedSupplierUpdate {
  supplierId: string;
  operationId: string;
  expectedVersion: bigint;
  name?: string;
  normalizedName?: string;
  phone?: string;
  normalizedPhone?: string;
  notes?: string | null;
  requestHash: string;
}

export type SupplierLifecycleAction = 'archive' | 'restore';

export interface PreparedSupplierLifecycle {
  supplierId: string;
  operationId: string;
  expectedVersion: bigint;
  action: SupplierLifecycleAction;
  requestHash: string;
}

export interface SupplierMutationRow extends SupplierDetailRow {
  normalizedPhone: string | null;
}

export type SupplierMutationFailureCode =
  | 'CONFLICT'
  | 'SUPPLIER_ARCHIVED'
  | 'SUPPLIER_NOT_FOUND'
  | 'SUPPLIER_PHONE_CONFLICT'
  | 'SUPPLIER_VERSION_CONFLICT'
  | 'OPERATION_ID_CONFLICT'
  | 'OPERATION_IN_PROGRESS';

export interface SupplierMutationFailure {
  code: SupplierMutationFailureCode;
  message: string;
  statusCode: 404 | 409;
}

export type SupplierMutationResult =
  { ok: true; response: SupplierMutationResponse } | { ok: false; error: SupplierMutationFailure };
