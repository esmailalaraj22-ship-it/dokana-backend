import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { AccountingPeriodReadService } from './accounting-period-read.service';
import type {
  AccountingPeriodListResponse,
  AccountingPeriodResponse,
} from './accounting-period-read.types';
import { AccountingPeriodIdParamDto } from './dto/accounting-period-id-param.dto';
import { AccountingPeriodWriteService } from './accounting-period-write.service';
import type { AccountingPeriodMutationResponse } from './accounting-period-write.types';
import { AccountingPeriodCloseDto } from './dto/accounting-period-close.dto';

@Controller('accounting-periods')
@UseGuards(AuthenticationGuard)
export class AccountingPeriodsController {
  constructor(
    private readonly reads: AccountingPeriodReadService,
    private readonly writes: AccountingPeriodWriteService,
  ) {}

  @Get()
  list(@Req() request: AuthenticatedRequest): Promise<AccountingPeriodListResponse> {
    return this.reads.list(request.principal, request.tenantContext);
  }

  @Get(':accountingPeriodId')
  getById(
    @Req() request: AuthenticatedRequest,
    @Param() params: AccountingPeriodIdParamDto,
  ): Promise<AccountingPeriodResponse> {
    return this.reads.getById(request.principal, request.tenantContext, params.accountingPeriodId);
  }

  @Post(':accountingPeriodId/close')
  @HttpCode(200)
  close(
    @Req() request: AuthenticatedRequest,
    @Param() params: AccountingPeriodIdParamDto,
    @Body() body: AccountingPeriodCloseDto,
  ): Promise<AccountingPeriodMutationResponse> {
    return this.writes.close(
      request.principal,
      request.tenantContext,
      params.accountingPeriodId,
      body,
    );
  }
}
