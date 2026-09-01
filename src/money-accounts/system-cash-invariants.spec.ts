import type { MoneyAccountMutationRow } from './money-account-write.types';
import {
  isValidSystemCash,
  requireSingleValidSystemCash,
  SYSTEM_CASH_NORMALIZED_NAME,
  SystemCashInvariantError,
} from './system-cash-invariants';

const cash: MoneyAccountMutationRow = {
  id: '84300000-0000-4000-8000-000000000001',
  name: 'الصندوق',
  normalizedName: SYSTEM_CASH_NORMALIZED_NAME,
  accountType: 'cash',
  availability: 'available',
  isDefault: true,
  status: 'active',
  archivedAt: null,
  createdAt: new Date('2026-09-01T08:00:00.000Z'),
  updatedAt: new Date('2026-09-01T08:00:00.000Z'),
  version: 1n,
};

describe('system Cash invariants', () => {
  it('accepts exactly one frozen permanent Cash identity', () => {
    expect(isValidSystemCash(cash)).toBe(true);
    expect(requireSingleValidSystemCash([cash])).toEqual(cash);
  });

  it.each([
    { ...cash, name: 'Cash' },
    { ...cash, normalizedName: 'cash' },
    { ...cash, availability: 'held_by_external_party' as const },
    { ...cash, isDefault: false },
    { ...cash, status: 'archived' as const, archivedAt: new Date() },
  ])('rejects a concrete invalid Cash state', (invalid) => {
    expect(isValidSystemCash(invalid)).toBe(false);
    expect(() => requireSingleValidSystemCash([invalid])).toThrow(SystemCashInvariantError);
  });

  it('rejects missing or multiple historical Cash identities', () => {
    expect(() => requireSingleValidSystemCash([])).toThrow(SystemCashInvariantError);
    expect(() =>
      requireSingleValidSystemCash([cash, { ...cash, id: crypto.randomUUID() }]),
    ).toThrow(SystemCashInvariantError);
  });
});
