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
  parseSaleCancelCommand,
  parseSaleEditCommand,
  type SaleCorrectionCommand,
} from './sale-correction-command';
import { SaleCorrectionRepository } from './sale-correction.repository';
import type {
  SaleCorrectionFailure,
  SaleCorrectionResponse,
  SaleCorrectionResult,
} from './sale-correction.types';

type SaleCorrectionPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class SaleCorrectionService {
  constructor(
    private readonly repository: SaleCorrectionRepository,
    private readonly operationalTime: OperationalTimeService,
  ) {}

  cancel(
    principal: SaleCorrectionPrincipal,
    context: TenantTransactionContext,
    targetOperationId: string,
    body: unknown,
  ): Promise<SaleCorrectionResponse> {
    return this.submit(principal, context, parseSaleCancelCommand(targetOperationId, body));
  }

  edit(
    principal: SaleCorrectionPrincipal,
    context: TenantTransactionContext,
    targetOperationId: string,
    body: unknown,
  ): Promise<SaleCorrectionResponse> {
    return this.submit(principal, context, parseSaleEditCommand(targetOperationId, body));
  }

  private async submit(
    principal: SaleCorrectionPrincipal,
    context: TenantTransactionContext,
    command: SaleCorrectionCommand,
  ): Promise<SaleCorrectionResponse> {
    this.assertAuthorized(principal, context);
    const postingDate = this.resolvePostingDate(command.occurredAt);
    return this.unwrap(await this.repository.correct(context, command, postingDate));
  }

  private assertAuthorized(
    principal: SaleCorrectionPrincipal,
    context: TenantTransactionContext,
  ): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'SALE_WRITE_NOT_ALLOWED',
        message: 'Sale writes are not allowed.',
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

  private unwrap(result: SaleCorrectionResult): SaleCorrectionResponse {
    if (result.ok) return result.response;
    this.throwFailure(result.error);
  }

  private throwFailure(error: SaleCorrectionFailure): never {
    const body = { code: error.code, message: error.message };
    if (error.statusCode === 400) throw new BadRequestException(body);
    if (error.statusCode === 404) throw new NotFoundException(body);
    throw new ConflictException(body);
  }
}
