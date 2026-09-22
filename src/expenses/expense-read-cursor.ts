import { TextDecoder } from 'node:util';

import { isUUID } from 'class-validator';

export const EXPENSE_CURSOR_MAX_DECODED_BYTES = 65;
export const EXPENSE_CURSOR_MAX_ENCODED_LENGTH = 87;
const maximumBigint = 9_223_372_036_854_775_807n;
const decoder = new TextDecoder('utf-8', { fatal: true });

export class ExpenseReadQueryError extends Error {
  constructor(
    readonly field: 'cursor',
    readonly constraint: 'expenseCursor' | 'expenseCursorAnchor',
  ) {
    super('Expense query is invalid.');
    this.name = 'ExpenseReadQueryError';
  }
}

export interface ExpenseCursorAnchor {
  id: string;
  version: bigint;
}

export function encodeExpenseCursor(anchor: ExpenseCursorAnchor): string {
  const canonical = parseId(anchor.id);
  const version = parseVersion(anchor.version.toString());
  const serialized = JSON.stringify([1, canonical, version.toString()]);
  if (Buffer.byteLength(serialized, 'utf8') > EXPENSE_CURSOR_MAX_DECODED_BYTES) {
    throw new Error('Expense cursor payload exceeds the supported bound.');
  }
  return Buffer.from(serialized, 'utf8').toString('base64url');
}

export function decodeExpenseCursor(encoded: string): ExpenseCursorAnchor {
  if (
    encoded.length === 0 ||
    encoded.length > EXPENSE_CURSOR_MAX_ENCODED_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    throw invalid();
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(encoded, 'base64url');
  } catch {
    throw invalid();
  }
  if (
    decoded.length === 0 ||
    decoded.length > EXPENSE_CURSOR_MAX_DECODED_BYTES ||
    decoded.toString('base64url') !== encoded
  ) {
    throw invalid();
  }
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(decoded)) as unknown;
  } catch {
    throw invalid();
  }
  if (!Array.isArray(value) || value.length !== 3 || value[0] !== 1) throw invalid();
  return { id: parseId(value[1]), version: parseVersion(value[2]) };
}

function parseId(value: unknown): string {
  if (typeof value !== 'string' || !isUUID(value) || value !== value.toLowerCase()) {
    throw invalid();
  }
  return value;
}

function parseVersion(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)) throw invalid();
  const version = BigInt(value);
  if (version > maximumBigint) throw invalid();
  return version;
}

function invalid(): ExpenseReadQueryError {
  return new ExpenseReadQueryError('cursor', 'expenseCursor');
}
