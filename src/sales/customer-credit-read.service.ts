import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import {
  assertCustomerCreditHistoryCursorScope,
  customerCreditHistoryScopeHash,
  decodeCustomerCreditHistoryCursor,
  encodeCustomerCreditHistoryCursor,
} from './customer-credit-history-cursor';
import {
  CustomerCreditReadRepository,
  type CustomerCreditHistoryRow,
} from './customer-credit-read.repository';
import type {
  CustomerCreditHistoryEntryResponse,
  CustomerCreditHistoryResponse,
} from './customer-credit.types';
import type { ListCustomerCreditHistoryQueryDto } from './dto/list-customer-credit-history-query.dto';
import { SaleReadQueryError } from './sale-read-query-error';

type Principal = Pick<AuthenticatedPrincipal, 'membershipRole' | 'storeId' | 'userId' | 'deviceId'>;

@Injectable()
export class CustomerCreditReadService {
  constructor(private readonly repository: CustomerCreditReadRepository) {}

  async list(
    principal: Principal,
    context: TenantTransactionContext,
    customerIdInput: string,
    query: ListCustomerCreditHistoryQueryDto,
  ): Promise<CustomerCreditHistoryResponse> {
    this.assertAuthorized(principal, context);
    try {
      const customerId = this.canonicalUuid(customerIdInput);
      const limit = query.limit ?? 50;
      const cursor = query.cursor ? decodeCustomerCreditHistoryCursor(query.cursor) : null;
      if (cursor) assertCustomerCreditHistoryCursorScope(cursor, customerId);
      const result = await this.repository.read(context, customerId, cursor, limit);
      if (!result) {
        throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found.' });
      }
      const hasNextPage = result.entries.length > limit;
      const page = hasNextPage ? result.entries.slice(0, limit) : result.entries;
      const last = page.at(-1);
      return {
        customerId,
        customerStatus: result.customer.status,
        receivableOutstandingMinor: result.customer.receivableMinor,
        creditBalanceMinor: result.customer.creditMinor,
        entries: page.map((row) => this.mapEntry(row)),
        nextCursor:
          hasNextPage && last
            ? encodeCustomerCreditHistoryCursor({
                scopeHash: customerCreditHistoryScopeHash(customerId),
                anchor: { id: last.id, occurredAt: new Date(last.occurredAt).toISOString() },
              })
            : null,
      };
    } catch (error) {
      if (error instanceof SaleReadQueryError) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
          details: [{ field: error.field, constraints: [error.constraint] }],
        });
      }
      throw error;
    }
  }

  private mapEntry(row: CustomerCreditHistoryRow): CustomerCreditHistoryEntryResponse {
    const targetType =
      row.sourceSaleId !== null
        ? ('sale_receivable' as const)
        : row.referenceType === 'customer_opening_receivable'
          ? ('opening_receivable' as const)
          : null;
    const targetId =
      targetType === 'sale_receivable' ? row.sourceSaleId : targetType ? row.referenceId : null;
    if ((row.moneyAccountId === null) !== (row.moneyAccountName === null)) {
      throw new Error('Customer Credit refund account presentation is inconsistent.');
    }
    return {
      id: row.id,
      operationId: row.operationId,
      entryType: row.entryType,
      receivableDeltaMinor: row.receivableDeltaMinor,
      creditDeltaMinor: row.creditDeltaMinor,
      targetType,
      targetId,
      moneyAccount:
        row.moneyAccountId && row.moneyAccountName
          ? { id: row.moneyAccountId, name: row.moneyAccountName }
          : null,
      reason: row.reason,
      occurredAt: new Date(row.occurredAt).toISOString(),
      createdAt: new Date(row.createdAt).toISOString(),
    };
  }

  private assertAuthorized(principal: Principal, context: TenantTransactionContext): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'CUSTOMER_FINANCIAL_READ_NOT_ALLOWED',
        message: 'Customer financial reads are not allowed.',
      });
    }
  }

  private canonicalUuid(value: string): string {
    if (!isUUID(value)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
      });
    }
    return value.toLowerCase();
  }
}
