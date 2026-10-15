import { Controller, Get, Param, Query, Req, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ApiS20PdfOperation } from '../api-contract/s20-openapi.decorators';
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
@ApiTags('Documents')
@ApiBearerAuth('bearer')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get('sales/:saleId.pdf')
  @ApiS20PdfOperation({
    operationId: 'documents.salePdf',
    summary: 'Download a canonical Sale PDF',
    description:
      'Renders the canonical Store-scoped Sale detail without creating any business, accounting, inventory, audit, or synchronization effect.',
  })
  async sale(
    @Req() request: AuthenticatedRequest,
    @Param() params: SaleIdParamDto,
  ): Promise<StreamableFile> {
    return this.file(
      await this.documents.generateSale(request.principal, request.tenantContext, params.saleId),
    );
  }

  @Get('customers/:customerId/ledger.pdf')
  @ApiS20PdfOperation({
    operationId: 'documents.customerLedgerPdf',
    summary: 'Download a Customer ledger PDF',
    description:
      'Renders the same bounded current receivable authority used by the Customer Receivables report.',
  })
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
  @ApiS20PdfOperation({
    operationId: 'documents.supplierLedgerPdf',
    summary: 'Download a Supplier ledger PDF',
    description:
      'Renders the same bounded current payable authority used by the Supplier Payables report.',
  })
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
  @ApiS20PdfOperation({
    operationId: 'documents.dailyReportPdf',
    summary: 'Download the daily operational report PDF',
    description: 'Renders exactly the canonical Daily report result for the supplied filters.',
  })
  async daily(
    @Req() request: AuthenticatedRequest,
    @Query() query: ReportDateRangeQueryDto,
  ): Promise<StreamableFile> {
    return this.file(
      await this.documents.generateDailyReport(request.principal, request.tenantContext, query),
    );
  }

  @Get('reports/monthly.pdf')
  @ApiS20PdfOperation({
    operationId: 'documents.monthlyReportPdf',
    summary: 'Download the monthly operational report PDF',
    description: 'Renders exactly the canonical Monthly report result for the supplied filters.',
  })
  async monthly(
    @Req() request: AuthenticatedRequest,
    @Query() query: ReportDateRangeQueryDto,
  ): Promise<StreamableFile> {
    return this.file(
      await this.documents.generateMonthlyReport(request.principal, request.tenantContext, query),
    );
  }

  @Get('reports/profit.pdf')
  @ApiS20PdfOperation({
    operationId: 'documents.profitReportPdf',
    summary: 'Download the operational profit report PDF',
    description:
      'Renders the canonical operational Profit report, including unknown-cost disclosure; it is not a statutory Profit and Loss statement.',
  })
  async profit(
    @Req() request: AuthenticatedRequest,
    @Query() query: ReportDateRangeQueryDto,
  ): Promise<StreamableFile> {
    return this.file(
      await this.documents.generateProfitReport(request.principal, request.tenantContext, query),
    );
  }

  @Get('reports/sales.pdf')
  @ApiS20PdfOperation({
    operationId: 'documents.salesReportPdf',
    summary: 'Download the Sales report PDF',
    description:
      'Renders exactly the requested bounded Sales report page. A continuation notice is included when another API page exists.',
  })
  async sales(
    @Req() request: AuthenticatedRequest,
    @Query() query: SalesReportQueryDto,
  ): Promise<StreamableFile> {
    return this.file(
      await this.documents.generateSalesReport(request.principal, request.tenantContext, query),
    );
  }

  @Get('reports/expenses.pdf')
  @ApiS20PdfOperation({
    operationId: 'documents.expensesReportPdf',
    summary: 'Download the Expense report PDF',
    description: 'Renders exactly the requested bounded Expense report page.',
  })
  async expenses(
    @Req() request: AuthenticatedRequest,
    @Query() query: ExpenseReportQueryDto,
  ): Promise<StreamableFile> {
    return this.file(
      await this.documents.generateExpensesReport(request.principal, request.tenantContext, query),
    );
  }

  @Get('reports/money-movements.pdf')
  @ApiS20PdfOperation({
    operationId: 'documents.moneyMovementsReportPdf',
    summary: 'Download the Money Movement report PDF',
    description: 'Renders exactly the requested bounded Money Movement report page.',
  })
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
  @ApiS20PdfOperation({
    operationId: 'documents.liquidityReportPdf',
    summary: 'Download the liquidity report PDF',
    description: 'Renders exactly the requested bounded current-liquidity report page.',
  })
  async liquidity(
    @Req() request: AuthenticatedRequest,
    @Query() query: LiquidityReportQueryDto,
  ): Promise<StreamableFile> {
    return this.file(
      await this.documents.generateLiquidityReport(request.principal, request.tenantContext, query),
    );
  }

  @Get('reports/customer-receivables.pdf')
  @ApiS20PdfOperation({
    operationId: 'documents.customerReceivablesReportPdf',
    summary: 'Download the Customer Receivables report PDF',
    description: 'Renders exactly the requested bounded current-receivables report page.',
  })
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
  @ApiS20PdfOperation({
    operationId: 'documents.supplierPayablesReportPdf',
    summary: 'Download the Supplier Payables report PDF',
    description: 'Renders exactly the requested bounded current-payables report page.',
  })
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
  @ApiS20PdfOperation({
    operationId: 'documents.inventoryStockReportPdf',
    summary: 'Download the inventory stock report PDF',
    description:
      'Renders exactly the requested bounded stock report page and preserves unknown/pending cost separately from zero.',
  })
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
  @ApiS20PdfOperation({
    operationId: 'documents.inventoryMovementsReportPdf',
    summary: 'Download the Inventory Movement report PDF',
    description: 'Renders exactly the requested bounded Inventory Movement report page.',
  })
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
  @ApiS20PdfOperation({
    operationId: 'documents.returnsCorrectionsReportPdf',
    summary: 'Download the Returns and Corrections report PDF',
    description: 'Renders exactly the requested bounded immutable correction-history page.',
  })
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
  @ApiS20PdfOperation({
    operationId: 'documents.ownerLedgerReportPdf',
    summary: 'Download the Owner Ledger report PDF',
    description: 'Renders exactly the requested bounded Owner Ledger page and current position.',
  })
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
