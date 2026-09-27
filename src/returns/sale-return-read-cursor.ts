import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { isUUID } from 'class-validator';

import { SaleReturnReadQueryError } from './sale-return-read-query-error';
import type { SaleReturnReadCursorAnchor } from './sale-return-read.types';

export const SALE_RETURN_READ_CURSOR_VERSION = 1;
export const SALE_RETURN_READ_ORDER_VERSION = 1;
export const SALE_RETURN_READ_CURSOR_MAX_DECODED_BYTES = 128;
export const SALE_RETURN_READ_CURSOR_MAX_ENCODED_LENGTH = 171;

const POSTGRESQL_BIGINT_MAX = 9_223_372_036_854_775_807n;
const scopeHashPattern = /^[A-Za-z0-9_-]{43}$/;
const canonicalVersionPattern = /^(?:[1-9][0-9]{0,18})$/;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export interface DecodedSaleReturnReadCursor {
  scopeHash: string;
  anchor: SaleReturnReadCursorAnchor;
}

function invalidCursor(constraint: string): SaleReturnReadQueryError {
  return new SaleReturnReadQueryError('cursor', constraint);
}

function parseCanonicalUuid(value: unknown): string {
  if (typeof value !== 'string' || !isUUID(value) || value !== value.toLowerCase()) {
    throw invalidCursor('saleReturnCursor');
  }
  return value;
}

function parseVersion(value: unknown): bigint {
  if (typeof value !== 'string' || !canonicalVersionPattern.test(value)) {
    throw invalidCursor('saleReturnCursor');
  }
  const version = BigInt(value);
  if (version < 1n || version > POSTGRESQL_BIGINT_MAX) {
    throw invalidCursor('saleReturnCursor');
  }
  return version;
}

export function saleReturnReadCursorScopeHash(saleId: string | null): string {
  return createHash('sha256')
    .update(JSON.stringify([SALE_RETURN_READ_ORDER_VERSION, saleId]), 'utf8')
    .digest('base64url');
}

export function encodeSaleReturnReadCursor(input: DecodedSaleReturnReadCursor): string {
  if (!scopeHashPattern.test(input.scopeHash)) {
    throw new TypeError('Invalid Sale Return cursor scope hash.');
  }
  const serialized = JSON.stringify([
    SALE_RETURN_READ_CURSOR_VERSION,
    input.scopeHash,
    parseCanonicalUuid(input.anchor.id),
    parseVersion(input.anchor.version.toString()).toString(),
  ]);
  if (Buffer.byteLength(serialized, 'utf8') > SALE_RETURN_READ_CURSOR_MAX_DECODED_BYTES) {
    throw new Error('Sale Return cursor payload exceeds the supported bound.');
  }
  const encoded = Buffer.from(serialized, 'utf8').toString('base64url');
  if (encoded.length > SALE_RETURN_READ_CURSOR_MAX_ENCODED_LENGTH) {
    throw new Error('Sale Return cursor exceeds the supported bound.');
  }
  return encoded;
}

export function decodeSaleReturnReadCursor(encoded: string): DecodedSaleReturnReadCursor {
  if (
    encoded.length === 0 ||
    encoded.length > SALE_RETURN_READ_CURSOR_MAX_ENCODED_LENGTH ||
    !base64UrlPattern.test(encoded)
  ) {
    throw invalidCursor('saleReturnCursor');
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(encoded, 'base64url');
  } catch {
    throw invalidCursor('saleReturnCursor');
  }
  if (
    decoded.length === 0 ||
    decoded.length > SALE_RETURN_READ_CURSOR_MAX_DECODED_BYTES ||
    decoded.toString('base64url') !== encoded
  ) {
    throw invalidCursor('saleReturnCursor');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decoder.decode(decoded)) as unknown;
  } catch {
    throw invalidCursor('saleReturnCursor');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 4 ||
    parsed[0] !== SALE_RETURN_READ_CURSOR_VERSION ||
    typeof parsed[1] !== 'string' ||
    !scopeHashPattern.test(parsed[1])
  ) {
    throw invalidCursor('saleReturnCursor');
  }
  return {
    scopeHash: parsed[1],
    anchor: { id: parseCanonicalUuid(parsed[2]), version: parseVersion(parsed[3]) },
  };
}

export function assertSaleReturnReadCursorScope(
  cursor: DecodedSaleReturnReadCursor,
  saleId: string | null,
): void {
  if (cursor.scopeHash !== saleReturnReadCursorScopeHash(saleId)) {
    throw invalidCursor('saleReturnCursorScope');
  }
}
