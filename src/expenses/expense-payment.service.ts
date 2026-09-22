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
import { parseExpensePaymentCommand } from './expense-payment-command';
import { ExpensePaymentRepository } from './expense-payment.repository';
import type { ExpensePaymentFailure, ExpensePaymentPostingResponse } from './expense-payment.types';

type Principal = Pick<AuthenticatedPrincipal, 'membershipRole' | 'storeId' | 'userId' | 'deviceId'>;

@Injectable()
export class ExpensePaymentService {
  constructor(
    private readonly repository: ExpensePaymentRepository,
    private readonly operationalTime: OperationalTimeService,
  ) {}

  async post(
    principal: Principal,
    context: TenantTransactionContext,
    expenseId: string,
    body: unknown,
  ): Promise<ExpensePaymentPostingResponse> {
    this.assertAuthorized(principal, context);
    const command = parseExpensePaymentCommand(expenseId, body);
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

  private assertAuthorized(principal: Principal, context: TenantTransactionContext): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'EXPENSE_WRITE_NOT_ALLOWED',
        message: 'Expense writes are not allowed.',
      });
    }
  }

  private throwFailure(error: ExpensePaymentFailure): never {
    const body = { code: error.code, message: error.message };
    if (error.statusCode === 404) throw new NotFoundException(body);
    throw new ConflictException(body);
  }
}
