import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { ListSuppliersQueryDto } from './dto/list-suppliers-query.dto';
import { SupplierIdParamDto } from './dto/supplier-id-param.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { SupplierReadService } from './supplier-read.service';
import type { SupplierDetailResponse, SupplierListResponse } from './supplier-read.types';
import { SupplierWriteService } from './supplier-write.service';
import type { SupplierMutationResponse } from './supplier-write.types';

@Controller('suppliers')
@UseGuards(AuthenticationGuard)
export class SuppliersController {
  constructor(
    private readonly supplierReads: SupplierReadService,
    private readonly supplierWrites: SupplierWriteService,
  ) {}

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListSuppliersQueryDto,
  ): Promise<SupplierListResponse> {
    return this.supplierReads.list(request.principal, request.tenantContext, query);
  }

  @Post()
  create(
    @Req() request: AuthenticatedRequest,
    @Body() body: CreateSupplierDto,
  ): Promise<SupplierMutationResponse> {
    return this.supplierWrites.create(request.principal, request.tenantContext, body);
  }

  @Get(':supplierId')
  getById(
    @Req() request: AuthenticatedRequest,
    @Param() params: SupplierIdParamDto,
  ): Promise<SupplierDetailResponse> {
    return this.supplierReads.getById(request.principal, request.tenantContext, params.supplierId);
  }

  @Patch(':supplierId')
  update(
    @Req() request: AuthenticatedRequest,
    @Param() params: SupplierIdParamDto,
    @Body() body: UpdateSupplierDto,
  ): Promise<SupplierMutationResponse> {
    return this.supplierWrites.update(
      request.principal,
      request.tenantContext,
      params.supplierId,
      body,
    );
  }
}
