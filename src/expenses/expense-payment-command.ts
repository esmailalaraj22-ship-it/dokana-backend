import { BadRequestException } from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { ACCOUNTING_PERIOD_MIN_YEAR } from '../accounting-periods/accounting-period-month';
import { isUuid } from '../common/logging/request-id';
import { MAX_MONEY_MINOR } from '../money-movements/money-amount';

export type ExpensePaymentSource = 'money_account' | 'owner_pocket';

export interface ExpensePaymentCommand {
  expenseId: string;
  operationId: string;
  paymentSource: ExpensePaymentSource;
  moneyAccountId: string | null;
  amountMinor: bigint;
  occurredAt: Date;
  notes: string | null;
  requestHash: string;
}

const identifier = z
  .string()
  .refine(isUuid)
  .transform((value) => value.toLowerCase());
const positiveMoneyPattern = /^[1-9][0-9]{0,18}$/;
const positiveMoney = z
  .string()
  .refine((value) => positiveMoneyPattern.test(value) && BigInt(value) <= MAX_MONEY_MINOR);
const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/)
  .refine((value) => isISO8601(value, { strict: true }) && Number.isFinite(Date.parse(value)))
  .refine((value) => new Date(value).getUTCFullYear() >= ACCOUNTING_PERIOD_MIN_YEAR - 1)
  .transform((value) => new Date(value).toISOString());
const optionalText = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine((value) => !value.includes('\0'))
  .nullable()
  .optional();

const request = z
  .object({
    operationId: identifier,
    paymentSource: z.enum(['money_account', 'owner_pocket']),
    moneyAccountId: identifier.nullable().optional(),
    amountMinor: positiveMoney,
    occurredAt: instant,
    notes: optionalText,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.paymentSource === 'money_account' && value.moneyAccountId == null) {
      context.addIssue({ code: 'custom', path: ['moneyAccountId'], message: 'required' });
    }
    if (value.paymentSource === 'owner_pocket' && value.moneyAccountId != null) {
      context.addIssue({ code: 'custom', path: ['moneyAccountId'], message: 'forbidden' });
    }
  });

export function parseExpensePaymentCommand(
  expenseIdInput: string,
  body: unknown,
): ExpensePaymentCommand {
  const expenseId = identifier.safeParse(expenseIdInput);
  const parsed = request.safeParse(body);
  if (!expenseId.success || !parsed.success) throw validationError();

  const moneyAccountId = parsed.data.moneyAccountId ?? null;
  const notes = parsed.data.notes ?? null;
  const semantic = {
    v: 1,
    action: 'expense_payments.post',
    expenseId: expenseId.data,
    paymentSource: parsed.data.paymentSource,
    moneyAccountId,
    amountMinor: parsed.data.amountMinor,
    occurredAt: parsed.data.occurredAt,
    notes,
  };

  return {
    expenseId: semantic.expenseId,
    operationId: parsed.data.operationId,
    paymentSource: semantic.paymentSource,
    moneyAccountId,
    amountMinor: BigInt(semantic.amountMinor),
    occurredAt: new Date(semantic.occurredAt),
    notes,
    requestHash: createHash('sha256').update(JSON.stringify(semantic), 'utf8').digest('hex'),
  };
}

function validationError(): BadRequestException {
  return new BadRequestException({
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed.',
  });
}
