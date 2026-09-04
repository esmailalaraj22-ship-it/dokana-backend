import type { PostedMoneyMovement } from '../money-movements/money-movement.types';

export interface MoneyTransferCommandInput {
  operationId: string;
  sourceAccountId: string;
  destinationAccountId: string;
  amountMinor: bigint;
  occurredAt: Date;
  postingDate: string;
  requestHash: string;
}

export interface PostedMoneyTransfer {
  id: string;
  displayNumber: string;
  sourceAccountId: string;
  destinationAccountId: string;
  amountMinor: string;
  transferAt: string;
  sourceMovementId: string;
  destinationMovementId: string;
  status: 'posted';
  operationId: string;
  createdAt: string;
  updatedAt: string;
  version: string;
}

export interface MoneyTransferMutationResponse {
  operationId: string;
  postingDate: string;
  accountingPeriodId: string;
  transfer: PostedMoneyTransfer;
  movements: [PostedMoneyMovement, PostedMoneyMovement];
}

export type MoneyTransferMutationFailureCode =
  | 'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT'
  | 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE'
  | 'MONEY_ACCOUNT_NOT_FOUND'
  | 'MONEY_ACCOUNT_UNAVAILABLE'
  | 'MONEY_TRANSFER_SAME_ACCOUNT'
  | 'MONEY_TRANSFER_FACT_IDENTITY_CONFLICT'
  | 'OPERATION_ID_CONFLICT'
  | 'OPERATION_IN_PROGRESS';

export interface MoneyTransferMutationFailure {
  code: MoneyTransferMutationFailureCode;
  message: string;
  statusCode: 404 | 409;
}

export type MoneyTransferMutationResult =
  | { ok: true; response: MoneyTransferMutationResponse }
  | { ok: false; error: MoneyTransferMutationFailure };
