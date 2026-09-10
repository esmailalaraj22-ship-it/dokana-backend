import { ForbiddenException, NotFoundException } from '@nestjs/common';

import type { AuthenticatedPrincipal, MembershipRole } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type { SupplierFinancialReadRepository } from './supplier-financial-read.repository';
import {
  encodeSupplierPaymentCursor,
  supplierPaymentCursorScopeHash,
} from './supplier-payment-read-cursor';
import { SupplierPaymentReadService } from './supplier-payment-read.service';
import type {
  SupplierPaymentDetailRow,
  SupplierPaymentListRow,
  SupplierPaymentPageRow,
} from './supplier-payment-read.types';
import { SupplierReadQueryError } from './supplier-read-query-error';

const context: TenantTransactionContext = {
  storeId: '82000000-0000-4000-8000-000000000001',
  userId: '82000000-0000-4000-8000-000000000002',
  deviceId: '82000000-0000-4000-8000-000000000003',
  requestId: '82000000-0000-4000-8000-000000000004',
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
const supplierId = '82100000-0000-4000-8000-000000000001';
const invoiceId = '82200000-0000-4000-8000-000000000001';
const payment: SupplierPaymentListRow = {
  id: '82300000-0000-4000-8000-000000000001',
  supplierId,
  accountingPeriodId: '82400000-0000-4000-8000-000000000001',
  operationId: '82500000-0000-4000-8000-000000000001',
  amountMinor: 9_007_199_254_740_993n,
  allocatedTotalMinor: 9_007_199_254_740_993n,
  creditCreatedMinor: 0n,
  paymentSource: 'money_account',
  moneyAccount: {
    id: '82600000-0000-4000-8000-000000000001',
    name: 'Cash',
    accountType: 'cash',
    status: 'archived',
  },
  paymentAt: new Date('2026-08-20T10:00:00.000Z'),
  externalReference: 'PAY-1',
  notes: 'Payment note',
  status: 'posted',
  cancelledAt: null,
  allocationCount: 1,
  targetAllocationMinor: 200n,
  createdAt: new Date('2026-08-20T10:00:01.000Z'),
  updatedAt: new Date('2026-08-20T10:00:02.000Z'),
  version: 2n,
};
const ownerPayment: SupplierPaymentListRow = {
  ...payment,
  id: '82300000-0000-4000-8000-000000000002',
  operationId: '82500000-0000-4000-8000-000000000002',
  paymentSource: 'owner_pocket',
  moneyAccount: null,
  targetAllocationMinor: null,
};
const page: SupplierPaymentPageRow = {
  supplier: {
    id: supplierId,
    name: 'Archived Supplier',
    phone: null,
    status: 'archived',
    archivedAt: new Date('2026-08-21T00:00:00.000Z'),
    version: 4n,
  },
  payments: [payment, ownerPayment],
};

describe('SupplierPaymentReadService', () => {
  const repository = {
    readSupplierPaymentPage: jest.fn(),
    findSupplierPayment: jest.fn(),
  } as jest.Mocked<
    Pick<SupplierFinancialReadRepository, 'readSupplierPaymentPage' | 'findSupplierPayment'>
  >;
  const service = new SupplierPaymentReadService(
    repository as unknown as SupplierFinancialReadRepository,
  );

  beforeEach(() => jest.clearAllMocks());

  it('serializes exact payment money and preserves archived Money Account presentation', async () => {
    repository.readSupplierPaymentPage.mockResolvedValue(page);

    const result = await service.list(principal, context, supplierId.toUpperCase(), {
      invoiceId: invoiceId.toUpperCase(),
    });

    expect(result.payments[0]).toMatchObject({
      id: payment.id,
      amountMinor: '9007199254740993',
      allocatedTotalMinor: '9007199254740993',
      creditCreatedMinor: '0',
      occurredAt: '2026-08-20T10:00:00.000Z',
      targetAllocationMinor: '200',
      source: {
        type: 'MONEY_ACCOUNT',
        moneyAccount: { name: 'Cash', accountType: 'cash', status: 'archived' },
      },
    });
    expect(result.payments[1]?.source).toEqual({ type: 'OWNER', moneyAccount: null });
    expect(repository.readSupplierPaymentPage).toHaveBeenCalledWith(context, supplierId, {
      anchor: null,
      limit: 50,
      target: { type: 'purchase_invoice', id: invoiceId },
    });
  });

  it('creates target-bound cursors and rejects cross-scope or stale anchors', async () => {
    repository.readSupplierPaymentPage.mockResolvedValue(page);
    const result = await service.list(principal, context, supplierId, { limit: 1, invoiceId });
    expect(result.payments).toHaveLength(1);
    expect(result.nextCursor).not.toBeNull();

    await expect(
      service.list(principal, context, supplierId, { cursor: result.nextCursor ?? undefined }),
    ).rejects.toMatchObject({
      response: { details: [{ field: 'cursor', constraints: ['supplierPaymentCursorScope'] }] },
    });

    const cursor = encodeSupplierPaymentCursor({
      scopeHash: supplierPaymentCursorScopeHash(supplierId, null),
      anchor: { id: payment.id, version: payment.version },
    });
    repository.readSupplierPaymentPage.mockRejectedValue(
      new SupplierReadQueryError('cursor', 'supplierPaymentCursorAnchor'),
    );
    await expect(service.list(principal, context, supplierId, { cursor })).rejects.toMatchObject({
      response: { details: [{ field: 'cursor', constraints: ['supplierPaymentCursorAnchor'] }] },
    });
  });

  it('rejects ambiguous target filters before repository access', async () => {
    await expect(
      service.list(principal, context, supplierId, {
        invoiceId,
        openingPayableId: '82700000-0000-4000-8000-000000000001',
      }),
    ).rejects.toMatchObject({
      response: { details: [{ field: 'target', constraints: ['supplierPaymentTargetExclusive'] }] },
    });
    expect(repository.readSupplierPaymentPage).not.toHaveBeenCalled();
  });

  it('returns payment detail with Invoice and Opening Payable target identities', async () => {
    const detail: SupplierPaymentDetailRow = {
      ...payment,
      supplier: page.supplier,
      allocations: [
        {
          id: '82800000-0000-4000-8000-000000000001',
          targetType: 'purchase_invoice',
          targetId: invoiceId,
          amountMinor: 200n,
          invoiceNumber: 'EXT-1',
          invoiceDisplayNumber: 'PI-1',
          invoiceDateAt: new Date('2026-08-01T00:00:00.000Z'),
          openingAmountMinor: null,
          openingOccurredAt: null,
          createdAt: new Date('2026-08-20T10:00:01.000Z'),
        },
        {
          id: '82800000-0000-4000-8000-000000000002',
          targetType: 'opening_payable',
          targetId: '82900000-0000-4000-8000-000000000001',
          amountMinor: 300n,
          invoiceNumber: null,
          invoiceDisplayNumber: null,
          invoiceDateAt: null,
          openingAmountMinor: 500n,
          openingOccurredAt: new Date('2026-07-01T00:00:00.000Z'),
          createdAt: new Date('2026-08-20T10:00:02.000Z'),
        },
      ],
    };
    repository.findSupplierPayment.mockResolvedValue(detail);

    const result = await service.getById(
      principal,
      context,
      supplierId.toUpperCase(),
      payment.id.toUpperCase(),
    );
    expect(result.allocations).toEqual([
      expect.objectContaining({
        amountMinor: '200',
        target: expect.objectContaining({ type: 'SUPPLIER_INVOICE', id: invoiceId }),
      }),
      expect.objectContaining({
        amountMinor: '300',
        target: expect.objectContaining({ type: 'OPENING_PAYABLE', amountMinor: '500' }),
      }),
    ]);
    expect(repository.findSupplierPayment).toHaveBeenCalledWith(context, supplierId, payment.id);
  });

  it.each<MembershipRole>(['manager', 'viewer', 'support'])(
    'rejects the %s role before payment repository access',
    async (membershipRole) => {
      await expect(
        service.list({ ...principal, membershipRole }, context, supplierId, {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.readSupplierPaymentPage).not.toHaveBeenCalled();
    },
  );

  it('uses non-disclosing not-found results for absent Suppliers and payments', async () => {
    repository.readSupplierPaymentPage.mockResolvedValue(undefined);
    await expect(service.list(principal, context, supplierId, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );

    repository.findSupplierPayment.mockResolvedValue(undefined);
    await expect(service.getById(principal, context, supplierId, payment.id)).rejects.toMatchObject(
      { response: { code: 'SUPPLIER_PAYMENT_NOT_FOUND' } },
    );
  });
});
