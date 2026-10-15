import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ApiS20JsonOperation } from '../api-contract/s20-openapi.decorators';
import { S20_SCHEMA_NAMES } from '../api-contract/s20-openapi.schemas';
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
@ApiTags('Reports')
@ApiBearerAuth('bearer')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('daily')
  @ApiS20JsonOperation({
    operationId: 'reports.daily',
    summary: 'Read the daily operational summary',
    description: 'Aggregates canonical operations by Store-local businessDate.',
    schemaName: S20_SCHEMA_NAMES.operationalSummary,
    validation: true,
  })
  readDaily(@Req() request: AuthenticatedRequest, @Query() query: ReportDateRangeQueryDto) {
    return this.reports.readDaily(request.principal, request.tenantContext, query);
  }

  @Get('monthly')
  @ApiS20JsonOperation({
    operationId: 'reports.monthly',
    summary: 'Read the monthly operational summary',
    description: 'Aggregates canonical operations by Store-local business month.',
    schemaName: S20_SCHEMA_NAMES.operationalSummary,
    validation: true,
  })
  readMonthly(@Req() request: AuthenticatedRequest, @Query() query: ReportDateRangeQueryDto) {
    return this.reports.readMonthly(request.principal, request.tenantContext, query);
  }

  @Get('profit')
  @ApiS20JsonOperation({
    operationId: 'reports.profit',
    summary: 'Read the operational profit report',
    description:
      'Uses canonical posted Sales, returns, known COGS, expenses, and known inventory losses. Unknown costs make profitMinor null. This is an operational report, not a statutory Profit and Loss statement.',
    schemaName: S20_SCHEMA_NAMES.profit,
    validation: true,
  })
  readProfit(@Req() request: AuthenticatedRequest, @Query() query: ReportDateRangeQueryDto) {
    return this.reports.readProfit(request.principal, request.tenantContext, query);
  }

  @Get('sales')
  @ApiS20JsonOperation({
    operationId: 'reports.sales',
    summary: 'Read the Sales report',
    description: 'Returns a bounded canonical Sale history with correction and return state.',
    schemaName: S20_SCHEMA_NAMES.sales,
    validation: true,
  })
  readSales(@Req() request: AuthenticatedRequest, @Query() query: SalesReportQueryDto) {
    return this.reports.readSales(request.principal, request.tenantContext, query);
  }

  @Get('expenses')
  @ApiS20JsonOperation({
    operationId: 'reports.expenses',
    summary: 'Read the Expense report',
    description: 'Returns bounded canonical Expense recognition and settlement state.',
    schemaName: S20_SCHEMA_NAMES.expenses,
    validation: true,
  })
  readExpenses(@Req() request: AuthenticatedRequest, @Query() query: ExpenseReportQueryDto) {
    return this.reports.readExpenses(request.principal, request.tenantContext, query);
  }

  @Get('money-movements')
  @ApiS20JsonOperation({
    operationId: 'reports.moneyMovements',
    summary: 'Read the Money Movement report',
    description: 'Returns bounded authoritative posted Money Movement history.',
    schemaName: S20_SCHEMA_NAMES.moneyMovements,
    validation: true,
  })
  readMoneyMovements(
    @Req() request: AuthenticatedRequest,
    @Query() query: MoneyMovementReportQueryDto,
  ) {
    return this.reports.readMoneyMovements(request.principal, request.tenantContext, query);
  }

  @Get('liquidity')
  @ApiS20JsonOperation({
    operationId: 'reports.liquidity',
    summary: 'Read current liquidity',
    description: 'Returns active available Money Accounts and their canonical projected balances.',
    schemaName: S20_SCHEMA_NAMES.liquidity,
    validation: true,
  })
  readLiquidity(@Req() request: AuthenticatedRequest, @Query() query: LiquidityReportQueryDto) {
    return this.reports.readLiquidity(request.principal, request.tenantContext, query);
  }

  @Get('customer-receivables')
  @ApiS20JsonOperation({
    operationId: 'reports.customerReceivables',
    summary: 'Read current Customer receivables',
    description: 'Returns current canonical Customer receivable, credit, and net-due projections.',
    schemaName: S20_SCHEMA_NAMES.customerReceivables,
    validation: true,
  })
  readCustomerReceivables(
    @Req() request: AuthenticatedRequest,
    @Query() query: CustomerReceivableReportQueryDto,
  ) {
    return this.reports.readCustomerReceivables(request.principal, request.tenantContext, query);
  }

  @Get('supplier-payables')
  @ApiS20JsonOperation({
    operationId: 'reports.supplierPayables',
    summary: 'Read current Supplier payables',
    description: 'Returns current canonical Supplier payable, credit, and net-payable projections.',
    schemaName: S20_SCHEMA_NAMES.supplierPayables,
    validation: true,
  })
  readSupplierPayables(
    @Req() request: AuthenticatedRequest,
    @Query() query: SupplierPayableReportQueryDto,
  ) {
    return this.reports.readSupplierPayables(request.principal, request.tenantContext, query);
  }

  @Get('inventory-stock')
  @ApiS20JsonOperation({
    operationId: 'reports.inventoryStock',
    summary: 'Read current inventory stock',
    description:
      'Returns authoritative stock projections while preserving known, unknown, and pending cost states.',
    schemaName: S20_SCHEMA_NAMES.inventoryStock,
    validation: true,
  })
  readInventoryStock(
    @Req() request: AuthenticatedRequest,
    @Query() query: InventoryStockReportQueryDto,
  ) {
    return this.reports.readInventoryStock(request.principal, request.tenantContext, query);
  }

  @Get('inventory-movements')
  @ApiS20JsonOperation({
    operationId: 'reports.inventoryMovements',
    summary: 'Read Inventory Movement history',
    description: 'Returns bounded authoritative Inventory Movement history by postingDate.',
    schemaName: S20_SCHEMA_NAMES.inventoryMovements,
    validation: true,
  })
  readInventoryMovements(
    @Req() request: AuthenticatedRequest,
    @Query() query: InventoryMovementReportQueryDto,
  ) {
    return this.reports.readInventoryMovements(request.principal, request.tenantContext, query);
  }

  @Get('returns-corrections')
  @ApiS20JsonOperation({
    operationId: 'reports.returnsCorrections',
    summary: 'Read Returns and Corrections history',
    description: 'Returns bounded immutable return, reversal, and replacement history.',
    schemaName: S20_SCHEMA_NAMES.returnsCorrections,
    validation: true,
  })
  readReturnsCorrections(
    @Req() request: AuthenticatedRequest,
    @Query() query: ReturnsCorrectionsReportQueryDto,
  ) {
    return this.reports.readReturnsCorrections(request.principal, request.tenantContext, query);
  }

  @Get('owner-ledger')
  @ApiS20JsonOperation({
    operationId: 'reports.ownerLedger',
    summary: 'Read Owner Ledger history and position',
    description: 'Returns bounded canonical Owner Ledger history plus the current owner position.',
    schemaName: S20_SCHEMA_NAMES.ownerLedger,
    validation: true,
  })
  readOwnerLedger(@Req() request: AuthenticatedRequest, @Query() query: OwnerLedgerReportQueryDto) {
    return this.reports.readOwnerLedger(request.principal, request.tenantContext, query);
  }
}
