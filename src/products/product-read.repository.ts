import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, or, sql, type SQL } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import { products, productUnits } from '../database/schema';
import type { TenantTransactionContext } from '../database/database.types';
import { ProductReadQueryError } from './product-read-query-error';
import { escapeProductNamePrefix } from './product-read-query';
import type {
  ProductDetailRecord,
  ProductListCriteria,
  ProductListPosition,
  ProductListRow,
  ProductSearchScope,
} from './product-read.types';

@Injectable()
export class ProductReadRepository {
  constructor(private readonly database: DatabaseService) {}

  list(
    context: TenantTransactionContext,
    criteria: ProductListCriteria,
  ): Promise<ProductListRow[]> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const basePredicates = this.basePredicates(context, criteria.status, criteria.search);
      let position: ProductListPosition | null = null;

      if (criteria.anchor) {
        const anchorRows = await transaction
          .select({
            id: products.id,
            isPinned: products.isPinned,
            normalizedName: products.normalizedName,
          })
          .from(products)
          .where(
            and(
              ...basePredicates,
              eq(products.id, criteria.anchor.id),
              eq(products.version, criteria.anchor.version),
            ),
          )
          .limit(1)
          .for('share');
        const anchor = anchorRows[0];
        if (!anchor) {
          throw new ProductReadQueryError('cursor', 'productCursorAnchor');
        }
        position = anchor;
      }

      const predicates = [...basePredicates];
      if (position) {
        predicates.push(this.continuationPredicate(position));
      }

      return transaction
        .select({
          id: products.id,
          name: products.name,
          normalizedName: products.normalizedName,
          sku: products.sku,
          barcode: products.barcode,
          measurementType: products.measurementType,
          trackInventory: products.trackInventory,
          allowNegativeStockOverride: products.allowNegativeStockOverride,
          lowStockThresholdMilli: products.lowStockThresholdMilli,
          isPinned: products.isPinned,
          status: products.status,
          archivedAt: products.archivedAt,
          updatedAt: products.updatedAt,
          version: products.version,
        })
        .from(products)
        .where(and(...predicates))
        .orderBy(desc(products.isPinned), asc(products.normalizedName), asc(products.id))
        .limit(criteria.limit + 1);
    });
  }

  findById(
    context: TenantTransactionContext,
    productId: string,
  ): Promise<ProductDetailRecord | undefined> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const productRows = await transaction
        .select({
          id: products.id,
          name: products.name,
          normalizedName: products.normalizedName,
          sku: products.sku,
          barcode: products.barcode,
          description: products.description,
          measurementType: products.measurementType,
          trackInventory: products.trackInventory,
          allowNegativeStockOverride: products.allowNegativeStockOverride,
          lowStockThresholdMilli: products.lowStockThresholdMilli,
          isPinned: products.isPinned,
          status: products.status,
          archivedAt: products.archivedAt,
          createdAt: products.createdAt,
          updatedAt: products.updatedAt,
          version: products.version,
        })
        .from(products)
        .where(and(eq(products.storeId, context.storeId), eq(products.id, productId)))
        .limit(1);
      const product = productRows[0];
      if (!product) {
        return undefined;
      }

      const units = await transaction
        .select({
          id: productUnits.id,
          measurementType: productUnits.measurementType,
          unitName: productUnits.unitName,
          unitCode: productUnits.unitCode,
          isBase: productUnits.isBase,
          factorNum: productUnits.factorNum,
          factorDen: productUnits.factorDen,
          salePriceMinor: productUnits.salePriceMinor,
          purchasePriceMinor: productUnits.purchasePriceMinor,
          status: productUnits.status,
          createdAt: productUnits.createdAt,
          updatedAt: productUnits.updatedAt,
          version: productUnits.version,
        })
        .from(productUnits)
        .where(
          and(eq(productUnits.storeId, context.storeId), eq(productUnits.productId, productId)),
        )
        .orderBy(desc(productUnits.isBase), asc(productUnits.unitName), asc(productUnits.id));

      return { product, units };
    });
  }

  private basePredicates(
    context: TenantTransactionContext,
    status: ProductListCriteria['status'],
    search: ProductSearchScope | null,
  ): SQL[] {
    const predicates: SQL[] = [eq(products.storeId, context.storeId), eq(products.status, status)];
    if (search) {
      const literalPrefix = `${escapeProductNamePrefix(search.normalizedNamePrefix)}%`;
      const searchPredicate = or(
        sql`${products.normalizedName} like ${literalPrefix} escape ${'\\'}`,
        eq(products.sku, search.canonicalSku),
        eq(products.barcode, search.canonicalBarcode),
      );
      if (!searchPredicate) {
        throw new Error('Product search predicate construction failed.');
      }
      predicates.push(searchPredicate);
    }
    return predicates;
  }

  private continuationPredicate(position: ProductListPosition): SQL {
    const laterWithinPinGroup = or(
      gt(products.normalizedName, position.normalizedName),
      and(eq(products.normalizedName, position.normalizedName), gt(products.id, position.id)),
    );
    if (!laterWithinPinGroup) {
      throw new Error('Product cursor predicate construction failed.');
    }

    const samePinGroup = and(eq(products.isPinned, position.isPinned), laterWithinPinGroup);
    const predicate = position.isPinned
      ? or(eq(products.isPinned, false), samePinGroup)
      : samePinGroup;
    if (!predicate) {
      throw new Error('Product cursor predicate construction failed.');
    }
    return predicate;
  }
}
