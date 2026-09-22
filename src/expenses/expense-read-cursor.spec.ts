import { randomUUID } from 'node:crypto';

import {
  decodeExpenseCursor,
  encodeExpenseCursor,
  ExpenseReadQueryError,
} from './expense-read-cursor';

describe('Expense read cursor', () => {
  it('round-trips a canonical immutable anchor', () => {
    const anchor = { id: randomUUID(), version: 7n };
    expect(decodeExpenseCursor(encodeExpenseCursor(anchor))).toEqual(anchor);
  });

  it('rejects malformed, non-canonical, and oversized cursors', () => {
    for (const cursor of [
      '',
      '*',
      Buffer.from(JSON.stringify([1, randomUUID().toUpperCase(), '1'])).toString('base64url'),
      Buffer.from(JSON.stringify([1, randomUUID(), '0'])).toString('base64url'),
      'a'.repeat(88),
    ]) {
      expect(() => decodeExpenseCursor(cursor)).toThrow(ExpenseReadQueryError);
    }
  });
});
