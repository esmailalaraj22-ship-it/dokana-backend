import type { SalePostingFailureCode, SalePostingResponse } from './sale-posting.types';

interface SaleCorrectionResponseBase {
  operationId: string;
  targetOperationId: string;
  occurredAt: string;
  businessDate: string;
  postingDate: string;
  accountingPeriodId: string;
}

export interface SaleCancelResponse extends SaleCorrectionResponseBase {
  intent: 'cancel';
  outcome: {
    saleId: string;
    status: 'cancelled';
    cancelledAt: string;
    version: string;
  };
  currentSale: null;
}

export interface SaleEditResponse extends SaleCorrectionResponseBase {
  intent: 'edit';
  outcome: {
    saleId: string;
    status: 'posted';
    cancelledAt: null;
    version: string;
  };
  currentSale: SalePostingResponse;
}

export type SaleCorrectionResponse = SaleCancelResponse | SaleEditResponse;

export type SaleCorrectionFailureCode =
  | SalePostingFailureCode
  | 'SALE_CORRECTION_DEPENDENT_FACTS'
  | 'SALE_CORRECTION_INVENTORY_STATE_CONFLICT'
  | 'SALE_CORRECTION_TARGET_INTEGRITY_CONFLICT'
  | 'SALE_CORRECTION_TARGET_NOT_ACTIVE'
  | 'SALE_CORRECTION_TARGET_NOT_FOUND';

export interface SaleCorrectionFailure {
  code: SaleCorrectionFailureCode;
  message: string;
  statusCode: 400 | 404 | 409;
}

export type SaleCorrectionResult =
  { ok: true; response: SaleCorrectionResponse } | { ok: false; error: SaleCorrectionFailure };
