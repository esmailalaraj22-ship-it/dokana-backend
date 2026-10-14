import { randomUUID } from 'node:crypto';

import {
  decodeSearchCursor,
  encodeSearchCursor,
  searchCursorScopeHash,
  SEARCH_CURSOR_MAX_ENCODED_LENGTH,
} from './search-cursor';
import { prepareGlobalSearchScope, SearchQueryError } from './search-query';

describe('global Search cursor contract', () => {
  const storeId = randomUUID();
  const scope = prepareGlobalSearchScope('Dashboard');
  const scopeHash = searchCursorScopeHash(storeId, scope, 'sale');
  const anchor = {
    matchRank: 1,
    sortAt: '2026-10-14T08:00:00.000Z',
    type: 'sale' as const,
    id: randomUUID(),
  };

  it('round-trips a bounded cursor with its complete Search scope', () => {
    const encoded = encodeSearchCursor({ scopeHash, anchor });

    expect(encoded.length).toBeLessThanOrEqual(SEARCH_CURSOR_MAX_ENCODED_LENGTH);
    expect(decodeSearchCursor(encoded, scopeHash)).toEqual({ scopeHash, anchor });
  });

  it('rejects reuse for another Store, normalized query, or result type', () => {
    const encoded = encodeSearchCursor({ scopeHash, anchor });
    const incompatibleHashes = [
      searchCursorScopeHash(randomUUID(), scope, 'sale'),
      searchCursorScopeHash(storeId, prepareGlobalSearchScope('Different'), 'sale'),
      searchCursorScopeHash(storeId, scope, 'expense'),
    ];

    for (const incompatibleHash of incompatibleHashes) {
      expect(() => decodeSearchCursor(encoded, incompatibleHash)).toThrow(SearchQueryError);
    }
  });

  it.each(['not-base64+', 'a'.repeat(SEARCH_CURSOR_MAX_ENCODED_LENGTH + 1), 'e30'])(
    'rejects malformed or over-bound cursor %#',
    (cursor) => {
      expect(() => decodeSearchCursor(cursor, scopeHash)).toThrow(SearchQueryError);
    },
  );
});
