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
import { parseSupplierPaymentPostingCommand } from './supplier-payment-posting-command';
import { SupplierPaymentPostingRepository } from './supplier-payment-posting.repository';
import type {
  SupplierPaymentFailure,
  SupplierPaymentPostingResponse,
} from './supplier-payment-posting.types';

type SupplierPaymentPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class SupplierPaymentPostingService {
  constructor(
    private readonly repository: SupplierPaymentPostingRepository,
    private readonly operationalTime: OperationalTimeService,
  ) {}

  async post(
    principal: SupplierPaymentPrincipal,
    context: TenantTransactionContext,
    supplierId: string,
    body: unknown,
  ): Promise<SupplierPaymentPostingResponse> {
    this.assertAuthorized(principal, context);
    const command = parseSupplierPaymentPostingCommand(supplierId, body);
    let postingDate: string;
    try {
      postingDate = this.operationalTime.resolve(command.occurredAt).businessDate;
    } catch (error) {
      if (error instanceof RangeError) {
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
    principal: SupplierPaymentPrincipal,
    context: TenantTransactionContext,
  ): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'SUPPLIER_FINANCIAL_WRITE_NOT_ALLOWED',
        message: 'Supplier financial writes are not allowed.',
      });
    }
  }

  private throwFailure(error: SupplierPaymentFailure): never {
    const body = { code: error.code, message: error.message };
    if (error.statusCode === 404) throw new NotFoundException(body);
    throw new ConflictException(body);
  }
}
