import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type { ListSuppliersQueryDto } from './dto/list-suppliers-query.dto';
import {
  assertSupplierCursorScope,
  decodeSupplierCursor,
  encodeSupplierCursor,
  supplierCursorScopeHash,
} from './supplier-read-cursor';
import { SupplierReadQueryError } from './supplier-read-query-error';
import { prepareSupplierSearchScope } from './supplier-read-query';
import { SupplierReadRepository } from './supplier-read.repository';
import type {
  SupplierDetailResponse,
  SupplierListItemResponse,
  SupplierListResponse,
  SupplierListRow,
  SupplierStatus,
} from './supplier-read.types';
import { canonicalizeSupplierUuid } from './supplier-validation';

type SupplierReadPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class SupplierReadService {
  constructor(private readonly repository: SupplierReadRepository) {}

  async list(
    principal: SupplierReadPrincipal,
    context: TenantTransactionContext,
    query: ListSuppliersQueryDto,
  ): Promise<SupplierListResponse> {
    this.assertAuthorized(principal, context);
    try {
      const status: SupplierStatus = query.status ?? 'active';
      const limit = query.limit ?? 50;
      const search = prepareSupplierSearchScope(query.search);
      const cursor = query.cursor === undefined ? null : decodeSupplierCursor(query.cursor);
      if (cursor) {
        assertSupplierCursorScope(cursor, status, search);
      }

      const rows = await this.repository.list(context, {
        status,
        search,
        anchor: cursor?.anchor ?? null,
        limit,
      });
      const hasNextPage = rows.length > limit;
      const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
      const lastRow = pageRows.at(-1);
      const nextCursor =
        hasNextPage && lastRow
          ? encodeSupplierCursor({
              scopeHash: supplierCursorScopeHash(status, search),
              anchor: { id: lastRow.id, version: lastRow.version },
            })
          : null;

      return {
        items: pageRows.map((row) => this.mapListItem(row)),
        nextCursor,
      };
    } catch (error) {
      if (error instanceof SupplierReadQueryError) {
        throw this.validationException(error.field, error.constraint);
      }
      throw error;
    }
  }

  async getById(
    principal: SupplierReadPrincipal,
    context: TenantTransactionContext,
    supplierId: string,
  ): Promise<SupplierDetailResponse> {
    this.assertAuthorized(principal, context);
    const record = await this.repository.findById(
      context,
      canonicalizeSupplierUuid(supplierId, 'id'),
    );
    if (!record) {
      throw new NotFoundException({
        code: 'SUPPLIER_NOT_FOUND',
        message: 'Supplier not found.',
      });
    }

    return {
      ...this.mapListItem(record),
      notes: record.notes,
      createdAt: record.createdAt.toISOString(),
    };
  }

  private assertAuthorized(
    principal: SupplierReadPrincipal,
    context: TenantTransactionContext,
  ): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'SUPPLIER_READ_NOT_ALLOWED',
        message: 'Supplier reads are not allowed.',
      });
    }
  }

  private mapListItem(row: SupplierListRow): SupplierListItemResponse {
    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      status: row.status,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
      version: row.version.toString(),
    };
  }

  private validationException(field: string, constraint: string): BadRequestException {
    return new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed.',
      details: [{ field, constraints: [constraint] }],
    });
  }
}
