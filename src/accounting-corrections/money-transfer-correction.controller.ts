import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { AccountingCorrectionWriteService } from './accounting-correction-write.service';
import { ReplaceMoneyTransferDto } from './dto/replace-money-transfer.dto';
import { ReverseAccountingEventDto } from './dto/reverse-accounting-event.dto';
import type { AccountingCorrectionMutationResponse } from './accounting-correction.types';

@Controller('money-transfers')
@UseGuards(AuthenticationGuard)
export class MoneyTransferCorrectionController {
  constructor(private readonly corrections: AccountingCorrectionWriteService) {}

  @Post(':targetOperationId/reversal')
  reverse(
    @Req() request: AuthenticatedRequest,
    @Param('targetOperationId') targetOperationId: string,
    @Body() body: ReverseAccountingEventDto,
  ): Promise<AccountingCorrectionMutationResponse> {
    return this.corrections.reverse(
      request.principal,
      request.tenantContext,
      targetOperationId,
      'internal_transfer',
      body,
    );
  }

  @Post(':targetOperationId/replacement')
  replace(
    @Req() request: AuthenticatedRequest,
    @Param('targetOperationId') targetOperationId: string,
    @Body() body: ReplaceMoneyTransferDto,
  ): Promise<AccountingCorrectionMutationResponse> {
    return this.corrections.replaceTransfer(
      request.principal,
      request.tenantContext,
      targetOperationId,
      body,
    );
  }
}
