import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { CreateMoneyAccountDto } from './dto/create-money-account.dto';
import { ListMoneyAccountsQueryDto } from './dto/list-money-accounts-query.dto';
import { MoneyAccountIdParamDto } from './dto/money-account-id-param.dto';
import { MoneyAccountLifecycleDto } from './dto/money-account-lifecycle.dto';
import { MoneyAccountReadService } from './money-account-read.service';
import type { MoneyAccountListResponse, MoneyAccountResponse } from './money-account-read.types';
import { MoneyAccountWriteService } from './money-account-write.service';
import type { MoneyAccountMutationResponse } from './money-account-write.types';

@Controller('money-accounts')
@UseGuards(AuthenticationGuard)
export class MoneyAccountsController {
  constructor(
    private readonly moneyAccountReads: MoneyAccountReadService,
    private readonly moneyAccountWrites: MoneyAccountWriteService,
  ) {}

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListMoneyAccountsQueryDto,
  ): Promise<MoneyAccountListResponse> {
    return this.moneyAccountReads.list(request.principal, request.tenantContext, query);
  }

  @Post()
  create(
    @Req() request: AuthenticatedRequest,
    @Body() body: CreateMoneyAccountDto,
  ): Promise<MoneyAccountMutationResponse> {
    return this.moneyAccountWrites.create(request.principal, request.tenantContext, body);
  }

  @Get(':moneyAccountId')
  getById(
    @Req() request: AuthenticatedRequest,
    @Param() params: MoneyAccountIdParamDto,
  ): Promise<MoneyAccountResponse> {
    return this.moneyAccountReads.getById(
      request.principal,
      request.tenantContext,
      params.moneyAccountId,
    );
  }

  @Post(':moneyAccountId/archive')
  @HttpCode(200)
  archive(
    @Req() request: AuthenticatedRequest,
    @Param() params: MoneyAccountIdParamDto,
    @Body() body: MoneyAccountLifecycleDto,
  ): Promise<MoneyAccountMutationResponse> {
    return this.moneyAccountWrites.archive(
      request.principal,
      request.tenantContext,
      params.moneyAccountId,
      body,
    );
  }

  @Post(':moneyAccountId/restore')
  @HttpCode(200)
  restore(
    @Req() request: AuthenticatedRequest,
    @Param() params: MoneyAccountIdParamDto,
    @Body() body: MoneyAccountLifecycleDto,
  ): Promise<MoneyAccountMutationResponse> {
    return this.moneyAccountWrites.restore(
      request.principal,
      request.tenantContext,
      params.moneyAccountId,
      body,
    );
  }
}
