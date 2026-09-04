import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { CreateMoneyTransferDto } from './dto/create-money-transfer.dto';
import type { MoneyTransferMutationResponse } from './money-transfer.types';
import { MoneyTransferWriteService } from './money-transfer-write.service';

@Controller('money-transfers')
@UseGuards(AuthenticationGuard)
export class MoneyTransferController {
  constructor(private readonly writes: MoneyTransferWriteService) {}

  @Post()
  create(
    @Req() request: AuthenticatedRequest,
    @Body() body: CreateMoneyTransferDto,
  ): Promise<MoneyTransferMutationResponse> {
    return this.writes.create(request.principal, request.tenantContext, body);
  }
}
