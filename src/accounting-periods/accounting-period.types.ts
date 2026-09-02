import type { MvpTimezone } from '../settings/app-settings.types';

export const ACCOUNTING_PERIOD_STATUSES = ['open', 'closing', 'closed'] as const;
export type AccountingPeriodStatus = (typeof ACCOUNTING_PERIOD_STATUSES)[number];

export interface AccountingPeriodRow {
  id: string;
  storeId: string;
  periodYear: number;
  periodMonth: number;
  startsAt: Date;
  endsAt: Date;
  status: AccountingPeriodStatus;
  closedAt: Date | null;
  deviceId: string | null;
  operationId: string;
  createdAt: Date;
  updatedAt: Date;
  version: bigint;
}

export interface AccountingPeriodMonth {
  periodYear: number;
  periodMonth: number;
}

export interface AccountingPeriodBoundaries extends AccountingPeriodMonth {
  startsAt: Date;
  endsAt: Date;
  timezoneName: MvpTimezone;
}
