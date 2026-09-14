import type {
  CustomerCollectionTenderCommand,
  CustomerReceivableTargetType,
} from './customer-payment-posting-command';

export interface CustomerReceivableSettlementPlanItem {
  targetType: CustomerReceivableTargetType;
  targetId: string;
  originId: string;
  amountMinor: bigint;
}

export interface CustomerPaymentAllocationMatrixItem extends CustomerReceivableSettlementPlanItem {
  moneyAccountId: string;
  paymentAmountMinor: bigint;
}

export function partitionCustomerCollection(
  tenders: CustomerCollectionTenderCommand[],
  settlementPlan: CustomerReceivableSettlementPlanItem[],
): CustomerPaymentAllocationMatrixItem[] {
  const result: CustomerPaymentAllocationMatrixItem[] = [];
  let tenderIndex = 0;
  let planIndex = 0;
  let tenderRemaining = tenders[0]?.amountMinor ?? 0n;
  let targetRemaining = settlementPlan[0]?.amountMinor ?? 0n;

  while (tenderIndex < tenders.length && planIndex < settlementPlan.length) {
    const currentTender = tenders[tenderIndex];
    const currentTarget = settlementPlan[planIndex];
    if (!currentTender || !currentTarget || tenderRemaining <= 0n || targetRemaining <= 0n) {
      throw new RangeError('Customer collection allocation input is inconsistent.');
    }
    const amountMinor = tenderRemaining < targetRemaining ? tenderRemaining : targetRemaining;
    result.push({
      ...currentTarget,
      moneyAccountId: currentTender.moneyAccountId,
      paymentAmountMinor: currentTender.amountMinor,
      amountMinor,
    });
    tenderRemaining -= amountMinor;
    targetRemaining -= amountMinor;
    if (tenderRemaining === 0n) {
      tenderIndex += 1;
      tenderRemaining = tenders[tenderIndex]?.amountMinor ?? 0n;
    }
    if (targetRemaining === 0n) {
      planIndex += 1;
      targetRemaining = settlementPlan[planIndex]?.amountMinor ?? 0n;
    }
  }

  if (tenderIndex !== tenders.length || planIndex !== settlementPlan.length) {
    throw new RangeError('Customer collection totals do not match.');
  }
  return result;
}
