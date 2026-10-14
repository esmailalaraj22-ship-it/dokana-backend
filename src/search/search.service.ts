import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type { GlobalSearchQueryDto } from './dto/global-search-query.dto';
import { decodeSearchCursor, encodeSearchCursor, searchCursorScopeHash } from './search-cursor';
import { prepareGlobalSearchScope, SearchQueryError } from './search-query';
import { SearchRepository } from './search.repository';
import type { GlobalSearchResponse, SearchRepositoryRow, SearchResult } from './search.types';

type SearchPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

const DEFAULT_LIMIT = 25;

@Injectable()
export class SearchService {
  constructor(private readonly repository: SearchRepository) {}

  async search(
    principal: SearchPrincipal,
    context: TenantTransactionContext,
    query: GlobalSearchQueryDto,
  ): Promise<GlobalSearchResponse> {
    this.assertAuthorized(principal, context);
    try {
      const scope = prepareGlobalSearchScope(query.q);
      const resultType = query.type ?? null;
      const limit = query.limit ?? DEFAULT_LIMIT;
      const scopeHash = searchCursorScopeHash(context.storeId, scope, resultType);
      const cursor = query.cursor ? decodeSearchCursor(query.cursor, scopeHash) : null;
      const rows = await this.repository.search(context, {
        scope,
        resultType,
        anchor: cursor?.anchor ?? null,
        limit,
      });
      const hasNextPage = rows.length > limit;
      const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
      const last = pageRows.at(-1);

      return {
        filters: { q: scope.query, type: resultType },
        items: pageRows.map((row) => this.mapResult(row)),
        pagination: {
          limit,
          nextCursor:
            hasNextPage && last
              ? encodeSearchCursor({
                  scopeHash,
                  anchor: {
                    matchRank: last.matchRank,
                    sortAt: this.databaseDate(last.sortAt, 'sort timestamp').toISOString(),
                    type: last.type,
                    id: last.id,
                  },
                })
              : null,
        },
      };
    } catch (error) {
      if (error instanceof SearchQueryError) {
        throw new BadRequestException({
          code: 'SEARCH_QUERY_INVALID',
          message: 'Search query is invalid.',
          details: [{ field: error.field, constraints: [error.constraint] }],
        });
      }
      throw error;
    }
  }

  private assertAuthorized(principal: SearchPrincipal, context: TenantTransactionContext): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'SEARCH_READ_NOT_ALLOWED',
        message: 'Search reads are not allowed.',
      });
    }
  }

  private mapResult(row: SearchRepositoryRow): SearchResult {
    return {
      type: row.type,
      id: row.id,
      primaryLabel: row.primaryLabel,
      secondaryLabel: row.secondaryLabel,
      status: row.status,
      displayNumber: row.displayNumber,
      amountMinor: row.amountMinor,
      quantityMilli: row.quantityMilli,
      businessDate: row.businessDate,
      occurredAt:
        row.occurredAt === null
          ? null
          : this.databaseDate(row.occurredAt, 'result timestamp').toISOString(),
    };
  }

  private databaseDate(value: Date | string, label: string): Date {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error(`Search ${label} is invalid.`);
    return date;
  }
}
