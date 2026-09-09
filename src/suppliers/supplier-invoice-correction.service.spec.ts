import { ConflictException, ForbiddenException } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import { OperationalTimeService } from '../settings/operational-time.service';
import { SupplierInvoiceCorrectionRepository } from './supplier-invoice-correction.repository';
import { SupplierInvoiceCorrectionService } from './supplier-invoice-correction.service';
import type {
  SupplierFinancialCorrectionResult,
  SupplierInvoiceCorrectionResponse,
} from './supplier-invoice-correction.types';

const ids = {
  store: 'a2410000-0000-4000-8000-000000000001',
  user: 'a2410000-0000-4000-8000-000000000002',
  device: 'a2410000-0000-4000-8000-000000000003',
  request: 'a2410000-0000-4000-8000-000000000004',
  target: 'a2410000-0000-4000-8000-000000000005',
  operation: 'a2410000-0000-4000-8000-000000000006',
  supplier: 'a2410000-0000-4000-8000-000000000007',
  period: 'a2410000-0000-4000-8000-000000000008',
  invoice: 'a2410000-0000-4000-8000-000000000009',
  payable: 'a2410000-0000-4000-8000-000000000010',
  reversal: 'a2410000-0000-4000-8000-000000000011',
  group: 'a2410000-0000-4000-8000-000000000012',
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
const response: SupplierInvoiceCorrectionResponse = {
  operationId: ids.operation,
  targetOperationId: ids.target,
  family: 'invoice',
  intent: 'cancel',
  occurredAt: '2026-08-05T10:00:00.000Z',
  businessDate: '2026-08-05',
  postingDate: '2026-08-05',
  accountingPeriodId: ids.period,
  target: {
    invoiceId: ids.invoice,
    supplierId: ids.supplier,
    status: 'cancelled',
    cancelledAt: '2026-08-05T10:00:00.000Z',
    version: '3',
  },
  reversal: {
    id: ids.reversal,
    entryType: 'correction',
    payableDeltaMinor: '-500',
    creditDeltaMinor: '0',
    sourcePurchaseInvoiceId: ids.invoice,
    transactionGroupId: ids.group,
    occurredAt: '2026-08-05T10:00:00.000Z',
    reversalOfId: ids.payable,
    operationId: ids.reversal,
    createdAt: '2026-08-05T10:00:01.000Z',
  },
  replacement: null,
};

describe('S12.4 SupplierInvoiceCorrectionService', () => {
  const repository = {
    correct: jest.fn<
      Promise<SupplierFinancialCorrectionResult>,
      Parameters<SupplierInvoiceCorrectionRepository['correct']>
    >(),
  };
  const service = new SupplierInvoiceCorrectionService(
    repository as unknown as SupplierInvoiceCorrectionRepository,
    new OperationalTimeService(),
  );

  beforeEach(() => {
    repository.correct.mockReset().mockResolvedValue({ ok: true, response });
  });

  it('derives operational posting date and dispatches user cancellation', async () => {
    await service.cancelInvoice(principal, context, ids.target, {
      operationId: ids.operation,
      occurredAt: '2026-08-04T21:30:00Z',
    });

    expect(repository.correct).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ family: 'invoice', kind: 'cancel' }),
      '2026-08-05',
    );
  });

  it('dispatches user edit as a same-family replacement', async () => {
    await service.editInvoice(principal, context, ids.target, {
      operationId: ids.operation,
      occurredAt: '2026-08-05T10:00:00Z',
      replacement: {
        supplierId: ids.supplier,
        items: [
          {
            description: 'Corrected',
            unitName: 'piece',
            quantityMilli: '1000',
            unitCostMinor: '450',
          },
        ],
      },
    });

    expect(repository.correct).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        family: 'invoice',
        kind: 'edit',
        replacement: expect.objectContaining({ totalMinor: 450n }),
      }),
      '2026-08-05',
    );
  });

  it('rejects non-owner and mismatched trusted context before persistence', async () => {
    await expect(
      service.cancelInvoice({ ...principal, membershipRole: 'manager' }, context, ids.target, {
        operationId: ids.operation,
        occurredAt: '2026-08-05T10:00:00Z',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.cancelOpeningPayable(
        { ...principal, storeId: 'a2410000-0000-4000-8000-000000000099' },
        context,
        ids.target,
        { operationId: ids.operation, occurredAt: '2026-08-05T10:00:00Z' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.correct).not.toHaveBeenCalled();
  });

  it('maps stable repository conflicts without changing their code', async () => {
    repository.correct.mockResolvedValue({
      ok: false,
      error: {
        code: 'SUPPLIER_CORRECTION_TARGET_NOT_ACTIVE',
        message: 'Supplier financial correction target is not the active operation.',
        statusCode: 409,
      },
    });

    await expect(
      service.cancelInvoice(principal, context, ids.target, {
        operationId: ids.operation,
        occurredAt: '2026-08-05T10:00:00Z',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
