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
  parseSupplierInvoicePostingCommand,
  parseSupplierOpeningPayableCommand,
} from './supplier-invoice-posting-command';
import { SupplierInvoicePostingRepository } from './supplier-invoice-posting.repository';
import type {
  SupplierInvoicePostingResponse,
  SupplierInvoicePostingResult,
  SupplierOpeningPayableResponse,
  SupplierOpeningPayableResult,
  SupplierPostingFailure,
} from './supplier-invoice-posting.types';

type SupplierPostingPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class SupplierInvoicePostingService {
  constructor(
    private readonly repository: SupplierInvoicePostingRepository,
    private readonly operationalTime: OperationalTimeService,
  ) {}

  async postInvoice(
    principal: SupplierPostingPrincipal,
    context: TenantTransactionContext,
    supplierId: string,
    body: unknown,
  ): Promise<SupplierInvoicePostingResponse> {
    this.assertAuthorized(principal, context);
    const command = parseSupplierInvoicePostingCommand(supplierId, body);
    const postingDate = this.resolvePostingDate(command.occurredAt);
    return this.unwrapInvoice(await this.repository.postInvoice(context, command, postingDate));
  }

  async postOpeningPayable(
    principal: SupplierPostingPrincipal,
    context: TenantTransactionContext,
    supplierId: string,
    body: unknown,
  ): Promise<SupplierOpeningPayableResponse> {
    this.assertAuthorized(principal, context);
    const command = parseSupplierOpeningPayableCommand(supplierId, body);
    const postingDate = this.resolvePostingDate(command.occurredAt);
    return this.unwrapOpening(
      await this.repository.postOpeningPayable(context, command, postingDate),
    );
  }

  private assertAuthorized(
    principal: SupplierPostingPrincipal,
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

  private resolvePostingDate(occurredAt: Date): string {
    try {
      return this.operationalTime.resolve(occurredAt).businessDate;
    } catch (error) {
      if (error instanceof RangeError) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
        });
      }
      throw error;
    }
  }

  private unwrapInvoice(result: SupplierInvoicePostingResult): SupplierInvoicePostingResponse {
    if (result.ok) return result.response;
    this.throwFailure(result.error);
  }

  private unwrapOpening(result: SupplierOpeningPayableResult): SupplierOpeningPayableResponse {
    if (result.ok) return result.response;
    this.throwFailure(result.error);
  }

  private throwFailure(error: SupplierPostingFailure): never {
    const body = { code: error.code, message: error.message };
    if (error.statusCode === 400) throw new BadRequestException(body);
    if (error.statusCode === 404) throw new NotFoundException(body);
    throw new ConflictException(body);
  }
}
