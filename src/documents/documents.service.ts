import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { isUUID } from 'class-validator';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type {
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
import { ReportsService } from '../reports/reports.service';
import type {
  OperationalSummaryResponse,
  ProfitReportResponse,
  ReportPageResponse,
} from '../reports/reports.types';
import { SaleReadService } from '../sales/sale-read.service';
import type { SaleDetailResponse } from '../sales/sale-read.types';
import {
  formatCanonicalDocumentValue,
  objectFields,
  objectRows,
  safePdfFilename,
} from './document-format';
import { DocumentPdfRenderer } from './document-pdf.renderer';
import type {
  CanonicalDocumentField,
  CanonicalPdfDocumentModel,
  GeneratedPdfDocument,
} from './document.types';

type DocumentsPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'storeName' | 'userId' | 'deviceId'
>;

interface PagedReportDocumentSource {
  asOf: string;
  timezoneName: string;
  dateAuthority: string;
  filters: object;
  items: object[];
  totals: { page: object; filtered: object };
  pagination: { limit: number; nextCursor: string | null };
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly sales: SaleReadService,
    private readonly reports: ReportsService,
    private readonly renderer: DocumentPdfRenderer,
  ) {}

  async generateSale(
    principal: DocumentsPrincipal,
    context: TenantTransactionContext,
    saleIdInput: string,
  ): Promise<GeneratedPdfDocument> {
    const saleId = this.canonicalUuid(saleIdInput, 'saleId');
    const source = await this.sales.getById(principal, context, saleId);
    return this.generate(this.saleModel(principal, source));
  }

  async generateCustomerLedger(
    principal: DocumentsPrincipal,
    context: TenantTransactionContext,
    customerIdInput: string,
  ): Promise<GeneratedPdfDocument> {
    const customerId = this.canonicalUuid(customerIdInput, 'customerId');
    const source = await this.reports.readCustomerReceivables(principal, context, {
      customerId,
      limit: 1,
    });
    if (source.items.length !== 1) this.documentNotFound();
    const model = this.pagedReportModel(
      principal,
      'customer-ledger',
      'Customer Ledger',
      `customer-ledger-${customerId}.pdf`,
      source,
      customerId,
    );
    return this.generate(model);
  }

  async generateSupplierLedger(
    principal: DocumentsPrincipal,
    context: TenantTransactionContext,
    supplierIdInput: string,
  ): Promise<GeneratedPdfDocument> {
    const supplierId = this.canonicalUuid(supplierIdInput, 'supplierId');
    const source = await this.reports.readSupplierPayables(principal, context, {
      supplierId,
      limit: 1,
    });
    if (source.items.length !== 1) this.documentNotFound();
    const model = this.pagedReportModel(
      principal,
      'supplier-ledger',
      'Supplier Ledger',
      `supplier-ledger-${supplierId}.pdf`,
      source,
      supplierId,
    );
    return this.generate(model);
  }

  async generateDailyReport(
    principal: DocumentsPrincipal,
    context: TenantTransactionContext,
    query: ReportDateRangeQueryDto,
  ): Promise<GeneratedPdfDocument> {
    return this.generate(
      this.summaryReportModel(
        principal,
        'daily-report',
        'Daily Operational Report',
        'report-daily.pdf',
        await this.reports.readDaily(principal, context, query),
      ),
    );
  }

  async generateMonthlyReport(
    principal: DocumentsPrincipal,
    context: TenantTransactionContext,
    query: ReportDateRangeQueryDto,
  ): Promise<GeneratedPdfDocument> {
    return this.generate(
      this.summaryReportModel(
        principal,
        'monthly-report',
        'Monthly Operational Report',
        'report-monthly.pdf',
        await this.reports.readMonthly(principal, context, query),
      ),
    );
  }

  async generateProfitReport(
    principal: DocumentsPrincipal,
    context: TenantTransactionContext,
    query: ReportDateRangeQueryDto,
  ): Promise<GeneratedPdfDocument> {
    const source = await this.reports.readProfit(principal, context, query);
    return this.generate(this.profitReportModel(principal, source));
  }

  async generateSalesReport(
    principal: DocumentsPrincipal,
    context: TenantTransactionContext,
    query: SalesReportQueryDto,
  ): Promise<GeneratedPdfDocument> {
    return this.generate(
      this.pagedReportModel(
        principal,
        'sales-report',
        'Sales Report',
        'report-sales.pdf',
        await this.reports.readSales(principal, context, query),
      ),
    );
  }

  async generateExpensesReport(
    principal: DocumentsPrincipal,
    context: TenantTransactionContext,
    query: ExpenseReportQueryDto,
  ): Promise<GeneratedPdfDocument> {
    return this.generate(
      this.pagedReportModel(
        principal,
        'expenses-report',
        'Expenses Report',
        'report-expenses.pdf',
        await this.reports.readExpenses(principal, context, query),
      ),
    );
  }

  async generateMoneyMovementsReport(
    principal: DocumentsPrincipal,
    context: TenantTransactionContext,
    query: MoneyMovementReportQueryDto,
  ): Promise<GeneratedPdfDocument> {
    return this.generate(
      this.pagedReportModel(
        principal,
        'money-movements-report',
        'Money Movements Report',
        'report-money-movements.pdf',
        await this.reports.readMoneyMovements(principal, context, query),
      ),
    );
  }

  async generateLiquidityReport(
    principal: DocumentsPrincipal,
    context: TenantTransactionContext,
    query: LiquidityReportQueryDto,
  ): Promise<GeneratedPdfDocument> {
    return this.generate(
      this.pagedReportModel(
        principal,
        'liquidity-report',
        'Liquidity Report',
        'report-liquidity.pdf',
        await this.reports.readLiquidity(principal, context, query),
      ),
    );
  }

  async generateCustomerReceivablesReport(
    principal: DocumentsPrincipal,
    context: TenantTransactionContext,
    query: CustomerReceivableReportQueryDto,
  ): Promise<GeneratedPdfDocument> {
    return this.generate(
      this.pagedReportModel(
        principal,
        'customer-receivables-report',
        'Customer Receivables Report',
        'report-customer-receivables.pdf',
        await this.reports.readCustomerReceivables(principal, context, query),
      ),
    );
  }

  async generateSupplierPayablesReport(
    principal: DocumentsPrincipal,
    context: TenantTransactionContext,
    query: SupplierPayableReportQueryDto,
  ): Promise<GeneratedPdfDocument> {
    return this.generate(
      this.pagedReportModel(
        principal,
        'supplier-payables-report',
        'Supplier Payables Report',
        'report-supplier-payables.pdf',
        await this.reports.readSupplierPayables(principal, context, query),
      ),
    );
  }

  async generateInventoryStockReport(
    principal: DocumentsPrincipal,
    context: TenantTransactionContext,
    query: InventoryStockReportQueryDto,
  ): Promise<GeneratedPdfDocument> {
    return this.generate(
      this.pagedReportModel(
        principal,
        'inventory-stock-report',
        'Inventory Stock Report',
        'report-inventory-stock.pdf',
        await this.reports.readInventoryStock(principal, context, query),
      ),
    );
  }

  async generateInventoryMovementsReport(
    principal: DocumentsPrincipal,
    context: TenantTransactionContext,
    query: InventoryMovementReportQueryDto,
  ): Promise<GeneratedPdfDocument> {
    return this.generate(
      this.pagedReportModel(
        principal,
        'inventory-movements-report',
        'Inventory Movements Report',
        'report-inventory-movements.pdf',
        await this.reports.readInventoryMovements(principal, context, query),
      ),
    );
  }

  async generateReturnsCorrectionsReport(
    principal: DocumentsPrincipal,
    context: TenantTransactionContext,
    query: ReturnsCorrectionsReportQueryDto,
  ): Promise<GeneratedPdfDocument> {
    return this.generate(
      this.pagedReportModel(
        principal,
        'returns-corrections-report',
        'Returns and Corrections Report',
        'report-returns-corrections.pdf',
        await this.reports.readReturnsCorrections(principal, context, query),
      ),
    );
  }

  async generateOwnerLedgerReport(
    principal: DocumentsPrincipal,
    context: TenantTransactionContext,
    query: OwnerLedgerReportQueryDto,
  ): Promise<GeneratedPdfDocument> {
    const source = await this.reports.readOwnerLedger(principal, context, query);
    const model = this.pagedReportModel(
      principal,
      'owner-ledger-report',
      'Owner Ledger Report',
      'report-owner-ledger.pdf',
      source,
    );
    model.sections.push({
      title: 'Current Position',
      fields: objectFields(source.currentPosition),
    });
    return this.generate(model);
  }

  saleModel(principal: DocumentsPrincipal, source: SaleDetailResponse): CanonicalPdfDocumentModel {
    const correctionNotices: string[] = [];
    if (source.sale.status !== 'posted') {
      correctionNotices.push(`Sale status: ${source.sale.status}`);
    }
    if (source.sale.correctionOfId) {
      correctionNotices.push(`Correction of Sale: ${source.sale.correctionOfId}`);
    }
    if (source.sale.reversedById) {
      correctionNotices.push(`Reversed by Sale: ${source.sale.reversedById}`);
    }
    if (source.sale.cancelledAt) {
      correctionNotices.push(`Cancelled at: ${source.sale.cancelledAt}`);
    }

    const customerFields: CanonicalDocumentField[] = source.sale.customer
      ? [
          { label: 'Customer ID', value: source.sale.customer.id },
          { label: 'Customer name', value: source.sale.customer.name },
          { label: 'Customer phone', value: source.sale.customer.phone },
          { label: 'Customer status', value: source.sale.customer.status },
        ]
      : [{ label: 'Customer', value: 'Anonymous fully paid Sale' }];

    const sections = [
      {
        title: 'Sale',
        fields: [
          { label: 'Sale ID', value: source.sale.id },
          { label: 'Display number', value: source.sale.displayNumber },
          { label: 'Status', value: source.sale.status },
          { label: 'Payment status', value: source.sale.paymentStatus },
          { label: 'Business date', value: source.sale.businessDate },
          { label: 'Posting date', value: source.sale.postingDate },
          { label: 'Occurred at (UTC)', value: source.sale.occurredAt },
          { label: 'Notes', value: source.sale.notes ?? 'None' },
        ],
      },
      { title: 'Customer', fields: customerFields },
      {
        title: 'Canonical Totals',
        fields: [
          this.moneyField('Items subtotal', source.sale.itemsSubtotalMinor),
          this.moneyField('Line discounts', source.sale.lineDiscountTotalMinor),
          this.moneyField('Invoice discount', source.sale.invoiceDiscountMinor),
          this.moneyField('Rounding', source.sale.roundingMinor),
          this.moneyField('Sale total', source.sale.totalMinor),
          this.moneyField('Money paid', source.sale.moneyPaidTotalMinor),
          this.moneyField('Customer credit used', source.sale.customerCreditUsedMinor),
          this.moneyField('Paid total', source.sale.paidTotalMinor),
          this.moneyField('Receivable originated', source.sale.receivableOriginatedMinor),
          this.moneyField('Receivable outstanding', source.sale.receivableOutstandingMinor),
        ],
      },
    ];

    if (source.customerCreditTender) {
      sections.push({
        title: 'Customer Credit Tender',
        fields: [
          this.moneyField('Amount', source.customerCreditTender.amountMinor),
          { label: 'Applied at (UTC)', value: source.customerCreditTender.appliedAt },
        ],
      });
    }
    if (source.receivable) {
      sections.push({
        title: 'Receivable',
        fields: [
          { label: 'Entry type', value: source.receivable.entryType },
          this.moneyField('Original amount', source.receivable.originalAmountMinor),
          this.moneyField('Outstanding', source.receivable.outstandingMinor),
          { label: 'Business date', value: source.receivable.businessDate },
          { label: 'Posting date', value: source.receivable.postingDate },
          { label: 'Occurred at (UTC)', value: source.receivable.occurredAt },
          { label: 'Reason', value: source.receivable.reason ?? 'None' },
        ],
      });
    }

    return {
      documentType: 'sale',
      title: 'Sale Document',
      filename: safePdfFilename(`sale-${source.sale.id}.pdf`),
      storeName: principal.storeName,
      generatedAt: new Date().toISOString(),
      reference: source.sale.displayNumber,
      notices: correctionNotices,
      sections,
      tables: [
        objectRows(
          'Items',
          source.items.map((item) => ({
            productName: item.productName,
            unitName: item.unitName,
            quantityMilli: item.quantityMilli,
            unitPriceMinor: item.unitPriceMinor,
            lineGrossMinor: item.lineGrossMinor,
            lineDiscountMinor: item.lineDiscountMinor,
            roundingMinor: item.roundingMinor,
            lineTotalMinor: item.lineTotalMinor,
          })),
        ),
        objectRows(
          'Payments',
          source.tenders.map((tender) => ({
            moneyAccountName: tender.moneyAccount.name,
            accountType: tender.moneyAccount.accountType,
            amountMinor: tender.amountMinor,
            paymentAt: tender.paymentAt,
            senderAccountName: tender.senderAccountName,
            externalReference: tender.externalReference,
          })),
        ),
      ],
    };
  }

  private summaryReportModel(
    principal: DocumentsPrincipal,
    type: string,
    title: string,
    filename: string,
    source: OperationalSummaryResponse,
  ): CanonicalPdfDocumentModel {
    return {
      documentType: type,
      title,
      filename: safePdfFilename(filename),
      storeName: principal.storeName,
      generatedAt: source.asOf,
      reference: null,
      notices: [],
      sections: [
        { title: 'Authority', fields: this.reportAuthorityFields(source) },
        { title: 'Filters', fields: objectFields(source.filters) },
        { title: 'Totals', fields: objectFields(source.totals) },
      ],
      tables: [objectRows('Rows', source.rows)],
    };
  }

  private profitReportModel(
    principal: DocumentsPrincipal,
    source: ProfitReportResponse,
  ): CanonicalPdfDocumentModel {
    const values = {
      netSalesMinor: source.netSalesMinor,
      grossSalesMinor: source.grossSalesMinor,
      saleReturnsMinor: source.saleReturnsMinor,
      knownCogsMinor: source.knownCogsMinor,
      restoredReturnCostMinor: source.restoredReturnCostMinor,
      netKnownCogsMinor: source.netKnownCogsMinor,
      expensesMinor: source.expensesMinor,
      knownInventoryLossesMinor: source.knownInventoryLossesMinor,
      profitMinor: source.profitMinor,
      profitCostComplete: source.profitCostComplete,
      unknownReturnCostMovementCount: source.unknownReturnCostMovementCount,
      unknownLossCostMovementCount: source.unknownLossCostMovementCount,
      costCoverage: source.costCoverage,
    };
    return {
      documentType: 'profit-report',
      title: 'Profit Report',
      filename: safePdfFilename('report-profit.pdf'),
      storeName: principal.storeName,
      generatedAt: source.asOf,
      reference: null,
      notices: source.profitCostComplete
        ? []
        : ['Profit is incomplete because one or more authoritative costs are unknown.'],
      sections: [
        { title: 'Authority', fields: this.reportAuthorityFields(source) },
        { title: 'Filters', fields: objectFields(source.filters) },
        { title: 'Canonical Values', fields: objectFields(values) },
      ],
      tables: [],
    };
  }

  private pagedReportModel<Item extends object, Totals extends object>(
    principal: DocumentsPrincipal,
    type: string,
    title: string,
    filename: string,
    source: ReportPageResponse<Item, Totals, Record<string, unknown>> & object,
    reference: string | null = null,
  ): CanonicalPdfDocumentModel {
    const pagedSource: PagedReportDocumentSource = source;
    const notices = pagedSource.pagination.nextCursor
      ? [
          'More results are available. This PDF represents exactly the requested bounded report page; use the API continuation cursor for the next page.',
        ]
      : [];
    return {
      documentType: type,
      title,
      filename: safePdfFilename(filename),
      storeName: principal.storeName,
      generatedAt: pagedSource.asOf,
      reference,
      notices,
      sections: [
        { title: 'Authority', fields: this.reportAuthorityFields(pagedSource) },
        { title: 'Filters', fields: objectFields(pagedSource.filters) },
        { title: 'Page Totals', fields: objectFields(pagedSource.totals.page) },
        { title: 'Filtered Totals', fields: objectFields(pagedSource.totals.filtered) },
        {
          title: 'Pagination',
          fields: [
            { label: 'Page limit', value: pagedSource.pagination.limit.toString() },
            {
              label: 'More results available',
              value: pagedSource.pagination.nextCursor ? 'Yes' : 'No',
            },
          ],
        },
      ],
      tables: [objectRows('Rows', pagedSource.items)],
    };
  }

  private reportAuthorityFields(source: {
    asOf: string;
    timezoneName: string;
    dateAuthority: string;
  }): CanonicalDocumentField[] {
    return [
      { label: 'As of', value: source.asOf },
      { label: 'Timezone', value: source.timezoneName },
      { label: 'Date authority', value: source.dateAuthority },
    ];
  }

  private moneyField(label: string, value: string): CanonicalDocumentField {
    return { label, value: formatCanonicalDocumentValue('amountMinor', value) };
  }

  private async generate(model: CanonicalPdfDocumentModel): Promise<GeneratedPdfDocument> {
    return {
      filename: model.filename,
      contentType: 'application/pdf',
      buffer: await this.renderer.render(model),
      model,
    };
  }

  private canonicalUuid(value: string, field: string): string {
    if (!isUUID(value)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
        details: [{ field, constraints: ['isUuid'] }],
      });
    }
    return value.toLowerCase();
  }

  private documentNotFound(): never {
    throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND', message: 'Document not found.' });
  }
}
