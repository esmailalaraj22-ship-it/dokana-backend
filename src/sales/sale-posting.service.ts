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
  parseCustomerOpeningReceivableCommand,
  parseSalePostingCommand,
} from './sale-posting-command';
import { SalePostingRepository } from './sale-posting.repository';
import type {
  CustomerOpeningReceivableResponse,
  CustomerOpeningReceivableResult,
  SalePostingFailure,
  SalePostingResponse,
  SalePostingResult,
} from './sale-posting.types';

type SalePostingPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class SalePostingService {
  constructor(
    private readonly repository: SalePostingRepository,
    private readonly operationalTime: OperationalTimeService,
  ) {}

  async postSale(
    principal: SalePostingPrincipal,
    context: TenantTransactionContext,
    body: unknown,
  ): Promise<SalePostingResponse> {
    this.assertAuthorized(principal, context);
    const command = parseSalePostingCommand(body);
    const postingDate = this.resolvePostingDate(command.occurredAt);
    return this.unwrapSale(await this.repository.postSale(context, command, postingDate));
  }

  async postOpeningReceivable(
    principal: SalePostingPrincipal,
    context: TenantTransactionContext,
    customerId: string,
    body: unknown,
  ): Promise<CustomerOpeningReceivableResponse> {
    this.assertAuthorized(principal, context);
    const command = parseCustomerOpeningReceivableCommand(customerId, body);
    const postingDate = this.resolvePostingDate(command.occurredAt);
    return this.unwrapOpening(
      await this.repository.postOpeningReceivable(context, command, postingDate),
    );
  }

  private assertAuthorized(
    principal: SalePostingPrincipal,
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

  private unwrapSale(result: SalePostingResult): SalePostingResponse {
    if (result.ok) return result.response;
    this.throwFailure(result.error);
  }

  private unwrapOpening(
    result: CustomerOpeningReceivableResult,
  ): CustomerOpeningReceivableResponse {
    if (result.ok) return result.response;
    this.throwFailure(result.error);
  }

  private throwFailure(error: SalePostingFailure): never {
    const body = { code: error.code, message: error.message };
    if (error.statusCode === 400) throw new BadRequestException(body);
    if (error.statusCode === 404) throw new NotFoundException(body);
    throw new ConflictException(body);
  }
}
