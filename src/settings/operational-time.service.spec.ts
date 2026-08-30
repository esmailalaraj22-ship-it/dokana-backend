import { OperationalTimeService } from './operational-time.service';

describe('OperationalTimeService', () => {
  const service = new OperationalTimeService();

  it('preserves the UTC instant and resolves a normal Asia/Hebron local datetime', () => {
    const occurredAt = new Date('2026-01-15T10:00:00.123Z');

    const result = service.resolve(occurredAt);

    expect(result.occurredAt).not.toBe(occurredAt);
    expect(result.occurredAt.toISOString()).toBe('2026-01-15T10:00:00.123Z');
    expect(result.storeLocalDatetime).toBe('2026-01-15T12:00:00.123+02:00[Asia/Hebron]');
    expect(result.businessDate).toBe('2026-01-15');
    expect(result.timezoneName).toBe('Asia/Hebron');
  });

  it('rolls businessDate at local midnight rather than the UTC date boundary', () => {
    const before = service.resolve(new Date('2026-01-14T21:59:59.999Z'));
    const at = service.resolve(new Date('2026-01-14T22:00:00.000Z'));
    const after = service.resolve(new Date('2026-01-14T22:00:00.001Z'));

    expect(before.storeLocalDatetime).toBe('2026-01-14T23:59:59.999+02:00[Asia/Hebron]');
    expect(before.businessDate).toBe('2026-01-14');
    expect(at.storeLocalDatetime).toBe('2026-01-15T00:00:00.000+02:00[Asia/Hebron]');
    expect(at.businessDate).toBe('2026-01-15');
    expect(after.storeLocalDatetime).toBe('2026-01-15T00:00:00.001+02:00[Asia/Hebron]');
    expect(after.businessDate).toBe('2026-01-15');
  });

  it('uses TZDB across the historical spring DST transition without fixed-offset math', () => {
    const before = service.resolve(new Date('2022-03-26T21:59:59.999Z'));
    const after = service.resolve(new Date('2022-03-26T22:00:00.000Z'));

    expect(before.storeLocalDatetime).toBe('2022-03-26T23:59:59.999+02:00[Asia/Hebron]');
    expect(after.storeLocalDatetime).toBe('2022-03-27T01:00:00.000+03:00[Asia/Hebron]');
    expect(before.businessDate).toBe('2022-03-26');
    expect(after.businessDate).toBe('2022-03-27');
  });

  it('disambiguates the repeated local hour at the historical autumn DST transition', () => {
    const firstOccurrence = service.resolve(new Date('2022-10-28T22:30:00.000Z'));
    const secondOccurrence = service.resolve(new Date('2022-10-28T23:30:00.000Z'));

    expect(firstOccurrence.storeLocalDatetime).toBe('2022-10-29T01:30:00.000+03:00[Asia/Hebron]');
    expect(secondOccurrence.storeLocalDatetime).toBe('2022-10-29T01:30:00.000+02:00[Asia/Hebron]');
    expect(firstOccurrence.businessDate).toBe('2022-10-29');
    expect(secondOccurrence.businessDate).toBe('2022-10-29');
  });

  it('rejects an invalid instant', () => {
    expect(() => service.resolve(new Date(Number.NaN))).toThrow(TypeError);
  });
});
