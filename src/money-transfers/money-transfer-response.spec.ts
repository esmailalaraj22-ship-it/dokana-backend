import {
  deriveMoneyFactId,
  deriveMoneyFactOperationId,
} from '../money-movements/money-movement-identity';
import { parseStoredMoneyTransferMutationResponse } from './money-transfer-response';

const ids = {
  store: '10000000-0000-4000-8000-000000000009',
  operation: '7f3a9c2e-1b4d-4a6f-8c0e-2d5b7e9a1c33',
  period: '10000000-0000-4000-8000-000000000001',
  source: '10000000-0000-4000-8000-000000000002',
  destination: '10000000-0000-4000-8000-000000000003',
};

function storedResponse() {
  const transferAt = '2026-01-15T10:00:00.000Z';
  const createdAt = '2026-01-15T10:00:01.000Z';
  return {
    operationId: ids.operation,
    postingDate: '2026-01-15',
    accountingPeriodId: ids.period,
    transfer: {
      id: deriveMoneyFactId(ids.store, ids.operation, 'transfer-header'),
      displayNumber: 'T1-2026-000001',
      sourceAccountId: ids.source,
      destinationAccountId: ids.destination,
      amountMinor: '100',
      transferAt,
      sourceMovementId: deriveMoneyFactId(ids.store, ids.operation, 'transfer-source'),
      destinationMovementId: deriveMoneyFactId(ids.store, ids.operation, 'transfer-destination'),
      status: 'posted',
      operationId: deriveMoneyFactOperationId(ids.store, ids.operation, 'transfer-header'),
      createdAt,
      updatedAt: createdAt,
      version: '1',
    },
    movements: [
      {
        id: deriveMoneyFactId(ids.store, ids.operation, 'transfer-source'),
        accountId: ids.source,
        accountingPeriodId: ids.period,
        movementType: 'internal_transfer',
        amountDeltaMinor: '-100',
        transactionGroupId: ids.operation,
        operationId: deriveMoneyFactOperationId(ids.store, ids.operation, 'transfer-source'),
        occurredAt: transferAt,
        createdAt,
      },
      {
        id: deriveMoneyFactId(ids.store, ids.operation, 'transfer-destination'),
        accountId: ids.destination,
        accountingPeriodId: ids.period,
        movementType: 'internal_transfer',
        amountDeltaMinor: '100',
        transactionGroupId: ids.operation,
        operationId: deriveMoneyFactOperationId(ids.store, ids.operation, 'transfer-destination'),
        occurredAt: transferAt,
        createdAt,
      },
    ],
  };
}

describe('stored Money Transfer response', () => {
  it('rejects an otherwise valid response derived for a different Store', () => {
    expect(() => parseStoredMoneyTransferMutationResponse(ids.source, storedResponse())).toThrow(
      'Stored Money Transfer response is invalid.',
    );
  });
  it('accepts the exact historical header and equal/opposite movement pair', () => {
    const value = storedResponse();
    expect(parseStoredMoneyTransferMutationResponse(ids.store, value)).toEqual(value);
  });

  it('rejects a response whose semantic source and destination facts are swapped', () => {
    const value = storedResponse();
    value.movements.reverse();
    expect(() => parseStoredMoneyTransferMutationResponse(ids.store, value)).toThrow(
      'Stored Money Transfer response is invalid.',
    );
  });

  it('rejects a non-zero-net or mismatched header response', () => {
    const value = storedResponse();
    const destination = value.movements.at(1);
    if (!destination) {
      throw new Error('Stored response fixture is missing its destination movement.');
    }
    destination.amountDeltaMinor = '99';
    expect(() => parseStoredMoneyTransferMutationResponse(ids.store, value)).toThrow(
      'Stored Money Transfer response is invalid.',
    );
  });
});
