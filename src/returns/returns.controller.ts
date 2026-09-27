import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { SaleReturnPostingService } from './sale-return-posting.service';
import type { SaleReturnPostingResponse } from './sale-return-posting.types';

@Controller()
@UseGuards(AuthenticationGuard)
export class ReturnsController {
  constructor(private readonly posting: SaleReturnPostingService) {}

  @Post('sales/:saleId/return')
  postSaleReturn(
    @Req() request: AuthenticatedRequest,
    @Param('saleId') saleId: string,
    @Body() body: unknown,
  ): Promise<SaleReturnPostingResponse> {
    return this.posting.post(request.principal, request.tenantContext, saleId, body);
  }
}
