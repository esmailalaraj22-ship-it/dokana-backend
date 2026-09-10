import { BadRequestException } from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { ACCOUNTING_PERIOD_MIN_YEAR } from '../accounting-periods/accounting-period-month';
import { isUuid } from '../common/logging/request-id';
import {
  parseSupplierInvoicePostingCommand,
  parseSupplierOpeningPayableCommand,
  type SupplierInvoicePostingCommand,
  type SupplierOpeningPayableCommand,
} from './supplier-invoice-posting-command';

export const SUPPLIER_FINANCIAL_CORRECTION_REQUEST_VERSION = 1;

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

interface CorrectionBase {
  operationId: string;
  targetOperationId: string;
  occurredAt: Date;
  requestHash: string;
}

export interface SupplierInvoiceCancelCommand extends CorrectionBase {
  family: 'invoice';
  kind: 'cancel';
}

export interface SupplierInvoiceEditCommand extends CorrectionBase {
  family: 'invoice';
  kind: 'edit';
  replacement: SupplierInvoicePostingCommand;
}

export interface SupplierOpeningPayableCancelCommand extends CorrectionBase {
  family: 'opening_payable';
  kind: 'cancel';
}

export interface SupplierOpeningPayableEditCommand extends CorrectionBase {
  family: 'opening_payable';
  kind: 'edit';
  replacement: SupplierOpeningPayableCommand;
}

export type SupplierFinancialCorrectionCommand =
  | SupplierInvoiceCancelCommand
  | SupplierInvoiceEditCommand
  | SupplierOpeningPayableCancelCommand
  | SupplierOpeningPayableEditCommand;

export function parseSupplierInvoiceCancelCommand(
  targetOperationIdInput: string,
  body: unknown,
): SupplierInvoiceCancelCommand {
  const targetOperationId = parseIdentifier(targetOperationIdInput);
  const parsed = cancelRequest.safeParse(body);
  if (!parsed.success) throw validationError();
  const semantic = {
    v: SUPPLIER_FINANCIAL_CORRECTION_REQUEST_VERSION,
    action: 'supplier_invoices.cancel',
    targetOperationId,
    occurredAt: parsed.data.occurredAt,
  };
  return {
    family: 'invoice',
    kind: 'cancel',
    operationId: parsed.data.operationId,
    targetOperationId,
    occurredAt: new Date(parsed.data.occurredAt),
    requestHash: hash(semantic),
  };
}

export function parseSupplierInvoiceEditCommand(
  targetOperationIdInput: string,
  body: unknown,
): SupplierInvoiceEditCommand {
  const targetOperationId = parseIdentifier(targetOperationIdInput);
  const parsed = editRequest.safeParse(body);
  if (!parsed.success) throw validationError();
  const { supplierId, postingBody } = splitReplacement(parsed.data.replacement);
  const replacement = parseSupplierInvoicePostingCommand(supplierId, {
    ...postingBody,
    operationId: parsed.data.operationId,
    occurredAt: parsed.data.occurredAt,
  });
  const semantic = {
    v: SUPPLIER_FINANCIAL_CORRECTION_REQUEST_VERSION,
    action: 'supplier_invoices.edit',
    targetOperationId,
    occurredAt: parsed.data.occurredAt,
    replacementRequestHash: replacement.requestHash,
    presence: invoicePresence(postingBody),
  };
  return {
    family: 'invoice',
    kind: 'edit',
    operationId: parsed.data.operationId,
    targetOperationId,
    occurredAt: new Date(parsed.data.occurredAt),
    replacement,
    requestHash: hash(semantic),
  };
}

export function parseSupplierOpeningPayableCancelCommand(
  targetOperationIdInput: string,
  body: unknown,
): SupplierOpeningPayableCancelCommand {
  const targetOperationId = parseIdentifier(targetOperationIdInput);
  const parsed = cancelRequest.safeParse(body);
  if (!parsed.success) throw validationError();
  return {
    family: 'opening_payable',
    kind: 'cancel',
    operationId: parsed.data.operationId,
    targetOperationId,
    occurredAt: new Date(parsed.data.occurredAt),
    requestHash: hash({
      v: SUPPLIER_FINANCIAL_CORRECTION_REQUEST_VERSION,
      action: 'supplier_payables.opening.cancel',
      targetOperationId,
      occurredAt: parsed.data.occurredAt,
    }),
  };
}

export function parseSupplierOpeningPayableEditCommand(
  targetOperationIdInput: string,
  body: unknown,
): SupplierOpeningPayableEditCommand {
  const targetOperationId = parseIdentifier(targetOperationIdInput);
  const parsed = editRequest.safeParse(body);
  if (!parsed.success) throw validationError();
  const { supplierId, postingBody } = splitReplacement(parsed.data.replacement);
  const replacement = parseSupplierOpeningPayableCommand(supplierId, {
    ...postingBody,
    operationId: parsed.data.operationId,
    occurredAt: parsed.data.occurredAt,
  });
  return {
    family: 'opening_payable',
    kind: 'edit',
    operationId: parsed.data.operationId,
    targetOperationId,
    occurredAt: new Date(parsed.data.occurredAt),
    replacement,
    requestHash: hash({
      v: SUPPLIER_FINANCIAL_CORRECTION_REQUEST_VERSION,
      action: 'supplier_payables.opening.edit',
      targetOperationId,
      occurredAt: parsed.data.occurredAt,
      replacementRequestHash: replacement.requestHash,
      presence: { notes: Object.hasOwn(postingBody, 'notes') },
    }),
  };
}

function splitReplacement(value: Record<string, unknown>): {
  supplierId: string;
  postingBody: Record<string, unknown>;
} {
  if (
    Object.hasOwn(value, 'operationId') ||
    Object.hasOwn(value, 'occurredAt') ||
    !Object.hasOwn(value, 'supplierId')
  ) {
    throw validationError();
  }
  const supplierId = parseIdentifierValue(value.supplierId);
  const postingBody = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'supplierId'),
  );
  return { supplierId, postingBody };
}

function invoicePresence(value: Record<string, unknown>): object {
  const items: unknown[] = Array.isArray(value.items) ? (value.items as unknown[]) : [];
  return {
    invoiceNumber: Object.hasOwn(value, 'invoiceNumber'),
    dueAt: Object.hasOwn(value, 'dueAt'),
    notes: Object.hasOwn(value, 'notes'),
    invoiceDiscountMinor: Object.hasOwn(value, 'invoiceDiscountMinor'),
    roundingMinor: Object.hasOwn(value, 'roundingMinor'),
    totalMinor: Object.hasOwn(value, 'totalMinor'),
    items: items.map((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
      return {
        lineDiscountMinor: Object.hasOwn(item, 'lineDiscountMinor'),
        roundingMinor: Object.hasOwn(item, 'roundingMinor'),
        lineTotalMinor: Object.hasOwn(item, 'lineTotalMinor'),
        productId: Object.hasOwn(item, 'productId'),
        productUnitId: Object.hasOwn(item, 'productUnitId'),
      };
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
