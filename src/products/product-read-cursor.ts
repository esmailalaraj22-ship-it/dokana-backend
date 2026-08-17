import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { isUUID } from 'class-validator';

import { ProductReadQueryError } from './product-read-query-error';
import type { ProductCursorAnchor, ProductSearchScope, ProductStatus } from './product-read.types';
import { POSTGRESQL_BIGINT_MAX } from './product-validation';

export const PRODUCT_CURSOR_VERSION = 1;
export const PRODUCT_ORDER_VERSION = 1;
export const PRODUCT_CURSOR_MAX_DECODED_BYTES = 110;
export const PRODUCT_CURSOR_MAX_ENCODED_LENGTH = 147;

const scopeHashPattern = /^[A-Za-z0-9_-]{43}$/;
const canonicalVersionPattern = /^(?:[1-9][0-9]{0,18})$/;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export interface DecodedProductCursor {
  scopeHash: string;
  anchor: ProductCursorAnchor;
}

function invalidCursor(constraint = 'productCursor'): ProductReadQueryError {
  return new ProductReadQueryError('cursor', constraint);
}

function parseVersion(value: unknown): bigint {
  if (typeof value !== 'string' || !canonicalVersionPattern.test(value)) {
    throw invalidCursor();
  }
  const version = BigInt(value);
  if (version < 1n || version > POSTGRESQL_BIGINT_MAX) {
    throw invalidCursor();
  }
  return version;
}

function parseCanonicalProductId(value: unknown): string {
  if (typeof value !== 'string' || !isUUID(value) || value !== value.toLowerCase()) {
    throw invalidCursor();
  }
  return value;
}

export function productCursorScopeHash(
  status: ProductStatus,
  search: ProductSearchScope | null,
): string {
  const canonicalScope = JSON.stringify([
    PRODUCT_ORDER_VERSION,
    status,
    search?.normalizedNamePrefix ?? null,
    search?.canonicalSku ?? null,
    search?.canonicalBarcode ?? null,
  ]);
  return createHash('sha256').update(canonicalScope, 'utf8').digest('base64url');
}

export function encodeProductCursor(input: DecodedProductCursor): string {
  if (!scopeHashPattern.test(input.scopeHash)) {
    throw new TypeError('Invalid Product cursor scope hash.');
  }
  const lastId = parseCanonicalProductId(input.anchor.id);
  const lastVersion = parseVersion(input.anchor.version.toString());
  const payload = [
    PRODUCT_CURSOR_VERSION,
    input.scopeHash,
    lastId,
    lastVersion.toString(),
  ] as const;
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > PRODUCT_CURSOR_MAX_DECODED_BYTES) {
    throw new Error('Product cursor payload exceeds the supported bound.');
  }
  const encoded = Buffer.from(serialized, 'utf8').toString('base64url');
  if (encoded.length > PRODUCT_CURSOR_MAX_ENCODED_LENGTH) {
    throw new Error('Product cursor exceeds the supported bound.');
  }
  return encoded;
}

export function decodeProductCursor(encoded: string): DecodedProductCursor {
  if (
    encoded.length === 0 ||
    encoded.length > PRODUCT_CURSOR_MAX_ENCODED_LENGTH ||
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
    decoded.length > PRODUCT_CURSOR_MAX_DECODED_BYTES ||
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
    parsed[0] !== PRODUCT_CURSOR_VERSION ||
    typeof parsed[1] !== 'string' ||
    !scopeHashPattern.test(parsed[1])
  ) {
    throw invalidCursor();
  }

  return {
    scopeHash: parsed[1],
    anchor: {
      id: parseCanonicalProductId(parsed[2]),
      version: parseVersion(parsed[3]),
    },
  };
}

export function assertProductCursorScope(
  cursor: DecodedProductCursor,
  status: ProductStatus,
  search: ProductSearchScope | null,
): void {
  if (cursor.scopeHash !== productCursorScopeHash(status, search)) {
    throw invalidCursor('productCursorScope');
  }
}
