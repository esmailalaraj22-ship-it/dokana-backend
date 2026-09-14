import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { isUUID } from 'class-validator';

import type { CustomerPaymentCursorAnchor } from './customer-payment-read.types';
import { SaleReadQueryError } from './sale-read-query-error';

export const CUSTOMER_PAYMENT_CURSOR_VERSION = 1;
export const CUSTOMER_PAYMENT_ORDER_VERSION = 1;
export const CUSTOMER_PAYMENT_CURSOR_MAX_DECODED_BYTES = 110;
export const CUSTOMER_PAYMENT_CURSOR_MAX_ENCODED_LENGTH = 147;

const POSTGRESQL_BIGINT_MAX = 9_223_372_036_854_775_807n;
const scopeHashPattern = /^[A-Za-z0-9_-]{43}$/;
const canonicalVersionPattern = /^(?:[1-9][0-9]{0,18})$/;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export interface DecodedCustomerPaymentCursor {
  scopeHash: string;
  anchor: CustomerPaymentCursorAnchor;
}

function invalidCursor(constraint = 'customerPaymentCursor'): SaleReadQueryError {
  return new SaleReadQueryError('cursor', constraint);
}

function parseVersion(value: unknown): bigint {
  if (typeof value !== 'string' || !canonicalVersionPattern.test(value)) throw invalidCursor();
  const version = BigInt(value);
  if (version < 1n || version > POSTGRESQL_BIGINT_MAX) throw invalidCursor();
  return version;
}

function parseCanonicalId(value: unknown): string {
  if (typeof value !== 'string' || !isUUID(value) || value !== value.toLowerCase()) {
    throw invalidCursor();
  }
  return value;
}

export function customerPaymentCursorScopeHash(customerId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([CUSTOMER_PAYMENT_ORDER_VERSION, customerId]), 'utf8')
    .digest('base64url');
}

export function encodeCustomerPaymentCursor(input: DecodedCustomerPaymentCursor): string {
  if (!scopeHashPattern.test(input.scopeHash)) {
    throw new TypeError('Invalid Customer Payment cursor scope hash.');
  }
  const serialized = JSON.stringify([
    CUSTOMER_PAYMENT_CURSOR_VERSION,
    input.scopeHash,
    parseCanonicalId(input.anchor.id),
    parseVersion(input.anchor.version.toString()).toString(),
  ]);
  if (Buffer.byteLength(serialized, 'utf8') > CUSTOMER_PAYMENT_CURSOR_MAX_DECODED_BYTES) {
    throw new Error('Customer Payment cursor payload exceeds the supported bound.');
  }
  const encoded = Buffer.from(serialized, 'utf8').toString('base64url');
  if (encoded.length > CUSTOMER_PAYMENT_CURSOR_MAX_ENCODED_LENGTH) {
    throw new Error('Customer Payment cursor exceeds the supported bound.');
  }
  return encoded;
}

export function decodeCustomerPaymentCursor(encoded: string): DecodedCustomerPaymentCursor {
  if (
    encoded.length === 0 ||
    encoded.length > CUSTOMER_PAYMENT_CURSOR_MAX_ENCODED_LENGTH ||
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
    decoded.length > CUSTOMER_PAYMENT_CURSOR_MAX_DECODED_BYTES ||
    decoded.toString('base64url') !== encoded
  ) {
    throw invalidCursor();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decoder.decode(decoded)) as unknown;
  } catch {
    throw invalidCursor();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 4 ||
    parsed[0] !== CUSTOMER_PAYMENT_CURSOR_VERSION ||
    typeof parsed[1] !== 'string' ||
    !scopeHashPattern.test(parsed[1])
  ) {
    throw invalidCursor();
  }
  return {
    scopeHash: parsed[1],
    anchor: { id: parseCanonicalId(parsed[2]), version: parseVersion(parsed[3]) },
  };
}

export function assertCustomerPaymentCursorScope(
  cursor: DecodedCustomerPaymentCursor,
  customerId: string,
): void {
  if (cursor.scopeHash !== customerPaymentCursorScopeHash(customerId)) {
    throw invalidCursor('customerPaymentCursorScope');
  }
}
