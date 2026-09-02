import { ForbiddenException, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { accountingPeriods, stores } from '../database/schema';
import type { DatabaseTransaction } from '../database/database.types';
import type { AccountingPeriodRow } from './accounting-period.types';

const accountingPeriodSelection = {
  id: accountingPeriods.id,
  storeId: accountingPeriods.storeId,
  periodYear: accountingPeriods.periodYear,
  periodMonth: accountingPeriods.periodMonth,
  startsAt: accountingPeriods.startsAt,
  endsAt: accountingPeriods.endsAt,
  status: accountingPeriods.status,
  closedAt: accountingPeriods.closedAt,
  deviceId: accountingPeriods.deviceId,
  operationId: accountingPeriods.operationId,
  createdAt: accountingPeriods.createdAt,
  updatedAt: accountingPeriods.updatedAt,
  version: accountingPeriods.version,
} as const;

@Injectable()
export class AccountingPeriodPostingContextRepository {
  async assertActiveStoreForPosting(
    transaction: DatabaseTransaction,
    storeId: string,
  ): Promise<void> {
    const rows = await transaction
      .select({ status: stores.status })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1)
      .for('share');

    if (rows[0]?.status !== 'active') {
      throw new ForbiddenException({
        code: 'BUSINESS_WRITE_NOT_ALLOWED',
        message: 'Business writes are not allowed.',
      });
    }
  }

  async lockCanonicalPeriod(
    transaction: DatabaseTransaction,
    storeId: string,
    accountingPeriodId: string,
  ): Promise<AccountingPeriodRow | undefined> {
    const rows = await transaction
      .select(accountingPeriodSelection)
      .from(accountingPeriods)
      .where(
        and(eq(accountingPeriods.storeId, storeId), eq(accountingPeriods.id, accountingPeriodId)),
      )
      .limit(1)
      .for('share');
    return rows[0];
  }
}
