import { BadRequestException } from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { ACCOUNTING_PERIOD_MIN_YEAR } from '../accounting-periods/accounting-period-month';
import { isUuid } from '../common/logging/request-id';
import { MAX_MONEY_MINOR } from '../money-movements/money-amount';

export type ExpenseRecognitionMode = 'DUE' | 'MONEY_PAID' | 'OWNER_FUNDED';

export interface ExpenseRecognitionCommand {
  expenseId: string;
  operationId: string;
  categoryId: string | null;
  description: string;
  amountMinor: bigint;
  occurredAt: Date;
  dueAt: Date | null;
  mode: ExpenseRecognitionMode;
  moneyAccountId: string | null;
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
const requiredText = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !value.includes('\0'));

const request = z
  .object({
    id: identifier,
    operationId: identifier,
    categoryId: identifier.nullable().optional(),
    description: requiredText(500),
    amountMinor: positiveMoney,
    occurredAt: instant,
    dueAt: instant.nullable().optional(),
    mode: z.enum(['DUE', 'MONEY_PAID', 'OWNER_FUNDED']),
    moneyAccountId: identifier.nullable().optional(),
    notes: requiredText(1000).nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === 'MONEY_PAID' && value.moneyAccountId == null) {
      context.addIssue({ code: 'custom', path: ['moneyAccountId'], message: 'required' });
    }
    if (value.mode !== 'MONEY_PAID' && value.moneyAccountId != null) {
      context.addIssue({ code: 'custom', path: ['moneyAccountId'], message: 'forbidden' });
    }
    if (value.mode !== 'DUE' && value.dueAt != null) {
      context.addIssue({ code: 'custom', path: ['dueAt'], message: 'forbidden' });
    }
  });

export function parseExpenseRecognitionCommand(body: unknown): ExpenseRecognitionCommand {
  const parsed = request.safeParse(body);
  if (!parsed.success) throw validationError();

  const semantic = {
    v: 1,
    action: 'expenses.recognize',
    expenseId: parsed.data.id,
    categoryId: parsed.data.categoryId ?? null,
    description: parsed.data.description,
    amountMinor: parsed.data.amountMinor,
    occurredAt: parsed.data.occurredAt,
    dueAt: parsed.data.dueAt ?? null,
    mode: parsed.data.mode,
    moneyAccountId: parsed.data.moneyAccountId ?? null,
    notes: parsed.data.notes ?? null,
  };

  return {
    expenseId: semantic.expenseId,
    operationId: parsed.data.operationId,
    categoryId: semantic.categoryId,
    description: semantic.description,
    amountMinor: BigInt(semantic.amountMinor),
    occurredAt: new Date(semantic.occurredAt),
    dueAt: semantic.dueAt === null ? null : new Date(semantic.dueAt),
    mode: semantic.mode,
    moneyAccountId: semantic.moneyAccountId,
    notes: semantic.notes,
    requestHash: createHash('sha256').update(JSON.stringify(semantic), 'utf8').digest('hex'),
  };
}

function validationError(): BadRequestException {
  return new BadRequestException({
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed.',
  });
}
