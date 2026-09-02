import { MVP_TIMEZONE_NAME } from '../settings/app-settings.types';
import type { AccountingPeriodBoundaries } from './accounting-period.types';

export const ACCOUNTING_PERIOD_MIN_YEAR = 2020;
export const ACCOUNTING_PERIOD_MAX_YEAR = 9999;

const offsetFormatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
  timeZone: MVP_TIMEZONE_NAME,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'longOffset',
});

export function resolveAccountingPeriodBoundaries(
  periodYear: number,
  periodMonth: number,
): AccountingPeriodBoundaries {
  assertAccountingPeriodMonth(periodYear, periodMonth);

  const nextYear = periodMonth === 12 ? periodYear + 1 : periodYear;
  const nextMonth = periodMonth === 12 ? 1 : periodMonth + 1;

  return {
    periodYear,
    periodMonth,
    startsAt: resolveLocalMidnight(periodYear, periodMonth),
    endsAt: resolveLocalMidnight(nextYear, nextMonth),
    timezoneName: MVP_TIMEZONE_NAME,
  };
}

export function assertAccountingPeriodMonth(periodYear: number, periodMonth: number): void {
  if (
    !Number.isInteger(periodYear) ||
    periodYear < ACCOUNTING_PERIOD_MIN_YEAR ||
    periodYear > ACCOUNTING_PERIOD_MAX_YEAR
  ) {
    throw new RangeError('Accounting period year must be a four-digit year from 2020 onward.');
  }

  if (!Number.isInteger(periodMonth) || periodMonth < 1 || periodMonth > 12) {
    throw new RangeError('Accounting period month must be an integer from 1 through 12.');
  }
}

function resolveLocalMidnight(year: number, month: number): Date {
  const localWallClockEpoch = Date.UTC(year, month - 1, 1, 0, 0, 0, 0);
  let candidateEpoch = localWallClockEpoch;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const nextCandidateEpoch = localWallClockEpoch - offsetMillisecondsAt(candidateEpoch);
    if (nextCandidateEpoch === candidateEpoch) {
      break;
    }
    candidateEpoch = nextCandidateEpoch;
  }

  const candidate = new Date(candidateEpoch);
  assertResolvedLocalMidnight(candidate, year, month);
  return candidate;
}

function offsetMillisecondsAt(epochMilliseconds: number): number {
  const parts = offsetFormatter.formatToParts(new Date(epochMilliseconds));
  const offset = requiredPart(parts, 'timeZoneName');
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offset);

  if (!match) {
    throw new Error('The runtime timezone engine returned an unsupported UTC offset.');
  }

  const sign = match[1] === '+' ? 1 : -1;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  return sign * (hours * 60 + minutes) * 60_000;
}

function assertResolvedLocalMidnight(candidate: Date, year: number, month: number): void {
  const parts = offsetFormatter.formatToParts(candidate);
  const resolved = {
    year: Number(requiredPart(parts, 'year')),
    month: Number(requiredPart(parts, 'month')),
    day: Number(requiredPart(parts, 'day')),
    hour: Number(requiredPart(parts, 'hour')),
    minute: Number(requiredPart(parts, 'minute')),
    second: Number(requiredPart(parts, 'second')),
  };

  if (
    resolved.year !== year ||
    resolved.month !== month ||
    resolved.day !== 1 ||
    resolved.hour !== 0 ||
    resolved.minute !== 0 ||
    resolved.second !== 0
  ) {
    throw new Error('Unable to resolve the canonical Asia/Hebron month boundary.');
  }
}

function requiredPart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  const value = parts.find((part) => part.type === type)?.value;
  if (value === undefined) {
    throw new Error('The runtime timezone engine returned an incomplete local datetime.');
  }
  return value;
}
