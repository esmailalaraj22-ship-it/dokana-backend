import type { SaleReturnRequestedLine } from './sale-return.types';

export class SaleReturnCorrectionScopeError extends Error {
  constructor() {
    super('SALE_RETURN_CORRECTION_SCOPE_EXPANDED');
    this.name = 'SaleReturnCorrectionScopeError';
  }
}

export function assertNonExpansiveReplacementLines(
  activeLines: readonly { saleItemId: string; quantityMilli: bigint }[],
  replacementLines: readonly SaleReturnRequestedLine[],
): void {
  const activeByLine = new Map(activeLines.map((line) => [line.saleItemId, line.quantityMilli]));
  for (const line of replacementLines) {
    const activeQuantity = activeByLine.get(line.saleItemId);
    if (activeQuantity === undefined || line.quantityMilli > activeQuantity) {
      throw new SaleReturnCorrectionScopeError();
    }
  }
}

export function assertNonExpansiveReplacementTotal(
  activeTotalMinor: bigint,
  replacementTotalMinor: bigint,
): void {
  if (replacementTotalMinor > activeTotalMinor) {
    throw new SaleReturnCorrectionScopeError();
  }
}
