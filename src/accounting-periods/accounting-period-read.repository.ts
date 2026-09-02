import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import { accountingPeriods } from '../database/schema';
import type { TenantTransactionContext } from '../database/database.types';
import {
  ACCOUNTING_PERIOD_PUBLIC_STATUSES,
  type AccountingPeriodPhysicalReadRow,
  type AccountingPeriodPublicStatus,
  type AccountingPeriodReadRow,
} from './accounting-period-read.types';

const publicProjection = {
  id: accountingPeriods.id,
  periodYear: accountingPeriods.periodYear,
  periodMonth: accountingPeriods.periodMonth,
  startsAt: accountingPeriods.startsAt,
  endsAt: accountingPeriods.endsAt,
  status: accountingPeriods.status,
  closedAt: accountingPeriods.closedAt,
  createdAt: accountingPeriods.createdAt,
  updatedAt: accountingPeriods.updatedAt,
  version: accountingPeriods.version,
};

@Injectable()
export class AccountingPeriodReadRepository {
  constructor(private readonly database: DatabaseService) {}

  list(context: TenantTransactionContext): Promise<AccountingPeriodReadRow[]> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const rows: AccountingPeriodPhysicalReadRow[] = await transaction
        .select(publicProjection)
        .from(accountingPeriods)
        .where(
          and(
            eq(accountingPeriods.storeId, context.storeId),
            inArray(accountingPeriods.status, [...ACCOUNTING_PERIOD_PUBLIC_STATUSES]),
          ),
        )
        .orderBy(
          desc(accountingPeriods.periodYear),
          desc(accountingPeriods.periodMonth),
          desc(accountingPeriods.id),
        );

      return rows.map((row) => this.toPublicRow(row));
    });
  }

  findById(
    context: TenantTransactionContext,
    accountingPeriodId: string,
  ): Promise<AccountingPeriodReadRow | undefined> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const rows: AccountingPeriodPhysicalReadRow[] = await transaction
        .select(publicProjection)
        .from(accountingPeriods)
        .where(
          and(
            eq(accountingPeriods.storeId, context.storeId),
            eq(accountingPeriods.id, accountingPeriodId),
            inArray(accountingPeriods.status, [...ACCOUNTING_PERIOD_PUBLIC_STATUSES]),
          ),
        )
        .limit(1);

      const row = rows[0];
      return row ? this.toPublicRow(row) : undefined;
    });
  }

  private toPublicRow(row: AccountingPeriodPhysicalReadRow): AccountingPeriodReadRow {
    if (!this.isPublicStatus(row.status)) {
      throw new Error('Accounting Period visibility invariant violated.');
    }

    return { ...row, status: row.status };
  }

  private isPublicStatus(status: string): status is AccountingPeriodPublicStatus {
    return ACCOUNTING_PERIOD_PUBLIC_STATUSES.some((publicStatus) => publicStatus === status);
  }
}
