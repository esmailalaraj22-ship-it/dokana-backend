export type SupplierReturnPolicyFailureCode =
  | 'SUPPLIER_CREDIT_INSUFFICIENT'
  | 'SUPPLIER_CREDIT_APPLICATION_EXCEEDS_OUTSTANDING'
  | 'SUPPLIER_RETURN_EXCEEDS_CREDITABLE_VALUE'
  | 'SUPPLIER_RETURN_FINANCIAL_STATE_INVALID';

export class SupplierReturnPolicyError extends Error {
  constructor(readonly code: SupplierReturnPolicyFailureCode) {
    super(code);
    this.name = 'SupplierReturnPolicyError';
  }
}

export interface SupplierReturnWaterfall {
  payableReductionMinor: bigint;
  supplierCreditCreatedMinor: bigint;
}

export function deriveInvoiceOutstanding(
  adjustedObligationMinor: bigint,
  activePaymentAllocationsMinor: bigint,
): bigint {
  if (
    adjustedObligationMinor < 0n ||
    activePaymentAllocationsMinor < 0n ||
    activePaymentAllocationsMinor > adjustedObligationMinor
  ) {
    throw new SupplierReturnPolicyError('SUPPLIER_RETURN_FINANCIAL_STATE_INVALID');
  }
  return adjustedObligationMinor - activePaymentAllocationsMinor;
}

export function calculateSupplierReturnWaterfall(
  returnAmountMinor: bigint,
  outstandingMinor: bigint,
): SupplierReturnWaterfall {
  if (returnAmountMinor <= 0n || outstandingMinor < 0n) {
    throw new SupplierReturnPolicyError('SUPPLIER_RETURN_FINANCIAL_STATE_INVALID');
  }
  const payableReductionMinor =
    returnAmountMinor < outstandingMinor ? returnAmountMinor : outstandingMinor;
  return {
    payableReductionMinor,
    supplierCreditCreatedMinor: returnAmountMinor - payableReductionMinor,
  };
}

export function assertSupplierReturnCapacity(
  invoiceTotalMinor: bigint,
  activeReturnTotalMinor: bigint,
  requestedReturnMinor: bigint,
): void {
  if (invoiceTotalMinor <= 0n || activeReturnTotalMinor < 0n || requestedReturnMinor <= 0n) {
    throw new SupplierReturnPolicyError('SUPPLIER_RETURN_FINANCIAL_STATE_INVALID');
  }
  if (
    activeReturnTotalMinor > invoiceTotalMinor ||
    requestedReturnMinor > invoiceTotalMinor - activeReturnTotalMinor
  ) {
    throw new SupplierReturnPolicyError('SUPPLIER_RETURN_EXCEEDS_CREDITABLE_VALUE');
  }
}

export function assertSupplierCreditConsumption(
  availableCreditMinor: bigint,
  amountMinor: bigint,
): void {
  if (availableCreditMinor < 0n || amountMinor <= 0n) {
    throw new SupplierReturnPolicyError('SUPPLIER_RETURN_FINANCIAL_STATE_INVALID');
  }
  if (amountMinor > availableCreditMinor) {
    throw new SupplierReturnPolicyError('SUPPLIER_CREDIT_INSUFFICIENT');
  }
}

export function assertSupplierCreditApplication(
  availableCreditMinor: bigint,
  outstandingMinor: bigint,
  amountMinor: bigint,
): void {
  assertSupplierCreditConsumption(availableCreditMinor, amountMinor);
  if (outstandingMinor < 0n) {
    throw new SupplierReturnPolicyError('SUPPLIER_RETURN_FINANCIAL_STATE_INVALID');
  }
  if (amountMinor > outstandingMinor) {
    throw new SupplierReturnPolicyError('SUPPLIER_CREDIT_APPLICATION_EXCEEDS_OUTSTANDING');
  }
}
