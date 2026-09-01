import type { MoneyAccountResponse } from './money-account-read.types';
import type {
  MoneyAccountPhysicalAvailability,
  MoneyAccountPhysicalType,
  MoneyAccountStatus,
} from './money-account.types';

export interface MoneyAccountMutationResponse extends MoneyAccountResponse {
  operationId: string;
}

export interface PreparedMoneyAccountCreate {
  moneyAccountId: string;
  operationId: string;
  name: string;
  normalizedName: string;
  requestHash: string;
}

export type MoneyAccountLifecycleAction = 'archive' | 'restore';

export interface PreparedMoneyAccountLifecycle {
  moneyAccountId: string;
  operationId: string;
  expectedVersion: bigint;
  action: MoneyAccountLifecycleAction;
  requestHash: string;
}

export interface MoneyAccountMutationRow {
  id: string;
  name: string;
  normalizedName: string;
  accountType: MoneyAccountPhysicalType;
  availability: MoneyAccountPhysicalAvailability;
  isDefault: boolean;
  status: MoneyAccountStatus;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: bigint;
}

export interface SystemCashProvisioningResult {
  id: string;
  name: 'الصندوق';
  normalizedName: string;
  accountType: 'cash';
  availability: 'available';
  isDefault: true;
  status: 'active';
  archivedAt: null;
  createdAt: Date;
  updatedAt: Date;
  version: bigint;
}

export type MoneyAccountMutationFailureCode =
  | 'CONFLICT'
  | 'MONEY_ACCOUNT_NOT_INITIALIZED'
  | 'MONEY_ACCOUNT_NOT_FOUND'
  | 'MONEY_ACCOUNT_NAME_CONFLICT'
  | 'MONEY_ACCOUNT_CASH_IMMUTABLE'
  | 'MONEY_ACCOUNT_VERSION_CONFLICT'
  | 'MONEY_ACCOUNT_NON_ZERO_BALANCE'
  | 'OPERATION_ID_CONFLICT'
  | 'OPERATION_IN_PROGRESS';

export interface MoneyAccountMutationFailure {
  code: MoneyAccountMutationFailureCode;
  message: string;
  statusCode: 404 | 409;
}

export type MoneyAccountMutationResult =
  | { ok: true; response: MoneyAccountMutationResponse }
  | { ok: false; error: MoneyAccountMutationFailure };
