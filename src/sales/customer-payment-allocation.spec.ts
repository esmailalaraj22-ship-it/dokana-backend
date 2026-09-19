import {
  partitionCustomerCollection,
  partitionCustomerPayment,
} from './customer-payment-allocation';
import type { CustomerCollectionTenderCommand } from './customer-payment-posting-command';

const tender = (moneyAccountId: string, amountMinor: bigint): CustomerCollectionTenderCommand => ({
  moneyAccountId,
  amountMinor,
  senderAccountName: null,
  externalReference: null,
  notes: null,
});

describe('S15.3 mixed-tender allocation matrix', () => {
  it('walks canonical tenders and settlement targets monotonically with no zero rows', () => {
    expect(
      partitionCustomerCollection(
        [tender('a', 100n), tender('b', 200n)],
        [
          {
            targetType: 'sale_receivable',
            targetId: 'sale-a',
            originId: 'origin-a',
            amountMinor: 150n,
          },
          {
            targetType: 'opening_receivable',
            targetId: 'opening-b',
            originId: 'opening-b',
            amountMinor: 150n,
          },
        ],
      ).map(({ moneyAccountId, targetId, amountMinor }) => ({
        moneyAccountId,
        targetId,
        amountMinor,
      })),
    ).toEqual([
      { moneyAccountId: 'a', targetId: 'sale-a', amountMinor: 100n },
      { moneyAccountId: 'b', targetId: 'sale-a', amountMinor: 50n },
      { moneyAccountId: 'b', targetId: 'opening-b', amountMinor: 150n },
    ]);
  });

  it('keeps exact bigint arithmetic above Number.MAX_SAFE_INTEGER', () => {
    const amount = 9_007_199_254_740_993n;
    expect(
      partitionCustomerCollection(
        [tender('a', amount)],
        [
          {
            targetType: 'sale_receivable',
            targetId: 'sale',
            originId: 'origin',
            amountMinor: amount,
          },
        ],
      )[0]?.amountMinor,
    ).toBe(amount);
  });

  it('rejects mismatched or invalid totals instead of silently reducing a request', () => {
    expect(() =>
      partitionCustomerCollection(
        [tender('a', 100n)],
        [{ targetType: 'sale_receivable', targetId: 'sale', originId: 'origin', amountMinor: 99n }],
      ),
    ).toThrow(RangeError);
    expect(() =>
      partitionCustomerCollection(
        [tender('a', 0n)],
        [{ targetType: 'sale_receivable', targetId: 'sale', originId: 'origin', amountMinor: 1n }],
      ),
    ).toThrow(RangeError);
  });

  it('partitions deterministic mixed-tender excess into Customer Credit', () => {
    const partition = partitionCustomerPayment(
      [tender('a', 200n), tender('b', 200n)],
      [
        {
          targetType: 'sale_receivable',
          targetId: 'sale',
          originId: 'origin',
          amountMinor: 300n,
        },
      ],
    );
    expect(
      partition.allocations.map(({ moneyAccountId, amountMinor }) => ({
        moneyAccountId,
        amountMinor,
      })),
    ).toEqual([
      { moneyAccountId: 'a', amountMinor: 200n },
      { moneyAccountId: 'b', amountMinor: 100n },
    ]);
    expect(partition.tenders).toEqual([
      { moneyAccountId: 'a', allocatedMinor: 200n, creditCreatedMinor: 0n },
      { moneyAccountId: 'b', allocatedMinor: 100n, creditCreatedMinor: 100n },
    ]);
  });

  it('partitions a zero-debt advance entirely into Customer Credit', () => {
    expect(partitionCustomerPayment([tender('a', 200n)], []).tenders).toEqual([
      { moneyAccountId: 'a', allocatedMinor: 0n, creditCreatedMinor: 200n },
    ]);
  });
});
