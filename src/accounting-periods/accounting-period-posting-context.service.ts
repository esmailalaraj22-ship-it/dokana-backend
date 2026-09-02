import { Injectable } from '@nestjs/common';

import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { parseAccountingPostingDate } from './accounting-posting-date';
import { deriveAccountingPeriodId } from './accounting-period-identity';
import { AccountingPeriodPostingContextRepository } from './accounting-period-posting-context.repository';
import type {
  AccountingPeriodPostingContext,
  ResolveAccountingPeriodPostingContextInput,
} from './accounting-period-posting-context.types';
import {
  AccountingPeriodIntegrityError,
  AccountingPeriodProvisioningService,
} from './accounting-period-provisioning.service';
import type { AccountingPeriodStatus } from './accounting-period.types';

export class AccountingPeriodNotPostingEligibleError extends Error {
  readonly code = 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE';

  constructor(readonly periodStatus: AccountingPeriodStatus) {
    super('Accounting Period is not eligible for posting.');
    this.name = 'AccountingPeriodNotPostingEligibleError';
  }
}

@Injectable()
export class AccountingPeriodPostingContextService {
  constructor(
    private readonly repository: AccountingPeriodPostingContextRepository,
    private readonly provisioning: AccountingPeriodProvisioningService,
  ) {}

  async resolveForWrite(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: ResolveAccountingPeriodPostingContextInput,
  ): Promise<AccountingPeriodPostingContext> {
    const postingDate = parseAccountingPostingDate(input.postingDate);
    const accountingPeriodId = deriveAccountingPeriodId(
      context.storeId,
      postingDate.periodYear,
      postingDate.periodMonth,
    );

    await this.repository.assertActiveStoreForPosting(transaction, context.storeId);
    await this.provisioning.ensureMonthlyAccountingPeriod(transaction, context, {
      periodYear: postingDate.periodYear,
      periodMonth: postingDate.periodMonth,
      operationId: input.operationId,
    });

    const lockedPeriod = await this.repository.lockCanonicalPeriod(
      transaction,
      context.storeId,
      accountingPeriodId,
    );
    if (!lockedPeriod) {
      throw new AccountingPeriodIntegrityError();
    }

    this.provisioning.assertCanonicalExistingRow(lockedPeriod, context.storeId);
    if (lockedPeriod.status !== 'open') {
      throw new AccountingPeriodNotPostingEligibleError(lockedPeriod.status);
    }

    return {
      storeId: context.storeId,
      postingDate: postingDate.value,
      accountingPeriodId,
      periodYear: postingDate.periodYear,
      periodMonth: postingDate.periodMonth,
    };
  }
}
