import { z } from 'zod';

import { isUuid } from '../common/logging/request-id';
import type {
  SupplierInvoicePostingResponse,
  SupplierOpeningPayableResponse,
} from './supplier-invoice-posting.types';

const identifier = z.string().refine(isUuid);
const integer = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const payable = z
  .object({
    id: identifier,
    entryType: z.enum(['supplier_invoice', 'opening_balance']),
    payableDeltaMinor: integer,
    creditDeltaMinor: integer,
    sourcePurchaseInvoiceId: identifier.nullable(),
    transactionGroupId: identifier,
    occurredAt: z.string(),
    operationId: identifier,
    createdAt: z.string(),
  })
  .strict();
const common = {
  operationId: identifier,
  supplierId: identifier,
  businessDate: z.string(),
  postingDate: z.string(),
  accountingPeriodId: identifier,
};
const item = z
  .object({
    id: identifier,
    productId: identifier.nullable(),
    productUnitId: identifier.nullable(),
    description: z.string(),
    unitName: z.string(),
    quantityMilli: integer,
    conversionFactorNumerator: z.number().int().positive(),
    conversionFactorDenominator: z.number().int().positive(),
    baseQuantityMilli: integer,
    unitCostMinor: integer,
    lineGrossMinor: integer,
    lineDiscountMinor: integer,
    roundingMinor: integer,
    lineTotalMinor: integer,
  })
  .strict();

const invoiceResponseSchema = z
  .object({
    ...common,
    invoice: z
      .object({
        id: identifier,
        invoiceNumber: z.string().nullable(),
        displayNumber: z.string(),
        occurredAt: z.string(),
        dueAt: z.string().nullable(),
        status: z.literal('open'),
        itemsSubtotalMinor: integer,
        lineDiscountTotalMinor: integer,
        invoiceDiscountMinor: integer,
        roundingMinor: integer,
        totalMinor: integer,
        notes: z.string().nullable(),
        version: integer,
      })
      .strict(),
    items: z.array(item),
    payable,
  })
  .strict();

const openingResponseSchema = z.object({ ...common, payable }).strict();

export function parseStoredSupplierInvoicePostingResponse(
  value: unknown,
): SupplierInvoicePostingResponse {
  return invoiceResponseSchema.parse(value);
}

export function parseStoredSupplierOpeningPayableResponse(
  value: unknown,
): SupplierOpeningPayableResponse {
  return openingResponseSchema.parse(value);
}
