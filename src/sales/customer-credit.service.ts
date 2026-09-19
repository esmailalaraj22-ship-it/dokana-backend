import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import { OperationalTimeService } from '../settings/operational-time.service';
import {
  parseApplyCustomerCreditCommand,
  parseRefundCustomerCreditCommand,
  parseSettleCustomerReceivableCommand,
  type CustomerFinancialCommand,
} from './customer-credit-command';
import { CustomerCreditRepository } from './customer-credit.repository';
import type { CustomerFinancialFailure, CustomerFinancialResponse } from './customer-credit.types';

type Principal = Pick<AuthenticatedPrincipal, 'membershipRole' | 'storeId' | 'userId' | 'deviceId'>;

@Injectable()
export class CustomerCreditService {
  constructor(
    private readonly repository: CustomerCreditRepository,
    private readonly operationalTime: OperationalTimeService,
  ) {}

  apply(
    principal: Principal,
    context: TenantTransactionContext,
    customerId: string,
    body: unknown,
  ): Promise<CustomerFinancialResponse> {
    return this.post(principal, context, parseApplyCustomerCreditCommand(customerId, body));
  }

  refund(
    principal: Principal,
    context: TenantTransactionContext,
    customerId: string,
    body: unknown,
  ): Promise<CustomerFinancialResponse> {
    return this.post(principal, context, parseRefundCustomerCreditCommand(customerId, body));
  }

  settle(
    principal: Principal,
    context: TenantTransactionContext,
    customerId: string,
    body: unknown,
  ): Promise<CustomerFinancialResponse> {
    return this.post(principal, context, parseSettleCustomerReceivableCommand(customerId, body));
  }

  private async post(
    principal: Principal,
    context: TenantTransactionContext,
    command: CustomerFinancialCommand,
  ): Promise<CustomerFinancialResponse> {
    this.assertAuthorized(principal, context);
    let postingDate: string;
    try {
      postingDate = this.operationalTime.resolve(command.occurredAt).businessDate;
    } catch (error) {
      if (error instanceof RangeError || error instanceof TypeError) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
        });
      }
      throw error;
    }
    const result = await this.repository.post(context, command, postingDate);
    if (result.ok) return result.response;
    this.throwFailure(result.error);
  }

  private assertAuthorized(principal: Principal, context: TenantTransactionContext): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'CUSTOMER_FINANCIAL_WRITE_NOT_ALLOWED',
        message: 'Customer financial writes are not allowed.',
      });
    }
  }

  private throwFailure(error: CustomerFinancialFailure): never {
    const body = { code: error.code, message: error.message };
    if (error.statusCode === 404) throw new NotFoundException(body);
    throw new ConflictException(body);
  }
}
