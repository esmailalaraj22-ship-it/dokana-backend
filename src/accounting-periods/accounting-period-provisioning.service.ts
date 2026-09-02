import { Injectable } from '@nestjs/common';

import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import {
  canonicalizeAccountingPeriodId,
  deriveAccountingPeriodId,
} from './accounting-period-identity';
import { resolveAccountingPeriodBoundaries } from './accounting-period-month';
import {
  AccountingPeriodProvisioningConflictError,
  AccountingPeriodProvisioningRepository,
} from './accounting-period-provisioning.repository';
import type { AccountingPeriodRow } from './accounting-period.types';

export interface EnsureMonthlyAccountingPeriodInput {
  periodYear: number;
  periodMonth: number;
  operationId: string;
}

export class AccountingPeriodIntegrityError extends Error {
  readonly code = 'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT';

  constructor() {
    super('Accounting Period identity or boundaries are inconsistent.');
    this.name = 'AccountingPeriodIntegrityError';
  }
}

@Injectable()
export class AccountingPeriodProvisioningService {
  constructor(private readonly repository: AccountingPeriodProvisioningRepository) {}

  async ensureMonthlyAccountingPeriod(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: EnsureMonthlyAccountingPeriodInput,
  ): Promise<AccountingPeriodRow> {
    const operationId = canonicalizeAccountingPeriodId(input.operationId);
    const boundaries = resolveAccountingPeriodBoundaries(input.periodYear, input.periodMonth);
    const accountingPeriodId = deriveAccountingPeriodId(
      context.storeId,
      input.periodYear,
      input.periodMonth,
    );
    let row: AccountingPeriodRow;
    try {
      row = await this.repository.ensure(transaction, context, {
        accountingPeriodId,
        periodYear: input.periodYear,
        periodMonth: input.periodMonth,
        startsAt: boundaries.startsAt,
        endsAt: boundaries.endsAt,
        operationId,
      });
    } catch (error) {
      if (error instanceof AccountingPeriodProvisioningConflictError) {
        throw new AccountingPeriodIntegrityError();
      }
      throw error;
    }

    this.assertCanonicalRow(row, context.storeId, {
      accountingPeriodId,
      periodYear: input.periodYear,
      periodMonth: input.periodMonth,
      startsAt: boundaries.startsAt,
      endsAt: boundaries.endsAt,
    });
    return row;
  }

  assertCanonicalExistingRow(row: AccountingPeriodRow, trustedStoreId: string): void {
    try {
      const boundaries = resolveAccountingPeriodBoundaries(row.periodYear, row.periodMonth);
      this.assertCanonicalRow(row, trustedStoreId, {
        accountingPeriodId: deriveAccountingPeriodId(
          trustedStoreId,
          row.periodYear,
          row.periodMonth,
        ),
        periodYear: row.periodYear,
        periodMonth: row.periodMonth,
        startsAt: boundaries.startsAt,
        endsAt: boundaries.endsAt,
      });
    } catch (error) {
      if (error instanceof AccountingPeriodIntegrityError) {
        throw error;
      }
      throw new AccountingPeriodIntegrityError();
    }
  }

  private assertCanonicalRow(
    row: AccountingPeriodRow,
    trustedStoreId: string,
    expected: {
      accountingPeriodId: string;
      periodYear: number;
      periodMonth: number;
      startsAt: Date;
      endsAt: Date;
    },
  ): void {
    if (
      row.storeId !== trustedStoreId ||
      row.id !== expected.accountingPeriodId ||
      row.periodYear !== expected.periodYear ||
      row.periodMonth !== expected.periodMonth ||
      row.startsAt.getTime() !== expected.startsAt.getTime() ||
      row.endsAt.getTime() !== expected.endsAt.getTime()
    ) {
      throw new AccountingPeriodIntegrityError();
    }
  }
}
