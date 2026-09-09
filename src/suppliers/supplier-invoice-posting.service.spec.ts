import { ConflictException, ForbiddenException } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import { OperationalTimeService } from '../settings/operational-time.service';
import type { SupplierInvoicePostingRepository } from './supplier-invoice-posting.repository';
import { SupplierInvoicePostingService } from './supplier-invoice-posting.service';
import type {
  SupplierInvoicePostingResponse,
  SupplierInvoicePostingResult,
  SupplierOpeningPayableResponse,
  SupplierOpeningPayableResult,
} from './supplier-invoice-posting.types';

const ids = {
  store: '81230000-0000-4000-8000-000000000001',
  user: '81230000-0000-4000-8000-000000000002',
  device: '81230000-0000-4000-8000-000000000003',
  request: '81230000-0000-4000-8000-000000000004',
  supplier: '81230000-0000-4000-8000-000000000005',
  operation: '81230000-0000-4000-8000-000000000006',
  invoice: '81230000-0000-4000-8000-000000000007',
  period: '81230000-0000-4000-8000-000000000008',
  payable: '81230000-0000-4000-8000-000000000009',
};
const principal: Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
> = {
  membershipRole: 'owner',
  storeId: ids.store,
  userId: ids.user,
  deviceId: ids.device,
};
const context: TenantTransactionContext = {
  storeId: ids.store,
  userId: ids.user,
  deviceId: ids.device,
  requestId: ids.request,
};
const payable = {
  id: ids.payable,
  entryType: 'supplier_invoice' as const,
  payableDeltaMinor: '500',
  creditDeltaMinor: '0',
  sourcePurchaseInvoiceId: ids.invoice,
  transactionGroupId: ids.operation,
  occurredAt: '2026-07-03T10:00:00.000Z',
  operationId: ids.payable,
  createdAt: '2026-07-03T10:00:00.000Z',
};
const invoiceResponse: SupplierInvoicePostingResponse = {
  operationId: ids.operation,
  supplierId: ids.supplier,
  businessDate: '2026-07-03',
  postingDate: '2026-07-03',
  accountingPeriodId: ids.period,
  invoice: {
    id: ids.invoice,
    invoiceNumber: null,
    displayNumber: `PI-${ids.invoice}`,
    occurredAt: '2026-07-03T10:00:00.000Z',
    dueAt: null,
    status: 'open',
    itemsSubtotalMinor: '500',
    lineDiscountTotalMinor: '0',
    invoiceDiscountMinor: '0',
    roundingMinor: '0',
    totalMinor: '500',
    notes: null,
    version: '2',
  },
  items: [],
  payable,
};
const openingResponse: SupplierOpeningPayableResponse = {
  operationId: ids.operation,
  supplierId: ids.supplier,
  businessDate: '2026-07-03',
  postingDate: '2026-07-03',
  accountingPeriodId: ids.period,
  payable: { ...payable, entryType: 'opening_balance', sourcePurchaseInvoiceId: null },
};

describe('S12.3 SupplierInvoicePostingService', () => {
  const repository = {
    postInvoice: jest.fn<
      Promise<SupplierInvoicePostingResult>,
      Parameters<SupplierInvoicePostingRepository['postInvoice']>
    >(),
    postOpeningPayable: jest.fn<
      Promise<SupplierOpeningPayableResult>,
      Parameters<SupplierInvoicePostingRepository['postOpeningPayable']>
    >(),
  };
  const service = new SupplierInvoicePostingService(
    repository as unknown as SupplierInvoicePostingRepository,
    new OperationalTimeService(),
  );

  beforeEach(() => {
    repository.postInvoice.mockReset().mockResolvedValue({ ok: true, response: invoiceResponse });
    repository.postOpeningPayable
      .mockReset()
      .mockResolvedValue({ ok: true, response: openingResponse });
  });

  it('derives the Asia/Hebron posting date and dispatches exact invoice facts', async () => {
    await service.postInvoice(principal, context, ids.supplier, {
      operationId: ids.operation,
      occurredAt: '2026-07-02T21:30:00Z',
      items: [
        {
          description: 'Sugar',
          unitName: 'kg',
          quantityMilli: '1000',
          unitCostMinor: '500',
        },
      ],
    });
    expect(repository.postInvoice).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ supplierId: ids.supplier, totalMinor: 500n }),
      '2026-07-03',
    );
  });

  it('dispatches opening payable without creating invoice semantics', async () => {
    await service.postOpeningPayable(principal, context, ids.supplier, {
      operationId: ids.operation,
      amountMinor: '1200',
      occurredAt: '2026-07-03T10:00:00Z',
    });
    expect(repository.postOpeningPayable).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ amountMinor: 1200n, supplierId: ids.supplier }),
      '2026-07-03',
    );
    expect(repository.postInvoice).not.toHaveBeenCalled();
  });

  it('rejects non-owner and mismatched trusted context before persistence', async () => {
    await expect(
      service.postInvoice({ ...principal, membershipRole: 'manager' }, context, ids.supplier, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.postOpeningPayable(
        { ...principal, storeId: '91230000-0000-4000-8000-000000000001' },
        context,
        ids.supplier,
        {},
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.postInvoice).not.toHaveBeenCalled();
    expect(repository.postOpeningPayable).not.toHaveBeenCalled();
  });

  it('maps stable repository conflicts without changing their code', async () => {
    repository.postInvoice.mockResolvedValue({
      ok: false,
      error: {
        code: 'OPERATION_ID_CONFLICT',
        message: 'Operation ID was reused with a different request.',
        statusCode: 409,
      },
    });
    await expect(
      service.postInvoice(principal, context, ids.supplier, {
        operationId: ids.operation,
        occurredAt: '2026-07-03T10:00:00Z',
        items: [
          {
            description: 'Sugar',
            unitName: 'kg',
            quantityMilli: '1000',
            unitCostMinor: '500',
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
