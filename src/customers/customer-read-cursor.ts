import { isUuid } from '../common/logging/request-id';
import { CustomerReadQueryError } from './customer-read-query';
import type {
  CustomerCursorPosition,
  CustomerSearchScope,
  CustomerStatus,
} from './customer-read.types';

export const CUSTOMER_CURSOR_VERSION = 1;
export const CUSTOMER_CURSOR_MAX_ENCODED_LENGTH = 2_048;
const CUSTOMER_CURSOR_MAX_DECODED_BYTES = 1_536;
const CUSTOMER_CURSOR_MAX_NAME_LENGTH = 1_024;
const customerCursorKeys = [
  'lastId',
  'lastName',
  'searchName',
  'searchPhone',
  'status',
  'v',
] as const;

interface CustomerCursorPayload {
  v: 1;
  status: CustomerStatus;
  searchName: string | null;
  searchPhone: string | null;
  lastName: string;
  lastId: string;
}

export interface DecodedCustomerCursor {
  status: CustomerStatus;
  search: CustomerSearchScope | null;
  position: CustomerCursorPosition;
}

function invalidCursor(): CustomerReadQueryError {
  return new CustomerReadQueryError('cursor', 'customerCursor');
}

function isNullableBoundedString(value: unknown, maximumLength: number): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= maximumLength);
}

function parseCustomerCursorPayload(value: unknown): CustomerCursorPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidCursor();
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== customerCursorKeys.length ||
    !keys.every((key, index) => key === customerCursorKeys[index])
  ) {
    throw invalidCursor();
  }

  if (
    record.v !== CUSTOMER_CURSOR_VERSION ||
    (record.status !== 'active' && record.status !== 'archived') ||
    !isNullableBoundedString(record.searchName, CUSTOMER_CURSOR_MAX_NAME_LENGTH) ||
    !isNullableBoundedString(record.searchPhone, 32) ||
    typeof record.lastName !== 'string' ||
    record.lastName.length === 0 ||
    record.lastName.length > CUSTOMER_CURSOR_MAX_NAME_LENGTH ||
    typeof record.lastId !== 'string' ||
    !isUuid(record.lastId)
  ) {
    throw invalidCursor();
  }

  if (record.searchName === null && record.searchPhone !== null) {
    throw invalidCursor();
  }

  return record as unknown as CustomerCursorPayload;
}

export function encodeCustomerCursor(input: DecodedCustomerCursor): string {
  const payload: CustomerCursorPayload = {
    v: CUSTOMER_CURSOR_VERSION,
    status: input.status,
    searchName: input.search?.normalizedNamePrefix ?? null,
    searchPhone: input.search?.canonicalPhone ?? null,
    lastName: input.position.normalizedName,
    lastId: input.position.id,
  };
  parseCustomerCursorPayload(payload);

  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > CUSTOMER_CURSOR_MAX_DECODED_BYTES) {
    throw new Error('Customer cursor payload exceeds the supported bound.');
  }

  const encoded = Buffer.from(serialized, 'utf8').toString('base64url');
  if (encoded.length > CUSTOMER_CURSOR_MAX_ENCODED_LENGTH) {
    throw new Error('Customer cursor exceeds the supported bound.');
  }
  return encoded;
}

export function decodeCustomerCursor(encoded: string): DecodedCustomerCursor {
  if (
    encoded.length === 0 ||
    encoded.length > CUSTOMER_CURSOR_MAX_ENCODED_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    throw invalidCursor();
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(encoded, 'base64url');
  } catch {
    throw invalidCursor();
  }

  if (
    decoded.length === 0 ||
    decoded.length > CUSTOMER_CURSOR_MAX_DECODED_BYTES ||
    decoded.toString('base64url') !== encoded
  ) {
    throw invalidCursor();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString('utf8')) as unknown;
  } catch {
    throw invalidCursor();
  }

  const payload = parseCustomerCursorPayload(parsed);
  return {
    status: payload.status,
    search:
      payload.searchName === null
        ? null
        : {
            normalizedNamePrefix: payload.searchName,
            canonicalPhone: payload.searchPhone,
          },
    position: {
      normalizedName: payload.lastName,
      id: payload.lastId,
    },
  };
}

export function customerCursorMatchesScope(
  cursor: DecodedCustomerCursor,
  status: CustomerStatus,
  search: CustomerSearchScope | null,
): boolean {
  return (
    cursor.status === status &&
    cursor.search?.normalizedNamePrefix === search?.normalizedNamePrefix &&
    cursor.search?.canonicalPhone === search?.canonicalPhone
  );
}
