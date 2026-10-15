import { randomUUID } from 'node:crypto';

import { NotFoundException } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type { ReportsService } from '../reports/reports.service';
import type { SaleReadService } from '../sales/sale-read.service';
import type { SaleDetailResponse } from '../sales/sale-read.types';
import type { DocumentPdfRenderer } from './document-pdf.renderer';
import { DocumentsService } from './documents.service';

const storeId = randomUUID();
const userId = randomUUID();
const deviceId = randomUUID();
const principal = {
  storeId,
  storeName: 'Dokana Test Store',
  userId,
  deviceId,
  membershipRole: 'owner',
} as AuthenticatedPrincipal;
const context: TenantTransactionContext = {
  storeId,
  userId,
  deviceId,
  requestId: randomUUID(),
};

function saleSource(): SaleDetailResponse {
  const saleId = randomUUID();
  return {
    sale: {
      id: saleId,
      displayNumber: 'SALE-42',
      occurredAt: '2026-10-15T08:00:00.000Z',
      businessDate: '2026-10-15',
      postingDate: '2026-10-15',
      accountingPeriodId: randomUUID(),
      customer: null,
      isAnonymous: true,
      status: 'corrected',
      paymentStatus: 'paid',
      totalMinor: '900719925474099312345',
      moneyPaidTotalMinor: '900719925474099312345',
      customerCreditUsedMinor: '0',
      paidTotalMinor: '900719925474099312345',
      receivableOriginatedMinor: '0',
      receivableOutstandingMinor: '0',
      createdAt: '2026-10-15T08:00:00.000Z',
      updatedAt: '2026-10-15T08:00:00.000Z',
      version: '3',
      itemsSubtotalMinor: '900719925474099312345',
      lineDiscountTotalMinor: '0',
      invoiceDiscountMinor: '0',
      roundingMinor: '0',
      knownCostTotalMinor: '0',
      pendingCostLineCount: 0,
      unknownCostLineCount: 1,
      notes: 'نص عربي <safe>',
      correctionOfId: randomUUID(),
      reversedById: null,
      cancelledAt: null,
    },
    items: [
      {
        id: randomUUID(),
        productId: null,
        productUnitId: null,
        isManualLine: true,
        productName: 'خدمة',
        unitName: null,
        quantityMilli: '1250',
        conversionFactorNumerator: 1,
        conversionFactorDenominator: 1,
        baseQuantityMilli: null,
        unitPriceMinor: '720575940379279449876',
        lineGrossMinor: '900719925474099312345',
        lineDiscountMinor: '0',
        roundingMinor: '0',
        lineTotalMinor: '900719925474099312345',
        costStatus: 'unknown',
        unitCostMinor: null,
        lineCostMinor: null,
        inventoryMovementId: null,
        createdAt: '2026-10-15T08:00:00.000Z',
        updatedAt: '2026-10-15T08:00:00.000Z',
        version: '1',
      },
    ],
    tenders: [],
    customerCreditTender: null,
    receivable: null,
  };
}

describe('DocumentsService', () => {
  let sales: jest.Mocked<SaleReadService>;
  let reports: jest.Mocked<ReportsService>;
  let renderer: jest.Mocked<DocumentPdfRenderer>;
  let service: DocumentsService;

  beforeEach(() => {
    sales = { getById: jest.fn() } as unknown as jest.Mocked<SaleReadService>;
    reports = {
      readCustomerReceivables: jest.fn(),
      readSales: jest.fn(),
    } as unknown as jest.Mocked<ReportsService>;
    renderer = {
      render: jest.fn().mockResolvedValue(Buffer.from('%PDF-test')),
    } as unknown as jest.Mocked<DocumentPdfRenderer>;
    service = new DocumentsService(sales, reports, renderer);
  });

  it('assembles a Sale document only from canonical Sale read values', async () => {
    const source = saleSource();
    sales.getById.mockResolvedValue(source);

    const result = await service.generateSale(principal, context, source.sale.id);

    expect(sales.getById).toHaveBeenCalledWith(principal, context, source.sale.id);
    expect(result.filename).toBe(`sale-${source.sale.id}.pdf`);
    expect(result.model.notices).toContain('Sale status: corrected');
    expect(
      result.model.sections.find((section) => section.title === 'Canonical Totals')?.fields,
    ).toContainEqual({
      label: 'Sale total',
      value: 'ILS 9,007,199,254,740,993,123.45',
    });
    expect(result.model.tables[0]?.rows[0]).toEqual(
      expect.arrayContaining(['1.250', 'ILS 9,007,199,254,740,993,123.45']),
    );
    expect(result.model.tables[0]?.columns).not.toContain('Unit Cost Minor');
    expect(result.model.tables[0]?.columns).not.toContain('Inventory Movement Id');
  });

  it('projects customer credit and receivable details without internal ledger identifiers', () => {
    const source = saleSource();
    const customerId = randomUUID();
    source.customerCreditTender = {
      id: randomUUID(),
      customerId,
      amountMinor: '100',
      customerLedgerEntryId: randomUUID(),
      appliedAt: '2026-10-15T08:00:00.000Z',
      createdAt: '2026-10-15T08:00:00.000Z',
    };
    source.receivable = {
      id: randomUUID(),
      customerId,
      accountingPeriodId: randomUUID(),
      entryType: 'sale_credit',
      originalAmountMinor: '200',
      outstandingMinor: '100',
      sale: { id: source.sale.id, displayNumber: source.sale.displayNumber },
      occurredAt: '2026-10-15T08:00:00.000Z',
      businessDate: '2026-10-15',
      postingDate: '2026-10-15',
      reason: null,
      createdAt: '2026-10-15T08:00:00.000Z',
    };

    const model = service.saleModel(principal, source);

    expect(model.sections.find((section) => section.title === 'Sale')?.fields).not.toContainEqual(
      expect.objectContaining({ label: 'Accounting period ID' }),
    );
    expect(
      model.sections.find((section) => section.title === 'Customer Credit Tender')?.fields,
    ).toEqual([
      { label: 'Amount', value: 'ILS 1.00' },
      { label: 'Applied at (UTC)', value: '2026-10-15T08:00:00.000Z' },
    ]);
    expect(model.sections.find((section) => section.title === 'Receivable')?.fields).toEqual([
      { label: 'Entry type', value: 'sale_credit' },
      { label: 'Original amount', value: 'ILS 2.00' },
      { label: 'Outstanding', value: 'ILS 1.00' },
      { label: 'Business date', value: '2026-10-15' },
      { label: 'Posting date', value: '2026-10-15' },
      { label: 'Occurred at (UTC)', value: '2026-10-15T08:00:00.000Z' },
      { label: 'Reason', value: 'None' },
    ]);
  });

  it('preserves the bounded report page, filtered totals, and continuation disclosure', async () => {
    reports.readSales.mockResolvedValue({
      asOf: '2026-10-15T10:00:00.000Z',
      timezoneName: 'Asia/Hebron',
      dateAuthority: 'businessDate',
      filters: {
        fromDate: '2026-10-01',
        toDate: '2026-10-15',
        accountingPeriodId: null,
        customerId: null,
        status: 'all',
      },
      items: [
        {
          id: randomUUID(),
          displayNumber: 'S-1',
          customerId: null,
          customerName: null,
          status: 'posted',
          paymentStatus: 'paid',
          totalMinor: '9007199254740993',
          paidTotalMinor: '9007199254740993',
          creditTotalMinor: '0',
          returnedTotalMinor: '0',
          knownCostTotalMinor: '0',
          pendingCostLineCount: 0,
          unknownCostLineCount: 1,
          businessDate: '2026-10-15',
          postingDate: '2026-10-15',
          accountingPeriodId: randomUUID(),
          occurredAt: '2026-10-15T08:00:00.000Z',
          correctionOfId: null,
          reversedById: null,
        },
      ],
      totals: {
        page: {
          rowCount: 1,
          postedTotalMinor: '9007199254740993',
          cancelledTotalMinor: '0',
          correctedTotalMinor: '0',
          paidTotalMinor: '9007199254740993',
          creditTotalMinor: '0',
          returnedTotalMinor: '0',
          netPostedSalesMinor: '9007199254740993',
        },
        filtered: {
          rowCount: 2,
          postedTotalMinor: '9007199254740994',
          cancelledTotalMinor: '0',
          correctedTotalMinor: '0',
          paidTotalMinor: '9007199254740994',
          creditTotalMinor: '0',
          returnedTotalMinor: '0',
          netPostedSalesMinor: '9007199254740994',
        },
      },
      pagination: { limit: 1, nextCursor: 'opaque-cursor' },
    });

    const result = await service.generateSalesReport(principal, context, {
      fromDate: '2026-10-01',
      toDate: '2026-10-15',
      limit: 1,
    });

    expect(result.model.notices).toHaveLength(1);
    expect(
      result.model.sections.find((section) => section.title === 'Filtered Totals')?.fields,
    ).toContainEqual({
      label: 'Posted Total Minor',
      value: 'ILS 90,071,992,547,409.94',
    });
  });

  it('uses a privacy-equivalent not-found response for an unavailable Customer ledger', async () => {
    reports.readCustomerReceivables.mockResolvedValue({
      asOf: '2026-10-15T10:00:00.000Z',
      timezoneName: 'Asia/Hebron',
      dateAuthority: 'currentState',
      filters: { customerId: randomUUID() },
      items: [],
      totals: {
        page: { rowCount: 0, receivableMinor: '0', creditMinor: '0', netDueMinor: '0' },
        filtered: { rowCount: 0, receivableMinor: '0', creditMinor: '0', netDueMinor: '0' },
      },
      pagination: { limit: 1, nextCursor: null },
    });

    await expect(service.generateCustomerLedger(principal, context, randomUUID())).rejects.toEqual(
      expect.any(NotFoundException),
    );
    expect(renderer.render).not.toHaveBeenCalled();
  });
});
