import type {
  MoneyAccountPhysicalAvailability,
  MoneyAccountPhysicalType,
  MoneyAccountStatus,
} from './money-account.types';

export const MONEY_ACCOUNT_PUBLIC_TYPES = ['cash', 'transfer'] as const;
export type MoneyAccountPublicType = (typeof MONEY_ACCOUNT_PUBLIC_TYPES)[number];

export type MoneyAccountListStatus = MoneyAccountStatus;

export interface MoneyAccountListCriteria {
  status: MoneyAccountListStatus;
}

export interface MoneyAccountPhysicalReadRow {
  id: string;
  name: string;
  accountType: MoneyAccountPhysicalType;
  availability: MoneyAccountPhysicalAvailability;
  isDefault: boolean;
  status: MoneyAccountStatus;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: bigint;
}

export interface MoneyAccountReadRow extends Omit<
  MoneyAccountPhysicalReadRow,
  'accountType' | 'availability'
> {
  accountType: MoneyAccountPublicType;
}

export interface MoneyAccountResponse {
  id: string;
  name: string;
  accountType: MoneyAccountPublicType;
  isDefault: boolean;
  status: MoneyAccountStatus;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: string;
}

export interface MoneyAccountListResponse {
  items: MoneyAccountResponse[];
}
