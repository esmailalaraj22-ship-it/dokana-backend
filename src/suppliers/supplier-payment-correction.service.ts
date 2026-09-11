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
  parseSupplierPaymentCancelCommand,
  parseSupplierPaymentEditCommand,
  type SupplierPaymentCorrectionCommand,
} from './supplier-payment-correction-command';
import { SupplierPaymentCorrectionRepository } from './supplier-payment-correction.repository';
import type {
  SupplierPaymentCorrectionFailure,
  SupplierPaymentCorrectionResponse,
  SupplierPaymentCorrectionResult,
} from './supplier-payment-correction.types';

type SupplierPaymentCorrectionPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class SupplierPaymentCorrectionService {
  constructor(
    private readonly repository: SupplierPaymentCorrectionRepository,
    private readonly operationalTime: OperationalTimeService,
  ) {}

  cancel(
    principal: SupplierPaymentCorrectionPrincipal,
    context: TenantTransactionContext,
    targetOperationId: string,
    body: unknown,
  ): Promise<SupplierPaymentCorrectionResponse> {
    return this.submit(
      principal,
      context,
      parseSupplierPaymentCancelCommand(targetOperationId, body),
    );
  }

  edit(
    principal: SupplierPaymentCorrectionPrincipal,
    context: TenantTransactionContext,
    targetOperationId: string,
    body: unknown,
  ): Promise<SupplierPaymentCorrectionResponse> {
    return this.submit(
      principal,
      context,
      parseSupplierPaymentEditCommand(targetOperationId, body),
    );
  }

  private async submit(
    principal: SupplierPaymentCorrectionPrincipal,
    context: TenantTransactionContext,
    command: SupplierPaymentCorrectionCommand,
  ): Promise<SupplierPaymentCorrectionResponse> {
    this.assertAuthorized(principal, context);
    const postingDate = this.resolvePostingDate(command.occurredAt);
    const replacementPostingDate =
      command.kind === 'edit' ? this.resolvePostingDate(command.replacement.occurredAt) : null;
    return this.unwrap(
      await this.repository.correct(context, command, postingDate, replacementPostingDate),
    );
  }

  private assertAuthorized(
    principal: SupplierPaymentCorrectionPrincipal,
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

  private unwrap(result: SupplierPaymentCorrectionResult): SupplierPaymentCorrectionResponse {
    if (result.ok) return result.response;
    this.throwFailure(result.error);
  }

  private throwFailure(error: SupplierPaymentCorrectionFailure): never {
    const body = { code: error.code, message: error.message };
    if (error.statusCode === 404) throw new NotFoundException(body);
    throw new ConflictException(body);
  }
}
