import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import type { TenantTransactionContext } from '../database/database.types';
import {
  customerCursorMatchesScope,
  decodeCustomerCursor,
  encodeCustomerCursor,
} from './customer-read-cursor';
import { CustomerReadQueryError, prepareCustomerSearchScope } from './customer-read-query';
import { CustomerReadRepository } from './customer-read.repository';
import type {
  CustomerDetailResponse,
  CustomerDetailRow,
  CustomerListItemResponse,
  CustomerListResponse,
  CustomerListRow,
  CustomerStatus,
} from './customer-read.types';
import type { ListCustomersQueryDto } from './dto/list-customers-query.dto';

@Injectable()
export class CustomerReadService {
  constructor(private readonly repository: CustomerReadRepository) {}

  async list(
    context: TenantTransactionContext,
    query: ListCustomersQueryDto,
  ): Promise<CustomerListResponse> {
    try {
      const status: CustomerStatus = query.status ?? 'active';
      const limit = query.limit ?? 50;
      const search = prepareCustomerSearchScope(query.search);
      const cursor = query.cursor ? decodeCustomerCursor(query.cursor) : null;

      if (cursor && !customerCursorMatchesScope(cursor, status, search)) {
        throw new CustomerReadQueryError('cursor', 'customerCursorScope');
      }

      const rows = await this.repository.list(context, {
        status,
        search,
        position: cursor?.position ?? null,
        limit,
      });
      const hasNextPage = rows.length > limit;
      const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
      const lastRow = pageRows.at(-1);
      const nextCursor =
        hasNextPage && lastRow
          ? encodeCustomerCursor({
              status,
              search,
              position: {
                normalizedName: lastRow.normalizedName,
                id: lastRow.id,
              },
            })
          : null;

      return {
        items: pageRows.map((row) => this.mapListItem(row)),
        nextCursor,
      };
    } catch (error) {
      if (error instanceof CustomerReadQueryError) {
        throw this.validationException(error.field, error.constraint);
      }
      throw error;
    }
  }

  async getById(
    context: TenantTransactionContext,
    customerId: string,
  ): Promise<CustomerDetailResponse> {
    const row = await this.repository.findById(context, customerId);
    if (!row) {
      throw new NotFoundException({
        code: 'CUSTOMER_NOT_FOUND',
        message: 'Customer not found.',
      });
    }

    return this.mapDetail(row);
  }

  private mapListItem(row: CustomerListRow): CustomerListItemResponse {
    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      status: row.status,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private mapDetail(row: CustomerDetailRow): CustomerDetailResponse {
    return {
      ...this.mapListItem(row),
      notes: row.notes,
      createdAt: row.createdAt.toISOString(),
      version: row.version.toString(),
    };
  }

  private validationException(field: string, constraint: string): BadRequestException {
    return new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed.',
      details: [{ field, constraints: [constraint] }],
    });
  }
}
