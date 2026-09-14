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
import { parseCustomerCollectionPostingCommand } from './customer-payment-posting-command';
import { CustomerPaymentPostingRepository } from './customer-payment-posting.repository';
import type {
  CustomerCollectionFailure,
  CustomerCollectionPostingResponse,
} from './customer-payment-posting.types';

type CustomerCollectionPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class CustomerPaymentPostingService {
  constructor(
    private readonly repository: CustomerPaymentPostingRepository,
    private readonly operationalTime: OperationalTimeService,
  ) {}

  async post(
    principal: CustomerCollectionPrincipal,
    context: TenantTransactionContext,
    customerId: string,
    body: unknown,
  ): Promise<CustomerCollectionPostingResponse> {
    this.assertAuthorized(principal, context);
    const command = parseCustomerCollectionPostingCommand(customerId, body);
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

  private assertAuthorized(
    principal: CustomerCollectionPrincipal,
    context: TenantTransactionContext,
  ): void {
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

  private throwFailure(error: CustomerCollectionFailure): never {
    const body = { code: error.code, message: error.message };
    if (error.statusCode === 404) throw new NotFoundException(body);
    throw new ConflictException(body);
  }
}
