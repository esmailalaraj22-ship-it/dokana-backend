import { z } from 'zod';

import { isUuid } from '../common/logging/request-id';
import type { CustomerFinancialResponse } from './customer-credit.types';

const identifier = z.string().refine(isUuid);
const integer = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const movement = z
  .object({
    id: identifier,
    accountId: identifier,
    accountingPeriodId: identifier,
    movementType: z.literal('customer_refund'),
    amountDeltaMinor: integer,
    transactionGroupId: identifier,
    operationId: identifier,
    occurredAt: z.string(),
    createdAt: z.string(),
  })
  .strict();
const effect = z
  .object({
    id: identifier,
    operationId: identifier,
    entryType: z.enum(['credit_used', 'refund', 'settlement']),
    receivableDeltaMinor: integer,
    creditDeltaMinor: integer,
    targetType: z.enum(['sale_receivable', 'opening_receivable']).nullable(),
    targetId: identifier.nullable(),
    reason: z.string().nullable(),
    occurredAt: z.string(),
    createdAt: z.string(),
  })
  .strict();
const response = z
  .object({
    operationId: identifier,
    action: z.enum(['apply_customer_credit', 'refund_customer_credit', 'settle_receivable']),
    customerId: identifier,
    amountMinor: integer,
    businessDate: z.string(),
    postingDate: z.string(),
    accountingPeriodId: identifier,
    transactionGroupId: identifier,
    ledgerEffects: z.array(effect),
    moneyMovement: movement.nullable(),
  })
  .strict();

export function parseStoredCustomerFinancialResponse(value: unknown): CustomerFinancialResponse {
  return response.parse(value);
}
