import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, or, sql, type SQL } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import { customers } from '../database/schema';
import type { TenantTransactionContext } from '../database/database.types';
import { escapeCustomerNamePrefix } from './customer-read-query';
import type {
  CustomerDetailRow,
  CustomerListCriteria,
  CustomerListRow,
} from './customer-read.types';

@Injectable()
export class CustomerReadRepository {
  constructor(private readonly database: DatabaseService) {}

  list(
    context: TenantTransactionContext,
    criteria: CustomerListCriteria,
  ): Promise<CustomerListRow[]> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const predicates: SQL[] = [
        eq(customers.storeId, context.storeId),
        eq(customers.status, criteria.status),
      ];

      if (criteria.search) {
        const literalPrefix = `${escapeCustomerNamePrefix(criteria.search.normalizedNamePrefix)}%`;
        const namePredicate = sql`${customers.normalizedName} like ${literalPrefix} escape ${'\\'}`;
        const searchPredicate = criteria.search.canonicalPhone
          ? or(namePredicate, eq(customers.normalizedPhone, criteria.search.canonicalPhone))
          : namePredicate;
        if (!searchPredicate) {
          throw new Error('Customer search predicate construction failed.');
        }
        predicates.push(searchPredicate);
      }

      if (criteria.position) {
        const positionPredicate = or(
          gt(customers.normalizedName, criteria.position.normalizedName),
          and(
            eq(customers.normalizedName, criteria.position.normalizedName),
            gt(customers.id, criteria.position.id),
          ),
        );
        if (!positionPredicate) {
          throw new Error('Customer cursor predicate construction failed.');
        }
        predicates.push(positionPredicate);
      }

      return transaction
        .select({
          id: customers.id,
          name: customers.name,
          normalizedName: customers.normalizedName,
          phone: customers.phone,
          status: customers.status,
          archivedAt: customers.archivedAt,
          updatedAt: customers.updatedAt,
        })
        .from(customers)
        .where(and(...predicates))
        .orderBy(asc(customers.normalizedName), asc(customers.id))
        .limit(criteria.limit + 1);
    });
  }

  findById(
    context: TenantTransactionContext,
    customerId: string,
  ): Promise<CustomerDetailRow | undefined> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const rows = await transaction
        .select({
          id: customers.id,
          name: customers.name,
          normalizedName: customers.normalizedName,
          phone: customers.phone,
          status: customers.status,
          archivedAt: customers.archivedAt,
          updatedAt: customers.updatedAt,
          notes: customers.notes,
          createdAt: customers.createdAt,
          version: customers.version,
        })
        .from(customers)
        .where(and(eq(customers.storeId, context.storeId), eq(customers.id, customerId)))
        .limit(1);

      return rows[0];
    });
  }
}
