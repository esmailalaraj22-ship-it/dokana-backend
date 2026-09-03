import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import { OperationalTimeService } from '../settings/operational-time.service';
import type { OwnerLedgerPostingRepository } from './owner-ledger-posting.repository';
import type { OwnerLedgerMutationResponse, OwnerLedgerMutationResult } from './owner-ledger.types';
import { OwnerLedgerWriteService } from './owner-ledger-write.service';

const ids = {
  store: '10000000-0000-4000-8000-000000000001',
  user: '10000000-0000-4000-8000-000000000002',
  device: '10000000-0000-4000-8000-000000000003',
  request: '10000000-0000-4000-8000-000000000004',
  account: '10000000-0000-4000-8000-000000000005',
  operation: '10000000-0000-4000-8000-000000000006',
  period: '10000000-0000-4000-8000-000000000007',
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

const response: OwnerLedgerMutationResponse = {
  operationId: ids.operation,
  postingDate: '2026-02-01',
  accountingPeriodId: ids.period,
  movements: [],
  ownerEntries: [],
};

describe('OwnerLedgerWriteService', () => {
  const repository = {
    postOpeningBalance: jest.fn<
      Promise<OwnerLedgerMutationResult>,
      Parameters<OwnerLedgerPostingRepository['postOpeningBalance']>
    >(),
    postOwnerCommand: jest.fn<
      Promise<OwnerLedgerMutationResult>,
      Parameters<OwnerLedgerPostingRepository['postOwnerCommand']>
    >(),
  };
  const service = new OwnerLedgerWriteService(
    repository as unknown as OwnerLedgerPostingRepository,
    new OperationalTimeService(),
  );

  beforeEach(() => {
    repository.postOpeningBalance.mockReset();
    repository.postOwnerCommand.mockReset();
    repository.postOpeningBalance.mockResolvedValue({ ok: true, response });
    repository.postOwnerCommand.mockResolvedValue({ ok: true, response });
  });

  it('canonicalizes a signed opening request and resolves the Asia/Hebron posting date', async () => {
    await service.postOpeningBalance(principal, context, {
      operationId: ids.operation.toUpperCase(),
      moneyAccountId: ids.account.toUpperCase(),
      amountMinor: '-4500',
      occurredAt: '2026-01-31T22:30:00.000Z',
    });

    const call = repository.postOpeningBalance.mock.calls[0];
    expect(call?.[0]).toBe(context);
    expect(call?.[1]).toMatchObject({
      operationId: ids.operation,
      moneyAccountId: ids.account,
      amountMinor: -4500n,
      postingDate: '2026-02-01',
      occurredAt: new Date('2026-01-31T22:30:00.000Z'),
    });
    expect(call?.[1].requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalizes equivalent offset instants to the same canonical request hash', async () => {
    await service.postOpeningBalance(principal, context, {
      operationId: ids.operation,
      moneyAccountId: ids.account,
      amountMinor: '0',
      occurredAt: '2026-01-15T12:00:00+02:00',
    });
    await service.postOpeningBalance(principal, context, {
      operationId: ids.operation,
      moneyAccountId: ids.account,
      amountMinor: '0',
      occurredAt: '2026-01-15T10:00:00Z',
    });

    const first = repository.postOpeningBalance.mock.calls[0]?.[1];
    const second = repository.postOpeningBalance.mock.calls[1]?.[1];
    expect(first?.requestHash).toBe(second?.requestHash);
  });

  it.each([
    ['postContribution', 'owner_contribution'],
    ['postLoan', 'owner_loan'],
    ['postReimbursement', 'owner_reimbursement'],
    ['postPersonalWithdrawal', 'owner_personal_withdrawal'],
    ['postCapitalWithdrawal', 'owner_capital_withdrawal'],
  ] as const)('dispatches %s as a positive-magnitude %s command', async (method, kind) => {
    await service[method](principal, context, {
      operationId: ids.operation,
      moneyAccountId: ids.account,
      amountMinor: '9223372036854775807',
      occurredAt: '2026-02-01T08:00:00.123Z',
    });

    expect(repository.postOwnerCommand).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        amountMinor: 9_223_372_036_854_775_807n,
        postingDate: '2026-02-01',
      }),
      kind,
    );
  });

  it.each([
    ['9223372036854775808', 'postContribution'],
    ['0', 'postContribution'],
    ['-1', 'postContribution'],
    ['-9223372036854775808', 'postOpeningBalance'],
  ] as const)('rejects unrepresentable or non-positive amount %s', async (amountMinor, method) => {
    await expect(
      service[method](principal, context, {
        operationId: ids.operation,
        moneyAccountId: ids.account,
        amountMinor,
        occurredAt: '2026-02-01T08:00:00Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a local or date-only occurredAt with no explicit offset', async () => {
    await expect(
      service.postLoan(principal, context, {
        operationId: ids.operation,
        moneyAccountId: ids.account,
        amountMinor: '1',
        occurredAt: '2026-02-01',
      }),
    ).rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR' } });
  });

  it('rejects non-owner or mismatched trusted principal context before persistence', async () => {
    await expect(
      service.postPersonalWithdrawal({ ...principal, membershipRole: 'manager' }, context, {
        operationId: ids.operation,
        moneyAccountId: ids.account,
        amountMinor: '1',
        occurredAt: '2026-02-01T08:00:00Z',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.postOwnerCommand).not.toHaveBeenCalled();
  });

  it('maps a stored domain rejection without weakening its stable error code', async () => {
    repository.postOwnerCommand.mockResolvedValue({
      ok: false,
      error: {
        code: 'OWNER_LIABILITY_EXCEEDED',
        message: 'Reimbursement exceeds the outstanding owner liability.',
        statusCode: 409,
      },
    });

    await expect(
      service.postReimbursement(principal, context, {
        operationId: ids.operation,
        moneyAccountId: ids.account,
        amountMinor: '1',
        occurredAt: '2026-02-01T08:00:00Z',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
