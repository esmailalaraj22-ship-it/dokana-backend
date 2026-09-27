import { randomUUID } from 'node:crypto';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import {
  assertSaleReturnReadCursorScope,
  decodeSaleReturnReadCursor,
  encodeSaleReturnReadCursor,
  saleReturnReadCursorScopeHash,
} from './sale-return-read-cursor';
import type { SaleReturnReadRepository } from './sale-return-read.repository';
import { SaleReturnReadService } from './sale-return-read.service';
import type {
  SaleReturnDetailRow,
  SaleReturnEligibilityRow,
  SaleReturnLineReadRow,
  SaleReturnSettlementReadRow,
  SaleReturnSummaryRow,
} from './sale-return-read.types';
import type { SaleReturnPostingResponse } from './sale-return-posting.types';

const storeId = randomUUID();
const userId = randomUUID();
const deviceId = randomUUID();
const requestId = randomUUID();
const saleId = randomUUID();
const returnId = randomUUID();
const customerId = randomUUID();
const periodId = randomUUID();
const operationId = randomUUID();
const transactionGroupId = randomUUID();
const occurredAt = new Date('2026-09-27T10:00:00.000Z');

const principal = {
  membershipRole: 'owner',
  storeId,
  userId,
  deviceId,
} as Pick<AuthenticatedPrincipal, 'membershipRole' | 'storeId' | 'userId' | 'deviceId'>;
const context: TenantTransactionContext = { storeId, userId, deviceId, requestId };

function postingSnapshot(): SaleReturnPostingResponse {
  return {
    operationId,
    transactionGroupId,
    return: {
      id: returnId,
      displayNumber: `SR-${returnId}`,
      saleId,
      saleDisplayNumber: 'SALE-42',
      customerId,
      totalMinor: '300',
      status: 'posted',
      returnAt: occurredAt.toISOString(),
      createdAt: occurredAt.toISOString(),
      version: '2',
    },
    lines: [],
    settlements: [],
    settlementSummary: {
      receivableReductionMinor: '50',
      originalCustomerCreditRestorationMinor: '100',
      newCustomerCreditMinor: '50',
      refundMinor: '100',
      residualChoice: 'REFUND',
    },
    posting: {
      businessDate: '2026-09-27',
      postingDate: '2026-09-27',
      accountingPeriodId: periodId,
    },
  };
}

function summary(overrides: Partial<SaleReturnSummaryRow> = {}): SaleReturnSummaryRow {
  return {
    id: returnId,
    saleId,
    saleDisplayNumber: 'SALE-42',
    saleAt: new Date('2026-09-27T09:00:00.000Z'),
    saleStatus: 'posted',
    saleCorrectionOfId: null,
    saleReversedById: null,
    customer: {
      id: customerId,
      name: 'Historical Customer',
      phone: '0599000000',
      status: 'archived',
      archivedAt: new Date('2026-09-28T00:00:00.000Z'),
    },
    accountingPeriodId: periodId,
    displayNumber: `SR-${returnId}`,
    returnAt: occurredAt,
    totalMinor: 300n,
    status: 'posted',
    reason: 'Returned goods',
    cancelledAt: null,
    operationId,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    version: 2n,
    postingSnapshot: postingSnapshot(),
    settlementSummary: {
      receivableReductionMinor: 50n,
      originalCustomerCreditRestorationMinor: 100n,
      newCustomerCreditMinor: 50n,
      refundMinor: 100n,
    },
    dispositionSummary: {
      restockSaleableLineCount: 1,
      damagedNoRestockLineCount: 3,
      noInventoryEffectLineCount: 3,
    },
    ...overrides,
  };
}

function line(
  costStatus: SaleReturnLineReadRow['costStatus'],
  disposition: SaleReturnLineReadRow['disposition'],
  options: { manual?: boolean; inventory?: boolean; value?: bigint } = {},
): SaleReturnLineReadRow {
  const id = randomUUID();
  const saleItemId = randomUUID();
  const productId = options.manual ? null : randomUUID();
  const productUnitId = options.manual ? null : randomUUID();
  return {
    id,
    saleItemId,
    productId,
    productUnitId,
    isManualLine: options.manual ?? false,
    productNameSnapshot: options.manual ? 'Manual historical line' : 'Historical product',
    unitNameSnapshot: options.manual ? null : 'piece',
    productStatus: productId ? 'archived' : null,
    productUnitStatus: productUnitId ? 'archived' : null,
    quantityMilli: 1_000n,
    baseQuantityMilli: productId ? 1_000n : null,
    lineRefundMinor: options.value ?? 75n,
    disposition,
    costStatus,
    historicalCostMinor: costStatus === 'known' ? 40n : null,
    cogsReversalMinor: costStatus === 'known' && disposition === 'RESTOCK_SALEABLE' ? 40n : null,
    inventoryEffect:
      options.inventory && productId && productUnitId
        ? {
            id: randomUUID(),
            operationId: randomUUID(),
            productId,
            productUnitId,
            movementType: 'customer_return_saleable',
            quantityDeltaMilli: 1_000n,
            valueDeltaMinor: 40n,
            costStatus: 'known',
            referenceType: 'sale_return',
            referenceId: returnId,
            transactionGroupId,
            occurredAt,
            businessDate: '2026-09-27',
            postingDate: '2026-09-27',
          }
        : null,
  };
}

function customerSettlement(
  kind: Extract<
    SaleReturnSettlementReadRow['kind'],
    'receivable_reduction' | 'original_customer_credit_restoration' | 'new_customer_credit'
  >,
  amountMinor: bigint,
): SaleReturnSettlementReadRow {
  const credit = kind !== 'receivable_reduction';
  return {
    id: randomUUID(),
    kind,
    amountMinor,
    customerLedgerEffect: {
      id: randomUUID(),
      operationId: randomUUID(),
      entryType: credit ? 'credit_created' : 'return',
      receivableDeltaMinor: credit ? 0n : -amountMinor,
      creditDeltaMinor: credit ? amountMinor : 0n,
      sourceSaleId: saleId,
      referenceType:
        kind === 'original_customer_credit_restoration'
          ? 'sale_return_original_credit_restoration'
          : 'sale_return',
      referenceId: returnId,
      transactionGroupId,
      occurredAt,
    },
    moneyAccount: null,
    moneyRefundEffect: null,
  };
}

function refundSettlement(): SaleReturnSettlementReadRow {
  const accountId = randomUUID();
  return {
    id: randomUUID(),
    kind: 'money_refund',
    amountMinor: 100n,
    customerLedgerEffect: null,
    moneyAccount: {
      id: accountId,
      name: 'Archived refund account',
      accountType: 'transfer',
      status: 'archived',
    },
    moneyRefundEffect: {
      id: randomUUID(),
      operationId: randomUUID(),
      amountDeltaMinor: -100n,
      movementType: 'customer_refund',
      referenceType: 'sale_return',
      referenceId: returnId,
      transactionGroupId,
      occurredAt,
    },
  };
}

describe('S17.4 Sale Return operational reads', () => {
  const repository = {
    list: jest.fn(),
    findById: jest.fn(),
    findEligibility: jest.fn(),
  } as unknown as jest.Mocked<SaleReturnReadRepository>;
  const service = new SaleReturnReadService(repository);

  beforeEach(() => jest.clearAllMocks());

  it('encodes stable scope-bound root cursors and rejects malformed or cross-scope cursors', () => {
    const encoded = encodeSaleReturnReadCursor({
      scopeHash: saleReturnReadCursorScopeHash(null),
      anchor: { id: returnId, version: 2n },
    });
    expect(decodeSaleReturnReadCursor(encoded)).toEqual({
      scopeHash: saleReturnReadCursorScopeHash(null),
      anchor: { id: returnId, version: 2n },
    });
    expect(() =>
      assertSaleReturnReadCursorScope(decodeSaleReturnReadCursor(encoded), saleId),
    ).toThrow('saleReturnCursorScope');
    expect(() => decodeSaleReturnReadCursor('not-a-cursor')).toThrow('saleReturnCursor');
  });

  it('paginates Return roots and binds a continuation cursor to the list scope', async () => {
    const rows = [summary(), summary({ id: randomUUID(), version: 3n })];
    repository.list.mockResolvedValue(rows);
    const first = await service.list(principal, context, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    expect(first.items[0]).toMatchObject({
      totalMinor: '300',
      isAnonymous: false,
      lifecycle: { status: 'posted', effective: true, version: '2' },
    });
    repository.list.mockResolvedValue([]);
    await expect(
      service.listForSale(principal, context, saleId, {
        cursor: first.nextCursor ?? undefined,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('maps registered multi-line history with four distinct settlement buckets and exact costs', async () => {
    const lines = [
      line('known', 'RESTOCK_SALEABLE', { inventory: true }),
      line('unknown', 'DAMAGED_NO_RESTOCK'),
      line('pending', 'DAMAGED_NO_RESTOCK'),
      line('unknown', 'DAMAGED_NO_RESTOCK', { manual: true }),
    ];
    const detail: SaleReturnDetailRow = {
      ...summary(),
      lines,
      settlements: [
        customerSettlement('receivable_reduction', 50n),
        customerSettlement('original_customer_credit_restoration', 100n),
        customerSettlement('new_customer_credit', 50n),
        refundSettlement(),
      ],
    };
    repository.findById.mockResolvedValue(detail);
    const response = await service.getById(principal, context, returnId);
    expect(response.return.customer).toMatchObject({ status: 'archived' });
    expect(response.settlementTrace).toMatchObject({
      receivableReduction: { amountMinor: '50' },
      restoredHistoricalCustomerCredit: { amountMinor: '100' },
      newCustomerCredit: { amountMinor: '50' },
      moneyRefund: {
        amountMinor: '100',
        moneyAccount: { status: 'archived' },
        moneyMovement: { amountDeltaMinor: '-100' },
      },
      reconciliation: {
        returnTotalMinor: '300',
        settlementTotalMinor: '300',
        reconciled: true,
      },
    });
    expect(response.lines.map((item) => item.historicalCost.state)).toEqual([
      'known',
      'unknown',
      'pending',
      'unknown',
    ]);
    expect(response.lines[0]).toMatchObject({
      inventoryQuantityEffectMilli: '1000',
      historicalCost: { returnedCostMinor: '40', cogsReversalMinor: '40' },
    });
    expect(response.lines.slice(1).map((item) => item.inventoryQuantityEffectMilli)).toEqual([
      '0',
      '0',
      '0',
    ]);
  });

  it('keeps an anonymous Return free of fabricated Customer and ledger effects', async () => {
    repository.findById.mockResolvedValue({
      ...summary({
        customer: null,
        settlementSummary: {
          receivableReductionMinor: 0n,
          originalCustomerCreditRestorationMinor: 0n,
          newCustomerCreditMinor: 0n,
          refundMinor: 300n,
        },
      }),
      lines: [line('unknown', 'DAMAGED_NO_RESTOCK', { manual: true, value: 300n })],
      settlements: [{ ...refundSettlement(), amountMinor: 300n }],
    });
    const response = await service.getById(principal, context, returnId);
    expect(response.return).toMatchObject({ customer: null, isAnonymous: true });
    expect(response.settlementTrace.receivableReduction).toBeNull();
    expect(response.settlementTrace.restoredHistoricalCustomerCredit).toBeNull();
    expect(response.settlementTrace.newCustomerCredit).toBeNull();
  });

  it('derives remaining quantity, cumulative historical value, and the 48-hour window losslessly', async () => {
    const eligibility: SaleReturnEligibilityRow = {
      saleId,
      saleDisplayNumber: 'SALE-42',
      saleAt: new Date('2026-09-27T09:00:00.000Z'),
      saleStatus: 'posted',
      saleReversedById: null,
      customer: summary().customer,
      acceptedAt: new Date('2026-09-27T10:00:00.000Z'),
      lines: [
        {
          saleItemId: randomUUID(),
          productId: randomUUID(),
          productUnitId: randomUUID(),
          isManualLine: false,
          productNameSnapshot: 'Historical exact product',
          unitNameSnapshot: 'piece',
          originalQuantityMilli: 3_000n,
          returnedQuantityMilli: 1_000n,
          remainingQuantityMilli: 2_000n,
          historicalNetValueMinor: 9_007_199_254_740_993n,
          returnedHistoricalValueMinor: 3_002_399_751_580_331n,
          remainingHistoricalValueMinor: 6_004_799_503_160_662n,
          wasInventoryTracked: true,
          currentRestockSaleableAllowed: false,
        },
      ],
    };
    repository.findEligibility.mockResolvedValue(eligibility);
    const response = await service.getEligibility(principal, context, saleId);
    expect(response).toMatchObject({
      returnableUntil: '2026-09-29T09:00:00.000Z',
      returnWindowOpen: true,
      currentlyReturnable: true,
      totalRemainingReturnableValueMinor: '6004799503160662',
      lines: [
        {
          originalQuantityMilli: '3000',
          returnedQuantityMilli: '1000',
          remainingQuantityMilli: '2000',
          currentRestockSaleableAllowed: false,
        },
      ],
    });
  });

  it('rejects non-owner or mismatched tenant context before repository access', async () => {
    await expect(
      service.list({ ...principal, membershipRole: 'manager' }, context, {}),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.list(principal, { ...context, storeId: randomUUID() }, {}),
    ).rejects.toMatchObject({ status: 403 });
    expect(repository.list).not.toHaveBeenCalled();
  });
});
