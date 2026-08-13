import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { CustomerReadService } from './customer-read.service';
import type { CustomerDetailResponse, CustomerListResponse } from './customer-read.types';
import { CustomerIdParamDto } from './dto/customer-id-param.dto';
import { ListCustomersQueryDto } from './dto/list-customers-query.dto';

@Controller('customers')
@UseGuards(AuthenticationGuard)
export class CustomersController {
  constructor(private readonly customers: CustomerReadService) {}

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListCustomersQueryDto,
  ): Promise<CustomerListResponse> {
    return this.customers.list(request.tenantContext, query);
  }

  @Get(':customerId')
  getById(
    @Req() request: AuthenticatedRequest,
    @Param() params: CustomerIdParamDto,
  ): Promise<CustomerDetailResponse> {
    return this.customers.getById(request.tenantContext, params.customerId);
  }
}
