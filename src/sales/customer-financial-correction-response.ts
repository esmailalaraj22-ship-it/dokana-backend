import { z } from 'zod';

import { isUuid } from '../common/logging/request-id';
import { parseStoredCustomerFinancialResponse } from './customer-credit-response';
import { parseStoredCustomerCollectionPostingResponse } from './customer-payment-posting-response';
import type { CustomerFinancialCorrectionResponse } from './customer-financial-correction.types';

const identifier = z.string().refine(isUuid);
const integer = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const cancelledPayment = z
  .object({
    id: identifier,
    status: z.literal('cancelled'),
    cancelledAt: z.string(),
    version: integer,
  })
  .strict();
const ledgerReversal = z
  .object({
    id: identifier,
    operationId: identifier,
    entryType: z.literal('correction'),
    receivableDeltaMinor: integer,
    creditDeltaMinor: integer,
    targetType: z.enum(['sale_receivable', 'opening_receivable']).nullable(),
    targetId: identifier.nullable(),
    reversalOfId: identifier,
    reason: z.string(),
    occurredAt: z.string(),
    createdAt: z.string(),
  })
  .strict();
const moneyReversal = z
  .object({
    id: identifier,
    accountId: identifier,
    accountingPeriodId: identifier,
    movementType: z.literal('correction'),
    amountDeltaMinor: integer,
    transactionGroupId: identifier,
    operationId: identifier,
    occurredAt: z.string(),
    createdAt: z.string(),
    reversalOfId: identifier,
  })
  .strict();
const response = z
  .object({
    operationId: identifier,
    targetOperationId: identifier,
    customerId: identifier,
    family: z.enum([
      'customer_collection',
      'customer_credit_application',
      'customer_credit_refund',
      'customer_receivable_settlement',
    ]),
    intent: z.enum(['cancel', 'edit']),
    reason: z.string(),
    occurredAt: z.string(),
    businessDate: z.string(),
    postingDate: z.string(),
    accountingPeriodId: identifier,
    transactionGroupId: identifier,
    activeOperationId: identifier.nullable(),
    target: z
      .object({
        operationId: identifier,
        transactionGroupId: identifier,
        payments: z.array(cancelledPayment),
      })
      .strict(),
    reversal: z
      .object({ ledgerEffects: z.array(ledgerReversal), moneyMovements: z.array(moneyReversal) })
      .strict(),
    replacement: z.unknown().nullable(),
  })
  .strict();

export function parseStoredCustomerFinancialCorrectionResponse(
  value: unknown,
): CustomerFinancialCorrectionResponse {
  const parsed = response.parse(value);
  const replacement =
    parsed.replacement === null
      ? null
      : parsed.family === 'customer_collection'
        ? parseStoredCustomerCollectionPostingResponse(parsed.replacement)
        : parseStoredCustomerFinancialResponse(parsed.replacement);
  return { ...parsed, replacement };
}
