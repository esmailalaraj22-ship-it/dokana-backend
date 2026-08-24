import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { CreateProductDto } from './dto/create-product.dto';
import { CreateProductUnitDto } from './dto/create-product-unit.dto';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { ProductLifecycleDto } from './dto/product-lifecycle.dto';
import { ProductIdParamDto } from './dto/product-id-param.dto';
import { ProductUnitIdParamDto } from './dto/product-unit-id-param.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { UpdateProductUnitDto } from './dto/update-product-unit.dto';
import { ProductReadService } from './product-read.service';
import type { ProductDetailResponse, ProductListResponse } from './product-read.types';
import { ProductWriteService } from './product-write.service';
import type { ProductMutationResponse, ProductUnitMutationResponse } from './product-write.types';

@Controller('products')
@UseGuards(AuthenticationGuard)
export class ProductsController {
  constructor(
    private readonly productReads: ProductReadService,
    private readonly productWrites: ProductWriteService,
  ) {}

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListProductsQueryDto,
  ): Promise<ProductListResponse> {
    return this.productReads.list(request.principal, request.tenantContext, query);
  }

  @Post()
  create(
    @Req() request: AuthenticatedRequest,
    @Body() body: CreateProductDto,
  ): Promise<ProductMutationResponse> {
    return this.productWrites.create(request.principal, request.tenantContext, body);
  }

  @Post('units')
  createUnit(
    @Req() request: AuthenticatedRequest,
    @Body() body: CreateProductUnitDto,
  ): Promise<ProductUnitMutationResponse> {
    return this.productWrites.createUnit(request.principal, request.tenantContext, body);
  }

  @Patch('units/:unitId')
  updateUnit(
    @Req() request: AuthenticatedRequest,
    @Param() params: ProductUnitIdParamDto,
    @Body() body: UpdateProductUnitDto,
  ): Promise<ProductUnitMutationResponse> {
    return this.productWrites.updateUnit(
      request.principal,
      request.tenantContext,
      params.unitId,
      body,
    );
  }

  @Post('units/:unitId/archive')
  @HttpCode(HttpStatus.OK)
  archiveUnit(
    @Req() request: AuthenticatedRequest,
    @Param() params: ProductUnitIdParamDto,
    @Body() body: ProductLifecycleDto,
  ): Promise<ProductUnitMutationResponse> {
    return this.productWrites.archiveUnit(
      request.principal,
      request.tenantContext,
      params.unitId,
      body,
    );
  }

  @Post('units/:unitId/restore')
  @HttpCode(HttpStatus.OK)
  restoreUnit(
    @Req() request: AuthenticatedRequest,
    @Param() params: ProductUnitIdParamDto,
    @Body() body: ProductLifecycleDto,
  ): Promise<ProductUnitMutationResponse> {
    return this.productWrites.restoreUnit(
      request.principal,
      request.tenantContext,
      params.unitId,
      body,
    );
  }

  @Post(':productId/archive')
  @HttpCode(HttpStatus.OK)
  archive(
    @Req() request: AuthenticatedRequest,
    @Param() params: ProductIdParamDto,
    @Body() body: ProductLifecycleDto,
  ): Promise<ProductMutationResponse> {
    return this.productWrites.archiveProduct(
      request.principal,
      request.tenantContext,
      params.productId,
      body,
    );
  }

  @Post(':productId/restore')
  @HttpCode(HttpStatus.OK)
  restore(
    @Req() request: AuthenticatedRequest,
    @Param() params: ProductIdParamDto,
    @Body() body: ProductLifecycleDto,
  ): Promise<ProductMutationResponse> {
    return this.productWrites.restoreProduct(
      request.principal,
      request.tenantContext,
      params.productId,
      body,
    );
  }

  @Get(':productId')
  getById(
    @Req() request: AuthenticatedRequest,
    @Param() params: ProductIdParamDto,
  ): Promise<ProductDetailResponse> {
    return this.productReads.getById(request.principal, request.tenantContext, params.productId);
  }

  @Patch(':productId')
  update(
    @Req() request: AuthenticatedRequest,
    @Param() params: ProductIdParamDto,
    @Body() body: UpdateProductDto,
  ): Promise<ProductMutationResponse> {
    return this.productWrites.update(
      request.principal,
      request.tenantContext,
      params.productId,
      body,
    );
  }
}
