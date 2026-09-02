import {
  InvalidAccountingPostingDateError,
  parseAccountingPostingDate,
} from './accounting-posting-date';

describe('parseAccountingPostingDate', () => {
  it('parses a valid canonical accounting date without timezone conversion', () => {
    expect(parseAccountingPostingDate('2026-09-02')).toEqual({
      value: '2026-09-02',
      periodYear: 2026,
      periodMonth: 9,
    });
  });

  it.each([
    ['2025-12-31', 2025, 12],
    ['2026-01-01', 2026, 1],
    ['2024-02-29', 2024, 2],
  ])('derives the correct month for %s', (value, periodYear, periodMonth) => {
    expect(parseAccountingPostingDate(value)).toEqual({ value, periodYear, periodMonth });
  });

  it.each([
    '2026-02-29',
    '2024-02-30',
    '2026-04-31',
    '2026-00-01',
    '2019-12-31',
    '2026-9-02',
    '02/09/2026',
    '2026-09-02T00:00:00Z',
  ])('rejects invalid or non-canonical date %s', (value) => {
    expect(() => parseAccountingPostingDate(value)).toThrow(InvalidAccountingPostingDateError);
  });
});
