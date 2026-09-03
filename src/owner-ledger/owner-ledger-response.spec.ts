import { parseStoredOwnerLedgerMutationResponse } from './owner-ledger-response';

const ids = {
  operation: '30000000-0000-4000-8000-000000000001',
  period: '30000000-0000-4000-8000-000000000002',
  movement: '30000000-0000-4000-8000-000000000003',
  movementOperation: '30000000-0000-4000-8000-000000000004',
  ownerEntry: '30000000-0000-4000-8000-000000000005',
  ownerOperation: '30000000-0000-4000-8000-000000000006',
  account: '30000000-0000-4000-8000-000000000007',
};

describe('stored Owner Ledger mutation response', () => {
  it('accepts a zero-opening historical response without accounting facts', () => {
    expect(
      parseStoredOwnerLedgerMutationResponse({
        operationId: ids.operation,
        postingDate: '2026-02-01',
        accountingPeriodId: ids.period,
        movements: [],
        ownerEntries: [],
      }),
    ).toEqual({
      operationId: ids.operation,
      postingDate: '2026-02-01',
      accountingPeriodId: ids.period,
      movements: [],
      ownerEntries: [],
    });
  });

  it('accepts an exact paired owner-money snapshot', () => {
    const value = {
      operationId: ids.operation,
      postingDate: '2026-02-01',
      accountingPeriodId: ids.period,
      movements: [
        {
          id: ids.movement,
          accountId: ids.account,
          accountingPeriodId: ids.period,
          movementType: 'owner_loan',
          amountDeltaMinor: '1000',
          transactionGroupId: ids.operation,
          operationId: ids.movementOperation,
          occurredAt: '2026-02-01T08:00:00.000Z',
          createdAt: '2026-02-01T08:00:01.000Z',
        },
      ],
      ownerEntries: [
        {
          id: ids.ownerEntry,
          entryType: 'owner_loan_to_store',
          ownerLiabilityDeltaMinor: '1000',
          equityDeltaMinor: '0',
          moneyAccountId: ids.account,
          transactionGroupId: ids.operation,
          operationId: ids.ownerOperation,
          occurredAt: '2026-02-01T08:00:00.000Z',
          createdAt: '2026-02-01T08:00:01.000Z',
        },
      ],
    };

    expect(parseStoredOwnerLedgerMutationResponse(value)).toEqual(value);
  });

  it.each([
    { postingDate: null },
    { accountingPeriodId: null },
    {
      ownerEntries: [
        {
          id: ids.ownerEntry,
          entryType: 'capital_contribution',
          ownerLiabilityDeltaMinor: '0',
          equityDeltaMinor: '0',
          moneyAccountId: ids.account,
          transactionGroupId: ids.operation,
          operationId: ids.ownerOperation,
          occurredAt: '2026-02-01T08:00:00.000Z',
          createdAt: '2026-02-01T08:00:01.000Z',
        },
      ],
    },
  ])('rejects malformed historical response data', (override) => {
    expect(() =>
      parseStoredOwnerLedgerMutationResponse({
        operationId: ids.operation,
        postingDate: '2026-02-01',
        accountingPeriodId: ids.period,
        movements: [],
        ownerEntries: [],
        ...override,
      }),
    ).toThrow('Stored owner-ledger response is invalid.');
  });
});
