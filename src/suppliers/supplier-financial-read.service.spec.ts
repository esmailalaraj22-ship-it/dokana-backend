import { ForbiddenException, NotFoundException } from '@nestjs/common';

import type { AuthenticatedPrincipal, MembershipRole } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import {
  encodeSupplierInvoiceCursor,
  supplierInvoiceCursorScopeHash,
} from './supplier-financial-read-cursor';
import type { SupplierFinancialReadRepository } from './supplier-financial-read.repository';
import { SupplierFinancialReadService } from './supplier-financial-read.service';
import type {
  SupplierFinancialPageRow,
  SupplierInvoiceDetailRow,
  SupplierInvoiceListRow,
} from './supplier-financial-read.types';
import { SupplierReadQueryError } from './supplier-read-query-error';

const context: TenantTransactionContext = {
  storeId: '72000000-0000-4000-8000-000000000001',
  userId: '72000000-0000-4000-8000-000000000002',
  deviceId: '72000000-0000-4000-8000-000000000003',
  requestId: '72000000-0000-4000-8000-000000000004',
};
const principal: Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
> = {
  membershipRole: 'owner',
  storeId: context.storeId,
  userId: context.userId,
  deviceId: context.deviceId,
};
const supplierId = '72100000-0000-4000-8000-000000000001';
const firstInvoice: SupplierInvoiceListRow = {
  id: '72200000-0000-4000-8000-000000000001',
  invoiceNumber: 'EXT-101',
  displayNumber: 'PI-101',
  invoiceDateAt: new Date('2026-07-20T10:00:00.000Z'),
  postingDate: '2026-07-20',
  dueAt: new Date('2026-08-20T10:00:00.000Z'),
  status: 'open',
  totalMinor: 9_007_199_254_740_993n,
  paidAmountMinor: 0n,
  outstandingMinor: 9_007_199_254_740_993n,
  settlementState: 'UNPAID',
  accountingPeriodId: '72300000-0000-4000-8000-000000000001',
  correctionOfId: null,
  replacedById: null,
  replacedBySupplierId: null,
  updatedAt: new Date('2026-07-20T10:05:00.000Z'),
  version: 9_007_199_254_740_993n,
};
const secondInvoice: SupplierInvoiceListRow = {
  ...firstInvoice,
  id: '72200000-0000-4000-8000-000000000002',
  invoiceNumber: null,
  displayNumber: 'PI-102',
  invoiceDateAt: new Date('2026-07-10T10:00:00.000Z'),
  postingDate: null,
  dueAt: null,
  status: 'draft',
  totalMinor: 0n,
  paidAmountMinor: 0n,
  outstandingMinor: 0n,
  settlementState: null,
  accountingPeriodId: null,
  version: 1n,
};
const page: SupplierFinancialPageRow = {
  supplier: {
    id: supplierId,
    name: 'Supplier A',
    phone: null,
    status: 'archived',
    archivedAt: new Date('2026-08-01T00:00:00.000Z'),
    version: 4n,
  },
  totalOutstandingMinor: 9_007_199_254_740_993n,
  invoices: [firstInvoice, secondInvoice],
  openingPayable: {
    id: '72700000-0000-4000-8000-000000000001',
    accountingPeriodId: '72300000-0000-4000-8000-000000000001',
    amountMinor: 500n,
    paidAmountMinor: 200n,
    outstandingMinor: 300n,
    settlementState: 'PARTIALLY_PAID',
    occurredAt: new Date('2026-07-01T00:00:00.000Z'),
    createdAt: new Date('2026-07-01T00:00:01.000Z'),
  },
};

describe('SupplierFinancialReadService', () => {
  const repository = {
    readSupplierFinancialPage: jest.fn(),
    findSupplierInvoice: jest.fn(),
  } as jest.Mocked<
    Pick<SupplierFinancialReadRepository, 'readSupplierFinancialPage' | 'findSupplierInvoice'>
  >;
  const service = new SupplierFinancialReadService(
    repository as unknown as SupplierFinancialReadRepository,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('serializes exact invoice, Opening Payable, and Supplier settlement amounts', async () => {
    repository.readSupplierFinancialPage.mockResolvedValue(page);

    await expect(
      service.getSupplierFinancialView(principal, context, supplierId.toUpperCase(), {}),
    ).resolves.toEqual({
      supplier: {
        id: supplierId,
        name: 'Supplier A',
        phone: null,
        status: 'archived',
        archivedAt: '2026-08-01T00:00:00.000Z',
        version: '4',
      },
      totalOutstandingMinor: '9007199254740993',
      invoices: [
        expect.objectContaining({
          id: firstInvoice.id,
          totalMinor: '9007199254740993',
          outstandingMinor: '9007199254740993',
          paidAmountMinor: '0',
          settlementState: 'UNPAID',
          postingDate: '2026-07-20',
        }),
        expect.objectContaining({
          id: secondInvoice.id,
          totalMinor: '0',
          outstandingMinor: '0',
          paidAmountMinor: '0',
          settlementState: null,
          postingDate: null,
        }),
      ],
      openingPayable: {
        id: page.openingPayable?.id,
        accountingPeriodId: page.openingPayable?.accountingPeriodId,
        amountMinor: '500',
        paidAmountMinor: '200',
        outstandingMinor: '300',
        settlementState: 'PARTIALLY_PAID',
        occurredAt: page.openingPayable?.occurredAt.toISOString(),
        createdAt: page.openingPayable?.createdAt.toISOString(),
      },
      nextCursor: null,
    });
    expect(repository.readSupplierFinancialPage).toHaveBeenCalledWith(context, supplierId, {
      anchor: null,
      limit: 50,
    });
  });

  it('creates a Supplier-bound cursor from the final returned invoice', async () => {
    repository.readSupplierFinancialPage.mockResolvedValue(page);

    const result = await service.getSupplierFinancialView(principal, context, supplierId, {
      limit: 1,
    });
    expect(result.invoices).toHaveLength(1);
    expect(result.nextCursor).not.toBeNull();
    expect(repository.readSupplierFinancialPage).toHaveBeenCalledWith(context, supplierId, {
      anchor: null,
      limit: 1,
    });
  });

  it('maps malformed, cross-Supplier, and stale-anchor cursors to stable validation errors', async () => {
    await expect(
      service.getSupplierFinancialView(principal, context, supplierId, { cursor: 'invalid+' }),
    ).rejects.toMatchObject({ status: 400 });

    const otherScope = encodeSupplierInvoiceCursor({
      scopeHash: supplierInvoiceCursorScopeHash('72100000-0000-4000-8000-000000000002'),
      anchor: { id: firstInvoice.id, version: firstInvoice.version },
    });
    await expect(
      service.getSupplierFinancialView(principal, context, supplierId, { cursor: otherScope }),
    ).rejects.toMatchObject({
      response: {
        details: [{ field: 'cursor', constraints: ['supplierInvoiceCursorScope'] }],
      },
    });

    const validCursor = encodeSupplierInvoiceCursor({
      scopeHash: supplierInvoiceCursorScopeHash(supplierId),
      anchor: { id: firstInvoice.id, version: firstInvoice.version },
    });
    repository.readSupplierFinancialPage.mockRejectedValue(
      new SupplierReadQueryError('cursor', 'supplierInvoiceCursorAnchor'),
    );
    await expect(
      service.getSupplierFinancialView(principal, context, supplierId, { cursor: validCursor }),
    ).rejects.toMatchObject({
      response: {
        details: [{ field: 'cursor', constraints: ['supplierInvoiceCursorAnchor'] }],
      },
    });
  });

  it('returns invoice detail with financial line facts and exact bigint strings', async () => {
    const detail: SupplierInvoiceDetailRow = {
      ...firstInvoice,
      supplier: page.supplier,
      notes: 'Invoice note',
      itemsSubtotalMinor: 9_007_199_254_740_994n,
      lineDiscountTotalMinor: 1n,
      invoiceDiscountMinor: 0n,
      roundingMinor: 0n,
      correctionOfId: null,
      cancelledAt: null,
      createdAt: new Date('2026-07-20T10:00:00.000Z'),
      items: [
        {
          id: '72400000-0000-4000-8000-000000000001',
          productId: '72500000-0000-4000-8000-000000000001',
          productUnitId: '72600000-0000-4000-8000-000000000001',
          productNameSnapshot: 'Sugar',
          unitNameSnapshot: 'bag',
          quantityMilli: 3_000n,
          conversionFactorNum: 10,
          conversionFactorDen: 1,
          baseQuantityMilli: 30_000n,
          unitCostMinor: 3_002_399_751_580_331n,
          lineGrossMinor: 9_007_199_254_740_994n,
          lineDiscountMinor: 1n,
          roundingMinor: 0n,
          lineTotalMinor: 9_007_199_254_740_993n,
          createdAt: new Date('2026-07-20T10:00:01.000Z'),
          updatedAt: new Date('2026-07-20T10:00:02.000Z'),
          version: 2n,
        },
      ],
    };
    repository.findSupplierInvoice.mockResolvedValue(detail);

    const response = await service.getSupplierInvoice(
      principal,
      context,
      supplierId.toUpperCase(),
      firstInvoice.id.toUpperCase(),
    );
    expect(response.invoice).toMatchObject({
      id: firstInvoice.id,
      totalMinor: '9007199254740993',
      outstandingMinor: '9007199254740993',
      paidAmountMinor: '0',
      settlementState: 'UNPAID',
      itemsSubtotalMinor: '9007199254740994',
      lineDiscountTotalMinor: '1',
    });
    expect(response.items).toEqual([
      expect.objectContaining({
        productName: 'Sugar',
        unitName: 'bag',
        quantityMilli: '3000',
        baseQuantityMilli: '30000',
        unitCostMinor: '3002399751580331',
        lineTotalMinor: '9007199254740993',
      }),
    ]);
    expect(repository.findSupplierInvoice).toHaveBeenCalledWith(
      context,
      supplierId,
      firstInvoice.id,
    );
  });

  it.each<MembershipRole>(['manager', 'viewer', 'support'])(
    'rejects the %s role before financial repository access',
    async (membershipRole) => {
      await expect(
        service.getSupplierFinancialView({ ...principal, membershipRole }, context, supplierId, {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.readSupplierFinancialPage).not.toHaveBeenCalled();
    },
  );

  it.each(['storeId', 'userId', 'deviceId'] as const)(
    'rejects mismatched trusted %s before financial repository access',
    async (field) => {
      await expect(
        service.getSupplierInvoice(
          { ...principal, [field]: '72000000-0000-4000-8000-000000000099' },
          context,
          supplierId,
          firstInvoice.id,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.findSupplierInvoice).not.toHaveBeenCalled();
    },
  );

  it('uses non-disclosing not-found results for absent Suppliers and invoices', async () => {
    repository.readSupplierFinancialPage.mockResolvedValue(undefined);
    await expect(
      service.getSupplierFinancialView(principal, context, supplierId, {}),
    ).rejects.toBeInstanceOf(NotFoundException);

    repository.findSupplierInvoice.mockResolvedValue(undefined);
    await expect(
      service.getSupplierInvoice(principal, context, supplierId, firstInvoice.id),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
