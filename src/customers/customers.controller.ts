import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { CustomerReadService } from './customer-read.service';
import type { CustomerDetailResponse, CustomerListResponse } from './customer-read.types';
import { CustomerWriteService } from './customer-write.service';
import type { CustomerMutationResponse } from './customer-write.types';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { CustomerIdParamDto } from './dto/customer-id-param.dto';
import { ListCustomersQueryDto } from './dto/list-customers-query.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

@Controller('customers')
@UseGuards(AuthenticationGuard)
export class CustomersController {
  constructor(
    private readonly customerReads: CustomerReadService,
    private readonly customerWrites: CustomerWriteService,
  ) {}

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListCustomersQueryDto,
  ): Promise<CustomerListResponse> {
    return this.customerReads.list(request.tenantContext, query);
  }

  @Get(':customerId')
  getById(
    @Req() request: AuthenticatedRequest,
    @Param() params: CustomerIdParamDto,
  ): Promise<CustomerDetailResponse> {
    return this.customerReads.getById(request.tenantContext, params.customerId);
  }

  @Post()
  create(
    @Req() request: AuthenticatedRequest,
    @Body() body: CreateCustomerDto,
  ): Promise<CustomerMutationResponse> {
    return this.customerWrites.create(request.tenantContext, body);
  }

  @Patch(':customerId')
  update(
    @Req() request: AuthenticatedRequest,
    @Param() params: CustomerIdParamDto,
    @Body() body: UpdateCustomerDto,
  ): Promise<CustomerMutationResponse> {
    return this.customerWrites.update(request.tenantContext, params.customerId, body);
  }
}
