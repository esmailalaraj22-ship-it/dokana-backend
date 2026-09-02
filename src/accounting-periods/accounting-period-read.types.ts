import type { AccountingPeriodStatus } from './accounting-period.types';

export const ACCOUNTING_PERIOD_PUBLIC_STATUSES = ['open', 'closed'] as const;
export type AccountingPeriodPublicStatus = (typeof ACCOUNTING_PERIOD_PUBLIC_STATUSES)[number];

export interface AccountingPeriodPhysicalReadRow {
  id: string;
  periodYear: number;
  periodMonth: number;
  startsAt: Date;
  endsAt: Date;
  status: AccountingPeriodStatus;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: bigint;
}

export interface AccountingPeriodReadRow extends Omit<AccountingPeriodPhysicalReadRow, 'status'> {
  status: AccountingPeriodPublicStatus;
}

export interface AccountingPeriodResponse {
  id: string;
  periodYear: number;
  periodMonth: number;
  startsAt: string;
  endsAt: string;
  status: AccountingPeriodPublicStatus;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: string;
}

export interface AccountingPeriodListResponse {
  items: AccountingPeriodResponse[];
}
