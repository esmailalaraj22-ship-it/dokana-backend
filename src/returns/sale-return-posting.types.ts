import type { SaleItemCostStatus } from '../database/schema';
import type { PostedMoneyMovement } from '../money-movements/money-movement.types';
import type { SaleReturnAuthorityFailureCode, SaleReturnDisposition } from './sale-return.types';

export interface PostedSaleReturnLine {
  id: string;
  saleItemId: string;
  productId: string | null;
  productUnitId: string | null;
  quantityMilli: string;
  baseQuantityMilli: string | null;
  lineRefundMinor: string;
  disposition: SaleReturnDisposition;
  itemCondition: 'saleable' | 'damaged';
  costStatus: SaleItemCostStatus;
  historicalCostMinor: string | null;
  cogsReversalMinor: string | null;
  inventoryMovement: {
    id: string;
    operationId: string;
    quantityDeltaMilli: string;
    valueDeltaMinor: string | null;
  } | null;
}

export type SaleReturnSettlementKind =
  | 'receivable_reduction'
  | 'original_customer_credit_restoration'
  | 'new_customer_credit'
  | 'money_refund';

export interface PostedSaleReturnSettlement {
  id: string;
  kind: SaleReturnSettlementKind;
  amountMinor: string;
  customerLedgerEntryId: string | null;
  customerLedgerOperationId: string | null;
  moneyAccountId: string | null;
  moneyMovement: PostedMoneyMovement | null;
}

export interface SaleReturnPostingResponse {
  operationId: string;
  transactionGroupId: string;
  return: {
    id: string;
    displayNumber: string;
    saleId: string;
    saleDisplayNumber: string;
    customerId: string | null;
    totalMinor: string;
    status: 'posted';
    returnAt: string;
    createdAt: string;
    version: string;
  };
  lines: PostedSaleReturnLine[];
  settlements: PostedSaleReturnSettlement[];
  settlementSummary: {
    receivableReductionMinor: string;
    originalCustomerCreditRestorationMinor: string;
    refundMinor: string;
    newCustomerCreditMinor: string;
    residualChoice: 'REFUND' | 'KEEP_AS_CUSTOMER_CREDIT' | null;
  };
  posting: {
    businessDate: string;
    postingDate: string;
    accountingPeriodId: string;
  };
}

export type SaleReturnPostingFailureCode =
  | SaleReturnAuthorityFailureCode
  | 'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT'
  | 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE'
  | 'OPERATION_ID_CONFLICT'
  | 'OPERATION_IN_PROGRESS';

export interface SaleReturnPostingFailure {
  code: SaleReturnPostingFailureCode;
  message: string;
  statusCode: 400 | 404 | 409;
}

export type SaleReturnPostingResult =
  | { ok: true; response: SaleReturnPostingResponse }
  | { ok: false; error: SaleReturnPostingFailure };
