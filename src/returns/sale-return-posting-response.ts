import { z } from 'zod';

import {
  deriveMoneyFactId,
  deriveMoneyFactOperationId,
} from '../money-movements/money-movement-identity';
import type { SaleReturnPostingResponse } from './sale-return-posting.types';

const uuid = z.uuid();
const unsigned = z.string().regex(/^(0|[1-9][0-9]*)$/);
const signed = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const instant = z.iso.datetime({ offset: true });
const moneyMovement = z
  .object({
    id: uuid,
    accountId: uuid,
    accountingPeriodId: uuid,
    movementType: z.literal('customer_refund'),
    amountDeltaMinor: signed,
    transactionGroupId: uuid,
    operationId: uuid,
    occurredAt: instant,
    createdAt: instant,
  })
  .strict();
const responseSchema = z
  .object({
    operationId: uuid,
    transactionGroupId: uuid,
    return: z
      .object({
        id: uuid,
        displayNumber: z.string().min(1),
        saleId: uuid,
        saleDisplayNumber: z.string().min(1),
        customerId: uuid.nullable(),
        totalMinor: unsigned,
        status: z.literal('posted'),
        returnAt: instant,
        createdAt: instant,
        version: unsigned,
      })
      .strict(),
    lines: z.array(
      z
        .object({
          id: uuid,
          saleItemId: uuid,
          productId: uuid.nullable(),
          productUnitId: uuid.nullable(),
          quantityMilli: unsigned,
          baseQuantityMilli: unsigned.nullable(),
          lineRefundMinor: unsigned,
          disposition: z.enum(['RESTOCK_SALEABLE', 'DAMAGED_NO_RESTOCK']),
          itemCondition: z.enum(['saleable', 'damaged']),
          costStatus: z.enum(['known', 'estimated', 'unknown', 'pending']),
          historicalCostMinor: unsigned.nullable(),
          cogsReversalMinor: unsigned.nullable(),
          inventoryMovement: z
            .object({
              id: uuid,
              operationId: uuid,
              quantityDeltaMilli: unsigned,
              valueDeltaMinor: signed.nullable(),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    ),
    settlements: z.array(
      z
        .object({
          id: uuid,
          kind: z.enum([
            'receivable_reduction',
            'original_customer_credit_restoration',
            'new_customer_credit',
            'money_refund',
          ]),
          amountMinor: unsigned,
          customerLedgerEntryId: uuid.nullable(),
          customerLedgerOperationId: uuid.nullable(),
          moneyAccountId: uuid.nullable(),
          moneyMovement: moneyMovement.nullable(),
        })
        .strict(),
    ),
    settlementSummary: z
      .object({
        receivableReductionMinor: unsigned,
        originalCustomerCreditRestorationMinor: unsigned,
        refundMinor: unsigned,
        newCustomerCreditMinor: unsigned,
        residualChoice: z.enum(['REFUND', 'KEEP_AS_CUSTOMER_CREDIT']).nullable(),
      })
      .strict(),
    posting: z
      .object({
        businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        postingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        accountingPeriodId: uuid,
      })
      .strict(),
  })
  .strict();

export function parseStoredSaleReturnPostingResponse(value: unknown): SaleReturnPostingResponse {
  const response = responseSchema.parse(value);
  if (
    response.transactionGroupId !== response.operationId ||
    response.return.id !== deriveMoneyFactId(response.operationId, 'sale-return')
  ) {
    throw new Error('Stored Sale Return response identity is invalid.');
  }
  for (const line of response.lines) {
    if (BigInt(line.quantityMilli) <= 0n) {
      throw new Error('Stored Sale Return line quantity is invalid.');
    }
    if (
      line.id !== deriveMoneyFactId(response.operationId, `sale-return-item:${line.saleItemId}`)
    ) {
      throw new Error('Stored Sale Return line identity is invalid.');
    }
    if (
      line.inventoryMovement &&
      (line.inventoryMovement.id !==
        deriveMoneyFactId(response.operationId, `sale-return-item:${line.saleItemId}:inventory`) ||
        line.inventoryMovement.operationId !==
          deriveMoneyFactOperationId(
            response.operationId,
            `sale-return-item:${line.saleItemId}:inventory`,
          ))
    ) {
      throw new Error('Stored Sale Return inventory identity is invalid.');
    }
    if (line.itemCondition === 'damaged' && line.inventoryMovement !== null) {
      throw new Error('Stored Sale Return damaged-line inventory is invalid.');
    }
  }
  if (new Set(response.lines.map((line) => line.saleItemId)).size !== response.lines.length) {
    throw new Error('Stored Sale Return line set is invalid.');
  }
  let settlementTotal = 0n;
  for (const settlement of response.settlements) {
    if (
      settlement.id !==
      deriveMoneyFactId(response.operationId, `sale-return-settlement:${settlement.kind}`)
    ) {
      throw new Error('Stored Sale Return settlement identity is invalid.');
    }
    const settlementAmount = BigInt(settlement.amountMinor);
    if (settlementAmount <= 0n) {
      throw new Error('Stored Sale Return settlement amount is invalid.');
    }
    settlementTotal += settlementAmount;
    const ledgerDiscriminator =
      settlement.kind === 'receivable_reduction'
        ? 'sale-return-receivable'
        : settlement.kind === 'original_customer_credit_restoration'
          ? 'sale-return-original-credit'
          : settlement.kind === 'new_customer_credit'
            ? 'sale-return-new-credit'
            : null;
    if (ledgerDiscriminator) {
      if (
        settlement.customerLedgerEntryId !==
          deriveMoneyFactId(response.operationId, ledgerDiscriminator) ||
        settlement.customerLedgerOperationId !==
          deriveMoneyFactOperationId(response.operationId, ledgerDiscriminator) ||
        settlement.moneyAccountId !== null ||
        settlement.moneyMovement !== null
      ) {
        throw new Error('Stored Sale Return Customer settlement lineage is invalid.');
      }
    } else if (
      settlement.customerLedgerEntryId !== null ||
      settlement.customerLedgerOperationId !== null ||
      settlement.moneyAccountId === null ||
      settlement.moneyMovement?.id !==
        deriveMoneyFactId(response.operationId, 'sale-return-refund-money') ||
      settlement.moneyMovement.operationId !==
        deriveMoneyFactOperationId(response.operationId, 'sale-return-refund-money') ||
      settlement.moneyMovement.accountId !== settlement.moneyAccountId ||
      settlement.moneyMovement.transactionGroupId !== response.operationId ||
      BigInt(settlement.moneyMovement.amountDeltaMinor) !== -BigInt(settlement.amountMinor)
    ) {
      throw new Error('Stored Sale Return refund lineage is invalid.');
    }
  }
  if (
    new Set(response.settlements.map((settlement) => settlement.kind)).size !==
    response.settlements.length
  ) {
    throw new Error('Stored Sale Return settlement set is invalid.');
  }
  const lineTotal = response.lines.reduce(
    (total, line) => total + BigInt(line.lineRefundMinor),
    0n,
  );
  const summaryTotal =
    BigInt(response.settlementSummary.receivableReductionMinor) +
    BigInt(response.settlementSummary.originalCustomerCreditRestorationMinor) +
    BigInt(response.settlementSummary.refundMinor) +
    BigInt(response.settlementSummary.newCustomerCreditMinor);
  const returnTotal = BigInt(response.return.totalMinor);
  if (
    lineTotal !== returnTotal ||
    settlementTotal !== returnTotal ||
    summaryTotal !== returnTotal
  ) {
    throw new Error('Stored Sale Return totals are invalid.');
  }
  return response;
}
