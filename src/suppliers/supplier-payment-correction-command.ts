import { BadRequestException } from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { ACCOUNTING_PERIOD_MIN_YEAR } from '../accounting-periods/accounting-period-month';
import { isUuid } from '../common/logging/request-id';
import {
  parseSupplierPaymentPostingCommand,
  type SupplierPaymentPostingCommand,
} from './supplier-payment-posting-command';

export const SUPPLIER_PAYMENT_CORRECTION_REQUEST_VERSION = 1;

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

interface SupplierPaymentCorrectionBase {
  operationId: string;
  targetOperationId: string;
  occurredAt: Date;
  requestHash: string;
}

export interface SupplierPaymentCancelCommand extends SupplierPaymentCorrectionBase {
  kind: 'cancel';
}

export interface SupplierPaymentEditCommand extends SupplierPaymentCorrectionBase {
  kind: 'edit';
  replacement: SupplierPaymentPostingCommand;
}

export type SupplierPaymentCorrectionCommand =
  SupplierPaymentCancelCommand | SupplierPaymentEditCommand;

export function parseSupplierPaymentCancelCommand(
  targetOperationIdInput: string,
  body: unknown,
): SupplierPaymentCancelCommand {
  const targetOperationId = parseIdentifier(targetOperationIdInput);
  const parsed = cancelRequest.safeParse(body);
  if (!parsed.success) throw validationError();

  return {
    kind: 'cancel',
    operationId: parsed.data.operationId,
    targetOperationId,
    occurredAt: new Date(parsed.data.occurredAt),
    requestHash: hash({
      v: SUPPLIER_PAYMENT_CORRECTION_REQUEST_VERSION,
      action: 'supplier_payments.cancel',
      targetOperationId,
      occurredAt: parsed.data.occurredAt,
    }),
  };
}

export function parseSupplierPaymentEditCommand(
  targetOperationIdInput: string,
  body: unknown,
): SupplierPaymentEditCommand {
  const targetOperationId = parseIdentifier(targetOperationIdInput);
  const parsed = editRequest.safeParse(body);
  if (!parsed.success) throw validationError();
  const { supplierId, postingBody } = splitReplacement(parsed.data.replacement);
  const replacement = parseSupplierPaymentPostingCommand(supplierId, {
    ...postingBody,
    operationId: parsed.data.operationId,
  });

  return {
    kind: 'edit',
    operationId: parsed.data.operationId,
    targetOperationId,
    occurredAt: new Date(parsed.data.occurredAt),
    replacement,
    requestHash: hash({
      v: SUPPLIER_PAYMENT_CORRECTION_REQUEST_VERSION,
      action: 'supplier_payments.edit',
      targetOperationId,
      occurredAt: parsed.data.occurredAt,
      replacementRequestHash: replacement.requestHash,
    }),
  };
}

function splitReplacement(value: Record<string, unknown>): {
  supplierId: string;
  postingBody: Record<string, unknown>;
} {
  if (!Object.hasOwn(value, 'supplierId') || Object.hasOwn(value, 'operationId')) {
    throw validationError();
  }
  const supplierId = parseIdentifierValue(value.supplierId);
  const postingBody = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'supplierId'),
  );
  return { supplierId, postingBody };
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
