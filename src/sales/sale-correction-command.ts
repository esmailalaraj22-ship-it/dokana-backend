import { BadRequestException } from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { ACCOUNTING_PERIOD_MIN_YEAR } from '../accounting-periods/accounting-period-month';
import { isUuid } from '../common/logging/request-id';
import { parseSalePostingCommand, type SalePostingCommand } from './sale-posting-command';

export const SALE_CORRECTION_REQUEST_VERSION = 1;

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
const record = z.custom<Record<string, unknown>>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
);
const cancelRequest = z.object({ operationId: identifier, occurredAt: instant }).strict();
const editRequest = z
  .object({ operationId: identifier, occurredAt: instant, replacement: record })
  .strict();

interface SaleCorrectionBase {
  operationId: string;
  targetOperationId: string;
  occurredAt: Date;
  requestHash: string;
}

export interface SaleCancelCommand extends SaleCorrectionBase {
  kind: 'cancel';
}

export interface SaleEditCommand extends SaleCorrectionBase {
  kind: 'edit';
  replacement: SalePostingCommand;
}

export type SaleCorrectionCommand = SaleCancelCommand | SaleEditCommand;

export function parseSaleCancelCommand(
  targetOperationIdInput: string,
  body: unknown,
): SaleCancelCommand {
  const targetOperationId = parseIdentifier(targetOperationIdInput);
  const parsed = cancelRequest.safeParse(body);
  if (!parsed.success) throw validationError();
  return {
    kind: 'cancel',
    operationId: parsed.data.operationId,
    targetOperationId,
    occurredAt: new Date(parsed.data.occurredAt),
    requestHash: hash({
      v: SALE_CORRECTION_REQUEST_VERSION,
      action: 'sales.cancel',
      targetOperationId,
      occurredAt: parsed.data.occurredAt,
    }),
  };
}

export function parseSaleEditCommand(
  targetOperationIdInput: string,
  body: unknown,
): SaleEditCommand {
  const targetOperationId = parseIdentifier(targetOperationIdInput);
  const parsed = editRequest.safeParse(body);
  if (!parsed.success) throw validationError();
  if (
    Object.hasOwn(parsed.data.replacement, 'operationId') ||
    Object.hasOwn(parsed.data.replacement, 'occurredAt')
  ) {
    throw validationError();
  }
  const replacement = parseSalePostingCommand({
    ...parsed.data.replacement,
    operationId: parsed.data.operationId,
    occurredAt: parsed.data.occurredAt,
  });
  return {
    kind: 'edit',
    operationId: parsed.data.operationId,
    targetOperationId,
    occurredAt: new Date(parsed.data.occurredAt),
    replacement,
    requestHash: hash({
      v: SALE_CORRECTION_REQUEST_VERSION,
      action: 'sales.edit',
      targetOperationId,
      occurredAt: parsed.data.occurredAt,
      replacementRequestHash: replacement.requestHash,
    }),
  };
}

function parseIdentifier(value: string): string {
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
