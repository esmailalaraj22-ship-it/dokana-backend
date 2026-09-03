import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { OpeningBalanceDto } from './dto/opening-balance.dto';
import { OwnerMoneyCommandDto } from './dto/owner-money-command.dto';
import type { OwnerLedgerMutationResponse, OwnerPositionResponse } from './owner-ledger.types';
import { OwnerLedgerWriteService } from './owner-ledger-write.service';
import { OwnerPositionReadService } from './owner-position-read.service';

@Controller('owner-ledger')
@UseGuards(AuthenticationGuard)
export class OwnerLedgerController {
  constructor(
    private readonly writes: OwnerLedgerWriteService,
    private readonly position: OwnerPositionReadService,
  ) {}

  @Get('position')
  readPosition(@Req() request: AuthenticatedRequest): Promise<OwnerPositionResponse> {
    return this.position.read(request.principal, request.tenantContext);
  }

  @Post('opening-balances')
  postOpeningBalance(
    @Req() request: AuthenticatedRequest,
    @Body() body: OpeningBalanceDto,
  ): Promise<OwnerLedgerMutationResponse> {
    return this.writes.postOpeningBalance(request.principal, request.tenantContext, body);
  }

  @Post('contributions')
  postContribution(
    @Req() request: AuthenticatedRequest,
    @Body() body: OwnerMoneyCommandDto,
  ): Promise<OwnerLedgerMutationResponse> {
    return this.writes.postContribution(request.principal, request.tenantContext, body);
  }

  @Post('loans')
  postLoan(
    @Req() request: AuthenticatedRequest,
    @Body() body: OwnerMoneyCommandDto,
  ): Promise<OwnerLedgerMutationResponse> {
    return this.writes.postLoan(request.principal, request.tenantContext, body);
  }

  @Post('reimbursements')
  postReimbursement(
    @Req() request: AuthenticatedRequest,
    @Body() body: OwnerMoneyCommandDto,
  ): Promise<OwnerLedgerMutationResponse> {
    return this.writes.postReimbursement(request.principal, request.tenantContext, body);
  }

  @Post('personal-withdrawals')
  postPersonalWithdrawal(
    @Req() request: AuthenticatedRequest,
    @Body() body: OwnerMoneyCommandDto,
  ): Promise<OwnerLedgerMutationResponse> {
    return this.writes.postPersonalWithdrawal(request.principal, request.tenantContext, body);
  }

  @Post('capital-withdrawals')
  postCapitalWithdrawal(
    @Req() request: AuthenticatedRequest,
    @Body() body: OwnerMoneyCommandDto,
  ): Promise<OwnerLedgerMutationResponse> {
    return this.writes.postCapitalWithdrawal(request.principal, request.tenantContext, body);
  }
}
