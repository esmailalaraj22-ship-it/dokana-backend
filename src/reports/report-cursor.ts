import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { BadRequestException } from '@nestjs/common';
import { isUUID } from 'class-validator';

export const REPORT_CURSOR_MAX_ENCODED_LENGTH = 192;

const CURSOR_VERSION = 1;
const CURSOR_MAX_DECODED_BYTES = 144;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const scopeHashPattern = /^[A-Za-z0-9_-]{43}$/;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export interface ReportCursor {
  scopeHash: string;
  anchorId: string;
  anchorType: string | null;
}

function invalidCursor(constraint: string): BadRequestException {
  return new BadRequestException({
    code: 'REPORT_QUERY_INVALID',
    message: 'Report query is invalid.',
    details: [{ field: 'cursor', constraint }],
  });
}

export function reportCursorScopeHash(family: string, filters: readonly unknown[]): string {
  return createHash('sha256')
    .update(JSON.stringify([1, family, ...filters]), 'utf8')
    .digest('base64url');
}

export function encodeReportCursor(cursor: ReportCursor): string {
  if (
    !scopeHashPattern.test(cursor.scopeHash) ||
    !isUUID(cursor.anchorId) ||
    cursor.anchorId !== cursor.anchorId.toLowerCase() ||
    (cursor.anchorType !== null && !/^[a-z][a-z_]{0,63}$/.test(cursor.anchorType))
  ) {
    throw new TypeError('Invalid Report cursor value.');
  }
  const serialized = JSON.stringify([
    CURSOR_VERSION,
    cursor.scopeHash,
    cursor.anchorId,
    cursor.anchorType,
  ]);
  if (Buffer.byteLength(serialized, 'utf8') > CURSOR_MAX_DECODED_BYTES) {
    throw new Error('Report cursor payload exceeds the supported bound.');
  }
  const encoded = Buffer.from(serialized, 'utf8').toString('base64url');
  if (encoded.length > REPORT_CURSOR_MAX_ENCODED_LENGTH) {
    throw new Error('Report cursor exceeds the supported bound.');
  }
  return encoded;
}

export function decodeReportCursor(encoded: string, expectedScopeHash: string): ReportCursor {
  if (
    encoded.length === 0 ||
    encoded.length > REPORT_CURSOR_MAX_ENCODED_LENGTH ||
    !base64UrlPattern.test(encoded)
  ) {
    throw invalidCursor('reportCursor');
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(encoded, 'base64url');
  } catch {
    throw invalidCursor('reportCursor');
  }
  if (
    decoded.length === 0 ||
    decoded.length > CURSOR_MAX_DECODED_BYTES ||
    decoded.toString('base64url') !== encoded
  ) {
    throw invalidCursor('reportCursor');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decoder.decode(decoded)) as unknown;
  } catch {
    throw invalidCursor('reportCursor');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 4 ||
    parsed[0] !== CURSOR_VERSION ||
    typeof parsed[1] !== 'string' ||
    parsed[1] !== expectedScopeHash ||
    typeof parsed[2] !== 'string' ||
    !isUUID(parsed[2]) ||
    parsed[2] !== parsed[2].toLowerCase() ||
    (parsed[3] !== null &&
      (typeof parsed[3] !== 'string' || !/^[a-z][a-z_]{0,63}$/.test(parsed[3])))
  ) {
    throw invalidCursor('reportCursorScope');
  }
  return { scopeHash: parsed[1], anchorId: parsed[2], anchorType: parsed[3] };
}
