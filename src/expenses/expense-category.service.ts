import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type {
  CreateExpenseCategoryDto,
  ExpenseCategoryLifecycleDto,
  ListExpenseCategoriesQueryDto,
  UpdateExpenseCategoryDto,
} from './dto/expense-category.dto';
import { ExpenseCategoryRepository } from './expense-category.repository';
import { mapExpenseCategory } from './expense-category-response';
import type {
  ExpenseCategoryMutationFailure,
  ExpenseCategoryMutationResponse,
  ExpenseCategoryResponse,
  PreparedExpenseCategoryMutation,
} from './expense-category.types';
import {
  canonicalizeExpenseCategoryName,
  canonicalizeExpenseUuid,
  ExpenseValidationError,
} from './expense-validation';

type Principal = Pick<AuthenticatedPrincipal, 'membershipRole' | 'storeId' | 'userId' | 'deviceId'>;

const maximumBigint = 9_223_372_036_854_775_807n;

@Injectable()
export class ExpenseCategoryService {
  constructor(private readonly repository: ExpenseCategoryRepository) {}

  async list(
    principal: Principal,
    context: TenantTransactionContext,
    query: ListExpenseCategoriesQueryDto,
  ): Promise<{ items: ExpenseCategoryResponse[] }> {
    this.assertAuthorized(principal, context, false);
    const rows = await this.repository.list(context, query.status ?? 'active');
    return { items: rows.map(mapExpenseCategory) };
  }

  async getById(
    principal: Principal,
    context: TenantTransactionContext,
    categoryIdInput: string,
  ): Promise<ExpenseCategoryResponse> {
    this.assertAuthorized(principal, context, false);
    const categoryId = this.uuid(categoryIdInput, 'expenseCategoryId');
    const row = await this.repository.findById(context, categoryId);
    if (!row)
      this.throwFailure({
        code: 'EXPENSE_CATEGORY_NOT_FOUND',
        message: 'Expense Category not found.',
        statusCode: 404,
      });
    return mapExpenseCategory(row);
  }

  create(
    principal: Principal,
    context: TenantTransactionContext,
    dto: CreateExpenseCategoryDto,
  ): Promise<ExpenseCategoryMutationResponse> {
    this.assertAuthorized(principal, context, true);
    const categoryId = this.uuid(dto.id, 'id');
    const operationId = this.uuid(dto.operationId, 'operationId');
    const name = this.name(dto.name);
    return this.mutate(context, {
      action: 'create',
      categoryId,
      operationId,
      ...name,
      requestHash: this.hash({ v: 1, action: 'create', categoryId, ...name }),
    });
  }

  update(
    principal: Principal,
    context: TenantTransactionContext,
    categoryIdInput: string,
    dto: UpdateExpenseCategoryDto,
  ): Promise<ExpenseCategoryMutationResponse> {
    this.assertAuthorized(principal, context, true);
    const categoryId = this.uuid(categoryIdInput, 'expenseCategoryId');
    const operationId = this.uuid(dto.operationId, 'operationId');
    const expectedVersion = this.version(dto.expectedVersion);
    const name = this.name(dto.name);
    return this.mutate(context, {
      action: 'update',
      categoryId,
      operationId,
      expectedVersion,
      ...name,
      requestHash: this.hash({
        v: 1,
        action: 'update',
        categoryId,
        expectedVersion: expectedVersion.toString(),
        ...name,
      }),
    });
  }

  archive(
    principal: Principal,
    context: TenantTransactionContext,
    categoryId: string,
    dto: ExpenseCategoryLifecycleDto,
  ): Promise<ExpenseCategoryMutationResponse> {
    return this.lifecycle(principal, context, categoryId, dto, 'archive');
  }

  restore(
    principal: Principal,
    context: TenantTransactionContext,
    categoryId: string,
    dto: ExpenseCategoryLifecycleDto,
  ): Promise<ExpenseCategoryMutationResponse> {
    return this.lifecycle(principal, context, categoryId, dto, 'restore');
  }

  private lifecycle(
    principal: Principal,
    context: TenantTransactionContext,
    categoryIdInput: string,
    dto: ExpenseCategoryLifecycleDto,
    action: 'archive' | 'restore',
  ): Promise<ExpenseCategoryMutationResponse> {
    this.assertAuthorized(principal, context, true);
    const categoryId = this.uuid(categoryIdInput, 'expenseCategoryId');
    const operationId = this.uuid(dto.operationId, 'operationId');
    const expectedVersion = this.version(dto.expectedVersion);
    return this.mutate(context, {
      action,
      categoryId,
      operationId,
      expectedVersion,
      requestHash: this.hash({
        v: 1,
        action,
        categoryId,
        expectedVersion: expectedVersion.toString(),
      }),
    });
  }

  private async mutate(
    context: TenantTransactionContext,
    input: PreparedExpenseCategoryMutation,
  ): Promise<ExpenseCategoryMutationResponse> {
    const result = await this.repository.mutate(context, input);
    if (result.ok) return result.response;
    this.throwFailure(result.error);
  }

  private assertAuthorized(
    principal: Principal,
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
        code: write ? 'EXPENSE_CATEGORY_WRITE_NOT_ALLOWED' : 'EXPENSE_CATEGORY_READ_NOT_ALLOWED',
        message: `Expense Category ${write ? 'writes' : 'reads'} are not allowed.`,
      });
    }
  }

  private uuid(value: unknown, field: 'id' | 'expenseCategoryId' | 'operationId'): string {
    try {
      return canonicalizeExpenseUuid(value, field);
    } catch (error) {
      this.rethrowValidation(error);
    }
  }

  private name(value: unknown): { name: string; normalizedName: string } {
    try {
      return canonicalizeExpenseCategoryName(value);
    } catch (error) {
      this.rethrowValidation(error);
    }
  }

  private version(value: string): bigint {
    const parsed = BigInt(value);
    if (parsed < 1n || parsed > maximumBigint) throw this.validation('expectedVersion');
    return parsed;
  }

  private hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
  }

  private rethrowValidation(error: unknown): never {
    if (error instanceof ExpenseValidationError) throw this.validation(error.field);
    throw error;
  }

  private validation(field: string): BadRequestException {
    return new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed.',
      details: [{ field, constraints: ['expenseValue'] }],
    });
  }

  private throwFailure(error: ExpenseCategoryMutationFailure): never {
    const body = { code: error.code, message: error.message };
    if (error.statusCode === 404) throw new NotFoundException(body);
    throw new ConflictException(body);
  }
}
