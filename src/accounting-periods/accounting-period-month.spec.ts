import {
  ACCOUNTING_PERIOD_MAX_YEAR,
  ACCOUNTING_PERIOD_MIN_YEAR,
  resolveAccountingPeriodBoundaries,
} from './accounting-period-month';

describe('accounting period monthly boundaries', () => {
  it('resolves a normal Asia/Hebron month as a half-open UTC interval', () => {
    const result = resolveAccountingPeriodBoundaries(2026, 1);

    expect(result).toEqual({
      periodYear: 2026,
      periodMonth: 1,
      startsAt: new Date('2025-12-31T22:00:00.000Z'),
      endsAt: new Date('2026-01-31T22:00:00.000Z'),
      timezoneName: 'Asia/Hebron',
    });
  });

  it('resolves December through the next local calendar year', () => {
    const result = resolveAccountingPeriodBoundaries(2026, 12);

    expect(result.startsAt.toISOString()).toBe('2026-11-30T22:00:00.000Z');
    expect(result.endsAt.toISOString()).toBe('2026-12-31T22:00:00.000Z');
  });

  it('resolves ordinary and leap-year February correctly', () => {
    const ordinary = resolveAccountingPeriodBoundaries(2023, 2);
    const leapYear = resolveAccountingPeriodBoundaries(2024, 2);

    expect(ordinary.startsAt.toISOString()).toBe('2023-01-31T22:00:00.000Z');
    expect(ordinary.endsAt.toISOString()).toBe('2023-02-28T22:00:00.000Z');
    expect(leapYear.startsAt.toISOString()).toBe('2024-01-31T22:00:00.000Z');
    expect(leapYear.endsAt.toISOString()).toBe('2024-02-29T22:00:00.000Z');
  });

  it('uses TZDB rather than fixed-offset arithmetic across a DST-sensitive month', () => {
    const result = resolveAccountingPeriodBoundaries(2022, 3);

    expect(result.startsAt.toISOString()).toBe('2022-02-28T22:00:00.000Z');
    expect(result.endsAt.toISOString()).toBe('2022-03-31T21:00:00.000Z');
    expect(result.endsAt.getTime() - result.startsAt.getTime()).toBe(
      31 * 24 * 60 * 60 * 1_000 - 60 * 60 * 1_000,
    );
  });

  it('makes adjacent canonical months meet at exactly one boundary', () => {
    const march = resolveAccountingPeriodBoundaries(2022, 3);
    const april = resolveAccountingPeriodBoundaries(2022, 4);

    expect(march.endsAt.getTime()).toBe(april.startsAt.getTime());
  });

  it.each([
    [ACCOUNTING_PERIOD_MIN_YEAR - 1, 1],
    [ACCOUNTING_PERIOD_MAX_YEAR + 1, 1],
    [2026.5, 1],
    [2026, 0],
    [2026, 13],
    [2026, 1.5],
  ])('rejects a non-canonical period month (%s, %s)', (year, month) => {
    expect(() => resolveAccountingPeriodBoundaries(year, month)).toThrow(RangeError);
  });
});
