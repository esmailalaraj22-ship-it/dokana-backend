import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import { OperationalTimeService } from '../settings/operational-time.service';
import {
  assertCustomerPaymentCursorScope,
  customerPaymentCursorScopeHash,
  decodeCustomerPaymentCursor,
  encodeCustomerPaymentCursor,
} from './customer-payment-read-cursor';
import { CustomerPaymentReadRepository } from './customer-payment-read.repository';
import type {
  CustomerPaymentAllocationResponse,
  CustomerPaymentAllocationRow,
  CustomerPaymentCustomerResponse,
  CustomerPaymentCustomerRow,
  CustomerPaymentDetailResponse,
  CustomerPaymentListResponse,
  CustomerPaymentListRow,
  CustomerPaymentSummaryResponse,
} from './customer-payment-read.types';
import type { ListCustomerPaymentsQueryDto } from './dto/list-customer-payments-query.dto';
import { SaleReadQueryError } from './sale-read-query-error';

type CustomerPaymentReadPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class CustomerPaymentReadService {
  constructor(
    private readonly repository: CustomerPaymentReadRepository,
    private readonly operationalTime: OperationalTimeService,
  ) {}

  async list(
    principal: CustomerPaymentReadPrincipal,
    context: TenantTransactionContext,
    customerIdInput: string,
    query: ListCustomerPaymentsQueryDto,
  ): Promise<CustomerPaymentListResponse> {
    this.assertAuthorized(principal, context);
    try {
      const customerId = this.canonicalUuid(customerIdInput, 'customerId');
      const limit = query.limit ?? 50;
      const cursor = query.cursor ? decodeCustomerPaymentCursor(query.cursor) : null;
      if (cursor) assertCustomerPaymentCursorScope(cursor, customerId);
      const result = await this.repository.readPage(context, customerId, {
        anchor: cursor?.anchor ?? null,
        limit,
      });
      if (!result) throw this.customerNotFound();
      const hasNextPage = result.payments.length > limit;
      const page = hasNextPage ? result.payments.slice(0, limit) : result.payments;
      const last = page.at(-1);
      return {
        customer: this.mapCustomer(result.customer),
        outstandingMinor: result.customer.outstandingMinor.toString(),
        creditBalanceMinor: result.customer.creditBalanceMinor.toString(),
        payments: page.map((payment) => this.mapPayment(payment)),
        nextCursor:
          hasNextPage && last
            ? encodeCustomerPaymentCursor({
                scopeHash: customerPaymentCursorScopeHash(customerId),
                anchor: { id: last.id, version: last.version },
              })
            : null,
      };
    } catch (error) {
      if (error instanceof SaleReadQueryError) {
        throw this.validationException(error.field, error.constraint);
      }
      throw error;
    }
  }

  async getById(
    principal: CustomerPaymentReadPrincipal,
    context: TenantTransactionContext,
    customerIdInput: string,
    paymentIdInput: string,
  ): Promise<CustomerPaymentDetailResponse> {
    this.assertAuthorized(principal, context);
    const customerId = this.canonicalUuid(customerIdInput, 'customerId');
    const paymentId = this.canonicalUuid(paymentIdInput, 'paymentId');
    const result = await this.repository.findById(context, customerId, paymentId);
    if (!result) {
      throw new NotFoundException({
        code: 'CUSTOMER_PAYMENT_NOT_FOUND',
        message: 'Customer Payment not found.',
      });
    }
    return {
      customer: this.mapCustomer(result.customer),
      outstandingMinor: result.customer.outstandingMinor.toString(),
      creditBalanceMinor: result.customer.creditBalanceMinor.toString(),
      payment: this.mapPayment(result),
      allocations: result.allocations.map((allocation) => this.mapAllocation(allocation)),
    };
  }

  private assertAuthorized(
    principal: CustomerPaymentReadPrincipal,
    context: TenantTransactionContext,
  ): void {
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

  private mapCustomer(row: CustomerPaymentCustomerRow): CustomerPaymentCustomerResponse {
    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      status: row.status,
      archivedAt: row.archivedAt?.toISOString() ?? null,
    };
  }

  private mapPayment(row: CustomerPaymentListRow): CustomerPaymentSummaryResponse {
    const businessDate = this.operationalTime.resolve(row.paymentAt).businessDate;
    return {
      id: row.id,
      operationId: row.operationId,
      collectionId: row.collectionId,
      customerId: row.customerId,
      accountingPeriodId: row.accountingPeriodId,
      amountMinor: row.amountMinor.toString(),
      allocatedTotalMinor: row.allocatedTotalMinor.toString(),
      creditCreatedMinor: row.creditCreatedMinor.toString(),
      occurredAt: row.paymentAt.toISOString(),
      businessDate,
      postingDate: businessDate,
      senderAccountName: row.senderAccountName,
      externalReference: row.externalReference,
      notes: row.notes,
      status: row.status,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      moneyAccount: row.moneyAccount,
      moneyMovementId: row.moneyMovementId,
      allocationCount: row.allocationCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: row.version.toString(),
    };
  }

  private mapAllocation(row: CustomerPaymentAllocationRow): CustomerPaymentAllocationResponse {
    const target =
      row.targetType === 'sale_receivable' && row.saleDisplayNumber !== null
        ? {
            type: 'SALE_RECEIVABLE' as const,
            id: row.targetId,
            displayNumber: row.saleDisplayNumber,
            occurredAt: row.originOccurredAt.toISOString(),
          }
        : row.targetType === 'opening_receivable' && row.openingAmountMinor !== null
          ? {
              type: 'OPENING_RECEIVABLE' as const,
              id: row.targetId,
              originalAmountMinor: row.openingAmountMinor.toString(),
              occurredAt: row.originOccurredAt.toISOString(),
            }
          : null;
    if (!target) throw new Error('Customer Payment allocation presentation is inconsistent.');
    return {
      id: row.id,
      target,
      amountMinor: row.amountMinor.toString(),
      paymentEffect: {
        id: row.customerLedgerEntryId,
        operationId: row.paymentEffectOperationId,
        receivableDeltaMinor: row.paymentEffectReceivableDeltaMinor.toString(),
      },
      createdAt: row.createdAt.toISOString(),
    };
  }

  private canonicalUuid(value: string, field: string): string {
    if (!isUUID(value)) throw this.validationException(field, 'isUuid');
    return value.toLowerCase();
  }

  private customerNotFound(): NotFoundException {
    return new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found.' });
  }

  private validationException(field: string, constraint: string): BadRequestException {
    return new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed.',
      details: [{ field, constraints: [constraint] }],
    });
  }
}
