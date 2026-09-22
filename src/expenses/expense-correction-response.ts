import { z } from 'zod';

import { isUuid } from '../common/logging/request-id';
import { parseStoredExpensePaymentResponse } from './expense-payment-response';
import { parseStoredExpenseRecognitionResponse } from './expense-recognition-response';
import type {
  ExpenseCorrectionResponse,
  ExpensePaymentCorrectionResponse,
  ExpenseRecognitionCorrectionResponse,
} from './expense-correction.types';

const id = z.string().refine(isUuid);
const integer = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const instant = z.string();
const moneyReversal = z
  .object({
    id,
    accountId: id,
    accountingPeriodId: id,
    movementType: z.literal('correction'),
    amountDeltaMinor: integer,
    transactionGroupId: id,
    operationId: id,
    occurredAt: instant,
    createdAt: instant,
    reversalOfId: id,
  })
  .strict();
const ownerReversal = z
  .object({
    id,
    entryType: z.literal('correction'),
    ownerLiabilityDeltaMinor: integer,
    equityDeltaMinor: integer,
    moneyAccountId: id.nullable(),
    transactionGroupId: id,
    operationId: id,
    occurredAt: instant,
    createdAt: instant,
    reversalOfId: id,
  })
  .strict();
const common = {
  operationId: id,
  targetOperationId: id,
  intent: z.enum(['cancel', 'edit']),
  reason: z.string().min(1),
  occurredAt: instant,
  businessDate: z.string(),
  postingDate: z.string(),
  accountingPeriodId: id,
};
const recognition = z
  .object({
    ...common,
    aggregate: z.literal('expense'),
    target: z
      .object({
        expenseId: id,
        status: z.literal('cancelled'),
        cancelledAt: instant,
        version: integer,
      })
      .strict(),
    reversal: z
      .object({
        originalAmountMinor: integer,
        amountDeltaMinor: integer,
        internalPaymentId: id.nullable(),
        moneyMovement: moneyReversal.nullable(),
        ownerLedgerEntry: ownerReversal.nullable(),
      })
      .strict(),
    replacement: z.unknown().nullable(),
  })
  .strict();
const payment = z
  .object({
    ...common,
    aggregate: z.literal('expense_payment'),
    target: z
      .object({
        expenseId: id,
        paymentId: id,
        status: z.literal('cancelled'),
        cancelledAt: instant,
        version: integer,
      })
      .strict(),
    reversal: z
      .object({
        expenseRecognitionDeltaMinor: z.literal('0'),
        moneyMovement: moneyReversal.nullable(),
        ownerLedgerEntry: ownerReversal.nullable(),
      })
      .strict(),
    replacement: z.unknown().nullable(),
  })
  .strict();

export function parseStoredExpenseCorrectionResponse(value: unknown): ExpenseCorrectionResponse {
  const aggregate = z.looseObject({ aggregate: z.string() }).parse(value).aggregate;
  if (aggregate === 'expense') return parseRecognition(value);
  if (aggregate === 'expense_payment') return parsePayment(value);
  throw new Error('Stored Expense correction response has an unsupported aggregate.');
}

function parseRecognition(value: unknown): ExpenseRecognitionCorrectionResponse {
  const parsed = recognition.parse(value);
  return {
    ...parsed,
    replacement:
      parsed.replacement === null
        ? null
        : parseStoredExpenseRecognitionResponse(parsed.replacement),
  };
}

function parsePayment(value: unknown): ExpensePaymentCorrectionResponse {
  const parsed = payment.parse(value);
  return {
    ...parsed,
    replacement:
      parsed.replacement === null ? null : parseStoredExpensePaymentResponse(parsed.replacement),
  };
}
