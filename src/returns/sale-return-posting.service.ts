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
import { parseSaleReturnCommand } from './sale-return-command';
import { SaleReturnPostingRepository } from './sale-return-posting.repository';
import type {
  SaleReturnPostingFailure,
  SaleReturnPostingResponse,
} from './sale-return-posting.types';

type Principal = Pick<AuthenticatedPrincipal, 'membershipRole' | 'storeId' | 'userId' | 'deviceId'>;

@Injectable()
export class SaleReturnPostingService {
  constructor(
    private readonly repository: SaleReturnPostingRepository,
    private readonly operationalTime: OperationalTimeService,
  ) {}

  async post(
    principal: Principal,
    context: TenantTransactionContext,
    saleId: string,
    body: unknown,
  ): Promise<SaleReturnPostingResponse> {
    this.assertAuthorized(principal, context);
    const command = parseSaleReturnCommand(saleId, body);
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
        code: 'SALE_RETURN_WRITE_NOT_ALLOWED',
        message: 'Sale Return writes are not allowed.',
      });
    }
  }

  private throwFailure(error: SaleReturnPostingFailure): never {
    const body = { code: error.code, message: error.message };
    if (error.statusCode === 400) throw new BadRequestException(body);
    if (error.statusCode === 404) throw new NotFoundException(body);
    throw new ConflictException(body);
  }
}
