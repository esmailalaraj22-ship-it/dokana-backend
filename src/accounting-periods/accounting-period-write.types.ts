import type { AccountingPeriodResponse } from './accounting-period-read.types';
import type { AccountingPeriodRow } from './accounting-period.types';

export const ACCOUNTING_PERIOD_CLOSE_ACTION = 'close' as const;

export interface AccountingPeriodMutationResponse extends AccountingPeriodResponse {
  operationId: string;
}

export interface PreparedAccountingPeriodClose {
  accountingPeriodId: string;
  operationId: string;
  expectedVersion: bigint;
  action: typeof ACCOUNTING_PERIOD_CLOSE_ACTION;
  requestHash: string;
}

export type AccountingPeriodMutationRow = AccountingPeriodRow;

export type AccountingPeriodMutationFailureCode =
  | 'ACCOUNTING_PERIOD_NOT_FOUND'
  | 'ACCOUNTING_PERIOD_VERSION_CONFLICT'
  | 'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT'
  | 'ACCOUNTING_PERIOD_CLOSING'
  | 'ACCOUNTING_PERIOD_CLOSE_BLOCKED'
  | 'OPERATION_ID_CONFLICT'
  | 'OPERATION_IN_PROGRESS';

export interface AccountingPeriodMutationFailure {
  code: AccountingPeriodMutationFailureCode;
  message: string;
  statusCode: 404 | 409;
}

export type AccountingPeriodMutationResult =
  | { ok: true; response: AccountingPeriodMutationResponse }
  | { ok: false; error: AccountingPeriodMutationFailure };
