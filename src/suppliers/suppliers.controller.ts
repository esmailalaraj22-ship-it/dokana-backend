import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { ListSupplierInvoicesQueryDto } from './dto/list-supplier-invoices-query.dto';
import { ListSuppliersQueryDto } from './dto/list-suppliers-query.dto';
import { SupplierIdParamDto } from './dto/supplier-id-param.dto';
import { SupplierInvoiceIdParamDto } from './dto/supplier-invoice-id-param.dto';
import { SupplierLifecycleDto } from './dto/supplier-lifecycle.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { SupplierFinancialReadService } from './supplier-financial-read.service';
import type {
  SupplierFinancialResponse,
  SupplierInvoiceDetailResponse,
} from './supplier-financial-read.types';
import { SupplierReadService } from './supplier-read.service';
import { SupplierInvoiceCorrectionService } from './supplier-invoice-correction.service';
import type { SupplierFinancialCorrectionResponse } from './supplier-invoice-correction.types';
import { SupplierInvoicePostingService } from './supplier-invoice-posting.service';
import type {
  SupplierInvoicePostingResponse,
  SupplierOpeningPayableResponse,
} from './supplier-invoice-posting.types';
import { SupplierPaymentPostingService } from './supplier-payment-posting.service';
import type { SupplierPaymentPostingResponse } from './supplier-payment-posting.types';
import type { SupplierDetailResponse, SupplierListResponse } from './supplier-read.types';
import { SupplierWriteService } from './supplier-write.service';
import type { SupplierMutationResponse } from './supplier-write.types';

@Controller('suppliers')
@UseGuards(AuthenticationGuard)
export class SuppliersController {
  constructor(
    private readonly supplierFinancialReads: SupplierFinancialReadService,
    private readonly supplierInvoiceCorrections: SupplierInvoiceCorrectionService,
    private readonly supplierInvoicePosting: SupplierInvoicePostingService,
    private readonly supplierPaymentPosting: SupplierPaymentPostingService,
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

  @Get(':supplierId/invoices')
  getFinancialView(
    @Req() request: AuthenticatedRequest,
    @Param() params: SupplierIdParamDto,
    @Query() query: ListSupplierInvoicesQueryDto,
  ): Promise<SupplierFinancialResponse> {
    return this.supplierFinancialReads.getSupplierFinancialView(
      request.principal,
      request.tenantContext,
      params.supplierId,
      query,
    );
  }

  @Post(':supplierId/invoices')
  postInvoice(
    @Req() request: AuthenticatedRequest,
    @Param() params: SupplierIdParamDto,
    @Body() body: unknown,
  ): Promise<SupplierInvoicePostingResponse> {
    return this.supplierInvoicePosting.postInvoice(
      request.principal,
      request.tenantContext,
      params.supplierId,
      body,
    );
  }

  @Post(':supplierId/opening-payables')
  postOpeningPayable(
    @Req() request: AuthenticatedRequest,
    @Param() params: SupplierIdParamDto,
    @Body() body: unknown,
  ): Promise<SupplierOpeningPayableResponse> {
    return this.supplierInvoicePosting.postOpeningPayable(
      request.principal,
      request.tenantContext,
      params.supplierId,
      body,
    );
  }

  @Post(':supplierId/payments')
  postPayment(
    @Req() request: AuthenticatedRequest,
    @Param() params: SupplierIdParamDto,
    @Body() body: unknown,
  ): Promise<SupplierPaymentPostingResponse> {
    return this.supplierPaymentPosting.post(
      request.principal,
      request.tenantContext,
      params.supplierId,
      body,
    );
  }

  @Post('invoices/:targetOperationId/cancel')
  cancelInvoice(
    @Req() request: AuthenticatedRequest,
    @Param('targetOperationId') targetOperationId: string,
    @Body() body: unknown,
  ): Promise<SupplierFinancialCorrectionResponse> {
    return this.supplierInvoiceCorrections.cancelInvoice(
      request.principal,
      request.tenantContext,
      targetOperationId,
      body,
    );
  }

  @Post('invoices/:targetOperationId/edit')
  editInvoice(
    @Req() request: AuthenticatedRequest,
    @Param('targetOperationId') targetOperationId: string,
    @Body() body: unknown,
  ): Promise<SupplierFinancialCorrectionResponse> {
    return this.supplierInvoiceCorrections.editInvoice(
      request.principal,
      request.tenantContext,
      targetOperationId,
      body,
    );
  }

  @Post('opening-payables/:targetOperationId/cancel')
  cancelOpeningPayable(
    @Req() request: AuthenticatedRequest,
    @Param('targetOperationId') targetOperationId: string,
    @Body() body: unknown,
  ): Promise<SupplierFinancialCorrectionResponse> {
    return this.supplierInvoiceCorrections.cancelOpeningPayable(
      request.principal,
      request.tenantContext,
      targetOperationId,
      body,
    );
  }

  @Post('opening-payables/:targetOperationId/edit')
  editOpeningPayable(
    @Req() request: AuthenticatedRequest,
    @Param('targetOperationId') targetOperationId: string,
    @Body() body: unknown,
  ): Promise<SupplierFinancialCorrectionResponse> {
    return this.supplierInvoiceCorrections.editOpeningPayable(
      request.principal,
      request.tenantContext,
      targetOperationId,
      body,
    );
  }

  @Get(':supplierId/invoices/:invoiceId')
  getInvoice(
    @Req() request: AuthenticatedRequest,
    @Param() params: SupplierInvoiceIdParamDto,
  ): Promise<SupplierInvoiceDetailResponse> {
    return this.supplierFinancialReads.getSupplierInvoice(
      request.principal,
      request.tenantContext,
      params.supplierId,
      params.invoiceId,
    );
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

  @Post(':supplierId/archive')
  @HttpCode(200)
  archive(
    @Req() request: AuthenticatedRequest,
    @Param() params: SupplierIdParamDto,
    @Body() body: SupplierLifecycleDto,
  ): Promise<SupplierMutationResponse> {
    return this.supplierWrites.archive(
      request.principal,
      request.tenantContext,
      params.supplierId,
      body,
    );
  }

  @Post(':supplierId/restore')
  @HttpCode(200)
  restore(
    @Req() request: AuthenticatedRequest,
    @Param() params: SupplierIdParamDto,
    @Body() body: SupplierLifecycleDto,
  ): Promise<SupplierMutationResponse> {
    return this.supplierWrites.restore(
      request.principal,
      request.tenantContext,
      params.supplierId,
      body,
    );
  }
}
