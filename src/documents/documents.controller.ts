import { Controller, Get, Param, Query, Req, StreamableFile, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { CustomerIdParamDto } from '../customers/dto/customer-id-param.dto';
import {
  CustomerReceivableReportQueryDto,
  ExpenseReportQueryDto,
  InventoryMovementReportQueryDto,
  InventoryStockReportQueryDto,
  LiquidityReportQueryDto,
  MoneyMovementReportQueryDto,
  OwnerLedgerReportQueryDto,
  ReportDateRangeQueryDto,
  ReturnsCorrectionsReportQueryDto,
  SalesReportQueryDto,
  SupplierPayableReportQueryDto,
} from '../reports/dto/report-query.dto';
import { SaleIdParamDto } from '../sales/dto/sale-id-param.dto';
import { SupplierIdParamDto } from '../suppliers/dto/supplier-id-param.dto';
import type { GeneratedPdfDocument } from './document.types';
import { DocumentsService } from './documents.service';

@Controller('documents')
@UseGuards(AuthenticationGuard)
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get('sales/:saleId.pdf')
  async sale(
    @Req() request: AuthenticatedRequest,
    @Param() params: SaleIdParamDto,
  ): Promise<StreamableFile> {
    return this.file(
      await this.documents.generateSale(request.principal, request.tenantContext, params.saleId),
    );
  }

  @Get('customers/:customerId/ledger.pdf')
  async customerLedger(
    @Req() request: AuthenticatedRequest,
    @Param() params: CustomerIdParamDto,
  ): Promise<StreamableFile> {
    return this.file(
      await this.documents.generateCustomerLedger(
        request.principal,
        request.tenantContext,
        params.customerId,
      ),
    );
  }

  @Get('suppliers/:supplierId/ledger.pdf')
  async supplierLedger(
    @Req() request: AuthenticatedRequest,
    @Param() params: SupplierIdParamDto,
  ): Promise<StreamableFile> {
    return this.file(
      await this.documents.generateSupplierLedger(
        request.principal,
        request.tenantContext,
        params.supplierId,
      ),
    );
  }

  @Get('reports/daily.pdf')
  async daily(
    @Req() request: AuthenticatedRequest,
    @Query() query: ReportDateRangeQueryDto,
  ): Promise<StreamableFile> {
    return this.file(
      await this.documents.generateDailyReport(request.principal, request.tenantContext, query),
    );
  }

  @Get('reports/monthly.pdf')
  async monthly(
    @Req() request: AuthenticatedRequest,
    @Query() query: ReportDateRangeQueryDto,
  ): Promise<StreamableFile> {
    return this.file(
      await this.documents.generateMonthlyReport(request.principal, request.tenantContext, query),
    );
  }

  @Get('reports/profit.pdf')
  async profit(
    @Req() request: AuthenticatedRequest,
    @Query() query: ReportDateRangeQueryDto,
  ): Promise<StreamableFile> {
    return this.file(
      await this.documents.generateProfitReport(request.principal, request.tenantContext, query),
    );
  }

  @Get('reports/sales.pdf')
  async sales(
    @Req() request: AuthenticatedRequest,
    @Query() query: SalesReportQueryDto,
  ): Promise<StreamableFile> {
    return this.file(
      await this.documents.generateSalesReport(request.principal, request.tenantContext, query),
    );
  }

  @Get('reports/expenses.pdf')
  async expenses(
    @Req() request: AuthenticatedRequest,
    @Query() query: ExpenseReportQueryDto,
  ): Promise<StreamableFile> {
    return this.file(
      await this.documents.generateExpensesReport(request.principal, request.tenantContext, query),
    );
  }

  @Get('reports/money-movements.pdf')
  async moneyMovements(
    @Req() request: AuthenticatedRequest,
    @Query() query: MoneyMovementReportQueryDto,
  ): Promise<StreamableFile> {
    return this.file(
      await this.documents.generateMoneyMovementsReport(
        request.principal,
        request.tenantContext,
        query,
      ),
    );
  }

  @Get('reports/liquidity.pdf')
  async liquidity(
    @Req() request: AuthenticatedRequest,
    @Query() query: LiquidityReportQueryDto,
  ): Promise<StreamableFile> {
    return this.file(
      await this.documents.generateLiquidityReport(request.principal, request.tenantContext, query),
    );
  }

  @Get('reports/customer-receivables.pdf')
  async customerReceivables(
    @Req() request: AuthenticatedRequest,
    @Query() query: CustomerReceivableReportQueryDto,
  ): Promise<StreamableFile> {
    return this.file(
      await this.documents.generateCustomerReceivablesReport(
        request.principal,
        request.tenantContext,
        query,
      ),
    );
  }

  @Get('reports/supplier-payables.pdf')
  async supplierPayables(
    @Req() request: AuthenticatedRequest,
    @Query() query: SupplierPayableReportQueryDto,
  ): Promise<StreamableFile> {
    return this.file(
      await this.documents.generateSupplierPayablesReport(
        request.principal,
        request.tenantContext,
        query,
      ),
    );
  }

  @Get('reports/inventory-stock.pdf')
  async inventoryStock(
    @Req() request: AuthenticatedRequest,
    @Query() query: InventoryStockReportQueryDto,
  ): Promise<StreamableFile> {
    return this.file(
      await this.documents.generateInventoryStockReport(
        request.principal,
        request.tenantContext,
        query,
      ),
    );
  }

  @Get('reports/inventory-movements.pdf')
  async inventoryMovements(
    @Req() request: AuthenticatedRequest,
    @Query() query: InventoryMovementReportQueryDto,
  ): Promise<StreamableFile> {
    return this.file(
      await this.documents.generateInventoryMovementsReport(
        request.principal,
        request.tenantContext,
        query,
      ),
    );
  }

  @Get('reports/returns-corrections.pdf')
  async returnsCorrections(
    @Req() request: AuthenticatedRequest,
    @Query() query: ReturnsCorrectionsReportQueryDto,
  ): Promise<StreamableFile> {
    return this.file(
      await this.documents.generateReturnsCorrectionsReport(
        request.principal,
        request.tenantContext,
        query,
      ),
    );
  }

  @Get('reports/owner-ledger.pdf')
  async ownerLedger(
    @Req() request: AuthenticatedRequest,
    @Query() query: OwnerLedgerReportQueryDto,
  ): Promise<StreamableFile> {
    return this.file(
      await this.documents.generateOwnerLedgerReport(
        request.principal,
        request.tenantContext,
        query,
      ),
    );
  }

  private file(document: GeneratedPdfDocument): StreamableFile {
    return new StreamableFile(document.buffer, {
      type: document.contentType,
      disposition: `attachment; filename="${document.filename}"`,
      length: document.buffer.length,
    });
  }
}
