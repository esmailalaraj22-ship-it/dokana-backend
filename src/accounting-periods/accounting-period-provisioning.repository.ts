import { ForbiddenException, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { accountingPeriods, stores } from '../database/schema';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { accountingPeriodConflictConstraint } from './accounting-period-database-error';
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

export interface CanonicalAccountingPeriodProvisioningInput {
  accountingPeriodId: string;
  periodYear: number;
  periodMonth: number;
  startsAt: Date;
  endsAt: Date;
  operationId: string;
}

export class AccountingPeriodProvisioningConflictError extends Error {
  constructor() {
    super('Accounting Period provisioning conflicts with existing physical state.');
    this.name = 'AccountingPeriodProvisioningConflictError';
  }
}

@Injectable()
export class AccountingPeriodProvisioningRepository {
  async ensure(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: CanonicalAccountingPeriodProvisioningInput,
  ): Promise<AccountingPeriodRow> {
    const existing = await this.readMonth(
      transaction,
      context.storeId,
      input.periodYear,
      input.periodMonth,
    );
    if (existing) {
      return existing;
    }

    await this.assertActiveStore(transaction, context.storeId);

    try {
      return await transaction.transaction(async (savepoint) => {
        const rows = await savepoint
          .insert(accountingPeriods)
          .values({
            id: input.accountingPeriodId,
            storeId: context.storeId,
            periodYear: input.periodYear,
            periodMonth: input.periodMonth,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            status: 'open',
            closedAt: null,
            deviceId: context.deviceId,
            operationId: input.operationId,
          })
          .returning(accountingPeriodSelection);
        const created = rows[0];
        if (!created) {
          throw new Error('Accounting Period provisioning did not return a row.');
        }
        return created;
      });
    } catch (error) {
      if (accountingPeriodConflictConstraint(error) === undefined) {
        throw error;
      }

      const winner = await this.readMonth(
        transaction,
        context.storeId,
        input.periodYear,
        input.periodMonth,
      );
      if (!winner) {
        throw new AccountingPeriodProvisioningConflictError();
      }
      return winner;
    }
  }

  private async readMonth(
    transaction: DatabaseTransaction,
    storeId: string,
    periodYear: number,
    periodMonth: number,
  ): Promise<AccountingPeriodRow | undefined> {
    const rows = await transaction
      .select(accountingPeriodSelection)
      .from(accountingPeriods)
      .where(
        and(
          eq(accountingPeriods.storeId, storeId),
          eq(accountingPeriods.periodYear, periodYear),
          eq(accountingPeriods.periodMonth, periodMonth),
        ),
      )
      .limit(1)
      .for('share');
    return rows[0];
  }

  private async assertActiveStore(
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
}
