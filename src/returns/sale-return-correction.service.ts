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
  parseSaleReturnCancelCommand,
  parseSaleReturnReplaceCommand,
  type SaleReturnCorrectionCommand,
} from './sale-return-correction-command';
import { SaleReturnCorrectionRepository } from './sale-return-correction.repository';
import type {
  SaleReturnCorrectionFailure,
  SaleReturnCorrectionResponse,
  SaleReturnCorrectionResult,
} from './sale-return-correction.types';

type SaleReturnCorrectionPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class SaleReturnCorrectionService {
  constructor(
    private readonly repository: SaleReturnCorrectionRepository,
    private readonly operationalTime: OperationalTimeService,
  ) {}

  cancel(
    principal: SaleReturnCorrectionPrincipal,
    context: TenantTransactionContext,
    targetReturnId: string,
    body: unknown,
  ): Promise<SaleReturnCorrectionResponse> {
    return this.submit(principal, context, parseSaleReturnCancelCommand(targetReturnId, body));
  }

  replace(
    principal: SaleReturnCorrectionPrincipal,
    context: TenantTransactionContext,
    targetReturnId: string,
    body: unknown,
  ): Promise<SaleReturnCorrectionResponse> {
    return this.submit(principal, context, parseSaleReturnReplaceCommand(targetReturnId, body));
  }

  private async submit(
    principal: SaleReturnCorrectionPrincipal,
    context: TenantTransactionContext,
    command: SaleReturnCorrectionCommand,
  ): Promise<SaleReturnCorrectionResponse> {
    this.assertAuthorized(principal, context);
    const postingDate = this.resolvePostingDate(command.occurredAt);
    return this.unwrap(await this.repository.correct(context, command, postingDate));
  }

  private assertAuthorized(
    principal: SaleReturnCorrectionPrincipal,
    context: TenantTransactionContext,
  ): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'SALE_RETURN_WRITE_NOT_ALLOWED',
        message: 'Sale Return writes are not allowed.',
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

  private unwrap(result: SaleReturnCorrectionResult): SaleReturnCorrectionResponse {
    if (result.ok) return result.response;
    this.throwFailure(result.error);
  }

  private throwFailure(error: SaleReturnCorrectionFailure): never {
    const body = { code: error.code, message: error.message };
    if (error.statusCode === 400) throw new BadRequestException(body);
    if (error.statusCode === 404) throw new NotFoundException(body);
    throw new ConflictException(body);
  }
}
