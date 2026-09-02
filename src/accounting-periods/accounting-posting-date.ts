import { assertAccountingPeriodMonth } from './accounting-period-month';

const canonicalAccountingDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface CanonicalAccountingPostingDate {
  value: string;
  periodYear: number;
  periodMonth: number;
}

export class InvalidAccountingPostingDateError extends Error {
  readonly code = 'INVALID_POSTING_DATE';

  constructor() {
    super('Posting date must be a valid canonical accounting date.');
    this.name = 'InvalidAccountingPostingDateError';
  }
}

export function parseAccountingPostingDate(value: string): CanonicalAccountingPostingDate {
  const match = canonicalAccountingDatePattern.exec(value);
  if (!match) {
    throw new InvalidAccountingPostingDateError();
  }

  const periodYear = Number(match[1]);
  const periodMonth = Number(match[2]);
  const day = Number(match[3]);

  try {
    assertAccountingPeriodMonth(periodYear, periodMonth);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new InvalidAccountingPostingDateError();
    }
    throw error;
  }

  if (day < 1 || day > daysInMonth(periodYear, periodMonth)) {
    throw new InvalidAccountingPostingDateError();
  }

  return { value, periodYear, periodMonth };
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
