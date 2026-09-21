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
  parseCustomerFinancialCancelCommand,
  parseCustomerFinancialEditCommand,
  type CustomerFinancialCorrectionCommand,
  type CustomerFinancialCorrectionFamily,
} from './customer-financial-correction-command';
import { CustomerFinancialCorrectionRepository } from './customer-financial-correction.repository';
import type {
  CustomerFinancialCorrectionFailure,
  CustomerFinancialCorrectionResponse,
  CustomerFinancialCorrectionResult,
} from './customer-financial-correction.types';

type Principal = Pick<AuthenticatedPrincipal, 'membershipRole' | 'storeId' | 'userId' | 'deviceId'>;

@Injectable()
export class CustomerFinancialCorrectionService {
  constructor(
    private readonly repository: CustomerFinancialCorrectionRepository,
    private readonly operationalTime: OperationalTimeService,
  ) {}

  cancel(
    family: CustomerFinancialCorrectionFamily,
    principal: Principal,
    context: TenantTransactionContext,
    customerId: string,
    targetOperationId: string,
    body: unknown,
  ): Promise<CustomerFinancialCorrectionResponse> {
    return this.submit(
      principal,
      context,
      parseCustomerFinancialCancelCommand(family, customerId, targetOperationId, body),
    );
  }

  edit(
    family: CustomerFinancialCorrectionFamily,
    principal: Principal,
    context: TenantTransactionContext,
    customerId: string,
    targetOperationId: string,
    body: unknown,
  ): Promise<CustomerFinancialCorrectionResponse> {
    return this.submit(
      principal,
      context,
      parseCustomerFinancialEditCommand(family, customerId, targetOperationId, body),
    );
  }

  private async submit(
    principal: Principal,
    context: TenantTransactionContext,
    command: CustomerFinancialCorrectionCommand,
  ): Promise<CustomerFinancialCorrectionResponse> {
    this.assertAuthorized(principal, context);
    const postingDate = this.resolvePostingDate(command.occurredAt);
    return this.unwrap(await this.repository.correct(context, command, postingDate));
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

  private resolvePostingDate(occurredAt: Date): string {
    try {
      return this.operationalTime.resolve(occurredAt).businessDate;
    } catch (error) {
      if (error instanceof RangeError || error instanceof TypeError) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
        });
      }
      throw error;
    }
  }

  private unwrap(result: CustomerFinancialCorrectionResult): CustomerFinancialCorrectionResponse {
    if (result.ok) return result.response;
    this.throwFailure(result.error);
  }

  private throwFailure(error: CustomerFinancialCorrectionFailure): never {
    const body = { code: error.code, message: error.message };
    if (error.statusCode === 404) throw new NotFoundException(body);
    throw new ConflictException(body);
  }
}
