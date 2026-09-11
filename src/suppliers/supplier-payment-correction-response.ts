import { z } from 'zod';

import { isUuid } from '../common/logging/request-id';
import { parseStoredSupplierPaymentPostingResponse } from './supplier-payment-posting-response';
import type { SupplierPaymentCorrectionResponse } from './supplier-payment-correction.types';

const identifier = z.string().refine(isUuid);
const integer = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const instant = z.string();
const payable = z
  .object({
    id: identifier,
    entryType: z.literal('correction'),
    payableDeltaMinor: integer,
    transactionGroupId: identifier,
    operationId: identifier,
    occurredAt: instant,
    createdAt: instant,
    reversalOfId: identifier,
  })
  .strict();
const moneyMovement = z
  .object({
    id: identifier,
    accountId: identifier,
    accountingPeriodId: identifier,
    movementType: z.literal('correction'),
    amountDeltaMinor: integer,
    transactionGroupId: identifier,
    operationId: identifier,
    occurredAt: instant,
    createdAt: instant,
    reversalOfId: identifier,
  })
  .strict();
const ownerLedgerEntry = z
  .object({
    id: identifier,
    entryType: z.literal('correction'),
    ownerLiabilityDeltaMinor: integer,
    equityDeltaMinor: integer,
    moneyAccountId: z.null(),
    transactionGroupId: identifier,
    operationId: identifier,
    occurredAt: instant,
    createdAt: instant,
    reversalOfId: identifier,
  })
  .strict();
const responseSchema = z
  .object({
    operationId: identifier,
    targetOperationId: identifier,
    intent: z.enum(['cancel', 'edit']),
    occurredAt: instant,
    businessDate: z.string(),
    postingDate: z.string(),
    accountingPeriodId: identifier,
    target: z
      .object({
        paymentId: identifier,
        supplierId: identifier,
        status: z.literal('cancelled'),
        cancelledAt: instant,
        version: integer,
      })
      .strict(),
    reversal: z
      .object({
        payable,
        moneyMovement: moneyMovement.nullable(),
        ownerLedgerEntry: ownerLedgerEntry.nullable(),
      })
      .strict(),
    replacement: z.unknown().nullable(),
  })
  .strict();

export function parseStoredSupplierPaymentCorrectionResponse(
  value: unknown,
): SupplierPaymentCorrectionResponse {
  const parsed = responseSchema.parse(value);
  return {
    ...parsed,
    replacement:
      parsed.replacement === null
        ? null
        : parseStoredSupplierPaymentPostingResponse(parsed.replacement),
  };
}
