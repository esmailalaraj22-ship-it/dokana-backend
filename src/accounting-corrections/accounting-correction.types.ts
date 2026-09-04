import type { PostedMoneyMovement } from '../money-movements/money-movement.types';
import type { PostedMoneyTransfer } from '../money-transfers/money-transfer.types';
import type { PostedOwnerLedgerEntry } from '../owner-ledger/owner-ledger.types';

export const accountingCorrectionDomains = [
  'opening_balance',
  'owner_contribution',
  'owner_loan',
  'owner_reimbursement',
  'owner_personal_withdrawal',
  'owner_capital_withdrawal',
  'internal_transfer',
] as const;

export type AccountingCorrectionDomain = (typeof accountingCorrectionDomains)[number];
export type AccountingCorrectionKind = 'reversal' | 'replacement';

export interface AccountingCorrectionReplacement {
  amountMinor: bigint;
  moneyAccountId?: string;
  sourceAccountId?: string;
  destinationAccountId?: string;
}

export interface AccountingCorrectionCommandInput {
  operationId: string;
  targetOperationId: string;
  domain: AccountingCorrectionDomain;
  kind: AccountingCorrectionKind;
  occurredAt: Date;
  postingDate: string;
  requestHash: string;
  replacement?: AccountingCorrectionReplacement;
}

export interface CorrectionPostedMoneyMovement extends PostedMoneyMovement {
  reversalOfId: string | null;
}

export interface CorrectionPostedOwnerEntry extends PostedOwnerLedgerEntry {
  reversalOfId: string | null;
}

export interface AccountingCorrectionMutationResponse {
  operationId: string;
  targetOperationId: string;
  domain: AccountingCorrectionDomain;
  correctionKind: AccountingCorrectionKind;
  postingDate: string;
  accountingPeriodId: string;
  movements: CorrectionPostedMoneyMovement[];
  ownerEntries: CorrectionPostedOwnerEntry[];
  replacementTransfer: PostedMoneyTransfer | null;
}

export type AccountingCorrectionFailureCode =
  | 'ACCOUNTING_CORRECTION_DOMAIN_MISMATCH'
  | 'ACCOUNTING_CORRECTION_NO_OP'
  | 'ACCOUNTING_CORRECTION_TARGET_INTEGRITY_CONFLICT'
  | 'ACCOUNTING_CORRECTION_TARGET_NOT_ACTIVE'
  | 'ACCOUNTING_CORRECTION_TARGET_NOT_FOUND'
  | 'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT'
  | 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE'
  | 'MONEY_ACCOUNT_NOT_FOUND'
  | 'MONEY_ACCOUNT_UNAVAILABLE'
  | 'MONEY_TRANSFER_SAME_ACCOUNT'
  | 'OPERATION_ID_CONFLICT'
  | 'OPERATION_IN_PROGRESS'
  | 'OWNER_LIABILITY_EXCEEDED';

export interface AccountingCorrectionFailure {
  code: AccountingCorrectionFailureCode;
  message: string;
  statusCode: 404 | 409;
}

export type AccountingCorrectionMutationResult =
  | { ok: true; response: AccountingCorrectionMutationResponse }
  | { ok: false; error: AccountingCorrectionFailure };
