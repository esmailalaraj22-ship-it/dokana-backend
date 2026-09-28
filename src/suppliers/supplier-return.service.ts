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
  parseSupplierCreditApplicationCommand,
  parseSupplierFinancialCorrectionCommand,
  parseSupplierRefundCommand,
  parseSupplierReturnPostingCommand,
  type SupplierFinancialCorrectionCommand,
} from './supplier-return-command';
import { SupplierReturnRepository } from './supplier-return.repository';
import type {
  SupplierFinancialCorrectionResponse,
  SupplierFinancialFailure,
  SupplierFinancialMutationResponse,
  SupplierFinancialPostingResponse,
  SupplierFinancialReturnReadResponse,
} from './supplier-return.types';
import { canonicalizeSupplierUuid } from './supplier-validation';

type SupplierFinancialPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class SupplierReturnService {
  constructor(
    private readonly repository: SupplierReturnRepository,
    private readonly operationalTime: OperationalTimeService,
  ) {}

  postReturn(
    principal: SupplierFinancialPrincipal,
    context: TenantTransactionContext,
    supplierId: string,
    body: unknown,
  ): Promise<SupplierFinancialPostingResponse> {
    this.assertAuthorized(principal, context, true);
    const command = parseSupplierReturnPostingCommand(supplierId, body);
    return this.post(command, context);
  }

  applyCredit(
    principal: SupplierFinancialPrincipal,
    context: TenantTransactionContext,
    supplierId: string,
    body: unknown,
  ): Promise<SupplierFinancialPostingResponse> {
    this.assertAuthorized(principal, context, true);
    const command = parseSupplierCreditApplicationCommand(supplierId, body);
    return this.post(command, context);
  }

  recordRefund(
    principal: SupplierFinancialPrincipal,
    context: TenantTransactionContext,
    supplierId: string,
    body: unknown,
  ): Promise<SupplierFinancialPostingResponse> {
    this.assertAuthorized(principal, context, true);
    const command = parseSupplierRefundCommand(supplierId, body);
    return this.post(command, context);
  }

  correct(
    principal: SupplierFinancialPrincipal,
    context: TenantTransactionContext,
    family: SupplierFinancialCorrectionCommand['family'],
    kind: SupplierFinancialCorrectionCommand['kind'],
    targetOperationId: string,
    body: unknown,
  ): Promise<SupplierFinancialCorrectionResponse> {
    this.assertAuthorized(principal, context, true);
    const command = parseSupplierFinancialCorrectionCommand(family, kind, targetOperationId, body);
    return this.correctCommand(command, context);
  }

  read(
    principal: SupplierFinancialPrincipal,
    context: TenantTransactionContext,
    supplierId: string,
  ): Promise<SupplierFinancialReturnReadResponse> {
    this.assertAuthorized(principal, context, false);
    let canonicalSupplierId: string;
    try {
      canonicalSupplierId = canonicalizeSupplierUuid(supplierId, 'id');
    } catch {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
      });
    }
    return this.repository.read(context, canonicalSupplierId).then((response) => {
      if (!response) {
        throw new NotFoundException({
          code: 'SUPPLIER_NOT_FOUND',
          message: 'Supplier not found.',
        });
      }
      return response;
    });
  }

  private async post(
    command: Parameters<SupplierReturnRepository['post']>[1],
    context: TenantTransactionContext,
  ): Promise<SupplierFinancialPostingResponse> {
    const postingDate = this.resolvePostingDate(command.occurredAt);
    const result = await this.repository.post(context, command, postingDate);
    const response = this.unwrap(result);
    if ('intent' in response) {
      throw new Error('Supplier financial posting returned a correction response.');
    }
    return response;
  }

  private async correctCommand(
    command: SupplierFinancialCorrectionCommand,
    context: TenantTransactionContext,
  ): Promise<SupplierFinancialCorrectionResponse> {
    const postingDate = this.resolvePostingDate(command.occurredAt);
    const result = await this.repository.correct(context, command, postingDate);
    const response = this.unwrap(result);
    if (!('intent' in response)) {
      throw new Error('Supplier financial correction returned a posting response.');
    }
    return response;
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

  private unwrap(
    result: Awaited<ReturnType<SupplierReturnRepository['post']>>,
  ): SupplierFinancialMutationResponse {
    if (result.ok) return result.response;
    this.throwFailure(result.error);
  }

  private throwFailure(error: SupplierFinancialFailure): never {
    const body = { code: error.code, message: error.message };
    if (error.statusCode === 404) throw new NotFoundException(body);
    throw new ConflictException(body);
  }

  private assertAuthorized(
    principal: SupplierFinancialPrincipal,
    context: TenantTransactionContext,
    write: boolean,
  ): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: write ? 'SUPPLIER_FINANCIAL_WRITE_NOT_ALLOWED' : 'SUPPLIER_READ_NOT_ALLOWED',
        message: write
          ? 'Supplier financial writes are not allowed.'
          : 'Supplier reads are not allowed.',
      });
    }
  }
}
