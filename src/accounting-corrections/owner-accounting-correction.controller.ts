import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { AccountingCorrectionWriteService } from './accounting-correction-write.service';
import { ReplaceOpeningBalanceDto } from './dto/replace-opening-balance.dto';
import { ReplaceOwnerEventDto } from './dto/replace-owner-event.dto';
import { ReverseAccountingEventDto } from './dto/reverse-accounting-event.dto';
import type {
  AccountingCorrectionDomain,
  AccountingCorrectionMutationResponse,
} from './accounting-correction.types';

@Controller('owner-ledger')
@UseGuards(AuthenticationGuard)
export class OwnerAccountingCorrectionController {
  constructor(private readonly corrections: AccountingCorrectionWriteService) {}

  @Post('opening-balances/:targetOperationId/reversal')
  reverseOpening(
    @Req() request: AuthenticatedRequest,
    @Param('targetOperationId') targetOperationId: string,
    @Body() body: ReverseAccountingEventDto,
  ): Promise<AccountingCorrectionMutationResponse> {
    return this.reverse(request, targetOperationId, 'opening_balance', body);
  }

  @Post('opening-balances/:targetOperationId/replacement')
  replaceOpening(
    @Req() request: AuthenticatedRequest,
    @Param('targetOperationId') targetOperationId: string,
    @Body() body: ReplaceOpeningBalanceDto,
  ): Promise<AccountingCorrectionMutationResponse> {
    return this.corrections.replaceOpeningBalance(
      request.principal,
      request.tenantContext,
      targetOperationId,
      body,
    );
  }

  @Post('contributions/:targetOperationId/reversal')
  reverseContribution(
    @Req() request: AuthenticatedRequest,
    @Param('targetOperationId') targetOperationId: string,
    @Body() body: ReverseAccountingEventDto,
  ): Promise<AccountingCorrectionMutationResponse> {
    return this.reverse(request, targetOperationId, 'owner_contribution', body);
  }

  @Post('contributions/:targetOperationId/replacement')
  replaceContribution(
    @Req() request: AuthenticatedRequest,
    @Param('targetOperationId') targetOperationId: string,
    @Body() body: ReplaceOwnerEventDto,
  ): Promise<AccountingCorrectionMutationResponse> {
    return this.replaceOwner(request, targetOperationId, 'owner_contribution', body);
  }

  @Post('loans/:targetOperationId/reversal')
  reverseLoan(
    @Req() request: AuthenticatedRequest,
    @Param('targetOperationId') targetOperationId: string,
    @Body() body: ReverseAccountingEventDto,
  ): Promise<AccountingCorrectionMutationResponse> {
    return this.reverse(request, targetOperationId, 'owner_loan', body);
  }

  @Post('loans/:targetOperationId/replacement')
  replaceLoan(
    @Req() request: AuthenticatedRequest,
    @Param('targetOperationId') targetOperationId: string,
    @Body() body: ReplaceOwnerEventDto,
  ): Promise<AccountingCorrectionMutationResponse> {
    return this.replaceOwner(request, targetOperationId, 'owner_loan', body);
  }

  @Post('reimbursements/:targetOperationId/reversal')
  reverseReimbursement(
    @Req() request: AuthenticatedRequest,
    @Param('targetOperationId') targetOperationId: string,
    @Body() body: ReverseAccountingEventDto,
  ): Promise<AccountingCorrectionMutationResponse> {
    return this.reverse(request, targetOperationId, 'owner_reimbursement', body);
  }

  @Post('reimbursements/:targetOperationId/replacement')
  replaceReimbursement(
    @Req() request: AuthenticatedRequest,
    @Param('targetOperationId') targetOperationId: string,
    @Body() body: ReplaceOwnerEventDto,
  ): Promise<AccountingCorrectionMutationResponse> {
    return this.replaceOwner(request, targetOperationId, 'owner_reimbursement', body);
  }

  @Post('personal-withdrawals/:targetOperationId/reversal')
  reversePersonalWithdrawal(
    @Req() request: AuthenticatedRequest,
    @Param('targetOperationId') targetOperationId: string,
    @Body() body: ReverseAccountingEventDto,
  ): Promise<AccountingCorrectionMutationResponse> {
    return this.reverse(request, targetOperationId, 'owner_personal_withdrawal', body);
  }

  @Post('personal-withdrawals/:targetOperationId/replacement')
  replacePersonalWithdrawal(
    @Req() request: AuthenticatedRequest,
    @Param('targetOperationId') targetOperationId: string,
    @Body() body: ReplaceOwnerEventDto,
  ): Promise<AccountingCorrectionMutationResponse> {
    return this.replaceOwner(request, targetOperationId, 'owner_personal_withdrawal', body);
  }

  @Post('capital-withdrawals/:targetOperationId/reversal')
  reverseCapitalWithdrawal(
    @Req() request: AuthenticatedRequest,
    @Param('targetOperationId') targetOperationId: string,
    @Body() body: ReverseAccountingEventDto,
  ): Promise<AccountingCorrectionMutationResponse> {
    return this.reverse(request, targetOperationId, 'owner_capital_withdrawal', body);
  }

  @Post('capital-withdrawals/:targetOperationId/replacement')
  replaceCapitalWithdrawal(
    @Req() request: AuthenticatedRequest,
    @Param('targetOperationId') targetOperationId: string,
    @Body() body: ReplaceOwnerEventDto,
  ): Promise<AccountingCorrectionMutationResponse> {
    return this.replaceOwner(request, targetOperationId, 'owner_capital_withdrawal', body);
  }

  private reverse(
    request: AuthenticatedRequest,
    targetOperationId: string,
    domain: AccountingCorrectionDomain,
    body: ReverseAccountingEventDto,
  ): Promise<AccountingCorrectionMutationResponse> {
    return this.corrections.reverse(
      request.principal,
      request.tenantContext,
      targetOperationId,
      domain,
      body,
    );
  }

  private replaceOwner(
    request: AuthenticatedRequest,
    targetOperationId: string,
    domain: Exclude<AccountingCorrectionDomain, 'opening_balance' | 'internal_transfer'>,
    body: ReplaceOwnerEventDto,
  ): Promise<AccountingCorrectionMutationResponse> {
    return this.corrections.replaceOwnerEvent(
      request.principal,
      request.tenantContext,
      targetOperationId,
      domain,
      body,
    );
  }
}
