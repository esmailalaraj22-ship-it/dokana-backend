import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { isUUID } from 'class-validator';

import { SupplierReadQueryError } from './supplier-read-query-error';
import type {
  SupplierCursorAnchor,
  SupplierSearchScope,
  SupplierStatus,
} from './supplier-read.types';

export const SUPPLIER_CURSOR_VERSION = 1;
export const SUPPLIER_ORDER_VERSION = 1;
export const SUPPLIER_CURSOR_MAX_DECODED_BYTES = 110;
export const SUPPLIER_CURSOR_MAX_ENCODED_LENGTH = 147;

const POSTGRESQL_BIGINT_MAX = 9_223_372_036_854_775_807n;
const scopeHashPattern = /^[A-Za-z0-9_-]{43}$/;
const canonicalVersionPattern = /^(?:[1-9][0-9]{0,18})$/;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export interface DecodedSupplierCursor {
  scopeHash: string;
  anchor: SupplierCursorAnchor;
}

function invalidCursor(constraint = 'supplierCursor'): SupplierReadQueryError {
  return new SupplierReadQueryError('cursor', constraint);
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

function parseCanonicalSupplierId(value: unknown): string {
  if (typeof value !== 'string' || !isUUID(value) || value !== value.toLowerCase()) {
    throw invalidCursor();
  }
  return value;
}

export function supplierCursorScopeHash(
  status: SupplierStatus,
  search: SupplierSearchScope | null,
): string {
  const canonicalScope = JSON.stringify([
    SUPPLIER_ORDER_VERSION,
    status,
    search?.normalizedNamePrefix ?? null,
    search?.canonicalPhone ?? null,
  ]);
  return createHash('sha256').update(canonicalScope, 'utf8').digest('base64url');
}

export function encodeSupplierCursor(input: DecodedSupplierCursor): string {
  if (!scopeHashPattern.test(input.scopeHash)) {
    throw new TypeError('Invalid Supplier cursor scope hash.');
  }
  const lastId = parseCanonicalSupplierId(input.anchor.id);
  const lastVersion = parseVersion(input.anchor.version.toString());
  const payload = [
    SUPPLIER_CURSOR_VERSION,
    input.scopeHash,
    lastId,
    lastVersion.toString(),
  ] as const;
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > SUPPLIER_CURSOR_MAX_DECODED_BYTES) {
    throw new Error('Supplier cursor payload exceeds the supported bound.');
  }
  const encoded = Buffer.from(serialized, 'utf8').toString('base64url');
  if (encoded.length > SUPPLIER_CURSOR_MAX_ENCODED_LENGTH) {
    throw new Error('Supplier cursor exceeds the supported bound.');
  }
  return encoded;
}

export function decodeSupplierCursor(encoded: string): DecodedSupplierCursor {
  if (
    encoded.length === 0 ||
    encoded.length > SUPPLIER_CURSOR_MAX_ENCODED_LENGTH ||
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
    decoded.length > SUPPLIER_CURSOR_MAX_DECODED_BYTES ||
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
    parsed[0] !== SUPPLIER_CURSOR_VERSION ||
    typeof parsed[1] !== 'string' ||
    !scopeHashPattern.test(parsed[1])
  ) {
    throw invalidCursor();
  }

  return {
    scopeHash: parsed[1],
    anchor: {
      id: parseCanonicalSupplierId(parsed[2]),
      version: parseVersion(parsed[3]),
    },
  };
}

export function assertSupplierCursorScope(
  cursor: DecodedSupplierCursor,
  status: SupplierStatus,
  search: SupplierSearchScope | null,
): void {
  if (cursor.scopeHash !== supplierCursorScopeHash(status, search)) {
    throw invalidCursor('supplierCursorScope');
  }
}
