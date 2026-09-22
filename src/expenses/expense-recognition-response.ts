import { z } from 'zod';

import { isUuid } from '../common/logging/request-id';
import type { ExpenseRecognitionResponse } from './expense-recognition.types';

const id = z.string().refine(isUuid);
const integer = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const timestamp = z.string();
const movement = z
  .object({
    id,
    accountId: id,
    accountingPeriodId: id,
    movementType: z.literal('expense_payment'),
    amountDeltaMinor: integer,
    transactionGroupId: id,
    operationId: id,
    occurredAt: timestamp,
    createdAt: timestamp,
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
    occurredAt: timestamp,
    createdAt: timestamp,
  })
  .strict();
const payment = z
  .object({
    id,
    amountMinor: integer,
    paymentSource: z.enum(['money_account', 'owner_pocket']),
    moneyAccountId: id.nullable(),
    moneyMovementId: id.nullable(),
    ownerLedgerEntryId: id.nullable(),
    paymentAt: timestamp,
    status: z.literal('posted'),
    operationId: id,
    version: integer,
  })
  .strict();

const response = z
  .object({
    operationId: id,
    mode: z.enum(['DUE', 'MONEY_PAID', 'OWNER_FUNDED']),
    businessDate: z.string(),
    postingDate: z.string(),
    accountingPeriodId: id,
    expense: z
      .object({
        id,
        categoryId: id.nullable(),
        description: z.string(),
        amountMinor: integer,
        paidTotalMinor: integer,
        outstandingMinor: integer,
        expenseAt: timestamp,
        dueAt: timestamp.nullable(),
        paymentTiming: z.enum(['paid_now', 'due_later']),
        status: z.literal('posted'),
        notes: z.string().nullable(),
        version: integer,
      })
      .strict(),
    payment: payment.nullable(),
    moneyMovement: movement.nullable(),
    ownerLedgerEntry: ownerEntry.nullable(),
  })
  .strict();

export function parseStoredExpenseRecognitionResponse(value: unknown): ExpenseRecognitionResponse {
  return response.parse(value);
}
