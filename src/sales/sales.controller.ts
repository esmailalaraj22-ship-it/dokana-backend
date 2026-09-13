import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { CustomerIdParamDto } from '../customers/dto/customer-id-param.dto';
import { SalePostingService } from './sale-posting.service';
import type { CustomerOpeningReceivableResponse, SalePostingResponse } from './sale-posting.types';

@Controller()
@UseGuards(AuthenticationGuard)
export class SalesController {
  constructor(private readonly posting: SalePostingService) {}

  @Post('sales')
  postSale(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<SalePostingResponse> {
    return this.posting.postSale(request.principal, request.tenantContext, body);
  }

  @Post('customers/:customerId/opening-receivables')
  postOpeningReceivable(
    @Req() request: AuthenticatedRequest,
    @Param() params: CustomerIdParamDto,
    @Body() body: unknown,
  ): Promise<CustomerOpeningReceivableResponse> {
    return this.posting.postOpeningReceivable(
      request.principal,
      request.tenantContext,
      params.customerId,
      body,
    );
  }
}
