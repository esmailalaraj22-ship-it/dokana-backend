import { z } from 'zod';

import { isUuid } from '../common/logging/request-id';
import type { CustomerCollectionPostingResponse } from './customer-payment-posting.types';

const identifier = z.string().refine(isUuid);
const integer = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const payment = z
  .object({
    id: identifier,
    operationId: identifier,
    moneyAccountId: identifier,
    amountMinor: integer,
    allocatedTotalMinor: integer,
    creditCreatedMinor: z.literal('0'),
    paymentAt: z.string(),
    senderAccountName: z.string().nullable(),
    externalReference: z.string().nullable(),
    notes: z.string().nullable(),
    status: z.literal('posted'),
    moneyMovementId: identifier,
    version: integer,
  })
  .strict();
const allocation = z
  .object({
    id: identifier,
    customerPaymentId: identifier,
    targetType: z.enum(['sale_receivable', 'opening_receivable']),
    targetId: identifier,
    amountMinor: integer,
    customerLedgerEntryId: identifier,
    paymentEffectOperationId: identifier,
    createdAt: z.string(),
  })
  .strict();
const movement = z
  .object({
    id: identifier,
    accountId: identifier,
    accountingPeriodId: identifier,
    movementType: z.literal('customer_payment'),
    amountDeltaMinor: integer,
    transactionGroupId: identifier,
    operationId: identifier,
    occurredAt: z.string(),
    createdAt: z.string(),
  })
  .strict();
const response = z
  .object({
    operationId: identifier,
    collectionId: identifier,
    customerId: identifier,
    allocationMode: z.enum(['fifo', 'custom']),
    amountMinor: integer,
    businessDate: z.string(),
    postingDate: z.string(),
    accountingPeriodId: identifier,
    payments: z.array(payment),
    allocations: z.array(allocation),
    moneyMovements: z.array(movement),
  })
  .strict();

export function parseStoredCustomerCollectionPostingResponse(
  value: unknown,
): CustomerCollectionPostingResponse {
  return response.parse(value);
}
