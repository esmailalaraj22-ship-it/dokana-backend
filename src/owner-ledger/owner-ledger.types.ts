import type { OwnerLedgerEntryTypeValue } from '../database/schema/ledger';
import type { PostedMoneyMovement } from '../money-movements/money-movement.types';

export type OwnerLedgerCommandKind =
  | 'owner_contribution'
  | 'owner_loan'
  | 'owner_reimbursement'
  | 'owner_personal_withdrawal'
  | 'owner_capital_withdrawal';

// Trusted, server-controlled owner-ledger command. The client supplies economic intent
// plus a positive magnitude; the server derives all accounting signs (S10.3 sign authority).
export interface OwnerLedgerCommandInput {
  operationId: string;
  moneyAccountId: string;
  amountMinor: bigint; // positive magnitude X > 0
  occurredAt: Date;
  postingDate: string;
  requestHash: string;
}

export interface OpeningBalanceCommandInput {
  operationId: string;
  moneyAccountId: string;
  amountMinor: bigint; // signed; zero creates no fact
  occurredAt: Date;
  postingDate: string;
  requestHash: string;
}

export interface PostedOwnerLedgerEntry {
  id: string;
  entryType: OwnerLedgerEntryTypeValue;
  ownerLiabilityDeltaMinor: string;
  equityDeltaMinor: string;
  moneyAccountId: string | null;
  transactionGroupId: string;
  operationId: string;
  occurredAt: string;
  createdAt: string;
}

export interface OwnerLedgerMutationResponse {
  operationId: string;
  postingDate: string;
  accountingPeriodId: string;
  movements: PostedMoneyMovement[];
  ownerEntries: PostedOwnerLedgerEntry[];
}

export interface OwnerPositionResponse {
  storeOwesOwnerMinor: string;
  ownerEquityMovementMinor: string;
}

export type OwnerLedgerMutationFailureCode =
  | 'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT'
  | 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE'
  | 'MONEY_ACCOUNT_NOT_FOUND'
  | 'MONEY_ACCOUNT_UNAVAILABLE'
  | 'OPENING_BALANCE_ALREADY_EXISTS'
  | 'OPERATION_ID_CONFLICT'
  | 'OPERATION_IN_PROGRESS'
  | 'OWNER_LIABILITY_EXCEEDED';

export interface OwnerLedgerMutationFailure {
  code: OwnerLedgerMutationFailureCode;
  message: string;
  statusCode: 404 | 409;
}

export type OwnerLedgerMutationResult =
  | { ok: true; response: OwnerLedgerMutationResponse }
  | { ok: false; error: OwnerLedgerMutationFailure };
