export const MONEY_ACCOUNT_PHYSICAL_TYPES = ['cash', 'transfer', 'external_party'] as const;
export type MoneyAccountPhysicalType = (typeof MONEY_ACCOUNT_PHYSICAL_TYPES)[number];

export const MONEY_ACCOUNT_MVP_USER_CREATABLE_TYPES = ['transfer'] as const;
export type MoneyAccountMvpUserCreatableType =
  (typeof MONEY_ACCOUNT_MVP_USER_CREATABLE_TYPES)[number];

export const MONEY_ACCOUNT_PHYSICAL_AVAILABILITIES = [
  'available',
  'held_by_external_party',
] as const;
export type MoneyAccountPhysicalAvailability =
  (typeof MONEY_ACCOUNT_PHYSICAL_AVAILABILITIES)[number];

export const MONEY_ACCOUNT_MVP_CREATED_AVAILABILITIES = ['available'] as const;
export type MoneyAccountMvpCreatedAvailability =
  (typeof MONEY_ACCOUNT_MVP_CREATED_AVAILABILITIES)[number];

export const MONEY_ACCOUNT_STATUSES = ['active', 'archived'] as const;
export type MoneyAccountStatus = (typeof MONEY_ACCOUNT_STATUSES)[number];

export interface MoneyAccountRow {
  id: string;
  storeId: string;
  name: string;
  normalizedName: string;
  accountType: MoneyAccountPhysicalType;
  availability: MoneyAccountPhysicalAvailability;
  isDefault: boolean;
  status: MoneyAccountStatus;
  archivedAt: Date | null;
  deviceId: string | null;
  operationId: string;
  createdAt: Date;
  updatedAt: Date;
  version: bigint;
}

export interface SystemCashMoneyAccountIdentity {
  readonly name: 'الصندوق';
  readonly accountType: 'cash';
  readonly availability: 'available';
  readonly isDefault: true;
}

export const SYSTEM_CASH_MONEY_ACCOUNT = Object.freeze({
  name: 'الصندوق',
  accountType: 'cash',
  availability: 'available',
  isDefault: true,
} satisfies SystemCashMoneyAccountIdentity);

export const MVP_ELECTRONIC_MONEY_ACCOUNT_DEFAULTS = Object.freeze({
  accountType: 'transfer',
  availability: 'available',
  isDefault: false,
} as const);

/** The only user-authored Money Account profile field at MVP creation. */
export const MONEY_ACCOUNT_USER_INPUT_FIELDS = [
  'name',
] as const satisfies readonly (keyof MoneyAccountRow)[];

/**
 * Fields controlled by the database, trusted application workflow, or sync
 * protocol rather than accepted as user-authored Money Account profile data.
 * This classification does not decide whether a future UUID/operation ID is
 * client-generated; it prevents those fields from becoming generic form input.
 */
export const MONEY_ACCOUNT_CONTROLLED_FIELDS = [
  'id',
  'storeId',
  'normalizedName',
  'accountType',
  'availability',
  'isDefault',
  'status',
  'archivedAt',
  'deviceId',
  'operationId',
  'createdAt',
  'updatedAt',
  'version',
] as const satisfies readonly (keyof MoneyAccountRow)[];

export type MoneyAccountUserInputField = (typeof MONEY_ACCOUNT_USER_INPUT_FIELDS)[number];
export type MoneyAccountControlledField = (typeof MONEY_ACCOUNT_CONTROLLED_FIELDS)[number];
