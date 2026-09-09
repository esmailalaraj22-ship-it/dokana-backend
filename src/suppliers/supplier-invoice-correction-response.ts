import { z } from 'zod';

import { isUuid } from '../common/logging/request-id';
import {
  parseStoredSupplierInvoicePostingResponse,
  parseStoredSupplierOpeningPayableResponse,
} from './supplier-invoice-posting-response';
import type {
  SupplierFinancialCorrectionResponse,
  SupplierInvoiceCorrectionResponse,
  SupplierOpeningPayableCorrectionResponse,
} from './supplier-invoice-correction.types';

const identifier = z.string().refine(isUuid);
const integer = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const correctionEntry = z
  .object({
    id: identifier,
    entryType: z.literal('correction'),
    payableDeltaMinor: integer,
    creditDeltaMinor: integer,
    sourcePurchaseInvoiceId: identifier.nullable(),
    transactionGroupId: identifier,
    occurredAt: z.string(),
    reversalOfId: identifier,
    operationId: identifier,
    createdAt: z.string(),
  })
  .strict();
const common = {
  operationId: identifier,
  targetOperationId: identifier,
  occurredAt: z.string(),
  businessDate: z.string(),
  postingDate: z.string(),
  accountingPeriodId: identifier,
  reversal: correctionEntry,
};
const invoiceSchema = z
  .object({
    ...common,
    family: z.literal('invoice'),
    intent: z.enum(['cancel', 'edit']),
    target: z
      .object({
        invoiceId: identifier,
        supplierId: identifier,
        status: z.literal('cancelled'),
        cancelledAt: z.string(),
        version: integer,
      })
      .strict(),
    replacement: z.unknown().nullable(),
  })
  .strict();
const openingSchema = z
  .object({
    ...common,
    family: z.literal('opening_payable'),
    intent: z.enum(['cancel', 'edit']),
    target: z
      .object({ payableId: identifier, supplierId: identifier, amountMinor: integer })
      .strict(),
    replacement: z.unknown().nullable(),
  })
  .strict();

export function parseStoredSupplierFinancialCorrectionResponse(
  value: unknown,
): SupplierFinancialCorrectionResponse {
  if (isInvoiceResponse(value)) {
    const parsed = invoiceSchema.parse(value);
    return {
      ...parsed,
      replacement:
        parsed.replacement === null
          ? null
          : parseStoredSupplierInvoicePostingResponse(parsed.replacement),
    } satisfies SupplierInvoiceCorrectionResponse;
  }
  const parsed = openingSchema.parse(value);
  return {
    ...parsed,
    replacement:
      parsed.replacement === null
        ? null
        : parseStoredSupplierOpeningPayableResponse(parsed.replacement),
  } satisfies SupplierOpeningPayableCorrectionResponse;
}

function isInvoiceResponse(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'family' in value &&
    value.family === 'invoice'
  );
}
