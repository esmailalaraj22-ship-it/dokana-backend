import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { InventoryPostingService } from './inventory-posting.service';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import {
  InventoryOperationParamDto,
  InventoryProductParamDto,
  assertNoInventoryQuery,
} from './dto/inventory-read.dto';
import { InventoryReadService } from './inventory-read.service';
import type { InventoryOperationResponse, InventoryStockResponse } from './inventory-read.types';
import { StockCountService } from './stock-count.service';

@Controller('inventory')
@UseGuards(AuthenticationGuard)
export class InventoryController {
  constructor(
    private readonly reads: InventoryReadService,
    private readonly posting: InventoryPostingService,
    private readonly stockCounts: StockCountService,
  ) {}

  @Post('opening')
  opening(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    assertNoInventoryQuery(request.query);
    return this.posting.post(request.principal, request.tenantContext, 'opening', body);
  }

  @Post('increase')
  increase(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    assertNoInventoryQuery(request.query);
    return this.posting.post(request.principal, request.tenantContext, 'increase', body);
  }

  @Post('decrease')
  decrease(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    assertNoInventoryQuery(request.query);
    return this.posting.post(request.principal, request.tenantContext, 'decrease', body);
  }

  @Post('counts')
  count(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    assertNoInventoryQuery(request.query);
    return this.stockCounts.post(request.principal, request.tenantContext, body);
  }

  @Get('stock/:productId')
  stock(
    @Req() request: AuthenticatedRequest,
    @Param() params: InventoryProductParamDto,
  ): Promise<InventoryStockResponse> {
    assertNoInventoryQuery(request.query);
    return this.reads.stock(request.principal, request.tenantContext, params.productId);
  }

  @Get('operations/:operationId')
  operation(
    @Req() request: AuthenticatedRequest,
    @Param() params: InventoryOperationParamDto,
  ): Promise<InventoryOperationResponse> {
    assertNoInventoryQuery(request.query);
    return this.reads.operation(request.principal, request.tenantContext, params.operationId);
  }
}
