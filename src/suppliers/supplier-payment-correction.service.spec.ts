import { ConflictException, ForbiddenException } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import { OperationalTimeService } from '../settings/operational-time.service';
import type { SupplierPaymentCorrectionRepository } from './supplier-payment-correction.repository';
import { SupplierPaymentCorrectionService } from './supplier-payment-correction.service';
import type {
  SupplierPaymentCorrectionResponse,
  SupplierPaymentCorrectionResult,
} from './supplier-payment-correction.types';

const ids = {
  store: 'd1360000-0000-4000-8000-000000000001',
  user: 'd1360000-0000-4000-8000-000000000002',
  device: 'd1360000-0000-4000-8000-000000000003',
  request: 'd1360000-0000-4000-8000-000000000004',
  operation: 'd1360000-0000-4000-8000-000000000005',
  target: 'd1360000-0000-4000-8000-000000000006',
  supplier: 'd1360000-0000-4000-8000-000000000007',
  payment: 'd1360000-0000-4000-8000-000000000008',
  period: 'd1360000-0000-4000-8000-000000000009',
  payable: 'd1360000-0000-4000-8000-000000000010',
  payableReversal: 'd1360000-0000-4000-8000-000000000011',
  group: 'd1360000-0000-4000-8000-000000000012',
};
const context: TenantTransactionContext = {
  storeId: ids.store,
  userId: ids.user,
  deviceId: ids.device,
  requestId: ids.request,
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
const response: SupplierPaymentCorrectionResponse = {
  operationId: ids.operation,
  targetOperationId: ids.target,
  intent: 'cancel',
  occurredAt: '2026-09-20T10:00:00.000Z',
  businessDate: '2026-09-20',
  postingDate: '2026-09-20',
  accountingPeriodId: ids.period,
  target: {
    paymentId: ids.payment,
    supplierId: ids.supplier,
    status: 'cancelled',
    cancelledAt: '2026-09-20T10:00:00.000Z',
    version: '3',
  },
  reversal: {
    payable: {
      id: ids.payableReversal,
      entryType: 'correction',
      payableDeltaMinor: '500',
      transactionGroupId: ids.group,
      operationId: ids.payableReversal,
      occurredAt: '2026-09-20T10:00:00.000Z',
      createdAt: '2026-09-20T10:00:01.000Z',
      reversalOfId: ids.payable,
    },
    moneyMovement: null,
    ownerLedgerEntry: null,
  },
  replacement: null,
};

describe('S13.5 SupplierPaymentCorrectionService', () => {
  const repository = {
    correct: jest.fn<
      Promise<SupplierPaymentCorrectionResult>,
      Parameters<SupplierPaymentCorrectionRepository['correct']>
    >(),
  };
  const service = new SupplierPaymentCorrectionService(
    repository as unknown as SupplierPaymentCorrectionRepository,
    new OperationalTimeService(),
  );

  beforeEach(() => {
    repository.correct.mockReset().mockResolvedValue({ ok: true, response });
  });

  it('derives correction and independent replacement business dates', async () => {
    await service.edit(principal, context, ids.target, {
      operationId: ids.operation,
      occurredAt: '2026-09-20T21:30:00Z',
      replacement: {
        supplierId: ids.supplier,
        paymentSource: 'owner_pocket',
        amountMinor: '500',
        occurredAt: '2026-10-01T21:30:00Z',
        allocations: [
          { targetType: 'purchase_invoice', targetId: ids.payment, amountMinor: '500' },
        ],
      },
    });

    const call = repository.correct.mock.calls[0];
    expect(call?.[0]).toBe(context);
    expect(call?.[1]).toMatchObject({ kind: 'edit' });
    expect(call?.[2]).toBe('2026-09-21');
    expect(call?.[3]).toBe('2026-10-02');
  });

  it('rejects non-owner and mismatched trusted context before persistence', async () => {
    await expect(
      service.cancel({ ...principal, membershipRole: 'manager' }, context, ids.target, {
        operationId: ids.operation,
        occurredAt: '2026-09-20T10:00:00Z',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.cancel({ ...principal, storeId: ids.target }, context, ids.target, {
        operationId: ids.operation,
        occurredAt: '2026-09-20T10:00:00Z',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.correct).not.toHaveBeenCalled();
  });

  it('maps stable repository conflicts without changing their code', async () => {
    repository.correct.mockResolvedValue({
      ok: false,
      error: {
        code: 'SUPPLIER_PAYMENT_CORRECTION_TARGET_NOT_ACTIVE',
        message: 'Supplier Payment correction target is not the active payment.',
        statusCode: 409,
      },
    });

    await expect(
      service.cancel(principal, context, ids.target, {
        operationId: ids.operation,
        occurredAt: '2026-09-20T10:00:00Z',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
