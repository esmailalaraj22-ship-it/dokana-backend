import {
  allocateHistoricalLineNetValues,
  assertNewCustomerReturnWithinWindow,
  calculateSaleReturnLine,
  calculateSaleReturnSettlement,
  calculateSupplierReturnSettlement,
  cumulativeProportionalAmount,
  resolveSaleReturnAdmission,
} from './sale-return-policy';
import type { SaleReturnLineAuthority, SaleReturnRequestedLine } from './sale-return.types';
import { SaleReturnAuthorityError } from './sale-return.types';

const lineId = '20000000-0000-4000-8000-000000000001';
const productId = '20000000-0000-4000-8000-000000000002';
const unitId = '20000000-0000-4000-8000-000000000003';
const customerId = '20000000-0000-4000-8000-000000000004';
const accountId = '20000000-0000-4000-8000-000000000005';

function authority(overrides: Partial<SaleReturnLineAuthority> = {}): SaleReturnLineAuthority {
  return {
    saleItemId: lineId,
    productId,
    productUnitId: unitId,
    isManualLine: false,
    productNameSnapshot: 'Historical Product',
    unitNameSnapshot: 'piece',
    originalQuantityMilli: 5000n,
    previousReturnedQuantityMilli: 0n,
    historicalNetValueMinor: 503n,
    conversionFactorNum: 1,
    conversionFactorDen: 1,
    historicalBaseQuantityMilli: 5000n,
    costStatus: 'known',
    historicalLineCostMinor: 251n,
    wasInventoryTracked: true,
    currentProductStatus: 'active',
    currentProductTracksInventory: true,
    currentUnitStatus: 'active',
    ...overrides,
  };
}

function request(overrides: Partial<SaleReturnRequestedLine> = {}): SaleReturnRequestedLine {
  return {
    saleItemId: lineId,
    quantityMilli: 1000n,
    disposition: 'RESTOCK_SALEABLE',
    ...overrides,
  };
}

function expectCode(work: () => unknown, code: string): void {
  try {
    work();
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(SaleReturnAuthorityError);
    expect(error).toMatchObject({ code });
  }
}

describe('Sale Return policy authority', () => {
  describe('48 actual-hour commercial window', () => {
    const saleAt = new Date('2026-09-20T10:00:00Z');

    it('allows a new Return before 48 hours', () => {
      expect(() =>
        assertNewCustomerReturnWithinWindow(saleAt, new Date('2026-09-22T09:59:59.999Z')),
      ).not.toThrow();
    });

    it('allows the exact 48-hour boundary deterministically', () => {
      expect(() =>
        assertNewCustomerReturnWithinWindow(saleAt, new Date('2026-09-22T10:00:00Z')),
      ).not.toThrow();
    });

    it('rejects one millisecond beyond 48 hours', () => {
      expectCode(
        () => assertNewCustomerReturnWithinWindow(saleAt, new Date('2026-09-22T10:00:00.001Z')),
        'SALE_RETURN_WINDOW_EXPIRED',
      );
    });

    it('rejects an acceptance instant before the authoritative Sale', () => {
      expectCode(
        () => assertNewCustomerReturnWithinWindow(saleAt, new Date('2026-09-20T09:59:59Z')),
        'SALE_RETURN_WINDOW_EXPIRED',
      );
    });

    it('resolves an exact historical replay before applying the current window', () => {
      expect(
        resolveSaleReturnAdmission({
          saleAt,
          acceptedAt: new Date('2026-09-23T10:00:00Z'),
          requestHash: 'a'.repeat(64),
          existingRequestHash: 'a'.repeat(64),
        }),
      ).toBe('historical_replay');
    });

    it('rejects changed material identity for an existing operation', () => {
      expectCode(
        () =>
          resolveSaleReturnAdmission({
            saleAt,
            acceptedAt: new Date('2026-09-23T10:00:00Z'),
            requestHash: 'b'.repeat(64),
            existingRequestHash: 'a'.repeat(64),
          }),
        'SALE_RETURN_OPERATION_CONFLICT',
      );
    });
  });

  describe('historical net value allocation', () => {
    const a = '20000000-0000-4000-8000-000000000011';
    const b = '20000000-0000-4000-8000-000000000012';
    const c = '20000000-0000-4000-8000-000000000013';

    it('allocates header discount and rounding to exact Sale total', () => {
      const result = allocateHistoricalLineNetValues(
        [
          { saleItemId: a, lineTotalMinor: 100n },
          { saleItemId: b, lineTotalMinor: 200n },
        ],
        251n,
      );
      expect(result).toEqual(
        new Map([
          [a, 84n],
          [b, 167n],
        ]),
      );
      expect([...result.values()].reduce((sum, value) => sum + value, 0n)).toBe(251n);
    });

    it('is independent of request order', () => {
      const forward = allocateHistoricalLineNetValues(
        [
          { saleItemId: a, lineTotalMinor: 1n },
          { saleItemId: b, lineTotalMinor: 1n },
        ],
        1n,
      );
      const reverse = allocateHistoricalLineNetValues(
        [
          { saleItemId: b, lineTotalMinor: 1n },
          { saleItemId: a, lineTotalMinor: 1n },
        ],
        1n,
      );
      expect(reverse).toEqual(forward);
      expect(forward).toEqual(
        new Map([
          [a, 1n],
          [b, 0n],
        ]),
      );
    });

    it('uses UUID ascending as the equal-remainder tie-break', () => {
      expect(
        allocateHistoricalLineNetValues(
          [
            { saleItemId: c, lineTotalMinor: 1n },
            { saleItemId: b, lineTotalMinor: 1n },
            { saleItemId: a, lineTotalMinor: 1n },
          ],
          2n,
        ),
      ).toEqual(
        new Map([
          [a, 1n],
          [b, 1n],
          [c, 0n],
        ]),
      );
    });

    it('handles the physically valid zero-weight header-rounding edge deterministically', () => {
      expect(
        allocateHistoricalLineNetValues(
          [
            { saleItemId: b, lineTotalMinor: 0n },
            { saleItemId: a, lineTotalMinor: 0n },
          ],
          1n,
        ),
      ).toEqual(
        new Map([
          [a, 1n],
          [b, 0n],
        ]),
      );
    });

    it('preserves bigint values beyond JavaScript safe integer', () => {
      const total = 9_007_199_254_740_993n;
      expect(
        allocateHistoricalLineNetValues([{ saleItemId: a, lineTotalMinor: total }], total).get(a),
      ).toBe(total);
    });
  });

  describe('cumulative partial quantity, value, and cost', () => {
    it('calculates a partial line from historical facts', () => {
      expect(calculateSaleReturnLine(authority(), request())).toMatchObject({
        requestedQuantityMilli: 1000n,
        cumulativeReturnedQuantityMilli: 1000n,
        remainingQuantityMilli: 4000n,
        returnValueMinor: 100n,
        returnHistoricalCostMinor: 50n,
        inventoryQuantityDeltaMilli: 1000n,
      });
    });

    it('calculates a full line and returns exact historical totals', () => {
      expect(calculateSaleReturnLine(authority(), request({ quantityMilli: 5000n }))).toMatchObject(
        {
          returnValueMinor: 503n,
          returnHistoricalCostMinor: 251n,
          remainingQuantityMilli: 0n,
          remainingReturnableValueMinor: 0n,
        },
      );
    });

    it('calculates a later partial Return from active prior quantity', () => {
      expect(
        calculateSaleReturnLine(
          authority({ previousReturnedQuantityMilli: 2000n }),
          request({ quantityMilli: 1000n }),
        ),
      ).toMatchObject({
        previousReturnedValueMinor: 201n,
        returnValueMinor: 100n,
        returnHistoricalCostMinor: 50n,
        cumulativeReturnedQuantityMilli: 3000n,
      });
    });

    it('makes all cumulative partial values equal the full historical value', () => {
      const first = cumulativeProportionalAmount(503n, 2000n, 5000n);
      const second = cumulativeProportionalAmount(503n, 4000n, 5000n) - first;
      const final = cumulativeProportionalAmount(503n, 5000n, 5000n) - first - second;
      expect([first, second, final]).toEqual([201n, 201n, 101n]);
      expect(first + second + final).toBe(503n);
    });

    it('makes all cumulative partial known costs equal historical cost', () => {
      const parts = [1n, 2n, 5n].map((quantity, index, values) => {
        const previous = index === 0 ? 0n : (values[index - 1] ?? 0n);
        return (
          cumulativeProportionalAmount(251n, quantity * 1000n, 5000n) -
          cumulativeProportionalAmount(251n, previous * 1000n, 5000n)
        );
      });
      expect(parts).toEqual([50n, 50n, 151n]);
      expect(parts.reduce((sum, value) => sum + value, 0n)).toBe(251n);
    });

    it('rejects a quantity above the remaining returnable quantity', () => {
      expectCode(
        () =>
          calculateSaleReturnLine(
            authority({ previousReturnedQuantityMilli: 4000n }),
            request({ quantityMilli: 1001n }),
          ),
        'SALE_RETURN_QUANTITY_EXCEEDED',
      );
    });

    it('rejects a mismatched Sale-line authority', () => {
      expectCode(
        () => calculateSaleReturnLine(authority(), request({ saleItemId: customerId })),
        'SALE_RETURN_INTEGRITY_CONFLICT',
      );
    });

    it('uses historical conversion rather than current ProductUnit conversion', () => {
      expect(
        calculateSaleReturnLine(
          authority({ conversionFactorNum: 3, conversionFactorDen: 2 }),
          request({ quantityMilli: 1000n }),
        ).returnBaseQuantityMilli,
      ).toBe(1500n);
    });

    it('rejects a partial quantity not representable by historical conversion', () => {
      expectCode(
        () =>
          calculateSaleReturnLine(
            authority({ conversionFactorNum: 1, conversionFactorDen: 3 }),
            request({ quantityMilli: 1000n }),
          ),
        'SALE_RETURN_AMOUNT_INVALID',
      );
    });

    it('keeps UNKNOWN historical cost nonnumeric', () => {
      expect(
        calculateSaleReturnLine(
          authority({ costStatus: 'unknown', historicalLineCostMinor: null }),
          request(),
        ),
      ).toMatchObject({ historicalLineCostMinor: null, returnHistoricalCostMinor: null });
    });

    it('keeps PENDING historical cost nonnumeric', () => {
      expect(
        calculateSaleReturnLine(
          authority({ costStatus: 'pending', historicalLineCostMinor: 0n }),
          request(),
        ),
      ).toMatchObject({ historicalLineCostMinor: null, returnHistoricalCostMinor: null });
    });

    it('never reverses COGS for damaged goods', () => {
      expect(
        calculateSaleReturnLine(authority(), request({ disposition: 'DAMAGED_NO_RESTOCK' })),
      ).toMatchObject({
        returnHistoricalCostMinor: 50n,
        cogsReversalMinor: null,
        inventoryQuantityDeltaMilli: 0n,
      });
    });

    it('does not create inventory for an untracked Product', () => {
      expect(
        calculateSaleReturnLine(
          authority({ wasInventoryTracked: false, currentProductTracksInventory: false }),
          request(),
        ),
      ).toMatchObject({ inventoryQuantityDeltaMilli: 0n, cogsReversalMinor: 50n });
    });

    it('does not create inventory or cost for a manual line', () => {
      expect(
        calculateSaleReturnLine(
          authority({
            productId: null,
            productUnitId: null,
            isManualLine: true,
            historicalBaseQuantityMilli: null,
            costStatus: 'unknown',
            historicalLineCostMinor: null,
            wasInventoryTracked: false,
            currentProductStatus: null,
            currentProductTracksInventory: null,
            currentUnitStatus: null,
          }),
          request(),
        ),
      ).toMatchObject({
        returnBaseQuantityMilli: null,
        inventoryQuantityDeltaMilli: 0n,
        returnHistoricalCostMinor: null,
      });
    });

    it.each([
      ['archived Product', { currentProductStatus: 'archived' as const }],
      ['archived ProductUnit', { currentUnitStatus: 'archived' as const }],
      ['untracked current Product', { currentProductTracksInventory: false }],
    ])('blocks saleable restock for %s', (_case, override) => {
      expectCode(
        () => calculateSaleReturnLine(authority(override), request()),
        'SALE_RETURN_RESTOCK_UNAVAILABLE',
      );
    });

    it('allows damaged financial Return against archived catalog history', () => {
      expect(
        calculateSaleReturnLine(
          authority({ currentProductStatus: 'archived', currentUnitStatus: 'archived' }),
          request({ disposition: 'DAMAGED_NO_RESTOCK' }),
        ),
      ).toMatchObject({
        productNameSnapshot: 'Historical Product',
        inventoryQuantityDeltaMilli: 0n,
      });
    });
  });

  describe('Customer settlement waterfall', () => {
    const base = {
      returnValueMinor: 300n,
      customerId,
      customerStatus: 'active' as const,
      currentSaleReceivableMinor: 100n,
      historicalCustomerCreditTenderMinor: 50n,
      previouslyRestoredOriginalCreditMinor: 0n,
      residualSettlement: { choice: 'REFUND' as const, moneyAccountId: accountId },
    };

    it('reduces the current Sale Receivable before every other settlement', () => {
      expect(calculateSaleReturnSettlement(base)).toEqual({
        receivableReductionMinor: 100n,
        originalCustomerCreditRestorationMinor: 50n,
        refundMinor: 150n,
        newCustomerCreditMinor: 0n,
        residualChoice: 'REFUND',
        refundMoneyAccountId: accountId,
      });
    });

    it('fully absorbs a Return in Receivable without a residual choice', () => {
      expect(
        calculateSaleReturnSettlement({
          ...base,
          returnValueMinor: 100n,
          currentSaleReceivableMinor: 200n,
          residualSettlement: null,
        }),
      ).toMatchObject({ receivableReductionMinor: 100n, refundMinor: 0n });
    });

    it('partly reduces Receivable before residual processing', () => {
      expect(calculateSaleReturnSettlement(base).receivableReductionMinor).toBe(100n);
    });

    it('restores original Customer Credit before cash', () => {
      expect(calculateSaleReturnSettlement(base).originalCustomerCreditRestorationMinor).toBe(50n);
    });

    it('caps cumulative original Credit restoration at historical consumption', () => {
      expect(
        calculateSaleReturnSettlement({ ...base, previouslyRestoredOriginalCreditMinor: 40n }),
      ).toMatchObject({ originalCustomerCreditRestorationMinor: 10n, refundMinor: 190n });
    });

    it('never converts original Customer Credit tender into refund', () => {
      const result = calculateSaleReturnSettlement({
        ...base,
        returnValueMinor: 50n,
        currentSaleReceivableMinor: 0n,
        residualSettlement: null,
      });
      expect(result).toMatchObject({
        originalCustomerCreditRestorationMinor: 50n,
        refundMinor: 0n,
      });
    });

    it('supports explicit residual Customer Credit for an active Customer', () => {
      expect(
        calculateSaleReturnSettlement({
          ...base,
          residualSettlement: { choice: 'KEEP_AS_CUSTOMER_CREDIT', moneyAccountId: null },
        }),
      ).toMatchObject({ newCustomerCreditMinor: 150n, refundMinor: 0n });
    });

    it('requires an explicit choice when a registered residual exists', () => {
      expectCode(
        () => calculateSaleReturnSettlement({ ...base, residualSettlement: null }),
        'SALE_RETURN_RESIDUAL_CHOICE_REQUIRED',
      );
    });

    it('rejects a residual choice when no residual exists', () => {
      expectCode(
        () =>
          calculateSaleReturnSettlement({
            ...base,
            returnValueMinor: 100n,
            currentSaleReceivableMinor: 100n,
          }),
        'SALE_RETURN_RESIDUAL_CHOICE_INVALID',
      );
    });

    it('supports anonymous Return residual as refund only', () => {
      expect(
        calculateSaleReturnSettlement({
          ...base,
          customerId: null,
          customerStatus: null,
          currentSaleReceivableMinor: 0n,
          historicalCustomerCreditTenderMinor: 0n,
        }),
      ).toMatchObject({ refundMinor: 300n, newCustomerCreditMinor: 0n });
    });

    it('rejects anonymous Customer Credit', () => {
      expectCode(
        () =>
          calculateSaleReturnSettlement({
            ...base,
            customerId: null,
            customerStatus: null,
            currentSaleReceivableMinor: 0n,
            historicalCustomerCreditTenderMinor: 0n,
            residualSettlement: { choice: 'KEEP_AS_CUSTOMER_CREDIT', moneyAccountId: null },
          }),
        'SALE_RETURN_CUSTOMER_CREDIT_NOT_ALLOWED',
      );
    });

    it('supports archived Customer refund without auto-restore', () => {
      expect(calculateSaleReturnSettlement({ ...base, customerStatus: 'archived' })).toMatchObject({
        refundMinor: 150n,
      });
    });

    it('requires restore before archived Customer receives new Credit', () => {
      expectCode(
        () =>
          calculateSaleReturnSettlement({
            ...base,
            customerStatus: 'archived',
            residualSettlement: { choice: 'KEEP_AS_CUSTOMER_CREDIT', moneyAccountId: null },
          }),
        'SALE_RETURN_CUSTOMER_RESTORE_REQUIRED',
      );
    });
  });

  describe('Supplier Return policy isolation', () => {
    it('uses payable-first conceptual settlement', () => {
      expect(calculateSupplierReturnSettlement(800n, 600n)).toEqual({
        payableReductionMinor: 600n,
        supplierCreditMinor: 200n,
      });
    });

    it('does not create negative Payable when Return exceeds it', () => {
      expect(calculateSupplierReturnSettlement(100n, 0n)).toEqual({
        payableReductionMinor: 0n,
        supplierCreditMinor: 100n,
      });
    });

    it('has no time-window input and therefore does not inherit Customer 48 hours', () => {
      expect(calculateSupplierReturnSettlement(1n, 1n)).toEqual({
        payableReductionMinor: 1n,
        supplierCreditMinor: 0n,
      });
    });
  });
});
