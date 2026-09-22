export type ExpenseCategoryStatus = 'active' | 'archived';
export type ExpenseCategoryLifecycleAction = 'archive' | 'restore';

export interface ExpenseCategoryRow {
  id: string;
  name: string;
  normalizedName: string;
  status: ExpenseCategoryStatus;
  createdAt: Date;
  updatedAt: Date;
  version: bigint;
}

export interface ExpenseCategoryResponse {
  id: string;
  name: string;
  status: ExpenseCategoryStatus;
  createdAt: string;
  updatedAt: string;
  version: string;
}

export interface ExpenseCategoryMutationResponse extends ExpenseCategoryResponse {
  operationId: string;
}

export interface PreparedExpenseCategoryCreate {
  action: 'create';
  categoryId: string;
  operationId: string;
  name: string;
  normalizedName: string;
  requestHash: string;
}

export interface PreparedExpenseCategoryUpdate {
  action: 'update';
  categoryId: string;
  operationId: string;
  expectedVersion: bigint;
  name: string;
  normalizedName: string;
  requestHash: string;
}

export interface PreparedExpenseCategoryLifecycle {
  action: ExpenseCategoryLifecycleAction;
  categoryId: string;
  operationId: string;
  expectedVersion: bigint;
  requestHash: string;
}

export type PreparedExpenseCategoryMutation =
  PreparedExpenseCategoryCreate | PreparedExpenseCategoryUpdate | PreparedExpenseCategoryLifecycle;

export type ExpenseCategoryMutationFailureCode =
  | 'EXPENSE_CATEGORY_NOT_FOUND'
  | 'EXPENSE_CATEGORY_ARCHIVED'
  | 'EXPENSE_CATEGORY_NAME_CONFLICT'
  | 'EXPENSE_CATEGORY_VERSION_CONFLICT'
  | 'OPERATION_ID_CONFLICT'
  | 'OPERATION_IN_PROGRESS'
  | 'CONFLICT';

export interface ExpenseCategoryMutationFailure {
  code: ExpenseCategoryMutationFailureCode;
  message: string;
  statusCode: 404 | 409;
}

export type ExpenseCategoryMutationResult =
  | { ok: true; response: ExpenseCategoryMutationResponse }
  | { ok: false; error: ExpenseCategoryMutationFailure };
