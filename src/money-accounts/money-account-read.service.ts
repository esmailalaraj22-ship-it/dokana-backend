import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type { ListMoneyAccountsQueryDto } from './dto/list-money-accounts-query.dto';
import { canonicalizeMoneyAccountId } from './money-account-identifiers';
import { MoneyAccountReadRepository } from './money-account-read.repository';
import type {
  MoneyAccountListResponse,
  MoneyAccountReadRow,
  MoneyAccountResponse,
} from './money-account-read.types';

type MoneyAccountReadPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class MoneyAccountReadService {
  constructor(private readonly repository: MoneyAccountReadRepository) {}

  async list(
    principal: MoneyAccountReadPrincipal,
    context: TenantTransactionContext,
    query: ListMoneyAccountsQueryDto,
  ): Promise<MoneyAccountListResponse> {
    this.assertAuthorized(principal, context);
    const rows = await this.repository.list(context, { status: query.status ?? 'active' });
    return { items: rows.map((row) => this.mapResponse(row)) };
  }

  async getById(
    principal: MoneyAccountReadPrincipal,
    context: TenantTransactionContext,
    moneyAccountId: string,
  ): Promise<MoneyAccountResponse> {
    this.assertAuthorized(principal, context);
    const row = await this.repository.findById(context, canonicalizeMoneyAccountId(moneyAccountId));
    if (!row) {
      throw new NotFoundException({
        code: 'MONEY_ACCOUNT_NOT_FOUND',
        message: 'Money Account not found.',
      });
    }

    return this.mapResponse(row);
  }

  private assertAuthorized(
    principal: MoneyAccountReadPrincipal,
    context: TenantTransactionContext,
  ): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'MONEY_ACCOUNT_READ_NOT_ALLOWED',
        message: 'Money Account reads are not allowed.',
      });
    }
  }

  private mapResponse(row: MoneyAccountReadRow): MoneyAccountResponse {
    return {
      id: row.id,
      name: row.name,
      accountType: row.accountType,
      isDefault: row.isDefault,
      status: row.status,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: row.version.toString(),
    };
  }
}
