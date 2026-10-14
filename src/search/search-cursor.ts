import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { isUUID } from 'class-validator';

import { SearchQueryError } from './search-query';
import {
  SEARCH_RESULT_TYPES,
  type GlobalSearchScope,
  type SearchCursorAnchor,
  type SearchResultType,
} from './search.types';

export const SEARCH_CURSOR_MAX_ENCODED_LENGTH = 256;

const CURSOR_VERSION = 1;
const CURSOR_MAX_DECODED_BYTES = 192;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const scopeHashPattern = /^[A-Za-z0-9_-]{43}$/;
const resultTypes = new Set<string>(SEARCH_RESULT_TYPES);
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export interface SearchCursor {
  scopeHash: string;
  anchor: SearchCursorAnchor;
}

export function searchCursorScopeHash(
  storeId: string,
  scope: GlobalSearchScope,
  resultType: SearchResultType | null,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        CURSOR_VERSION,
        storeId,
        resultType,
        scope.customerNamePrefix,
        scope.supplierNamePrefix,
        scope.productNamePrefix,
        scope.moneyAccountNamePrefix,
        scope.canonicalPhone,
        scope.canonicalSku,
        scope.canonicalBarcode,
        scope.text,
        scope.exactUuid,
        scope.amountMinor,
        scope.exactDate,
      ]),
      'utf8',
    )
    .digest('base64url');
}

export function encodeSearchCursor(cursor: SearchCursor): string {
  const { anchor } = cursor;
  if (
    !scopeHashPattern.test(cursor.scopeHash) ||
    !Number.isInteger(anchor.matchRank) ||
    anchor.matchRank < 0 ||
    anchor.matchRank > 9 ||
    new Date(anchor.sortAt).toISOString() !== anchor.sortAt ||
    !resultTypes.has(anchor.type) ||
    !isUUID(anchor.id) ||
    anchor.id !== anchor.id.toLowerCase()
  ) {
    throw new TypeError('Invalid Search cursor value.');
  }
  const serialized = JSON.stringify([
    CURSOR_VERSION,
    cursor.scopeHash,
    anchor.matchRank,
    anchor.sortAt,
    anchor.type,
    anchor.id,
  ]);
  if (Buffer.byteLength(serialized, 'utf8') > CURSOR_MAX_DECODED_BYTES) {
    throw new Error('Search cursor payload exceeds the supported bound.');
  }
  const encoded = Buffer.from(serialized, 'utf8').toString('base64url');
  if (encoded.length > SEARCH_CURSOR_MAX_ENCODED_LENGTH) {
    throw new Error('Search cursor exceeds the supported bound.');
  }
  return encoded;
}

export function decodeSearchCursor(encoded: string, expectedScopeHash: string): SearchCursor {
  if (
    encoded.length === 0 ||
    encoded.length > SEARCH_CURSOR_MAX_ENCODED_LENGTH ||
    !base64UrlPattern.test(encoded)
  ) {
    throw new SearchQueryError('cursor', 'searchCursor');
  }
  const decoded = Buffer.from(encoded, 'base64url');
  if (
    decoded.length === 0 ||
    decoded.length > CURSOR_MAX_DECODED_BYTES ||
    decoded.toString('base64url') !== encoded
  ) {
    throw new SearchQueryError('cursor', 'searchCursor');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decoder.decode(decoded)) as unknown;
  } catch {
    throw new SearchQueryError('cursor', 'searchCursor');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 6 ||
    parsed[0] !== CURSOR_VERSION ||
    parsed[1] !== expectedScopeHash ||
    typeof parsed[2] !== 'number' ||
    !Number.isInteger(parsed[2]) ||
    parsed[2] < 0 ||
    parsed[2] > 9 ||
    typeof parsed[3] !== 'string' ||
    !Number.isFinite(new Date(parsed[3]).getTime()) ||
    new Date(parsed[3]).toISOString() !== parsed[3] ||
    typeof parsed[4] !== 'string' ||
    !resultTypes.has(parsed[4]) ||
    typeof parsed[5] !== 'string' ||
    !isUUID(parsed[5]) ||
    parsed[5] !== parsed[5].toLowerCase()
  ) {
    throw new SearchQueryError('cursor', 'searchCursorScope');
  }

  return {
    scopeHash: expectedScopeHash,
    anchor: {
      matchRank: parsed[2],
      sortAt: parsed[3],
      type: parsed[4] as SearchResultType,
      id: parsed[5],
    },
  };
}
