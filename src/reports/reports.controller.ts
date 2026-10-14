import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
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
} from './dto/report-query.dto';
import { ReportsService } from './reports.service';

@Controller('reports')
@UseGuards(AuthenticationGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('daily')
  readDaily(@Req() request: AuthenticatedRequest, @Query() query: ReportDateRangeQueryDto) {
    return this.reports.readDaily(request.principal, request.tenantContext, query);
  }

  @Get('monthly')
  readMonthly(@Req() request: AuthenticatedRequest, @Query() query: ReportDateRangeQueryDto) {
    return this.reports.readMonthly(request.principal, request.tenantContext, query);
  }

  @Get('profit')
  readProfit(@Req() request: AuthenticatedRequest, @Query() query: ReportDateRangeQueryDto) {
    return this.reports.readProfit(request.principal, request.tenantContext, query);
  }

  @Get('sales')
  readSales(@Req() request: AuthenticatedRequest, @Query() query: SalesReportQueryDto) {
    return this.reports.readSales(request.principal, request.tenantContext, query);
  }

  @Get('expenses')
  readExpenses(@Req() request: AuthenticatedRequest, @Query() query: ExpenseReportQueryDto) {
    return this.reports.readExpenses(request.principal, request.tenantContext, query);
  }

  @Get('money-movements')
  readMoneyMovements(
    @Req() request: AuthenticatedRequest,
    @Query() query: MoneyMovementReportQueryDto,
  ) {
    return this.reports.readMoneyMovements(request.principal, request.tenantContext, query);
  }

  @Get('liquidity')
  readLiquidity(@Req() request: AuthenticatedRequest, @Query() query: LiquidityReportQueryDto) {
    return this.reports.readLiquidity(request.principal, request.tenantContext, query);
  }

  @Get('customer-receivables')
  readCustomerReceivables(
    @Req() request: AuthenticatedRequest,
    @Query() query: CustomerReceivableReportQueryDto,
  ) {
    return this.reports.readCustomerReceivables(request.principal, request.tenantContext, query);
  }

  @Get('supplier-payables')
  readSupplierPayables(
    @Req() request: AuthenticatedRequest,
    @Query() query: SupplierPayableReportQueryDto,
  ) {
    return this.reports.readSupplierPayables(request.principal, request.tenantContext, query);
  }

  @Get('inventory-stock')
  readInventoryStock(
    @Req() request: AuthenticatedRequest,
    @Query() query: InventoryStockReportQueryDto,
  ) {
    return this.reports.readInventoryStock(request.principal, request.tenantContext, query);
  }

  @Get('inventory-movements')
  readInventoryMovements(
    @Req() request: AuthenticatedRequest,
    @Query() query: InventoryMovementReportQueryDto,
  ) {
    return this.reports.readInventoryMovements(request.principal, request.tenantContext, query);
  }

  @Get('returns-corrections')
  readReturnsCorrections(
    @Req() request: AuthenticatedRequest,
    @Query() query: ReturnsCorrectionsReportQueryDto,
  ) {
    return this.reports.readReturnsCorrections(request.principal, request.tenantContext, query);
  }

  @Get('owner-ledger')
  readOwnerLedger(@Req() request: AuthenticatedRequest, @Query() query: OwnerLedgerReportQueryDto) {
    return this.reports.readOwnerLedger(request.principal, request.tenantContext, query);
  }
}
