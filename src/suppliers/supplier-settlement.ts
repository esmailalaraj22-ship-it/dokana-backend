import type { SupplierSettlementState } from './supplier-financial-read.types';

export interface SupplierSettlementAmounts {
  paidAmountMinor: bigint;
  outstandingMinor: bigint;
  settlementState: SupplierSettlementState | null;
}

export function deriveSupplierSettlement(
  obligationMinor: bigint,
  activeAllocatedMinor: bigint,
): SupplierSettlementAmounts {
  if (obligationMinor < 0n || activeAllocatedMinor < 0n || activeAllocatedMinor > obligationMinor) {
    throw new Error('Supplier settlement facts are inconsistent.');
  }

  const outstandingMinor = obligationMinor - activeAllocatedMinor;
  let settlementState: SupplierSettlementState | null = null;
  if (obligationMinor > 0n) {
    settlementState =
      activeAllocatedMinor === 0n ? 'UNPAID' : outstandingMinor === 0n ? 'PAID' : 'PARTIALLY_PAID';
  }

  return {
    paidAmountMinor: activeAllocatedMinor,
    outstandingMinor,
    settlementState,
  };
}
