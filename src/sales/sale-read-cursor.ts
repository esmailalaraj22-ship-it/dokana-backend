import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { isUUID } from 'class-validator';

import type { CustomerReceivableCursorAnchor, SaleReadCursorAnchor } from './sale-read.types';
import { SaleReadQueryError } from './sale-read-query-error';

export const SALE_READ_CURSOR_VERSION = 1;
export const SALE_READ_ORDER_VERSION = 1;
export const SALE_READ_CURSOR_MAX_DECODED_BYTES = 110;
export const SALE_READ_CURSOR_MAX_ENCODED_LENGTH = 147;
export const CUSTOMER_RECEIVABLE_CURSOR_VERSION = 1;
export const CUSTOMER_RECEIVABLE_ORDER_VERSION = 1;
export const CUSTOMER_RECEIVABLE_CURSOR_MAX_DECODED_BYTES = 91;
export const CUSTOMER_RECEIVABLE_CURSOR_MAX_ENCODED_LENGTH = 122;

const POSTGRESQL_BIGINT_MAX = 9_223_372_036_854_775_807n;
const scopeHashPattern = /^[A-Za-z0-9_-]{43}$/;
const canonicalVersionPattern = /^(?:[1-9][0-9]{0,18})$/;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export interface DecodedSaleReadCursor {
  scopeHash: string;
  anchor: SaleReadCursorAnchor;
}

export interface DecodedCustomerReceivableCursor {
  scopeHash: string;
  anchor: CustomerReceivableCursorAnchor;
}

function invalidCursor(constraint: string): SaleReadQueryError {
  return new SaleReadQueryError('cursor', constraint);
}

function parseCanonicalUuid(value: unknown, constraint: string): string {
  if (typeof value !== 'string' || !isUUID(value) || value !== value.toLowerCase()) {
    throw invalidCursor(constraint);
  }
  return value;
}

function parseVersion(value: unknown): bigint {
  if (typeof value !== 'string' || !canonicalVersionPattern.test(value)) {
    throw invalidCursor('saleCursor');
  }
  const version = BigInt(value);
  if (version < 1n || version > POSTGRESQL_BIGINT_MAX) {
    throw invalidCursor('saleCursor');
  }
  return version;
}

function scopeHash(input: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(input), 'utf8').digest('base64url');
}

export function saleReadCursorScopeHash(): string {
  return scopeHash([SALE_READ_ORDER_VERSION]);
}

export function customerReceivableCursorScopeHash(customerId: string): string {
  return scopeHash([CUSTOMER_RECEIVABLE_ORDER_VERSION, customerId]);
}

export function encodeSaleReadCursor(input: DecodedSaleReadCursor): string {
  if (!scopeHashPattern.test(input.scopeHash)) {
    throw new TypeError('Invalid Sale cursor scope hash.');
  }
  const serialized = JSON.stringify([
    SALE_READ_CURSOR_VERSION,
    input.scopeHash,
    parseCanonicalUuid(input.anchor.id, 'saleCursor'),
    parseVersion(input.anchor.version.toString()).toString(),
  ]);
  return encodeBounded(
    serialized,
    SALE_READ_CURSOR_MAX_DECODED_BYTES,
    SALE_READ_CURSOR_MAX_ENCODED_LENGTH,
    'Sale',
  );
}

export function decodeSaleReadCursor(encoded: string): DecodedSaleReadCursor {
  const parsed = decodeBounded(
    encoded,
    SALE_READ_CURSOR_MAX_DECODED_BYTES,
    SALE_READ_CURSOR_MAX_ENCODED_LENGTH,
    'saleCursor',
  );
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 4 ||
    parsed[0] !== SALE_READ_CURSOR_VERSION ||
    typeof parsed[1] !== 'string' ||
    !scopeHashPattern.test(parsed[1])
  ) {
    throw invalidCursor('saleCursor');
  }
  return {
    scopeHash: parsed[1],
    anchor: {
      id: parseCanonicalUuid(parsed[2], 'saleCursor'),
      version: parseVersion(parsed[3]),
    },
  };
}

export function assertSaleReadCursorScope(cursor: DecodedSaleReadCursor): void {
  if (cursor.scopeHash !== saleReadCursorScopeHash()) {
    throw invalidCursor('saleCursorScope');
  }
}

export function encodeCustomerReceivableCursor(input: DecodedCustomerReceivableCursor): string {
  if (!scopeHashPattern.test(input.scopeHash)) {
    throw new TypeError('Invalid Customer Receivable cursor scope hash.');
  }
  const serialized = JSON.stringify([
    CUSTOMER_RECEIVABLE_CURSOR_VERSION,
    input.scopeHash,
    parseCanonicalUuid(input.anchor.id, 'customerReceivableCursor'),
  ]);
  return encodeBounded(
    serialized,
    CUSTOMER_RECEIVABLE_CURSOR_MAX_DECODED_BYTES,
    CUSTOMER_RECEIVABLE_CURSOR_MAX_ENCODED_LENGTH,
    'Customer Receivable',
  );
}

export function decodeCustomerReceivableCursor(encoded: string): DecodedCustomerReceivableCursor {
  const parsed = decodeBounded(
    encoded,
    CUSTOMER_RECEIVABLE_CURSOR_MAX_DECODED_BYTES,
    CUSTOMER_RECEIVABLE_CURSOR_MAX_ENCODED_LENGTH,
    'customerReceivableCursor',
  );
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    parsed[0] !== CUSTOMER_RECEIVABLE_CURSOR_VERSION ||
    typeof parsed[1] !== 'string' ||
    !scopeHashPattern.test(parsed[1])
  ) {
    throw invalidCursor('customerReceivableCursor');
  }
  return {
    scopeHash: parsed[1],
    anchor: { id: parseCanonicalUuid(parsed[2], 'customerReceivableCursor') },
  };
}

export function assertCustomerReceivableCursorScope(
  cursor: DecodedCustomerReceivableCursor,
  customerId: string,
): void {
  if (cursor.scopeHash !== customerReceivableCursorScopeHash(customerId)) {
    throw invalidCursor('customerReceivableCursorScope');
  }
}

function encodeBounded(
  serialized: string,
  maximumDecodedBytes: number,
  maximumEncodedLength: number,
  label: string,
): string {
  if (Buffer.byteLength(serialized, 'utf8') > maximumDecodedBytes) {
    throw new Error(`${label} cursor payload exceeds the supported bound.`);
  }
  const encoded = Buffer.from(serialized, 'utf8').toString('base64url');
  if (encoded.length > maximumEncodedLength) {
    throw new Error(`${label} cursor exceeds the supported bound.`);
  }
  return encoded;
}

function decodeBounded(
  encoded: string,
  maximumDecodedBytes: number,
  maximumEncodedLength: number,
  constraint: string,
): unknown {
  if (
    encoded.length === 0 ||
    encoded.length > maximumEncodedLength ||
    !base64UrlPattern.test(encoded)
  ) {
    throw invalidCursor(constraint);
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(encoded, 'base64url');
  } catch {
    throw invalidCursor(constraint);
  }
  if (
    decoded.length === 0 ||
    decoded.length > maximumDecodedBytes ||
    decoded.toString('base64url') !== encoded
  ) {
    throw invalidCursor(constraint);
  }
  try {
    return JSON.parse(utf8Decoder.decode(decoded)) as unknown;
  } catch {
    throw invalidCursor(constraint);
  }
}
