import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import {
  InventoryOperationParamDto,
  InventoryProductParamDto,
  assertNoInventoryQuery,
} from './dto/inventory-read.dto';
import { InventoryReadService } from './inventory-read.service';
import type { InventoryOperationResponse, InventoryStockResponse } from './inventory-read.types';

@Controller('inventory')
@UseGuards(AuthenticationGuard)
export class InventoryController {
  constructor(private readonly reads: InventoryReadService) {}

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
