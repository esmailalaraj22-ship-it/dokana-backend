import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { AccountingPeriodReadService } from './accounting-period-read.service';
import type {
  AccountingPeriodListResponse,
  AccountingPeriodResponse,
} from './accounting-period-read.types';
import { AccountingPeriodIdParamDto } from './dto/accounting-period-id-param.dto';

@Controller('accounting-periods')
@UseGuards(AuthenticationGuard)
export class AccountingPeriodsController {
  constructor(private readonly reads: AccountingPeriodReadService) {}

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
}
