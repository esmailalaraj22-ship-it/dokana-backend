import type { CustomerDetailResponse, CustomerDetailRow } from './customer-read.types';

export interface CustomerMutationResponse extends CustomerDetailResponse {
  operationId: string;
}

export interface PreparedCustomerCreate {
  customerId: string;
  operationId: string;
  name: string;
  normalizedName: string;
  phone: string;
  normalizedPhone: string;
  notes: string | null;
  requestHash: string;
}

export interface PreparedCustomerUpdate {
  customerId: string;
  operationId: string;
  expectedVersion: bigint;
  name?: string;
  normalizedName?: string;
  phone?: string;
  normalizedPhone?: string;
  notes?: string | null;
  requestHash: string;
}

export interface CustomerMutationRow extends CustomerDetailRow {
  operationId: string;
}

export type CustomerMutationFailureCode =
  | 'CONFLICT'
  | 'CUSTOMER_ARCHIVED'
  | 'CUSTOMER_NOT_FOUND'
  | 'CUSTOMER_PHONE_CONFLICT'
  | 'CUSTOMER_VERSION_CONFLICT'
  | 'OPERATION_ID_CONFLICT'
  | 'OPERATION_IN_PROGRESS';

export interface CustomerMutationFailure {
  code: CustomerMutationFailureCode;
  message: string;
  statusCode: 404 | 409;
}

export type CustomerMutationResult =
  { ok: true; response: CustomerMutationResponse } | { ok: false; error: CustomerMutationFailure };
