import { isUUID } from 'class-validator';

import {
  cleanCustomerDisplayName,
  cleanCustomerDisplayPhone,
  CUSTOMER_NORMALIZATION_VERSION,
  CustomerNormalizationError,
  type CustomerNormalizationErrorCode,
  normalizeCustomerName,
  normalizeCustomerPhone,
} from '../customers/customer-normalization';

export const SUPPLIER_VALIDATION_CONTRACT_VERSION = 1;
export const SUPPLIER_NORMALIZATION_VERSION = CUSTOMER_NORMALIZATION_VERSION;

export type SupplierValidationField =
  'id' | 'operationId' | 'name' | 'normalizedName' | 'phone' | 'notes';

export type SupplierValidationErrorCode =
  | 'SUPPLIER_UUID_INVALID'
  | 'SUPPLIER_PHONE_REQUIRED'
  | 'SUPPLIER_VALUE_TYPE_INVALID'
  | 'SUPPLIER_TEXT_NOT_POSTGRESQL_REPRESENTABLE'
  | 'SUPPLIER_DISPLAY_NAME_EMPTY'
  | 'SUPPLIER_NORMALIZED_NAME_EMPTY'
  | 'SUPPLIER_DISPLAY_PHONE_EMPTY'
  | 'SUPPLIER_PHONE_EMPTY'
  | 'SUPPLIER_PHONE_INVALID'
  | 'SUPPLIER_PHONE_EXTENSION_UNSUPPORTED';

const supplierValidationErrorMessages: Readonly<Record<SupplierValidationErrorCode, string>> = {
  SUPPLIER_UUID_INVALID: 'The identifier is not a valid UUID.',
  SUPPLIER_PHONE_REQUIRED: 'Supplier phone is required.',
  SUPPLIER_VALUE_TYPE_INVALID: 'The supplied value has an invalid type.',
  SUPPLIER_TEXT_NOT_POSTGRESQL_REPRESENTABLE:
    'The supplied text is not representable by PostgreSQL text.',
  SUPPLIER_DISPLAY_NAME_EMPTY: 'Supplier display name must not be empty.',
  SUPPLIER_NORMALIZED_NAME_EMPTY: 'Supplier normalized name must not be empty.',
  SUPPLIER_DISPLAY_PHONE_EMPTY: 'Supplier display phone must not be empty.',
  SUPPLIER_PHONE_EMPTY: 'Supplier phone must not be empty.',
  SUPPLIER_PHONE_INVALID: 'Supplier phone is invalid.',
  SUPPLIER_PHONE_EXTENSION_UNSUPPORTED: 'Supplier phone extensions are not supported.',
};

export class SupplierValidationError extends Error {
  constructor(
    public readonly code: SupplierValidationErrorCode,
    public readonly field: SupplierValidationField,
  ) {
    super(supplierValidationErrorMessages[code]);
    this.name = 'SupplierValidationError';
  }
}

export interface CanonicalSupplierName {
  readonly name: string;
  readonly normalizedName: string;
}

export interface CanonicalSupplierPhone {
  readonly phone: string;
  readonly normalizedPhone: string;
}

const supplierErrorByCustomerError: Readonly<
  Record<
    CustomerNormalizationErrorCode,
    Readonly<{ code: SupplierValidationErrorCode; field: SupplierValidationField }>
  >
> = {
  CUSTOMER_DISPLAY_NAME_EMPTY: { code: 'SUPPLIER_DISPLAY_NAME_EMPTY', field: 'name' },
  CUSTOMER_NORMALIZED_NAME_EMPTY: {
    code: 'SUPPLIER_NORMALIZED_NAME_EMPTY',
    field: 'normalizedName',
  },
  CUSTOMER_DISPLAY_PHONE_EMPTY: { code: 'SUPPLIER_DISPLAY_PHONE_EMPTY', field: 'phone' },
  CUSTOMER_PHONE_EMPTY: { code: 'SUPPLIER_PHONE_EMPTY', field: 'phone' },
  CUSTOMER_PHONE_INVALID: { code: 'SUPPLIER_PHONE_INVALID', field: 'phone' },
  CUSTOMER_PHONE_EXTENSION_UNSUPPORTED: {
    code: 'SUPPLIER_PHONE_EXTENSION_UNSUPPORTED',
    field: 'phone',
  },
};

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) {
        return false;
      }
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }

  return true;
}

function requirePostgreSqlText(value: unknown, field: SupplierValidationField): string {
  if (typeof value !== 'string') {
    throw new SupplierValidationError('SUPPLIER_VALUE_TYPE_INVALID', field);
  }
  if (value.includes('\u0000') || !isWellFormedUnicode(value)) {
    throw new SupplierValidationError('SUPPLIER_TEXT_NOT_POSTGRESQL_REPRESENTABLE', field);
  }

  return value;
}

function useCustomerNormalization<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof CustomerNormalizationError) {
      const supplierError = supplierErrorByCustomerError[error.code];
      throw new SupplierValidationError(supplierError.code, supplierError.field);
    }
    throw error;
  }
}

export function cleanSupplierDisplayName(value: unknown): string {
  const text = requirePostgreSqlText(value, 'name');
  return useCustomerNormalization(() => cleanCustomerDisplayName(text));
}

export function normalizeSupplierName(value: unknown): string {
  const text = requirePostgreSqlText(value, 'name');
  return useCustomerNormalization(() => normalizeCustomerName(text));
}

export function canonicalizeSupplierName(value: unknown): CanonicalSupplierName {
  const name = cleanSupplierDisplayName(value);
  return {
    name,
    normalizedName: normalizeSupplierName(name),
  };
}

export function cleanSupplierDisplayPhone(value: unknown): string {
  const text = requirePostgreSqlText(value, 'phone');
  return useCustomerNormalization(() => cleanCustomerDisplayPhone(text));
}

export function normalizeSupplierPhone(value: unknown): string {
  const text = requirePostgreSqlText(value, 'phone');
  return useCustomerNormalization(() => normalizeCustomerPhone(text));
}

export function canonicalizeSupplierPhone(value: unknown): CanonicalSupplierPhone {
  if (value === undefined || value === null) {
    throw new SupplierValidationError('SUPPLIER_PHONE_REQUIRED', 'phone');
  }

  const phone = cleanSupplierDisplayPhone(value);
  return {
    phone,
    normalizedPhone: normalizeSupplierPhone(phone),
  };
}

export function canonicalizeSupplierNotes(value: unknown): string | null {
  return value === null ? null : requirePostgreSqlText(value, 'notes');
}

export function canonicalizeSupplierUuid(value: unknown, field: 'id' | 'operationId'): string {
  if (typeof value !== 'string' || !isUUID(value)) {
    throw new SupplierValidationError('SUPPLIER_UUID_INVALID', field);
  }

  return value.toLowerCase();
}
