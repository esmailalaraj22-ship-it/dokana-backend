import { BadRequestException } from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { ACCOUNTING_PERIOD_MIN_YEAR } from '../accounting-periods/accounting-period-month';
import { isUuid } from '../common/logging/request-id';
import { parseExpensePaymentCommand, type ExpensePaymentCommand } from './expense-payment-command';
import {
  parseExpenseRecognitionCommand,
  type ExpenseRecognitionCommand,
} from './expense-recognition-command';

export const EXPENSE_CORRECTION_REQUEST_VERSION = 1;

const identifier = z
  .string()
  .refine(isUuid)
  .transform((value) => value.toLowerCase());
const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/)
  .refine((value) => isISO8601(value, { strict: true }) && Number.isFinite(Date.parse(value)))
  .refine((value) => new Date(value).getUTCFullYear() >= ACCOUNTING_PERIOD_MIN_YEAR - 1)
  .transform((value) => new Date(value).toISOString());
const reason = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine((value) => !value.includes('\0'));
const record = z.custom<Record<string, unknown>>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
);
const cancelRequest = z.object({ operationId: identifier, occurredAt: instant, reason }).strict();
const editRequest = cancelRequest.extend({ replacement: record }).strict();

interface CorrectionBase {
  operationId: string;
  targetOperationId: string;
  occurredAt: Date;
  reason: string;
  requestHash: string;
}

export interface ExpenseCancelCommand extends CorrectionBase {
  aggregate: 'expense';
  kind: 'cancel';
}

export interface ExpenseEditCommand extends CorrectionBase {
  aggregate: 'expense';
  kind: 'edit';
  replacement: ExpenseRecognitionCommand;
}

export interface ExpensePaymentCancelCommand extends CorrectionBase {
  aggregate: 'expense_payment';
  kind: 'cancel';
}

export interface ExpensePaymentEditCommand extends CorrectionBase {
  aggregate: 'expense_payment';
  kind: 'edit';
  replacement: ExpensePaymentCommand;
}

export type ExpenseRecognitionCorrectionCommand = ExpenseCancelCommand | ExpenseEditCommand;
export type ExpensePaymentCorrectionCommand =
  ExpensePaymentCancelCommand | ExpensePaymentEditCommand;
export type ExpenseCorrectionCommand =
  ExpenseRecognitionCorrectionCommand | ExpensePaymentCorrectionCommand;

export function parseExpenseCancelCommand(
  targetOperationIdInput: string,
  body: unknown,
): ExpenseCancelCommand {
  const targetOperationId = parseIdentifier(targetOperationIdInput);
  const parsed = cancelRequest.safeParse(body);
  if (!parsed.success) throw validationError();
  const semantic = {
    v: EXPENSE_CORRECTION_REQUEST_VERSION,
    action: 'expenses.cancel',
    targetOperationId,
    occurredAt: parsed.data.occurredAt,
    reason: parsed.data.reason,
  };
  return {
    aggregate: 'expense',
    kind: 'cancel',
    operationId: parsed.data.operationId,
    targetOperationId,
    occurredAt: new Date(parsed.data.occurredAt),
    reason: parsed.data.reason,
    requestHash: hash(semantic),
  };
}

export function parseExpenseEditCommand(
  targetOperationIdInput: string,
  body: unknown,
): ExpenseEditCommand {
  const targetOperationId = parseIdentifier(targetOperationIdInput);
  const parsed = editRequest.safeParse(body);
  if (!parsed.success || Object.hasOwn(parsed.data.replacement, 'operationId')) {
    throw validationError();
  }
  const replacement = parseExpenseRecognitionCommand({
    ...parsed.data.replacement,
    operationId: parsed.data.operationId,
  });
  return {
    aggregate: 'expense',
    kind: 'edit',
    operationId: parsed.data.operationId,
    targetOperationId,
    occurredAt: new Date(parsed.data.occurredAt),
    reason: parsed.data.reason,
    replacement,
    requestHash: hash({
      v: EXPENSE_CORRECTION_REQUEST_VERSION,
      action: 'expenses.edit',
      targetOperationId,
      occurredAt: parsed.data.occurredAt,
      reason: parsed.data.reason,
      replacementRequestHash: replacement.requestHash,
    }),
  };
}

export function parseExpensePaymentCancelCommand(
  targetOperationIdInput: string,
  body: unknown,
): ExpensePaymentCancelCommand {
  const targetOperationId = parseIdentifier(targetOperationIdInput);
  const parsed = cancelRequest.safeParse(body);
  if (!parsed.success) throw validationError();
  return {
    aggregate: 'expense_payment',
    kind: 'cancel',
    operationId: parsed.data.operationId,
    targetOperationId,
    occurredAt: new Date(parsed.data.occurredAt),
    reason: parsed.data.reason,
    requestHash: hash({
      v: EXPENSE_CORRECTION_REQUEST_VERSION,
      action: 'expense_payments.cancel',
      targetOperationId,
      occurredAt: parsed.data.occurredAt,
      reason: parsed.data.reason,
    }),
  };
}

export function parseExpensePaymentEditCommand(
  targetOperationIdInput: string,
  body: unknown,
): ExpensePaymentEditCommand {
  const targetOperationId = parseIdentifier(targetOperationIdInput);
  const parsed = editRequest.safeParse(body);
  if (!parsed.success || Object.hasOwn(parsed.data.replacement, 'operationId')) {
    throw validationError();
  }
  const expenseId = parseIdentifierValue(parsed.data.replacement.expenseId);
  const replacementBody = Object.fromEntries(
    Object.entries(parsed.data.replacement).filter(([key]) => key !== 'expenseId'),
  );
  const replacement = parseExpensePaymentCommand(expenseId, {
    ...replacementBody,
    operationId: parsed.data.operationId,
  });
  return {
    aggregate: 'expense_payment',
    kind: 'edit',
    operationId: parsed.data.operationId,
    targetOperationId,
    occurredAt: new Date(parsed.data.occurredAt),
    reason: parsed.data.reason,
    replacement,
    requestHash: hash({
      v: EXPENSE_CORRECTION_REQUEST_VERSION,
      action: 'expense_payments.edit',
      targetOperationId,
      occurredAt: parsed.data.occurredAt,
      reason: parsed.data.reason,
      replacementRequestHash: replacement.requestHash,
    }),
  };
}

function parseIdentifier(value: string): string {
  return parseIdentifierValue(value);
}

function parseIdentifierValue(value: unknown): string {
  const parsed = identifier.safeParse(value);
  if (!parsed.success) throw validationError();
  return parsed.data;
}

function hash(value: object): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function validationError(): BadRequestException {
  return new BadRequestException({
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed.',
  });
}
