import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, or, sql, type SQL } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import { suppliers } from '../database/schema';
import type { TenantTransactionContext } from '../database/database.types';
import { SupplierReadQueryError } from './supplier-read-query-error';
import { escapeSupplierNamePrefix } from './supplier-read-query';
import type {
  SupplierDetailRow,
  SupplierListCriteria,
  SupplierListPosition,
  SupplierListRow,
  SupplierSearchScope,
} from './supplier-read.types';

@Injectable()
export class SupplierReadRepository {
  constructor(private readonly database: DatabaseService) {}

  list(
    context: TenantTransactionContext,
    criteria: SupplierListCriteria,
  ): Promise<SupplierListRow[]> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const basePredicates = this.basePredicates(context, criteria.status, criteria.search);
      let position: SupplierListPosition | null = null;

      if (criteria.anchor) {
        const anchorRows = await transaction
          .select({
            id: suppliers.id,
            normalizedName: suppliers.normalizedName,
          })
          .from(suppliers)
          .where(
            and(
              ...basePredicates,
              eq(suppliers.id, criteria.anchor.id),
              eq(suppliers.version, criteria.anchor.version),
            ),
          )
          .limit(1)
          .for('share');
        const anchor = anchorRows[0];
        if (!anchor) {
          throw new SupplierReadQueryError('cursor', 'supplierCursorAnchor');
        }
        position = anchor;
      }

      const predicates = [...basePredicates];
      if (position) {
        predicates.push(this.continuationPredicate(position));
      }

      return transaction
        .select({
          id: suppliers.id,
          name: suppliers.name,
          normalizedName: suppliers.normalizedName,
          phone: suppliers.phone,
          status: suppliers.status,
          archivedAt: suppliers.archivedAt,
          updatedAt: suppliers.updatedAt,
          version: suppliers.version,
        })
        .from(suppliers)
        .where(and(...predicates))
        .orderBy(asc(suppliers.normalizedName), asc(suppliers.id))
        .limit(criteria.limit + 1);
    });
  }

  findById(
    context: TenantTransactionContext,
    supplierId: string,
  ): Promise<SupplierDetailRow | undefined> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const rows = await transaction
        .select({
          id: suppliers.id,
          name: suppliers.name,
          normalizedName: suppliers.normalizedName,
          phone: suppliers.phone,
          notes: suppliers.notes,
          status: suppliers.status,
          archivedAt: suppliers.archivedAt,
          createdAt: suppliers.createdAt,
          updatedAt: suppliers.updatedAt,
          version: suppliers.version,
        })
        .from(suppliers)
        .where(and(eq(suppliers.storeId, context.storeId), eq(suppliers.id, supplierId)))
        .limit(1);
      return rows[0];
    });
  }

  private basePredicates(
    context: TenantTransactionContext,
    status: SupplierListCriteria['status'],
    search: SupplierSearchScope | null,
  ): SQL[] {
    const predicates: SQL[] = [
      eq(suppliers.storeId, context.storeId),
      eq(suppliers.status, status),
    ];
    if (search) {
      const literalPrefix = `${escapeSupplierNamePrefix(search.normalizedNamePrefix)}%`;
      const namePredicate = sql`${suppliers.normalizedName} like ${literalPrefix} escape ${'\\'}`;
      const searchPredicate =
        search.canonicalPhone === null
          ? namePredicate
          : or(namePredicate, eq(suppliers.normalizedPhone, search.canonicalPhone));
      if (!searchPredicate) {
        throw new Error('Supplier search predicate construction failed.');
      }
      predicates.push(searchPredicate);
    }
    return predicates;
  }

  private continuationPredicate(position: SupplierListPosition): SQL {
    const predicate = or(
      gt(suppliers.normalizedName, position.normalizedName),
      and(eq(suppliers.normalizedName, position.normalizedName), gt(suppliers.id, position.id)),
    );
    if (!predicate) {
      throw new Error('Supplier cursor predicate construction failed.');
    }
    return predicate;
  }
}
