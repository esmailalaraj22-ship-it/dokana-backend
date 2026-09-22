import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type { OperationalTimeService } from '../settings/operational-time.service';
import type { ExpenseCorrectionRepository } from './expense-correction.repository';
import { ExpenseCorrectionService } from './expense-correction.service';
import type { ExpenseCorrectionResponse } from './expense-correction.types';

const ids = {
  store: '18dcbf0a-acbe-48d6-88ed-cd1b078ddf41',
  user: 'a417fabd-b3c8-409c-9db3-2d62fdce21fd',
  device: '59e90f52-05aa-4bf4-af84-242686f712a8',
  target: '9f97bb10-b68a-4474-888e-7244fc581bcb',
  operation: '5d791456-eeb5-4e8a-9f21-f76cb0b26a11',
  expense: 'c3b4524e-0f87-46f2-8115-06bb9933d46b',
  period: '6af4b73a-b527-4c8c-933f-7c5f428d9a15',
} as const;
const occurredAt = '2026-09-20T10:00:00Z';
const context: TenantTransactionContext = {
  storeId: ids.store,
  userId: ids.user,
  deviceId: ids.device,
  requestId: 'b190a06f-8c0a-4ec2-915b-07ab8ec40c67',
};
const principal = {
  membershipRole: 'owner',
  storeId: ids.store,
  userId: ids.user,
  deviceId: ids.device,
} as Pick<AuthenticatedPrincipal, 'membershipRole' | 'storeId' | 'userId' | 'deviceId'>;
type Principal = typeof principal;
const response: ExpenseCorrectionResponse = {
  operationId: ids.operation,
  targetOperationId: ids.target,
  aggregate: 'expense',
  intent: 'cancel',
  reason: 'Correct entry',
  occurredAt,
  businessDate: '2026-09-20',
  postingDate: '2026-09-20',
  accountingPeriodId: ids.period,
  target: {
    expenseId: ids.expense,
    status: 'cancelled',
    cancelledAt: occurredAt,
    version: '2',
  },
  reversal: {
    originalAmountMinor: '500',
    amountDeltaMinor: '-500',
    internalPaymentId: null,
    moneyMovement: null,
    ownerLedgerEntry: null,
  },
  replacement: null,
};

function cancelBody() {
  return { operationId: ids.operation, occurredAt, reason: 'Correct entry' };
}

function paymentEditBody() {
  return {
    ...cancelBody(),
    replacement: {
      expenseId: ids.expense,
      paymentSource: 'owner_pocket',
      amountMinor: '200',
      occurredAt: '2026-09-21T10:00:00Z',
    },
  };
}

function harness() {
  const repository = {
    correctExpense: jest.fn().mockResolvedValue({ ok: true, response }),
    correctPayment: jest.fn().mockResolvedValue({ ok: true, response }),
  } as jest.Mocked<Pick<ExpenseCorrectionRepository, 'correctExpense' | 'correctPayment'>>;
  const operationalTime = {
    resolve: jest.fn((value: Date) => ({
      businessDate: value.toISOString().slice(0, 10),
    })),
  } as unknown as jest.Mocked<Pick<OperationalTimeService, 'resolve'>>;
  const service = new ExpenseCorrectionService(
    repository as unknown as ExpenseCorrectionRepository,
    operationalTime as unknown as OperationalTimeService,
  );
  return { service, repository, operationalTime };
}

describe('ExpenseCorrectionService', () => {
  it('dispatches Expense cancellation with current correction posting date', async () => {
    const { service, repository } = harness();
    await expect(service.cancelExpense(principal, context, ids.target, cancelBody())).resolves.toBe(
      response,
    );
    expect(repository.correctExpense).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ kind: 'cancel', reason: 'Correct entry' }),
      '2026-09-20',
      null,
    );
  });

  it('dispatches Expense replacement with independent correction and replacement dates', async () => {
    const { service, repository } = harness();
    await service.editExpense(principal, context, ids.target, {
      ...cancelBody(),
      replacement: {
        id: ids.expense,
        description: 'Replacement',
        amountMinor: '500',
        occurredAt: '2026-09-21T10:00:00Z',
        dueAt: '2026-10-01T10:00:00Z',
        mode: 'DUE',
      },
    });
    expect(repository.correctExpense).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ kind: 'edit' }),
      '2026-09-20',
      '2026-09-21',
    );
  });

  it('dispatches later Payment cancellation', async () => {
    const { service, repository } = harness();
    await service.cancelPayment(principal, context, ids.target, cancelBody());
    expect(repository.correctPayment).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ aggregate: 'expense_payment', kind: 'cancel' }),
      '2026-09-20',
      null,
    );
  });

  it('dispatches later Payment replacement with restored-state revalidation delegated', async () => {
    const { service, repository } = harness();
    await service.editPayment(principal, context, ids.target, paymentEditBody());
    expect(repository.correctPayment).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ kind: 'edit' }),
      '2026-09-20',
      '2026-09-21',
    );
  });

  it.each<[string, Partial<Principal>]>([
    ['role', { membershipRole: 'viewer' }],
    ['store', { storeId: ids.target }],
    ['user', { userId: ids.target }],
    ['device', { deviceId: ids.target }],
  ])('rejects mismatched %s authority', async (_label, change) => {
    const { service } = harness();
    await expect(
      service.cancelExpense({ ...principal, ...change }, context, ids.target, cancelBody()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('maps a missing correction target to NotFoundException', async () => {
    const { service, repository } = harness();
    repository.correctExpense.mockResolvedValue({
      ok: false,
      error: {
        code: 'EXPENSE_CORRECTION_TARGET_NOT_FOUND',
        message: 'Expense correction target not found.',
        statusCode: 404,
      },
    });
    await expect(
      service.cancelExpense(principal, context, ids.target, cancelBody()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps an inactive target to ConflictException', async () => {
    const { service, repository } = harness();
    repository.correctPayment.mockResolvedValue({
      ok: false,
      error: {
        code: 'EXPENSE_CORRECTION_TARGET_NOT_ACTIVE',
        message: 'Expense correction target is not active.',
        statusCode: 409,
      },
    });
    await expect(
      service.cancelPayment(principal, context, ids.target, cancelBody()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps active later-payment dependency to ConflictException', async () => {
    const { service, repository } = harness();
    repository.correctExpense.mockResolvedValue({
      ok: false,
      error: {
        code: 'EXPENSE_CORRECTION_ACTIVE_PAYMENT_DEPENDENCY',
        message: 'Expense has active later Payments.',
        statusCode: 409,
      },
    });
    await expect(
      service.cancelExpense(principal, context, ids.target, cancelBody()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps out-of-range correction operational time to validation failure', async () => {
    const { service, operationalTime } = harness();
    operationalTime.resolve.mockImplementation(() => {
      throw new RangeError('unsupported time');
    });
    await expect(
      service.cancelExpense(principal, context, ids.target, cancelBody()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('does not call persistence when authorization fails', async () => {
    const { service, repository } = harness();
    await expect(
      service.cancelPayment(
        { ...principal, membershipRole: 'support' },
        context,
        ids.target,
        cancelBody(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.correctPayment).not.toHaveBeenCalled();
  });
});
