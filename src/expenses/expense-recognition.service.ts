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
import { parseExpenseRecognitionCommand } from './expense-recognition-command';
import { ExpenseRecognitionRepository } from './expense-recognition.repository';
import type {
  ExpenseRecognitionFailure,
  ExpenseRecognitionResponse,
} from './expense-recognition.types';

type Principal = Pick<AuthenticatedPrincipal, 'membershipRole' | 'storeId' | 'userId' | 'deviceId'>;

@Injectable()
export class ExpenseRecognitionService {
  constructor(
    private readonly repository: ExpenseRecognitionRepository,
    private readonly operationalTime: OperationalTimeService,
  ) {}

  async recognize(
    principal: Principal,
    context: TenantTransactionContext,
    body: unknown,
  ): Promise<ExpenseRecognitionResponse> {
    this.assertAuthorized(principal, context);
    const command = parseExpenseRecognitionCommand(body);
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

    const result = await this.repository.recognize(context, command, postingDate);
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

  private throwFailure(error: ExpenseRecognitionFailure): never {
    const body = { code: error.code, message: error.message };
    if (error.statusCode === 404) throw new NotFoundException(body);
    throw new ConflictException(body);
  }
}
