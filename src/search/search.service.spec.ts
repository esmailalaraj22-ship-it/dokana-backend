import { randomUUID } from 'node:crypto';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import { decodeSearchCursor, searchCursorScopeHash } from './search-cursor';
import { prepareGlobalSearchScope } from './search-query';
import type { SearchRepository } from './search.repository';
import { SearchService } from './search.service';
import type { SearchRepositoryRow } from './search.types';

const context: TenantTransactionContext = {
  storeId: randomUUID(),
  userId: randomUUID(),
  deviceId: randomUUID(),
  requestId: randomUUID(),
};
const principal = {
  membershipRole: 'owner',
  storeId: context.storeId,
  userId: context.userId,
  deviceId: context.deviceId,
} satisfies Pick<AuthenticatedPrincipal, 'membershipRole' | 'storeId' | 'userId' | 'deviceId'>;

function row(id: string, sortAt: string): SearchRepositoryRow {
  return {
    type: 'sale',
    id,
    primaryLabel: 'S-20',
    secondaryLabel: null,
    status: 'posted',
    displayNumber: 'S-20',
    amountMinor: '9007199254740993',
    quantityMilli: null,
    businessDate: '2026-10-14',
    occurredAt: sortAt,
    matchRank: 1,
    sortAt,
  };
}

describe('SearchService', () => {
  let repository: jest.Mocked<SearchRepository>;
  let service: SearchService;

  beforeEach(() => {
    repository = { search: jest.fn() } as unknown as jest.Mocked<SearchRepository>;
    service = new SearchService(repository);
  });

  it('returns sanitized exact values and a scope-bound keyset cursor', async () => {
    const rows = [
      row(randomUUID(), '2026-10-14T10:00:00.000Z'),
      row(randomUUID(), '2026-10-14T09:00:00.000Z'),
      row(randomUUID(), '2026-10-14T08:00:00.000Z'),
    ];
    repository.search.mockResolvedValue(rows);

    const response = await service.search(principal, context, {
      q: 'S-20',
      type: 'sale',
      limit: 2,
    });

    expect(response.items).toHaveLength(2);
    expect(response.items[0]).toMatchObject({
      type: 'sale',
      amountMinor: '9007199254740993',
      occurredAt: '2026-10-14T10:00:00.000Z',
    });
    const scopeHash = searchCursorScopeHash(
      context.storeId,
      prepareGlobalSearchScope('S-20'),
      'sale',
    );
    expect(decodeSearchCursor(response.pagination.nextCursor ?? '', scopeHash).anchor).toEqual({
      matchRank: 1,
      sortAt: '2026-10-14T09:00:00.000Z',
      type: 'sale',
      id: rows[1]?.id,
    });
    expect(repository.search).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ resultType: 'sale', limit: 2, anchor: null }),
    );
  });

  it.each([
    { ...principal, membershipRole: 'manager' as const },
    { ...principal, storeId: randomUUID() },
    { ...principal, userId: randomUUID() },
    { ...principal, deviceId: randomUUID() },
  ])('fails closed before querying for an unauthorized principal', async (unauthorized) => {
    await expect(service.search(unauthorized, context, { q: 'test' })).rejects.toMatchObject({
      status: 403,
      response: { code: 'SEARCH_READ_NOT_ALLOWED' },
    });
    expect(repository.search).not.toHaveBeenCalled();
  });

  it('maps invalid normalized input to the stable Search error contract', async () => {
    await expect(service.search(principal, context, { q: ' \u00a0\u2003 ' })).rejects.toMatchObject(
      {
        status: 400,
        response: {
          code: 'SEARCH_QUERY_INVALID',
          details: [{ field: 'q', constraints: ['globalSearch'] }],
        },
      },
    );
    expect(repository.search).not.toHaveBeenCalled();
  });
});
