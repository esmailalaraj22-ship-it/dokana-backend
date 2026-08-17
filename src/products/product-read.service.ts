import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import {
  assertProductCursorScope,
  decodeProductCursor,
  encodeProductCursor,
  productCursorScopeHash,
} from './product-read-cursor';
import { ProductReadQueryError } from './product-read-query-error';
import { prepareProductSearchScope } from './product-read-query';
import { ProductReadRepository } from './product-read.repository';
import type {
  ProductDetailResponse,
  ProductListItemResponse,
  ProductListResponse,
  ProductListRow,
  ProductStatus,
  ProductUnitResponse,
  ProductUnitRow,
} from './product-read.types';
import { canonicalizeProductUuid } from './product-validation';
import type { ListProductsQueryDto } from './dto/list-products-query.dto';

type ProductReadPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class ProductReadService {
  constructor(private readonly repository: ProductReadRepository) {}

  async list(
    principal: ProductReadPrincipal,
    context: TenantTransactionContext,
    query: ListProductsQueryDto,
  ): Promise<ProductListResponse> {
    this.assertAuthorized(principal, context);
    try {
      const status: ProductStatus = query.status ?? 'active';
      const limit = query.limit ?? 50;
      const search = prepareProductSearchScope(query.search);
      const cursor = query.cursor === undefined ? null : decodeProductCursor(query.cursor);
      if (cursor) {
        assertProductCursorScope(cursor, status, search);
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
          ? encodeProductCursor({
              scopeHash: productCursorScopeHash(status, search),
              anchor: { id: lastRow.id, version: lastRow.version },
            })
          : null;

      return {
        items: pageRows.map((row) => this.mapListItem(row)),
        nextCursor,
      };
    } catch (error) {
      if (error instanceof ProductReadQueryError) {
        throw this.validationException(error.field, error.constraint);
      }
      throw error;
    }
  }

  async getById(
    principal: ProductReadPrincipal,
    context: TenantTransactionContext,
    productId: string,
  ): Promise<ProductDetailResponse> {
    this.assertAuthorized(principal, context);
    const record = await this.repository.findById(
      context,
      canonicalizeProductUuid(productId, 'productId'),
    );
    if (!record) {
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'Product not found.',
      });
    }

    return {
      ...this.mapListItem(record.product),
      description: record.product.description,
      createdAt: record.product.createdAt.toISOString(),
      units: record.units.map((unit) => this.mapUnit(unit)),
    };
  }

  private assertAuthorized(
    principal: ProductReadPrincipal,
    context: TenantTransactionContext,
  ): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'PRODUCT_READ_NOT_ALLOWED',
        message: 'Product reads are not allowed.',
      });
    }
  }

  private mapListItem(row: ProductListRow): ProductListItemResponse {
    return {
      id: row.id,
      name: row.name,
      sku: row.sku,
      barcode: row.barcode,
      measurementType: row.measurementType,
      trackInventory: row.trackInventory,
      allowNegativeStockOverride: row.allowNegativeStockOverride,
      lowStockThresholdMilli: row.lowStockThresholdMilli?.toString() ?? null,
      isPinned: row.isPinned,
      status: row.status,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
      version: row.version.toString(),
    };
  }

  private mapUnit(row: ProductUnitRow): ProductUnitResponse {
    return {
      id: row.id,
      measurementType: row.measurementType,
      unitName: row.unitName,
      unitCode: row.unitCode,
      isBase: row.isBase,
      factorNum: row.factorNum,
      factorDen: row.factorDen,
      salePriceMinor: row.salePriceMinor?.toString() ?? null,
      purchasePriceMinor: row.purchasePriceMinor?.toString() ?? null,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
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
