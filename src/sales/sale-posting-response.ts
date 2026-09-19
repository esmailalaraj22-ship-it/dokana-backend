import { z } from 'zod';

import { isUuid } from '../common/logging/request-id';
import type { CustomerOpeningReceivableResponse, SalePostingResponse } from './sale-posting.types';

const identifier = z.string().refine(isUuid);
const integer = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const receivable = z
  .object({
    id: identifier,
    customerId: identifier,
    entryType: z.enum(['sale_credit', 'opening_balance']),
    receivableDeltaMinor: integer,
    creditDeltaMinor: integer,
    sourceSaleId: identifier.nullable(),
    transactionGroupId: identifier,
    occurredAt: z.string(),
    operationId: identifier,
    createdAt: z.string(),
  })
  .strict();
const customerCreditTender = z
  .object({
    id: identifier,
    customerId: identifier,
    amountMinor: integer,
    customerLedgerEntryId: identifier,
    appliedAt: z.string(),
    createdAt: z.string(),
  })
  .strict();
const common = {
  operationId: identifier,
  businessDate: z.string(),
  postingDate: z.string(),
  accountingPeriodId: identifier,
};

const saleResponse = z
  .object({
    ...common,
    sale: z
      .object({
        id: identifier,
        customerId: identifier.nullable(),
        displayNumber: z.string(),
        occurredAt: z.string(),
        status: z.literal('posted'),
        paymentStatus: z.enum(['paid', 'partial', 'credit']),
        itemsSubtotalMinor: integer,
        lineDiscountTotalMinor: integer,
        invoiceDiscountMinor: integer,
        roundingMinor: integer,
        totalMinor: integer,
        paidTotalMinor: integer,
        creditTotalMinor: integer,
        knownCostTotalMinor: integer,
        pendingCostLineCount: z.number().int().nonnegative(),
        unknownCostLineCount: z.number().int().nonnegative(),
        notes: z.string().nullable(),
        version: integer,
      })
      .strict(),
    items: z.array(
      z
        .object({
          id: identifier,
          productId: identifier.nullable(),
          productUnitId: identifier.nullable(),
          isManualLine: z.boolean(),
          productName: z.string(),
          unitName: z.string().nullable(),
          quantityMilli: integer,
          conversionFactorNumerator: z.number().int().positive(),
          conversionFactorDenominator: z.number().int().positive(),
          baseQuantityMilli: integer.nullable(),
          unitPriceMinor: integer,
          lineGrossMinor: integer,
          lineDiscountMinor: integer,
          roundingMinor: integer,
          lineTotalMinor: integer,
          costStatus: z.enum(['known', 'pending', 'unknown']),
          unitCostMinor: integer.nullable(),
          lineCostMinor: integer.nullable(),
          inventoryMovementId: identifier.nullable(),
        })
        .strict(),
    ),
    payments: z.array(
      z
        .object({
          id: identifier,
          moneyAccountId: identifier,
          amountMinor: integer,
          senderAccountName: z.string().nullable(),
          externalReference: z.string().nullable(),
          moneyMovementId: identifier,
        })
        .strict(),
    ),
    customerCreditTender: customerCreditTender.nullable().optional().default(null),
    receivable: receivable.nullable(),
  })
  .strict();

const openingResponse = z
  .object({
    ...common,
    customerId: identifier,
    receivable,
  })
  .strict();

export function parseStoredSalePostingResponse(value: unknown): SalePostingResponse {
  return saleResponse.parse(value);
}

export function parseStoredCustomerOpeningReceivableResponse(
  value: unknown,
): CustomerOpeningReceivableResponse {
  return openingResponse.parse(value);
}
