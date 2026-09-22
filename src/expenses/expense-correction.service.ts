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
  parseExpenseCancelCommand,
  parseExpenseEditCommand,
  parseExpensePaymentCancelCommand,
  parseExpensePaymentEditCommand,
  type ExpensePaymentCorrectionCommand,
  type ExpenseRecognitionCorrectionCommand,
} from './expense-correction-command';
import { ExpenseCorrectionRepository } from './expense-correction.repository';
import type {
  ExpenseCorrectionFailure,
  ExpenseCorrectionResponse,
  ExpenseCorrectionResult,
} from './expense-correction.types';

type Principal = Pick<AuthenticatedPrincipal, 'membershipRole' | 'storeId' | 'userId' | 'deviceId'>;

@Injectable()
export class ExpenseCorrectionService {
  constructor(
    private readonly repository: ExpenseCorrectionRepository,
    private readonly operationalTime: OperationalTimeService,
  ) {}

  cancelExpense(
    principal: Principal,
    context: TenantTransactionContext,
    targetOperationId: string,
    body: unknown,
  ): Promise<ExpenseCorrectionResponse> {
    return this.submitExpense(
      principal,
      context,
      parseExpenseCancelCommand(targetOperationId, body),
    );
  }

  editExpense(
    principal: Principal,
    context: TenantTransactionContext,
    targetOperationId: string,
    body: unknown,
  ): Promise<ExpenseCorrectionResponse> {
    return this.submitExpense(principal, context, parseExpenseEditCommand(targetOperationId, body));
  }

  cancelPayment(
    principal: Principal,
    context: TenantTransactionContext,
    targetOperationId: string,
    body: unknown,
  ): Promise<ExpenseCorrectionResponse> {
    return this.submitPayment(
      principal,
      context,
      parseExpensePaymentCancelCommand(targetOperationId, body),
    );
  }

  editPayment(
    principal: Principal,
    context: TenantTransactionContext,
    targetOperationId: string,
    body: unknown,
  ): Promise<ExpenseCorrectionResponse> {
    return this.submitPayment(
      principal,
      context,
      parseExpensePaymentEditCommand(targetOperationId, body),
    );
  }

  private async submitExpense(
    principal: Principal,
    context: TenantTransactionContext,
    command: ExpenseRecognitionCorrectionCommand,
  ): Promise<ExpenseCorrectionResponse> {
    this.assertAuthorized(principal, context);
    const result = await this.repository.correctExpense(
      context,
      command,
      this.resolvePostingDate(command.occurredAt),
      command.kind === 'edit' ? this.resolvePostingDate(command.replacement.occurredAt) : null,
    );
    return this.unwrap(result);
  }

  private async submitPayment(
    principal: Principal,
    context: TenantTransactionContext,
    command: ExpensePaymentCorrectionCommand,
  ): Promise<ExpenseCorrectionResponse> {
    this.assertAuthorized(principal, context);
    const result = await this.repository.correctPayment(
      context,
      command,
      this.resolvePostingDate(command.occurredAt),
      command.kind === 'edit' ? this.resolvePostingDate(command.replacement.occurredAt) : null,
    );
    return this.unwrap(result);
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

  private unwrap(result: ExpenseCorrectionResult): ExpenseCorrectionResponse {
    if (result.ok) return result.response;
    this.throwFailure(result.error);
  }

  private throwFailure(error: ExpenseCorrectionFailure): never {
    const body = { code: error.code, message: error.message };
    if (error.statusCode === 404) throw new NotFoundException(body);
    throw new ConflictException(body);
  }
}
