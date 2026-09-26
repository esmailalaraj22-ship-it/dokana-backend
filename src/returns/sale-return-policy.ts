import { inventoryBaseQuantity } from '../inventory/inventory-math';
import type {
  SaleReturnCalculatedLine,
  SaleReturnCommand,
  SaleReturnLineAuthority,
  SaleReturnSettlementPlan,
} from './sale-return.types';
import { CUSTOMER_RETURN_WINDOW_MS, SaleReturnAuthorityError } from './sale-return.types';

export function assertNewCustomerReturnWithinWindow(saleAt: Date, acceptedAt: Date): void {
  const saleTime = saleAt.getTime();
  const acceptedTime = acceptedAt.getTime();
  if (
    !Number.isFinite(saleTime) ||
    !Number.isFinite(acceptedTime) ||
    acceptedTime < saleTime ||
    acceptedTime > saleTime + CUSTOMER_RETURN_WINDOW_MS
  ) {
    throw new SaleReturnAuthorityError('SALE_RETURN_WINDOW_EXPIRED');
  }
}

export function resolveSaleReturnAdmission(input: {
  saleAt: Date;
  acceptedAt: Date;
  requestHash: string;
  existingRequestHash: string | null;
}): 'new' | 'historical_replay' {
  if (input.existingRequestHash !== null) {
    if (input.existingRequestHash !== input.requestHash) {
      throw new SaleReturnAuthorityError('SALE_RETURN_OPERATION_CONFLICT');
    }
    return 'historical_replay';
  }
  assertNewCustomerReturnWithinWindow(input.saleAt, input.acceptedAt);
  return 'new';
}

export function allocateHistoricalLineNetValues(
  lines: readonly { saleItemId: string; lineTotalMinor: bigint }[],
  saleTotalMinor: bigint,
): Map<string, bigint> {
  if (lines.length === 0 || saleTotalMinor < 0n) invalidAmount();
  const ordered = [...lines].sort((left, right) =>
    compareCanonical(left.saleItemId, right.saleItemId),
  );
  if (new Set(ordered.map((line) => line.saleItemId)).size !== ordered.length) invalidIntegrity();
  let weightTotal = 0n;
  for (const line of ordered) {
    if (line.lineTotalMinor < 0n) invalidAmount();
    weightTotal += line.lineTotalMinor;
  }
  if (weightTotal === 0n) {
    const result = new Map(ordered.map((line) => [line.saleItemId, 0n]));
    const first = ordered[0];
    if (!first) invalidIntegrity();
    result.set(first.saleItemId, saleTotalMinor);
    return result;
  }

  const allocations = ordered.map((line) => {
    const numerator = saleTotalMinor * line.lineTotalMinor;
    return {
      saleItemId: line.saleItemId,
      value: numerator / weightTotal,
      remainder: numerator % weightTotal,
    };
  });
  const allocated = allocations.reduce((sum, line) => sum + line.value, 0n);
  let remainderUnits = saleTotalMinor - allocated;
  allocations.sort((left, right) => {
    if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1;
    return compareCanonical(left.saleItemId, right.saleItemId);
  });
  for (const line of allocations) {
    if (remainderUnits === 0n) break;
    line.value += 1n;
    remainderUnits -= 1n;
  }
  if (remainderUnits !== 0n) invalidIntegrity();
  return new Map(allocations.map((line) => [line.saleItemId, line.value]));
}

export function cumulativeProportionalAmount(
  totalAmount: bigint,
  cumulativeQuantity: bigint,
  originalQuantity: bigint,
): bigint {
  if (
    totalAmount < 0n ||
    originalQuantity <= 0n ||
    cumulativeQuantity < 0n ||
    cumulativeQuantity > originalQuantity
  ) {
    invalidAmount();
  }
  return (totalAmount * cumulativeQuantity) / originalQuantity;
}

export function calculateSaleReturnLine(
  authority: SaleReturnLineAuthority,
  request: SaleReturnCommand['lines'][number],
): SaleReturnCalculatedLine {
  if (request.saleItemId !== authority.saleItemId) invalidIntegrity();
  if (request.quantityMilli <= 0n || authority.originalQuantityMilli <= 0n) invalidAmount();
  if (
    authority.previousReturnedQuantityMilli < 0n ||
    authority.previousReturnedQuantityMilli > authority.originalQuantityMilli
  ) {
    invalidIntegrity();
  }
  const cumulativeReturnedQuantityMilli =
    authority.previousReturnedQuantityMilli + request.quantityMilli;
  if (cumulativeReturnedQuantityMilli > authority.originalQuantityMilli) {
    throw new SaleReturnAuthorityError('SALE_RETURN_QUANTITY_EXCEEDED');
  }

  const previousReturnedValueMinor = cumulativeProportionalAmount(
    authority.historicalNetValueMinor,
    authority.previousReturnedQuantityMilli,
    authority.originalQuantityMilli,
  );
  const cumulativeValueMinor = cumulativeProportionalAmount(
    authority.historicalNetValueMinor,
    cumulativeReturnedQuantityMilli,
    authority.originalQuantityMilli,
  );
  const returnValueMinor = cumulativeValueMinor - previousReturnedValueMinor;

  const productLinked =
    !authority.isManualLine &&
    authority.productId !== null &&
    authority.productUnitId !== null &&
    authority.historicalBaseQuantityMilli !== null;
  let returnBaseQuantityMilli: bigint | null = null;
  if (productLinked) {
    try {
      returnBaseQuantityMilli = inventoryBaseQuantity(
        request.quantityMilli,
        authority.conversionFactorNum,
        authority.conversionFactorDen,
      );
    } catch (error) {
      if (error instanceof RangeError) invalidAmount();
      throw error;
    }
    if (returnBaseQuantityMilli <= 0n) invalidAmount();
  }

  const currentRestockEligible =
    !authority.wasInventoryTracked ||
    (authority.currentProductStatus === 'active' &&
      authority.currentProductTracksInventory === true &&
      authority.currentUnitStatus === 'active');
  if (
    authority.wasInventoryTracked &&
    request.disposition === 'RESTOCK_SALEABLE' &&
    !currentRestockEligible
  ) {
    throw new SaleReturnAuthorityError('SALE_RETURN_RESTOCK_UNAVAILABLE');
  }

  let previousHistoricalCostMinor: bigint | null = null;
  let returnHistoricalCostMinor: bigint | null = null;
  if (authority.costStatus === 'known') {
    if (authority.historicalLineCostMinor === null) invalidIntegrity();
    previousHistoricalCostMinor = cumulativeProportionalAmount(
      authority.historicalLineCostMinor,
      authority.previousReturnedQuantityMilli,
      authority.originalQuantityMilli,
    );
    returnHistoricalCostMinor =
      cumulativeProportionalAmount(
        authority.historicalLineCostMinor,
        cumulativeReturnedQuantityMilli,
        authority.originalQuantityMilli,
      ) - previousHistoricalCostMinor;
  }

  const saleable = request.disposition === 'RESTOCK_SALEABLE';
  return {
    saleItemId: authority.saleItemId,
    productId: authority.productId,
    productUnitId: authority.productUnitId,
    isManualLine: authority.isManualLine,
    productNameSnapshot: authority.productNameSnapshot,
    unitNameSnapshot: authority.unitNameSnapshot,
    disposition: request.disposition,
    physicalCondition: saleable ? 'saleable' : 'damaged',
    originalQuantityMilli: authority.originalQuantityMilli,
    previousReturnedQuantityMilli: authority.previousReturnedQuantityMilli,
    requestedQuantityMilli: request.quantityMilli,
    cumulativeReturnedQuantityMilli,
    remainingQuantityMilli: authority.originalQuantityMilli - cumulativeReturnedQuantityMilli,
    historicalNetValueMinor: authority.historicalNetValueMinor,
    previousReturnedValueMinor,
    returnValueMinor,
    remainingReturnableValueMinor: authority.historicalNetValueMinor - cumulativeValueMinor,
    historicalBaseQuantityMilli: authority.historicalBaseQuantityMilli,
    returnBaseQuantityMilli,
    inventoryQuantityDeltaMilli:
      authority.wasInventoryTracked && saleable ? (returnBaseQuantityMilli ?? 0n) : 0n,
    costStatus: authority.costStatus,
    historicalLineCostMinor:
      authority.costStatus === 'known' ? authority.historicalLineCostMinor : null,
    returnHistoricalCostMinor,
    cogsReversalMinor: saleable ? returnHistoricalCostMinor : null,
    wasInventoryTracked: authority.wasInventoryTracked,
    currentRestockEligible,
  };
}

export function calculateSaleReturnSettlement(input: {
  returnValueMinor: bigint;
  customerId: string | null;
  customerStatus: 'active' | 'archived' | null;
  currentSaleReceivableMinor: bigint;
  historicalCustomerCreditTenderMinor: bigint;
  previouslyRestoredOriginalCreditMinor: bigint;
  residualSettlement: SaleReturnCommand['residualSettlement'];
}): SaleReturnSettlementPlan {
  if (
    input.returnValueMinor < 0n ||
    input.currentSaleReceivableMinor < 0n ||
    input.historicalCustomerCreditTenderMinor < 0n ||
    input.previouslyRestoredOriginalCreditMinor < 0n ||
    input.previouslyRestoredOriginalCreditMinor > input.historicalCustomerCreditTenderMinor
  ) {
    invalidIntegrity();
  }
  if (input.customerId === null) {
    if (
      input.customerStatus !== null ||
      input.currentSaleReceivableMinor !== 0n ||
      input.historicalCustomerCreditTenderMinor !== 0n ||
      input.previouslyRestoredOriginalCreditMinor !== 0n
    ) {
      invalidIntegrity();
    }
  } else if (input.customerStatus === null) {
    invalidIntegrity();
  }

  const receivableReductionMinor = minimum(
    input.returnValueMinor,
    input.currentSaleReceivableMinor,
  );
  let residual = input.returnValueMinor - receivableReductionMinor;
  const originalCreditRemaining =
    input.historicalCustomerCreditTenderMinor - input.previouslyRestoredOriginalCreditMinor;
  const originalCustomerCreditRestorationMinor = minimum(residual, originalCreditRemaining);
  residual -= originalCustomerCreditRestorationMinor;

  if (residual === 0n) {
    if (input.residualSettlement !== null) {
      throw new SaleReturnAuthorityError('SALE_RETURN_RESIDUAL_CHOICE_INVALID');
    }
    return {
      receivableReductionMinor,
      originalCustomerCreditRestorationMinor,
      refundMinor: 0n,
      newCustomerCreditMinor: 0n,
      residualChoice: null,
      refundMoneyAccountId: null,
    };
  }
  if (!input.residualSettlement) {
    throw new SaleReturnAuthorityError('SALE_RETURN_RESIDUAL_CHOICE_REQUIRED');
  }
  if (input.customerId === null && input.residualSettlement.choice !== 'REFUND') {
    throw new SaleReturnAuthorityError('SALE_RETURN_CUSTOMER_CREDIT_NOT_ALLOWED');
  }
  if (
    input.residualSettlement.choice === 'KEEP_AS_CUSTOMER_CREDIT' &&
    input.customerStatus !== 'active'
  ) {
    throw new SaleReturnAuthorityError('SALE_RETURN_CUSTOMER_RESTORE_REQUIRED');
  }

  return {
    receivableReductionMinor,
    originalCustomerCreditRestorationMinor,
    refundMinor: input.residualSettlement.choice === 'REFUND' ? residual : 0n,
    newCustomerCreditMinor:
      input.residualSettlement.choice === 'KEEP_AS_CUSTOMER_CREDIT' ? residual : 0n,
    residualChoice: input.residualSettlement.choice,
    refundMoneyAccountId: input.residualSettlement.moneyAccountId,
  };
}

export function calculateSupplierReturnSettlement(
  returnValueMinor: bigint,
  currentPayableMinor: bigint,
): { payableReductionMinor: bigint; supplierCreditMinor: bigint } {
  if (returnValueMinor < 0n || currentPayableMinor < 0n) invalidAmount();
  const payableReductionMinor = minimum(returnValueMinor, currentPayableMinor);
  return {
    payableReductionMinor,
    supplierCreditMinor: returnValueMinor - payableReductionMinor,
  };
}

function minimum(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidAmount(): never {
  throw new SaleReturnAuthorityError('SALE_RETURN_AMOUNT_INVALID');
}

function invalidIntegrity(): never {
  throw new SaleReturnAuthorityError('SALE_RETURN_INTEGRITY_CONFLICT');
}
