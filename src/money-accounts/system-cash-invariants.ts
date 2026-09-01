import { canonicalizeMoneyAccountNameV1 } from './money-account-normalization';
import { SYSTEM_CASH_MONEY_ACCOUNT } from './money-account.types';
import type {
  MoneyAccountMutationRow,
  SystemCashProvisioningResult,
} from './money-account-write.types';

export const SYSTEM_CASH_NORMALIZED_NAME = canonicalizeMoneyAccountNameV1(
  SYSTEM_CASH_MONEY_ACCOUNT.name,
).normalizedName;

export class SystemCashInvariantError extends Error {
  constructor(public readonly reason: 'invalid_existing_cash' | 'cash_identity_conflict') {
    super('The Store system Cash invariant is invalid.');
    this.name = 'SystemCashInvariantError';
  }
}

export function isValidSystemCash(row: MoneyAccountMutationRow): boolean {
  return (
    row.name === SYSTEM_CASH_MONEY_ACCOUNT.name &&
    row.normalizedName === SYSTEM_CASH_NORMALIZED_NAME &&
    row.accountType === SYSTEM_CASH_MONEY_ACCOUNT.accountType &&
    row.availability === SYSTEM_CASH_MONEY_ACCOUNT.availability &&
    row.isDefault === SYSTEM_CASH_MONEY_ACCOUNT.isDefault &&
    row.status === 'active' &&
    row.archivedAt === null
  );
}

export function requireSingleValidSystemCash(
  rows: MoneyAccountMutationRow[],
): SystemCashProvisioningResult {
  const row = rows[0];
  if (rows.length !== 1 || !row || !isValidSystemCash(row)) {
    throw new SystemCashInvariantError('invalid_existing_cash');
  }

  return {
    id: row.id,
    name: SYSTEM_CASH_MONEY_ACCOUNT.name,
    normalizedName: SYSTEM_CASH_NORMALIZED_NAME,
    accountType: SYSTEM_CASH_MONEY_ACCOUNT.accountType,
    availability: SYSTEM_CASH_MONEY_ACCOUNT.availability,
    isDefault: SYSTEM_CASH_MONEY_ACCOUNT.isDefault,
    status: 'active',
    archivedAt: null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}
