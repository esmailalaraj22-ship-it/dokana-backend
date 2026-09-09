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
  parseSupplierInvoiceCancelCommand,
  parseSupplierInvoiceEditCommand,
  parseSupplierOpeningPayableCancelCommand,
  parseSupplierOpeningPayableEditCommand,
  type SupplierFinancialCorrectionCommand,
} from './supplier-invoice-correction-command';
import { SupplierInvoiceCorrectionRepository } from './supplier-invoice-correction.repository';
import type {
  SupplierCorrectionFailure,
  SupplierFinancialCorrectionResponse,
  SupplierFinancialCorrectionResult,
} from './supplier-invoice-correction.types';

type SupplierCorrectionPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class SupplierInvoiceCorrectionService {
  constructor(
    private readonly repository: SupplierInvoiceCorrectionRepository,
    private readonly operationalTime: OperationalTimeService,
  ) {}

  cancelInvoice(
    principal: SupplierCorrectionPrincipal,
    context: TenantTransactionContext,
    targetOperationId: string,
    body: unknown,
  ): Promise<SupplierFinancialCorrectionResponse> {
    return this.submit(
      principal,
      context,
      parseSupplierInvoiceCancelCommand(targetOperationId, body),
    );
  }

  editInvoice(
    principal: SupplierCorrectionPrincipal,
    context: TenantTransactionContext,
    targetOperationId: string,
    body: unknown,
  ): Promise<SupplierFinancialCorrectionResponse> {
    return this.submit(
      principal,
      context,
      parseSupplierInvoiceEditCommand(targetOperationId, body),
    );
  }

  cancelOpeningPayable(
    principal: SupplierCorrectionPrincipal,
    context: TenantTransactionContext,
    targetOperationId: string,
    body: unknown,
  ): Promise<SupplierFinancialCorrectionResponse> {
    return this.submit(
      principal,
      context,
      parseSupplierOpeningPayableCancelCommand(targetOperationId, body),
    );
  }

  editOpeningPayable(
    principal: SupplierCorrectionPrincipal,
    context: TenantTransactionContext,
    targetOperationId: string,
    body: unknown,
  ): Promise<SupplierFinancialCorrectionResponse> {
    return this.submit(
      principal,
      context,
      parseSupplierOpeningPayableEditCommand(targetOperationId, body),
    );
  }

  private async submit(
    principal: SupplierCorrectionPrincipal,
    context: TenantTransactionContext,
    command: SupplierFinancialCorrectionCommand,
  ): Promise<SupplierFinancialCorrectionResponse> {
    this.assertAuthorized(principal, context);
    const postingDate = this.resolvePostingDate(command.occurredAt);
    return this.unwrap(await this.repository.correct(context, command, postingDate));
  }

  private assertAuthorized(
    principal: SupplierCorrectionPrincipal,
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

  private unwrap(result: SupplierFinancialCorrectionResult): SupplierFinancialCorrectionResponse {
    if (result.ok) return result.response;
    this.throwFailure(result.error);
  }

  private throwFailure(error: SupplierCorrectionFailure): never {
    const body = { code: error.code, message: error.message };
    if (error.statusCode === 400) throw new BadRequestException(body);
    if (error.statusCode === 404) throw new NotFoundException(body);
    throw new ConflictException(body);
  }
}
