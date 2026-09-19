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

export interface CustomerPaymentTenderPartition {
  moneyAccountId: string;
  allocatedMinor: bigint;
  creditCreatedMinor: bigint;
}

export interface CustomerPaymentPartition {
  allocations: CustomerPaymentAllocationMatrixItem[];
  tenders: CustomerPaymentTenderPartition[];
}

export function partitionCustomerCollection(
  tenders: CustomerCollectionTenderCommand[],
  settlementPlan: CustomerReceivableSettlementPlanItem[],
): CustomerPaymentAllocationMatrixItem[] {
  const partition = partitionCustomerPayment(tenders, settlementPlan);
  if (partition.tenders.some((tender) => tender.creditCreatedMinor !== 0n)) {
    throw new RangeError('Customer collection totals do not match.');
  }
  return partition.allocations;
}

export function partitionCustomerPayment(
  tenders: CustomerCollectionTenderCommand[],
  settlementPlan: CustomerReceivableSettlementPlanItem[],
): CustomerPaymentPartition {
  const result: CustomerPaymentAllocationMatrixItem[] = [];
  const tenderPartitions: CustomerPaymentTenderPartition[] = [];
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

  if (planIndex !== settlementPlan.length) {
    throw new RangeError('Customer collection totals do not match.');
  }

  for (const tender of tenders) {
    if (tender.amountMinor <= 0n) {
      throw new RangeError('Customer collection allocation input is inconsistent.');
    }
    const allocatedMinor = result
      .filter((item) => item.moneyAccountId === tender.moneyAccountId)
      .reduce((total, item) => total + item.amountMinor, 0n);
    if (allocatedMinor > tender.amountMinor) {
      throw new RangeError('Customer collection allocation input is inconsistent.');
    }
    tenderPartitions.push({
      moneyAccountId: tender.moneyAccountId,
      allocatedMinor,
      creditCreatedMinor: tender.amountMinor - allocatedMinor,
    });
  }
  return { allocations: result, tenders: tenderPartitions };
}
