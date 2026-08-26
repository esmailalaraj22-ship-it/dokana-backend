import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { ListSuppliersQueryDto } from './dto/list-suppliers-query.dto';
import { SupplierIdParamDto } from './dto/supplier-id-param.dto';
import { SupplierReadService } from './supplier-read.service';
import type { SupplierDetailResponse, SupplierListResponse } from './supplier-read.types';

@Controller('suppliers')
@UseGuards(AuthenticationGuard)
export class SuppliersController {
  constructor(private readonly supplierReads: SupplierReadService) {}

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListSuppliersQueryDto,
  ): Promise<SupplierListResponse> {
    return this.supplierReads.list(request.principal, request.tenantContext, query);
  }

  @Get(':supplierId')
  getById(
    @Req() request: AuthenticatedRequest,
    @Param() params: SupplierIdParamDto,
  ): Promise<SupplierDetailResponse> {
    return this.supplierReads.getById(request.principal, request.tenantContext, params.supplierId);
  }
}
