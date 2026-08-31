import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { ListMoneyAccountsQueryDto } from './dto/list-money-accounts-query.dto';
import { MoneyAccountIdParamDto } from './dto/money-account-id-param.dto';
import { MoneyAccountReadService } from './money-account-read.service';
import type { MoneyAccountListResponse, MoneyAccountResponse } from './money-account-read.types';

@Controller('money-accounts')
@UseGuards(AuthenticationGuard)
export class MoneyAccountsController {
  constructor(private readonly moneyAccountReads: MoneyAccountReadService) {}

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListMoneyAccountsQueryDto,
  ): Promise<MoneyAccountListResponse> {
    return this.moneyAccountReads.list(request.principal, request.tenantContext, query);
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
}
