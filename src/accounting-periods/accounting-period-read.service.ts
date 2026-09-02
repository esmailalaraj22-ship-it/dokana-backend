import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import { canonicalizeAccountingPeriodId } from './accounting-period-identity';
import { AccountingPeriodReadRepository } from './accounting-period-read.repository';
import type {
  AccountingPeriodListResponse,
  AccountingPeriodReadRow,
  AccountingPeriodResponse,
} from './accounting-period-read.types';

type AccountingPeriodReadPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class AccountingPeriodReadService {
  constructor(private readonly repository: AccountingPeriodReadRepository) {}

  async list(
    principal: AccountingPeriodReadPrincipal,
    context: TenantTransactionContext,
  ): Promise<AccountingPeriodListResponse> {
    this.assertAuthorized(principal, context);
    const rows = await this.repository.list(context);
    return { items: rows.map((row) => this.mapResponse(row)) };
  }

  async getById(
    principal: AccountingPeriodReadPrincipal,
    context: TenantTransactionContext,
    accountingPeriodId: string,
  ): Promise<AccountingPeriodResponse> {
    this.assertAuthorized(principal, context);
    const row = await this.repository.findById(
      context,
      canonicalizeAccountingPeriodId(accountingPeriodId),
    );
    if (!row) {
      throw new NotFoundException({
        code: 'ACCOUNTING_PERIOD_NOT_FOUND',
        message: 'Accounting Period not found.',
      });
    }

    return this.mapResponse(row);
  }

  private assertAuthorized(
    principal: AccountingPeriodReadPrincipal,
    context: TenantTransactionContext,
  ): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'ACCOUNTING_PERIOD_READ_NOT_ALLOWED',
        message: 'Accounting Period reads are not allowed.',
      });
    }
  }

  private mapResponse(row: AccountingPeriodReadRow): AccountingPeriodResponse {
    return {
      id: row.id,
      periodYear: row.periodYear,
      periodMonth: row.periodMonth,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      status: row.status,
      closedAt: row.closedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: row.version.toString(),
    };
  }
}
