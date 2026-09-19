import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { isUUID } from 'class-validator';

import { SaleReadQueryError } from './sale-read-query-error';

export const CUSTOMER_CREDIT_CURSOR_MAX_DECODED_BYTES = 130;
export const CUSTOMER_CREDIT_CURSOR_MAX_ENCODED_LENGTH = 174;
const decoder = new TextDecoder('utf-8', { fatal: true });
const scopePattern = /^[A-Za-z0-9_-]{43}$/;

export interface CustomerCreditHistoryCursor {
  scopeHash: string;
  anchor: { id: string; occurredAt: string };
}

function invalid(constraint = 'customerCreditHistoryCursor'): SaleReadQueryError {
  return new SaleReadQueryError('cursor', constraint);
}

export function customerCreditHistoryScopeHash(customerId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([1, customerId]), 'utf8')
    .digest('base64url');
}

export function encodeCustomerCreditHistoryCursor(input: CustomerCreditHistoryCursor): string {
  const id = canonicalId(input.anchor.id);
  const occurredAt = canonicalInstant(input.anchor.occurredAt);
  if (!scopePattern.test(input.scopeHash)) throw new TypeError('Invalid credit cursor scope.');
  const serialized = JSON.stringify([1, input.scopeHash, occurredAt, id]);
  if (Buffer.byteLength(serialized, 'utf8') > CUSTOMER_CREDIT_CURSOR_MAX_DECODED_BYTES) {
    throw new Error('Customer Credit cursor payload exceeds the supported bound.');
  }
  const encoded = Buffer.from(serialized, 'utf8').toString('base64url');
  if (encoded.length > CUSTOMER_CREDIT_CURSOR_MAX_ENCODED_LENGTH) {
    throw new Error('Customer Credit cursor exceeds the supported bound.');
  }
  return encoded;
}

export function decodeCustomerCreditHistoryCursor(encoded: string): CustomerCreditHistoryCursor {
  if (
    encoded.length === 0 ||
    encoded.length > CUSTOMER_CREDIT_CURSOR_MAX_ENCODED_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    throw invalid();
  }
  const decoded = Buffer.from(encoded, 'base64url');
  if (
    decoded.length === 0 ||
    decoded.length > CUSTOMER_CREDIT_CURSOR_MAX_DECODED_BYTES ||
    decoded.toString('base64url') !== encoded
  ) {
    throw invalid();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(decoded)) as unknown;
  } catch {
    throw invalid();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 4 ||
    parsed[0] !== 1 ||
    typeof parsed[1] !== 'string' ||
    !scopePattern.test(parsed[1])
  ) {
    throw invalid();
  }
  return {
    scopeHash: parsed[1],
    anchor: { occurredAt: canonicalInstant(parsed[2]), id: canonicalId(parsed[3]) },
  };
}

export function assertCustomerCreditHistoryCursorScope(
  cursor: CustomerCreditHistoryCursor,
  customerId: string,
): void {
  if (cursor.scopeHash !== customerCreditHistoryScopeHash(customerId)) {
    throw invalid('customerCreditHistoryCursorScope');
  }
}

function canonicalId(value: unknown): string {
  if (typeof value !== 'string' || !isUUID(value) || value !== value.toLowerCase()) throw invalid();
  return value;
}

function canonicalInstant(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw invalid();
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw invalid();
  return value;
}
