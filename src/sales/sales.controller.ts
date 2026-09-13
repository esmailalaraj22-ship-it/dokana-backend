import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { CustomerIdParamDto } from '../customers/dto/customer-id-param.dto';
import { ListCustomerReceivablesQueryDto } from './dto/list-customer-receivables-query.dto';
import { ListSalesQueryDto } from './dto/list-sales-query.dto';
import { SaleIdParamDto } from './dto/sale-id-param.dto';
import { SaleReadService } from './sale-read.service';
import type {
  CustomerReceivableListResponse,
  SaleDetailResponse,
  SaleListResponse,
} from './sale-read.types';
import { SalePostingService } from './sale-posting.service';
import type { CustomerOpeningReceivableResponse, SalePostingResponse } from './sale-posting.types';

@Controller()
@UseGuards(AuthenticationGuard)
export class SalesController {
  constructor(
    private readonly posting: SalePostingService,
    private readonly reads: SaleReadService,
  ) {}

  @Get('sales')
  listSales(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListSalesQueryDto,
  ): Promise<SaleListResponse> {
    return this.reads.list(request.principal, request.tenantContext, query);
  }

  @Get('sales/:saleId')
  getSale(
    @Req() request: AuthenticatedRequest,
    @Param() params: SaleIdParamDto,
  ): Promise<SaleDetailResponse> {
    return this.reads.getById(request.principal, request.tenantContext, params.saleId);
  }

  @Get('customers/:customerId/receivables')
  listCustomerReceivables(
    @Req() request: AuthenticatedRequest,
    @Param() params: CustomerIdParamDto,
    @Query() query: ListCustomerReceivablesQueryDto,
  ): Promise<CustomerReceivableListResponse> {
    return this.reads.listCustomerReceivables(
      request.principal,
      request.tenantContext,
      params.customerId,
      query,
    );
  }

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
