import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { CustomerIdParamDto } from '../customers/dto/customer-id-param.dto';
import { CustomerPaymentPostingService } from './customer-payment-posting.service';
import type { CustomerCollectionPostingResponse } from './customer-payment-posting.types';
import { CustomerPaymentReadService } from './customer-payment-read.service';
import type {
  CustomerPaymentDetailResponse,
  CustomerPaymentListResponse,
} from './customer-payment-read.types';
import { CustomerPaymentIdParamDto } from './dto/customer-payment-id-param.dto';
import { ListCustomerReceivablesQueryDto } from './dto/list-customer-receivables-query.dto';
import { ListCustomerPaymentsQueryDto } from './dto/list-customer-payments-query.dto';
import { ListSalesQueryDto } from './dto/list-sales-query.dto';
import { SaleIdParamDto } from './dto/sale-id-param.dto';
import { SaleCorrectionService } from './sale-correction.service';
import type { SaleCorrectionResponse } from './sale-correction.types';
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
    private readonly corrections: SaleCorrectionService,
    private readonly customerPaymentPosting: CustomerPaymentPostingService,
    private readonly customerPaymentReads: CustomerPaymentReadService,
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

  @Post('sales/:targetOperationId/cancel')
  cancelSale(
    @Req() request: AuthenticatedRequest,
    @Param('targetOperationId') targetOperationId: string,
    @Body() body: unknown,
  ): Promise<SaleCorrectionResponse> {
    return this.corrections.cancel(
      request.principal,
      request.tenantContext,
      targetOperationId,
      body,
    );
  }

  @Post('sales/:targetOperationId/edit')
  editSale(
    @Req() request: AuthenticatedRequest,
    @Param('targetOperationId') targetOperationId: string,
    @Body() body: unknown,
  ): Promise<SaleCorrectionResponse> {
    return this.corrections.edit(request.principal, request.tenantContext, targetOperationId, body);
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

  @Post('customers/:customerId/payments')
  postCustomerPayment(
    @Req() request: AuthenticatedRequest,
    @Param() params: CustomerIdParamDto,
    @Body() body: unknown,
  ): Promise<CustomerCollectionPostingResponse> {
    return this.customerPaymentPosting.post(
      request.principal,
      request.tenantContext,
      params.customerId,
      body,
    );
  }

  @Get('customers/:customerId/payments')
  listCustomerPayments(
    @Req() request: AuthenticatedRequest,
    @Param() params: CustomerIdParamDto,
    @Query() query: ListCustomerPaymentsQueryDto,
  ): Promise<CustomerPaymentListResponse> {
    return this.customerPaymentReads.list(
      request.principal,
      request.tenantContext,
      params.customerId,
      query,
    );
  }

  @Get('customers/:customerId/payments/:paymentId')
  getCustomerPayment(
    @Req() request: AuthenticatedRequest,
    @Param() params: CustomerPaymentIdParamDto,
  ): Promise<CustomerPaymentDetailResponse> {
    return this.customerPaymentReads.getById(
      request.principal,
      request.tenantContext,
      params.customerId,
      params.paymentId,
    );
  }
}
