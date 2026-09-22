import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import { OperationalTimeService } from '../settings/operational-time.service';
import type { ExpensePaymentRepository } from './expense-payment.repository';
import { ExpensePaymentService } from './expense-payment.service';
import type {
  ExpensePaymentPostingResponse,
  ExpensePaymentPostingResult,
} from './expense-payment.types';

const ids = {
  store: '16300000-0000-4000-8000-000000000001',
  user: '16300000-0000-4000-8000-000000000002',
  device: '16300000-0000-4000-8000-000000000003',
  request: '16300000-0000-4000-8000-000000000004',
  expense: '16300000-0000-4000-8000-000000000005',
  operation: '16300000-0000-4000-8000-000000000006',
  account: '16300000-0000-4000-8000-000000000007',
  period: '16300000-0000-4000-8000-000000000008',
  payment: '16300000-0000-4000-8000-000000000009',
  group: '16300000-0000-4000-8000-000000000010',
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
const response: ExpensePaymentPostingResponse = {
  operationId: ids.operation,
  expenseId: ids.expense,
  businessDate: '2026-10-15',
  postingDate: '2026-10-15',
  accountingPeriodId: ids.period,
  payment: {
    id: ids.payment,
    amountMinor: '200',
    paymentSource: 'money_account',
    moneyAccountId: ids.account,
    moneyMovementId: ids.payment,
    ownerLedgerEntryId: null,
    transactionGroupId: ids.group,
    paymentAt: '2026-10-15T10:00:00.000Z',
    notes: null,
    status: 'posted',
    operationId: ids.operation,
    version: '2',
  },
  settlement: {
    recognizedAmountMinor: '500',
    settledBeforeMinor: '0',
    settledAfterMinor: '200',
    outstandingBeforeMinor: '500',
    outstandingAfterMinor: '300',
  },
  moneyMovement: null,
  ownerLedgerEntry: null,
};

describe('S16.3 ExpensePaymentService', () => {
  const repository = {
    post: jest.fn<
      Promise<ExpensePaymentPostingResult>,
      Parameters<ExpensePaymentRepository['post']>
    >(),
  };
  const service = new ExpensePaymentService(
    repository as unknown as ExpensePaymentRepository,
    new OperationalTimeService(),
  );

  beforeEach(() => {
    repository.post.mockReset().mockResolvedValue({ ok: true, response });
  });

  it('derives posting date and dispatches exact bigint settlement intent', async () => {
    await service.post(principal, context, ids.expense, {
      operationId: ids.operation,
      paymentSource: 'money_account',
      moneyAccountId: ids.account,
      amountMinor: '200',
      occurredAt: '2026-10-15T10:00:00Z',
    });
    expect(repository.post).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        expenseId: ids.expense,
        amountMinor: 200n,
        paymentSource: 'money_account',
      }),
      '2026-10-15',
    );
  });

  it('rejects a non-owner or mismatched trusted context before persistence', async () => {
    await expect(
      service.post({ ...principal, membershipRole: 'manager' }, context, ids.expense, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.post({ ...principal, storeId: ids.expense }, context, ids.expense, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.post).not.toHaveBeenCalled();
  });

  it.each([
    ['OPERATION_ID_CONFLICT', 409, ConflictException],
    ['EXPENSE_NOT_FOUND', 404, NotFoundException],
  ] as const)('preserves repository error %s', async (code, statusCode, expected) => {
    repository.post.mockResolvedValue({
      ok: false,
      error: { code, message: 'Stable failure.', statusCode },
    });
    await expect(
      service.post(principal, context, ids.expense, {
        operationId: ids.operation,
        paymentSource: 'owner_pocket',
        amountMinor: '1',
        occurredAt: '2026-10-15T10:00:00Z',
      }),
    ).rejects.toBeInstanceOf(expected);
  });
});
