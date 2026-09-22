import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import {
  CreateExpenseCategoryDto,
  ExpenseCategoryIdParamDto,
  ExpenseCategoryLifecycleDto,
  ListExpenseCategoriesQueryDto,
  UpdateExpenseCategoryDto,
} from './dto/expense-category.dto';
import { ExpenseIdParamDto, ListExpensesQueryDto } from './dto/expense-read.dto';
import { ExpenseCategoryService } from './expense-category.service';
import type {
  ExpenseCategoryMutationResponse,
  ExpenseCategoryResponse,
} from './expense-category.types';
import { ExpensePaymentService } from './expense-payment.service';
import type { ExpensePaymentPostingResponse } from './expense-payment.types';
import { ExpenseReadService } from './expense-read.service';
import type {
  ExpenseDetailResponse,
  ExpenseListResponse,
  ExpensePaymentHistoryResponse,
} from './expense-read.types';
import { ExpenseRecognitionService } from './expense-recognition.service';
import type { ExpenseRecognitionResponse } from './expense-recognition.types';

@Controller()
@UseGuards(AuthenticationGuard)
export class ExpensesController {
  constructor(
    private readonly categories: ExpenseCategoryService,
    private readonly recognition: ExpenseRecognitionService,
    private readonly payments: ExpensePaymentService,
    private readonly reads: ExpenseReadService,
  ) {}

  @Get('expense-categories')
  listCategories(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListExpenseCategoriesQueryDto,
  ): Promise<{ items: ExpenseCategoryResponse[] }> {
    return this.categories.list(request.principal, request.tenantContext, query);
  }

  @Post('expense-categories')
  createCategory(
    @Req() request: AuthenticatedRequest,
    @Body() body: CreateExpenseCategoryDto,
  ): Promise<ExpenseCategoryMutationResponse> {
    return this.categories.create(request.principal, request.tenantContext, body);
  }

  @Get('expense-categories/:expenseCategoryId')
  getCategory(
    @Req() request: AuthenticatedRequest,
    @Param() params: ExpenseCategoryIdParamDto,
  ): Promise<ExpenseCategoryResponse> {
    return this.categories.getById(
      request.principal,
      request.tenantContext,
      params.expenseCategoryId,
    );
  }

  @Patch('expense-categories/:expenseCategoryId')
  updateCategory(
    @Req() request: AuthenticatedRequest,
    @Param() params: ExpenseCategoryIdParamDto,
    @Body() body: UpdateExpenseCategoryDto,
  ): Promise<ExpenseCategoryMutationResponse> {
    return this.categories.update(
      request.principal,
      request.tenantContext,
      params.expenseCategoryId,
      body,
    );
  }

  @Post('expense-categories/:expenseCategoryId/archive')
  @HttpCode(200)
  archiveCategory(
    @Req() request: AuthenticatedRequest,
    @Param() params: ExpenseCategoryIdParamDto,
    @Body() body: ExpenseCategoryLifecycleDto,
  ): Promise<ExpenseCategoryMutationResponse> {
    return this.categories.archive(
      request.principal,
      request.tenantContext,
      params.expenseCategoryId,
      body,
    );
  }

  @Post('expense-categories/:expenseCategoryId/restore')
  @HttpCode(200)
  restoreCategory(
    @Req() request: AuthenticatedRequest,
    @Param() params: ExpenseCategoryIdParamDto,
    @Body() body: ExpenseCategoryLifecycleDto,
  ): Promise<ExpenseCategoryMutationResponse> {
    return this.categories.restore(
      request.principal,
      request.tenantContext,
      params.expenseCategoryId,
      body,
    );
  }

  @Get('expenses')
  listExpenses(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListExpensesQueryDto,
  ): Promise<ExpenseListResponse> {
    return this.reads.list(request.principal, request.tenantContext, query);
  }

  @Post('expenses')
  recognizeExpense(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ExpenseRecognitionResponse> {
    return this.recognition.recognize(request.principal, request.tenantContext, body);
  }

  @Post('expenses/:expenseId/payments')
  postExpensePayment(
    @Req() request: AuthenticatedRequest,
    @Param() params: ExpenseIdParamDto,
    @Body() body: unknown,
  ): Promise<ExpensePaymentPostingResponse> {
    return this.payments.post(request.principal, request.tenantContext, params.expenseId, body);
  }

  @Get('expenses/:expenseId/payments')
  getExpensePayments(
    @Req() request: AuthenticatedRequest,
    @Param() params: ExpenseIdParamDto,
  ): Promise<ExpensePaymentHistoryResponse> {
    return this.reads.getPaymentHistory(request.principal, request.tenantContext, params.expenseId);
  }

  @Get('expenses/:expenseId')
  getExpense(
    @Req() request: AuthenticatedRequest,
    @Param() params: ExpenseIdParamDto,
  ): Promise<ExpenseDetailResponse> {
    return this.reads.getById(request.principal, request.tenantContext, params.expenseId);
  }
}
