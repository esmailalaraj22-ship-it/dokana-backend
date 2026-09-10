import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import { OperationalTimeService } from '../settings/operational-time.service';
import type { SupplierPaymentPostingRepository } from './supplier-payment-posting.repository';
import { SupplierPaymentPostingService } from './supplier-payment-posting.service';
import type {
  SupplierPaymentPostingResponse,
  SupplierPaymentPostingResult,
} from './supplier-payment-posting.types';

const ids = {
  store: '13331000-0000-4000-8000-000000000001',
  user: '13331000-0000-4000-8000-000000000002',
  device: '13331000-0000-4000-8000-000000000003',
  request: '13331000-0000-4000-8000-000000000004',
  supplier: '13331000-0000-4000-8000-000000000005',
  operation: '13331000-0000-4000-8000-000000000006',
  account: '13331000-0000-4000-8000-000000000007',
  invoice: '13331000-0000-4000-8000-000000000008',
  period: '13331000-0000-4000-8000-000000000009',
  payment: '13331000-0000-4000-8000-000000000010',
  payable: '13331000-0000-4000-8000-000000000011',
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
const response: SupplierPaymentPostingResponse = {
  operationId: ids.operation,
  supplierId: ids.supplier,
  businessDate: '2026-09-11',
  postingDate: '2026-09-11',
  accountingPeriodId: ids.period,
  payment: {
    id: ids.payment,
    paymentSource: 'money_account',
    moneyAccountId: ids.account,
    amountMinor: '500',
    allocatedTotalMinor: '500',
    creditCreatedMinor: '0',
    paymentAt: '2026-09-10T21:30:00.000Z',
    externalReference: null,
    notes: null,
    status: 'posted',
    moneyMovementId: ids.payment,
    ownerLedgerEntryId: null,
    version: '2',
  },
  allocations: [],
  payable: {
    id: ids.payable,
    payableDeltaMinor: '-500',
    transactionGroupId: ids.operation,
    operationId: ids.payable,
    occurredAt: '2026-09-10T21:30:00.000Z',
    createdAt: '2026-09-10T21:30:01.000Z',
  },
  moneyMovement: null,
  ownerLedgerEntry: null,
};

describe('S13.3 SupplierPaymentPostingService', () => {
  const repository = {
    post: jest.fn<
      Promise<SupplierPaymentPostingResult>,
      Parameters<SupplierPaymentPostingRepository['post']>
    >(),
  };
  const service = new SupplierPaymentPostingService(
    repository as unknown as SupplierPaymentPostingRepository,
    new OperationalTimeService(),
  );

  beforeEach(() => {
    repository.post.mockReset().mockResolvedValue({ ok: true, response });
  });

  it('derives the operational posting date and dispatches exact bigint facts', async () => {
    await service.post(principal, context, ids.supplier, {
      operationId: ids.operation,
      paymentSource: 'money_account',
      moneyAccountId: ids.account,
      amountMinor: '500',
      occurredAt: '2026-09-10T21:30:00Z',
      allocations: [{ targetType: 'purchase_invoice', targetId: ids.invoice, amountMinor: '500' }],
    });
    expect(repository.post).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ amountMinor: 500n, supplierId: ids.supplier }),
      '2026-09-11',
    );
  });

  it('rejects a non-owner or mismatched trusted context before persistence', async () => {
    await expect(
      service.post({ ...principal, membershipRole: 'manager' }, context, ids.supplier, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.post({ ...principal, storeId: ids.invoice }, context, ids.supplier, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.post).not.toHaveBeenCalled();
  });

  it.each([
    ['OPERATION_ID_CONFLICT', 409, ConflictException],
    ['SUPPLIER_PAYMENT_TARGET_NOT_FOUND', 404, NotFoundException],
  ] as const)('preserves repository error %s', async (code, statusCode, expected) => {
    repository.post.mockResolvedValue({
      ok: false,
      error: { code, message: 'Stable failure.', statusCode },
    });
    await expect(
      service.post(principal, context, ids.supplier, {
        operationId: ids.operation,
        paymentSource: 'money_account',
        moneyAccountId: ids.account,
        amountMinor: '1',
        occurredAt: '2026-09-10T10:00:00Z',
        allocations: [{ targetType: 'purchase_invoice', targetId: ids.invoice, amountMinor: '1' }],
      }),
    ).rejects.toBeInstanceOf(expected);
  });
});
