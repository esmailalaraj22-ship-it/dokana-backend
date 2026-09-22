import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type { ListExpensesQueryDto } from './dto/expense-read.dto';
import {
  decodeExpenseCursor,
  encodeExpenseCursor,
  ExpenseReadQueryError,
} from './expense-read-cursor';
import { ExpenseReadRepository } from './expense-read.repository';
import type {
  ExpenseDetailResponse,
  ExpenseListResponse,
  ExpensePaymentHistoryResponse,
  ExpensePaymentReadRow,
  ExpenseReadItem,
  ExpenseReadRow,
} from './expense-read.types';
import { canonicalizeExpenseUuid, ExpenseValidationError } from './expense-validation';

type Principal = Pick<AuthenticatedPrincipal, 'membershipRole' | 'storeId' | 'userId' | 'deviceId'>;

@Injectable()
export class ExpenseReadService {
  constructor(private readonly repository: ExpenseReadRepository) {}

  async list(
    principal: Principal,
    context: TenantTransactionContext,
    query: ListExpensesQueryDto,
  ): Promise<ExpenseListResponse> {
    this.assertAuthorized(principal, context);
    try {
      const limit = query.limit ?? 50;
      const rows = await this.repository.list(context, {
        anchor: query.cursor === undefined ? null : decodeExpenseCursor(query.cursor),
        limit,
      });
      const hasNextPage = rows.length > limit;
      const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
      const last = pageRows.at(-1);
      return {
        items: pageRows.map((row) => this.mapExpense(row)),
        nextCursor:
          hasNextPage && last
            ? encodeExpenseCursor({ id: last.id, version: BigInt(last.version) })
            : null,
      };
    } catch (error) {
      if (error instanceof ExpenseReadQueryError) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
          details: [{ field: error.field, constraints: [error.constraint] }],
        });
      }
      throw error;
    }
  }

  async getById(
    principal: Principal,
    context: TenantTransactionContext,
    expenseIdInput: string,
  ): Promise<ExpenseDetailResponse> {
    this.assertAuthorized(principal, context);
    let expenseId: string;
    try {
      expenseId = canonicalizeExpenseUuid(expenseIdInput, 'expenseId');
    } catch (error) {
      if (error instanceof ExpenseValidationError) {
        throw new NotFoundException({ code: 'EXPENSE_NOT_FOUND', message: 'Expense not found.' });
      }
      throw error;
    }
    const record = await this.repository.findById(context, expenseId);
    if (!record) {
      throw new NotFoundException({ code: 'EXPENSE_NOT_FOUND', message: 'Expense not found.' });
    }
    return {
      ...this.mapExpense(record.expense),
      notes: record.expense.notes,
      payments: record.payments.map((payment) => this.mapPayment(payment)),
    };
  }

  async getPaymentHistory(
    principal: Principal,
    context: TenantTransactionContext,
    expenseIdInput: string,
  ): Promise<ExpensePaymentHistoryResponse> {
    const detail = await this.getById(principal, context, expenseIdInput);
    return {
      expenseId: detail.id,
      recognizedAmountMinor: detail.amountMinor,
      settledMinor: detail.paidMinor,
      outstandingMinor: detail.outstandingMinor,
      items: detail.payments,
    };
  }

  private mapExpense(row: ExpenseReadRow): ExpenseReadItem {
    const recognitionMode =
      row.paymentTiming === 'due_later'
        ? 'DUE'
        : row.recognitionPaymentSource === 'owner_pocket'
          ? 'OWNER_FUNDED'
          : 'MONEY_PAID';
    return {
      id: row.id,
      category:
        row.categoryId === null || row.categoryName === null || row.categoryStatus === null
          ? null
          : { id: row.categoryId, name: row.categoryName, status: row.categoryStatus },
      accountingPeriodId: row.accountingPeriodId,
      description: row.description,
      amountMinor: row.amountMinor,
      paidMinor: row.paidMinor,
      outstandingMinor: row.outstandingMinor,
      expenseAt: this.iso(row.expenseAt),
      dueAt: row.dueAt === null ? null : this.iso(row.dueAt),
      recognitionMode,
      recognitionFunding:
        row.paymentTiming === 'due_later' ||
        row.recognitionPaymentSource === null ||
        row.recognitionPaymentId === null
          ? null
          : {
              paymentId: row.recognitionPaymentId,
              source: row.recognitionPaymentSource,
              moneyAccountId: row.recognitionMoneyAccountId,
              moneyMovementId: row.recognitionMoneyMovementId,
              ownerLedgerEntryId: row.recognitionOwnerLedgerEntryId,
            },
      status: row.status,
      createdAt: this.iso(row.createdAt),
      updatedAt: this.iso(row.updatedAt),
      version: row.version,
    };
  }

  private mapPayment(row: ExpensePaymentReadRow) {
    if (row.transactionGroupId === null) {
      throw new Error('Expense Payment transaction lineage is unavailable.');
    }
    return {
      id: row.id,
      accountingPeriodId: row.accountingPeriodId,
      amountMinor: row.amountMinor,
      paymentSource: row.paymentSource,
      moneyAccountId: row.moneyAccountId,
      moneyAccount:
        row.moneyAccountId === null ||
        row.moneyAccountName === null ||
        row.moneyAccountStatus === null
          ? null
          : {
              id: row.moneyAccountId,
              name: row.moneyAccountName,
              status: row.moneyAccountStatus,
            },
      moneyMovementId: row.moneyMovementId,
      ownerLedgerEntryId: row.ownerLedgerEntryId,
      transactionGroupId: row.transactionGroupId,
      paymentAt: this.iso(row.paymentAt),
      notes: row.notes,
      status: row.status,
      operationId: row.operationId,
      createdAt: this.iso(row.createdAt),
      version: row.version,
    };
  }

  private assertAuthorized(principal: Principal, context: TenantTransactionContext): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'EXPENSE_READ_NOT_ALLOWED',
        message: 'Expense reads are not allowed.',
      });
    }
  }

  private iso(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }
}
