import {
  mapMoneyAccountMutationResponse,
  parseStoredMoneyAccountMutationResponse,
} from './money-account-write-response';
import type { MoneyAccountMutationRow } from './money-account-write.types';

const row: MoneyAccountMutationRow = {
  id: '84200000-0000-4000-8000-000000000001',
  name: 'Bank Account',
  normalizedName: 'bank account',
  accountType: 'transfer',
  availability: 'available',
  isDefault: false,
  status: 'active',
  archivedAt: null,
  createdAt: new Date('2026-09-01T08:00:00.000Z'),
  updatedAt: new Date('2026-09-01T09:00:00.000Z'),
  version: 9_007_199_254_740_993n,
};
const operationId = '84200000-0000-4000-8000-000000000002';

describe('Money Account mutation response', () => {
  it('uses the exact S8.3 projection plus operationId and lossless version', () => {
    const response = mapMoneyAccountMutationResponse(row, operationId);
    expect(response).toEqual({
      id: row.id,
      name: row.name,
      accountType: 'transfer',
      isDefault: false,
      status: 'active',
      archivedAt: null,
      createdAt: '2026-09-01T08:00:00.000Z',
      updatedAt: '2026-09-01T09:00:00.000Z',
      version: '9007199254740993',
      operationId,
    });
    expect(parseStoredMoneyAccountMutationResponse(response)).toEqual(response);
  });

  it('rejects stored Cash, malformed UUID, or numeric-version snapshots', () => {
    const response = mapMoneyAccountMutationResponse(row, operationId);
    for (const invalid of [
      { ...response, accountType: 'cash', isDefault: true },
      { ...response, id: 'invalid' },
      { ...response, version: 1 },
    ]) {
      expect(() => parseStoredMoneyAccountMutationResponse(invalid)).toThrow();
    }
  });

  it('does not expose an unexpected stored balance field', () => {
    const response = mapMoneyAccountMutationResponse(row, operationId);
    expect(parseStoredMoneyAccountMutationResponse({ ...response, balance: '999' })).toEqual(
      response,
    );
  });
});
