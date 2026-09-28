import type { PostedMoneyMovement } from '../money-movements/money-movement.types';
import type {
  SaleReturnPostingFailureCode,
  SaleReturnPostingResponse,
} from './sale-return-posting.types';

export interface SaleReturnLedgerReversalResponse {
  id: string;
  operationId: string;
  reversalOfId: string;
  receivableDeltaMinor: string;
  creditDeltaMinor: string;
}

export interface SaleReturnMoneyReversalResponse extends PostedMoneyMovement {
  reversalOfId: string;
}

export interface SaleReturnInventoryReversalResponse {
  id: string;
  operationId: string;
  reversalOfId: string;
  productId: string;
  productUnitId: string;
  quantityDeltaMilli: string;
  valueDeltaMinor: string | null;
  costStatus: 'known' | 'unknown' | 'pending';
}

export interface SaleReturnCorrectionResponse {
  operationId: string;
  transactionGroupId: string;
  targetReturnId: string;
  intent: 'cancel' | 'replace';
  correctionReason: string;
  occurredAt: string;
  businessDate: string;
  postingDate: string;
  accountingPeriodId: string;
  outcome: {
    targetReturnId: string;
    status: 'cancelled';
    cancelledAt: string;
    version: string;
    activeReturnId: string | null;
  };
  reversal: {
    customerLedgerEffects: SaleReturnLedgerReversalResponse[];
    moneyMovements: SaleReturnMoneyReversalResponse[];
    inventoryMovements: SaleReturnInventoryReversalResponse[];
  };
  replacement: SaleReturnPostingResponse | null;
}

export type SaleReturnCorrectionFailureCode =
  | SaleReturnPostingFailureCode
  | 'SALE_RETURN_CORRECTION_CREDIT_DEPENDENCY'
  | 'SALE_RETURN_CORRECTION_INVENTORY_STATE_CONFLICT'
  | 'SALE_RETURN_CORRECTION_NEGATIVE_STOCK_NOT_ALLOWED'
  | 'SALE_RETURN_CORRECTION_SCOPE_EXPANDED'
  | 'SALE_RETURN_CORRECTION_TARGET_INTEGRITY_CONFLICT'
  | 'SALE_RETURN_CORRECTION_TARGET_NOT_ACTIVE'
  | 'SALE_RETURN_CORRECTION_TARGET_NOT_FOUND';

export interface SaleReturnCorrectionFailure {
  code: SaleReturnCorrectionFailureCode;
  message: string;
  statusCode: 400 | 404 | 409;
}

export type SaleReturnCorrectionResult =
  | { ok: true; response: SaleReturnCorrectionResponse }
  | { ok: false; error: SaleReturnCorrectionFailure };
