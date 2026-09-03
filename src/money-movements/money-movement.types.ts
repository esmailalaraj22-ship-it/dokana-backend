import type { MoneyMovementTypeValue } from '../database/schema/ledger';

// Trusted internal posting inputs. The Money Movement Authority is not a public generic
// money-posting API (D10-P9/§11): future domain services (S10.3-S10.5, later Stations)
// determine legitimate economic effects and call this authority with server-controlled data.

export interface MoneyMovementEffectInput {
  // Frozen effect discriminator (D10-P9a), unique within a single command.
  discriminator: string;
  accountId: string;
  amountDeltaMinor: bigint;
  movementType: MoneyMovementTypeValue;
  referenceType: string;
  referenceId: string;
  transferGroupId?: string | null;
  counterAccountId?: string | null;
  counterpartyName?: string | null;
  externalReference?: string | null;
  notes?: string | null;
  reversalOfId?: string | null;
}

export interface MoneyMovementPostingCommand {
  // Business command identity (shared idempotency authority).
  operationId: string;
  // Canonical action label bound in sync.processed_operations.
  action: string;
  // Canonical request fingerprint computed by the owning domain command.
  requestHash: string;
  occurredAt: Date;
  effects: MoneyMovementEffectInput[];
}

export interface PostedMoneyMovement {
  id: string;
  accountId: string;
  accountingPeriodId: string;
  movementType: MoneyMovementTypeValue;
  amountDeltaMinor: string;
  transactionGroupId: string;
  operationId: string;
  occurredAt: string;
  createdAt: string;
}

export interface MoneyMovementPostingResponse {
  operationId: string;
  postingDate: string;
  accountingPeriodId: string;
  movements: PostedMoneyMovement[];
}

// Fully-resolved, server-controlled specification for inserting one immutable money
// movement inside a caller-owned transaction (used by S10.3+ multi-effect commands that
// compose the S10.2 authority without claiming/completing their own operation).
export interface MoneyMovementInsertSpec {
  commandOperationId: string;
  discriminator: string;
  accountId: string;
  amountDeltaMinor: bigint;
  movementType: MoneyMovementTypeValue;
  referenceType: string;
  referenceId: string;
  accountingPeriodId: string;
  occurredAt: Date;
  transactionGroupId: string;
  transferGroupId?: string | null;
  counterAccountId?: string | null;
  counterpartyName?: string | null;
  externalReference?: string | null;
  notes?: string | null;
  reversalOfId?: string | null;
}
