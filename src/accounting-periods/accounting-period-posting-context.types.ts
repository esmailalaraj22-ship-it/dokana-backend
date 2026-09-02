export interface ResolveAccountingPeriodPostingContextInput {
  postingDate: string;
  operationId: string;
}

// This result is authoritative only while the caller's current transaction remains open.
export interface AccountingPeriodPostingContext {
  storeId: string;
  postingDate: string;
  accountingPeriodId: string;
  periodYear: number;
  periodMonth: number;
}
