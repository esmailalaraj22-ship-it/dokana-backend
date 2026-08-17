import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { ProductIdParamDto } from './dto/product-id-param.dto';
import { ProductReadService } from './product-read.service';
import type { ProductDetailResponse, ProductListResponse } from './product-read.types';

@Controller('products')
@UseGuards(AuthenticationGuard)
export class ProductsController {
  constructor(private readonly productReads: ProductReadService) {}

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListProductsQueryDto,
  ): Promise<ProductListResponse> {
    return this.productReads.list(request.principal, request.tenantContext, query);
  }

  @Get(':productId')
  getById(
    @Req() request: AuthenticatedRequest,
    @Param() params: ProductIdParamDto,
  ): Promise<ProductDetailResponse> {
    return this.productReads.getById(request.principal, request.tenantContext, params.productId);
  }
}
