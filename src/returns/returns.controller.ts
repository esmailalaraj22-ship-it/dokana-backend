import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { SaleIdParamDto } from '../sales/dto/sale-id-param.dto';
import { ListSaleReturnsQueryDto } from './dto/list-sale-returns-query.dto';
import { SaleReturnIdParamDto } from './dto/sale-return-id-param.dto';
import { SaleReturnPostingService } from './sale-return-posting.service';
import { SaleReturnCorrectionService } from './sale-return-correction.service';
import type { SaleReturnCorrectionResponse } from './sale-return-correction.types';
import { SaleReturnReadService } from './sale-return-read.service';
import type {
  SaleReturnDetailResponse,
  SaleReturnEligibilityResponse,
  SaleReturnListResponse,
} from './sale-return-read.types';
import type { SaleReturnPostingResponse } from './sale-return-posting.types';

@Controller()
@UseGuards(AuthenticationGuard)
export class ReturnsController {
  constructor(
    private readonly posting: SaleReturnPostingService,
    private readonly reads: SaleReturnReadService,
    private readonly corrections: SaleReturnCorrectionService,
  ) {}

  @Get('returns')
  listSaleReturns(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListSaleReturnsQueryDto,
  ): Promise<SaleReturnListResponse> {
    return this.reads.list(request.principal, request.tenantContext, query);
  }

  @Get('returns/:returnId')
  getSaleReturn(
    @Req() request: AuthenticatedRequest,
    @Param() params: SaleReturnIdParamDto,
  ): Promise<SaleReturnDetailResponse> {
    return this.reads.getById(request.principal, request.tenantContext, params.returnId);
  }

  @Get('sales/:saleId/returns')
  listSaleReturnsForSale(
    @Req() request: AuthenticatedRequest,
    @Param() params: SaleIdParamDto,
    @Query() query: ListSaleReturnsQueryDto,
  ): Promise<SaleReturnListResponse> {
    return this.reads.listForSale(request.principal, request.tenantContext, params.saleId, query);
  }

  @Get('sales/:saleId/return-eligibility')
  getSaleReturnEligibility(
    @Req() request: AuthenticatedRequest,
    @Param() params: SaleIdParamDto,
  ): Promise<SaleReturnEligibilityResponse> {
    return this.reads.getEligibility(request.principal, request.tenantContext, params.saleId);
  }

  @Post('sales/:saleId/return')
  postSaleReturn(
    @Req() request: AuthenticatedRequest,
    @Param('saleId') saleId: string,
    @Body() body: unknown,
  ): Promise<SaleReturnPostingResponse> {
    return this.posting.post(request.principal, request.tenantContext, saleId, body);
  }

  @Post('returns/:returnId/cancel')
  cancelSaleReturn(
    @Req() request: AuthenticatedRequest,
    @Param('returnId') returnId: string,
    @Body() body: unknown,
  ): Promise<SaleReturnCorrectionResponse> {
    return this.corrections.cancel(request.principal, request.tenantContext, returnId, body);
  }

  @Post('returns/:returnId/replace')
  replaceSaleReturn(
    @Req() request: AuthenticatedRequest,
    @Param('returnId') returnId: string,
    @Body() body: unknown,
  ): Promise<SaleReturnCorrectionResponse> {
    return this.corrections.replace(request.principal, request.tenantContext, returnId, body);
  }
}
