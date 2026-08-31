import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import { moneyAccounts } from '../database/schema';
import type { TenantTransactionContext } from '../database/database.types';
import {
  MONEY_ACCOUNT_PUBLIC_TYPES,
  type MoneyAccountListCriteria,
  type MoneyAccountPhysicalReadRow,
  type MoneyAccountPublicType,
  type MoneyAccountReadRow,
} from './money-account-read.types';

function isPublicMoneyAccountType(
  accountType: MoneyAccountPhysicalReadRow['accountType'],
): accountType is MoneyAccountPublicType {
  return MONEY_ACCOUNT_PUBLIC_TYPES.some((publicType) => publicType === accountType);
}

@Injectable()
export class MoneyAccountReadRepository {
  constructor(private readonly database: DatabaseService) {}

  list(
    context: TenantTransactionContext,
    criteria: MoneyAccountListCriteria,
  ): Promise<MoneyAccountReadRow[]> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const rows: MoneyAccountPhysicalReadRow[] = await transaction
        .select({
          id: moneyAccounts.id,
          name: moneyAccounts.name,
          accountType: moneyAccounts.accountType,
          availability: moneyAccounts.availability,
          isDefault: moneyAccounts.isDefault,
          status: moneyAccounts.status,
          archivedAt: moneyAccounts.archivedAt,
          createdAt: moneyAccounts.createdAt,
          updatedAt: moneyAccounts.updatedAt,
          version: moneyAccounts.version,
        })
        .from(moneyAccounts)
        .where(
          and(
            eq(moneyAccounts.storeId, context.storeId),
            eq(moneyAccounts.status, criteria.status),
            inArray(moneyAccounts.accountType, [...MONEY_ACCOUNT_PUBLIC_TYPES]),
            eq(moneyAccounts.availability, 'available'),
          ),
        )
        .orderBy(
          desc(eq(moneyAccounts.accountType, 'cash')),
          asc(moneyAccounts.normalizedName),
          asc(moneyAccounts.id),
        );

      return rows.map((row) => this.toPublicRow(row));
    });
  }

  findById(
    context: TenantTransactionContext,
    moneyAccountId: string,
  ): Promise<MoneyAccountReadRow | undefined> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const rows: MoneyAccountPhysicalReadRow[] = await transaction
        .select({
          id: moneyAccounts.id,
          name: moneyAccounts.name,
          accountType: moneyAccounts.accountType,
          availability: moneyAccounts.availability,
          isDefault: moneyAccounts.isDefault,
          status: moneyAccounts.status,
          archivedAt: moneyAccounts.archivedAt,
          createdAt: moneyAccounts.createdAt,
          updatedAt: moneyAccounts.updatedAt,
          version: moneyAccounts.version,
        })
        .from(moneyAccounts)
        .where(
          and(
            eq(moneyAccounts.storeId, context.storeId),
            eq(moneyAccounts.id, moneyAccountId),
            inArray(moneyAccounts.accountType, [...MONEY_ACCOUNT_PUBLIC_TYPES]),
            eq(moneyAccounts.availability, 'available'),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row ? this.toPublicRow(row) : undefined;
    });
  }

  private toPublicRow(row: MoneyAccountPhysicalReadRow): MoneyAccountReadRow {
    if (row.availability !== 'available' || !isPublicMoneyAccountType(row.accountType)) {
      throw new Error('Money Account visibility invariant violated.');
    }

    return {
      id: row.id,
      name: row.name,
      accountType: row.accountType,
      isDefault: row.isDefault,
      status: row.status,
      archivedAt: row.archivedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      version: row.version,
    };
  }
}
