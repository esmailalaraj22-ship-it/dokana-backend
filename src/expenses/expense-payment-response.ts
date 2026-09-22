import { z } from 'zod';

import { isUuid } from '../common/logging/request-id';
import type { ExpensePaymentPostingResponse } from './expense-payment.types';

const id = z.string().refine(isUuid);
const integer = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const instant = z.string();
const movement = z
  .object({
    id,
    accountId: id,
    accountingPeriodId: id,
    movementType: z.literal('expense_payment'),
    amountDeltaMinor: integer,
    transactionGroupId: id,
    operationId: id,
    occurredAt: instant,
    createdAt: instant,
  })
  .strict();
const ownerEntry = z
  .object({
    id,
    entryType: z.literal('owner_paid_expense'),
    ownerLiabilityDeltaMinor: integer,
    equityDeltaMinor: integer,
    moneyAccountId: z.null(),
    transactionGroupId: id,
    operationId: id,
    occurredAt: instant,
    createdAt: instant,
  })
  .strict();

const response = z
  .object({
    operationId: id,
    expenseId: id,
    businessDate: z.string(),
    postingDate: z.string(),
    accountingPeriodId: id,
    payment: z
      .object({
        id,
        amountMinor: integer,
        paymentSource: z.enum(['money_account', 'owner_pocket']),
        moneyAccountId: id.nullable(),
        moneyMovementId: id.nullable(),
        ownerLedgerEntryId: id.nullable(),
        transactionGroupId: id,
        paymentAt: instant,
        notes: z.string().nullable(),
        status: z.literal('posted'),
        operationId: id,
        version: integer,
      })
      .strict(),
    settlement: z
      .object({
        recognizedAmountMinor: integer,
        settledBeforeMinor: integer,
        settledAfterMinor: integer,
        outstandingBeforeMinor: integer,
        outstandingAfterMinor: integer,
      })
      .strict(),
    moneyMovement: movement.nullable(),
    ownerLedgerEntry: ownerEntry.nullable(),
  })
  .strict();

export function parseStoredExpensePaymentResponse(value: unknown): ExpensePaymentPostingResponse {
  return response.parse(value);
}
