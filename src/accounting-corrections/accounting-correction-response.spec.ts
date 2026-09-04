import {
  deriveMoneyFactId,
  deriveMoneyFactOperationId,
} from '../money-movements/money-movement-identity';
import { parseStoredAccountingCorrectionResponse } from './accounting-correction-response';

const ids = {
  operation: '10000000-0000-4000-8000-000000000001',
  target: '10000000-0000-4000-8000-000000000002',
  period: '10000000-0000-4000-8000-000000000003',
  source: '10000000-0000-4000-8000-000000000004',
  destination: '10000000-0000-4000-8000-000000000005',
  originalSourceMovement: '10000000-0000-4000-8000-000000000006',
  originalDestinationMovement: '10000000-0000-4000-8000-000000000007',
};

const occurredAt = '2026-01-20T10:00:00.000Z';
const createdAt = '2026-01-20T10:00:01.000Z';

function movement(
  role: string,
  accountId: string,
  amountDeltaMinor: string,
  reversalOfId: string | null,
) {
  return {
    id: deriveMoneyFactId(ids.operation, role),
    accountId,
    accountingPeriodId: ids.period,
    movementType: 'correction',
    amountDeltaMinor,
    transactionGroupId: ids.operation,
    operationId: deriveMoneyFactOperationId(ids.operation, role),
    occurredAt,
    createdAt,
    reversalOfId,
  };
}

function transferReplacementResponse() {
  const replacementSource = movement('replacement:transfer-source', ids.source, '-15', null);
  const replacementDestination = movement(
    'replacement:transfer-destination',
    ids.destination,
    '15',
    null,
  );
  return {
    operationId: ids.operation,
    targetOperationId: ids.target,
    domain: 'internal_transfer',
    correctionKind: 'replacement',
    postingDate: '2026-01-20',
    accountingPeriodId: ids.period,
    movements: [
      movement('reversal:transfer-source', ids.source, '10', ids.originalSourceMovement),
      movement(
        'reversal:transfer-destination',
        ids.destination,
        '-10',
        ids.originalDestinationMovement,
      ),
      replacementSource,
      replacementDestination,
    ],
    ownerEntries: [],
    replacementTransfer: {
      id: deriveMoneyFactId(ids.operation, 'replacement:transfer-header'),
      displayNumber: 'T-2026-000001',
      sourceAccountId: ids.source,
      destinationAccountId: ids.destination,
      amountMinor: '15',
      transferAt: occurredAt,
      sourceMovementId: replacementSource.id,
      destinationMovementId: replacementDestination.id,
      status: 'posted',
      operationId: deriveMoneyFactOperationId(ids.operation, 'replacement:transfer-header'),
      createdAt,
      updatedAt: createdAt,
      version: '1',
    },
  };
}

describe('parseStoredAccountingCorrectionResponse', () => {
  it('accepts a structurally and deterministically valid Transfer replacement snapshot', () => {
    const value = transferReplacementResponse();
    expect(parseStoredAccountingCorrectionResponse(value)).toEqual(value);
  });

  it('rejects a replacement Transfer header that disagrees with its child facts', () => {
    const value = transferReplacementResponse();
    value.replacementTransfer.amountMinor = '16';
    expect(() => parseStoredAccountingCorrectionResponse(value)).toThrow(
      'Stored accounting-correction response is invalid.',
    );
  });

  it('rejects non-deterministic correction fact identity', () => {
    const value = transferReplacementResponse();
    const replacementDestination = value.movements[3];
    if (!replacementDestination) {
      throw new Error('Test fixture is incomplete.');
    }
    replacementDestination.id = ids.originalDestinationMovement;
    expect(() => parseStoredAccountingCorrectionResponse(value)).toThrow(
      'Stored accounting-correction response is invalid.',
    );
  });
});
