import { BadRequestException } from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { ACCOUNTING_PERIOD_MIN_YEAR } from '../accounting-periods/accounting-period-month';
import { isUuid } from '../common/logging/request-id';
import { MAX_MONEY_MINOR } from '../money-movements/money-amount';

export const SUPPLIER_FINANCIAL_RETURN_REQUEST_VERSION = 1;

const identifier = z
  .string()
  .refine(isUuid)
  .transform((value) => value.toLowerCase());
const positiveMoneyPattern = /^[1-9][0-9]{0,18}$/;
const positiveMoney = z
  .string()
  .regex(positiveMoneyPattern)
  .refine((value) => !positiveMoneyPattern.test(value) || BigInt(value) <= MAX_MONEY_MINOR);
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
const optionalText = (maximum: number) => requiredText(maximum).nullable().optional();

const returnRequest = z
  .object({
    operationId: identifier,
    purchaseInvoiceId: identifier,
    amountMinor: positiveMoney,
    occurredAt: instant,
    reason: requiredText(1000),
  })
  .strict();

const creditApplicationRequest = z
  .object({
    operationId: identifier,
    purchaseInvoiceId: identifier,
    amountMinor: positiveMoney,
    occurredAt: instant,
    notes: optionalText(1000),
  })
  .strict();

const refundRequest = z
  .object({
    operationId: identifier,
    moneyAccountId: identifier,
    amountMinor: positiveMoney,
    occurredAt: instant,
    notes: optionalText(1000),
  })
  .strict();

const cancelCorrectionRequest = z
  .object({
    operationId: identifier,
    occurredAt: instant,
    reason: requiredText(1000),
  })
  .strict();

const returnReplacement = z
  .object({ amountMinor: positiveMoney, reason: requiredText(1000) })
  .strict();
const applicationReplacement = z
  .object({
    purchaseInvoiceId: identifier,
    amountMinor: positiveMoney,
    notes: optionalText(1000),
  })
  .strict();
const refundReplacement = z
  .object({ moneyAccountId: identifier, amountMinor: positiveMoney, notes: optionalText(1000) })
  .strict();

const returnReplaceRequest = cancelCorrectionRequest.extend({ replacement: returnReplacement });
const applicationReplaceRequest = cancelCorrectionRequest.extend({
  replacement: applicationReplacement,
});
const refundReplaceRequest = cancelCorrectionRequest.extend({ replacement: refundReplacement });

interface SupplierFinancialCommandBase {
  operationId: string;
  supplierId: string;
  amountMinor: bigint;
  occurredAt: Date;
  requestHash: string;
}

export interface SupplierReturnPostingCommand extends SupplierFinancialCommandBase {
  family: 'supplier_return';
  purchaseInvoiceId: string;
  reason: string;
}

export interface SupplierCreditApplicationCommand extends SupplierFinancialCommandBase {
  family: 'supplier_credit_application';
  purchaseInvoiceId: string;
  notes: string | null;
}

export interface SupplierRefundCommand extends SupplierFinancialCommandBase {
  family: 'supplier_refund';
  moneyAccountId: string;
  notes: string | null;
}

export type SupplierFinancialPostingCommand =
  SupplierReturnPostingCommand | SupplierCreditApplicationCommand | SupplierRefundCommand;

interface SupplierCorrectionBase {
  operationId: string;
  targetOperationId: string;
  occurredAt: Date;
  correctionReason: string;
  requestHash: string;
}

export interface SupplierReturnCancelCommand extends SupplierCorrectionBase {
  family: 'supplier_return';
  kind: 'cancel';
}

export interface SupplierReturnReplaceCommand extends SupplierCorrectionBase {
  family: 'supplier_return';
  kind: 'replace';
  replacement: { amountMinor: bigint; reason: string };
}

export interface SupplierCreditApplicationCancelCommand extends SupplierCorrectionBase {
  family: 'supplier_credit_application';
  kind: 'cancel';
}

export interface SupplierCreditApplicationReplaceCommand extends SupplierCorrectionBase {
  family: 'supplier_credit_application';
  kind: 'replace';
  replacement: { purchaseInvoiceId: string; amountMinor: bigint; notes: string | null };
}

export interface SupplierRefundCancelCommand extends SupplierCorrectionBase {
  family: 'supplier_refund';
  kind: 'cancel';
}

export interface SupplierRefundReplaceCommand extends SupplierCorrectionBase {
  family: 'supplier_refund';
  kind: 'replace';
  replacement: { moneyAccountId: string; amountMinor: bigint; notes: string | null };
}

export type SupplierFinancialCorrectionCommand =
  | SupplierReturnCancelCommand
  | SupplierReturnReplaceCommand
  | SupplierCreditApplicationCancelCommand
  | SupplierCreditApplicationReplaceCommand
  | SupplierRefundCancelCommand
  | SupplierRefundReplaceCommand;

export function parseSupplierReturnPostingCommand(
  supplierIdInput: string,
  body: unknown,
): SupplierReturnPostingCommand {
  const supplierId = parseIdentifier(supplierIdInput);
  const parsed = returnRequest.safeParse(body);
  if (!parsed.success) throw validationError();
  const amountMinor = BigInt(parsed.data.amountMinor);
  const semantic = {
    v: SUPPLIER_FINANCIAL_RETURN_REQUEST_VERSION,
    action: 'supplier_returns.post',
    supplierId,
    purchaseInvoiceId: parsed.data.purchaseInvoiceId,
    amountMinor: amountMinor.toString(),
    occurredAt: parsed.data.occurredAt,
    reason: parsed.data.reason,
  };
  return {
    family: 'supplier_return',
    operationId: parsed.data.operationId,
    supplierId,
    purchaseInvoiceId: parsed.data.purchaseInvoiceId,
    amountMinor,
    occurredAt: new Date(parsed.data.occurredAt),
    reason: parsed.data.reason,
    requestHash: hash(semantic),
  };
}

export function parseSupplierCreditApplicationCommand(
  supplierIdInput: string,
  body: unknown,
): SupplierCreditApplicationCommand {
  const supplierId = parseIdentifier(supplierIdInput);
  const parsed = creditApplicationRequest.safeParse(body);
  if (!parsed.success) throw validationError();
  const notes = parsed.data.notes ?? null;
  const amountMinor = BigInt(parsed.data.amountMinor);
  const semantic = {
    v: SUPPLIER_FINANCIAL_RETURN_REQUEST_VERSION,
    action: 'supplier_credit_applications.post',
    supplierId,
    purchaseInvoiceId: parsed.data.purchaseInvoiceId,
    amountMinor: amountMinor.toString(),
    occurredAt: parsed.data.occurredAt,
    notes,
  };
  return {
    family: 'supplier_credit_application',
    operationId: parsed.data.operationId,
    supplierId,
    purchaseInvoiceId: parsed.data.purchaseInvoiceId,
    amountMinor,
    occurredAt: new Date(parsed.data.occurredAt),
    notes,
    requestHash: hash(semantic),
  };
}

export function parseSupplierRefundCommand(
  supplierIdInput: string,
  body: unknown,
): SupplierRefundCommand {
  const supplierId = parseIdentifier(supplierIdInput);
  const parsed = refundRequest.safeParse(body);
  if (!parsed.success) throw validationError();
  const notes = parsed.data.notes ?? null;
  const amountMinor = BigInt(parsed.data.amountMinor);
  const semantic = {
    v: SUPPLIER_FINANCIAL_RETURN_REQUEST_VERSION,
    action: 'supplier_refunds.post',
    supplierId,
    moneyAccountId: parsed.data.moneyAccountId,
    amountMinor: amountMinor.toString(),
    occurredAt: parsed.data.occurredAt,
    notes,
  };
  return {
    family: 'supplier_refund',
    operationId: parsed.data.operationId,
    supplierId,
    moneyAccountId: parsed.data.moneyAccountId,
    amountMinor,
    occurredAt: new Date(parsed.data.occurredAt),
    notes,
    requestHash: hash(semantic),
  };
}

export function parseSupplierFinancialCorrectionCommand(
  family: SupplierFinancialCorrectionCommand['family'],
  kind: SupplierFinancialCorrectionCommand['kind'],
  targetOperationIdInput: string,
  body: unknown,
): SupplierFinancialCorrectionCommand {
  const targetOperationId = parseIdentifier(targetOperationIdInput);
  if (kind === 'cancel') {
    const parsed = cancelCorrectionRequest.safeParse(body);
    if (!parsed.success) throw validationError();
    return correctionCommand(family, kind, targetOperationId, parsed.data);
  }
  if (family === 'supplier_return') {
    const parsed = returnReplaceRequest.safeParse(body);
    if (!parsed.success) throw validationError();
    return correctionCommand(family, kind, targetOperationId, parsed.data);
  }
  if (family === 'supplier_credit_application') {
    const parsed = applicationReplaceRequest.safeParse(body);
    if (!parsed.success) throw validationError();
    return correctionCommand(family, kind, targetOperationId, parsed.data);
  }
  const parsed = refundReplaceRequest.safeParse(body);
  if (!parsed.success) throw validationError();
  return correctionCommand(family, kind, targetOperationId, parsed.data);
}

function correctionCommand(
  family: SupplierFinancialCorrectionCommand['family'],
  kind: SupplierFinancialCorrectionCommand['kind'],
  targetOperationId: string,
  data: z.infer<typeof cancelCorrectionRequest> & { replacement?: unknown },
): SupplierFinancialCorrectionCommand {
  const base = {
    operationId: data.operationId,
    targetOperationId,
    occurredAt: new Date(data.occurredAt),
    correctionReason: data.reason,
  };
  let replacement: Record<string, unknown> | undefined;
  if (kind === 'replace') {
    replacement = normalizeReplacement(family, data.replacement);
  }
  const semantic = {
    v: SUPPLIER_FINANCIAL_RETURN_REQUEST_VERSION,
    action: `${family}.${kind}`,
    targetOperationId,
    occurredAt: data.occurredAt,
    correctionReason: data.reason,
    replacement,
  };
  const requestHash = hash(semantic);
  if (kind === 'cancel') return { ...base, family, kind, requestHash };
  if (family === 'supplier_return') {
    const value = replacement as { amountMinor: string; reason: string };
    return {
      ...base,
      family,
      kind,
      replacement: { amountMinor: BigInt(value.amountMinor), reason: value.reason },
      requestHash,
    };
  }
  if (family === 'supplier_credit_application') {
    const value = replacement as {
      purchaseInvoiceId: string;
      amountMinor: string;
      notes: string | null;
    };
    return {
      ...base,
      family,
      kind,
      replacement: {
        purchaseInvoiceId: value.purchaseInvoiceId,
        amountMinor: BigInt(value.amountMinor),
        notes: value.notes,
      },
      requestHash,
    };
  }
  const value = replacement as {
    moneyAccountId: string;
    amountMinor: string;
    notes: string | null;
  };
  return {
    ...base,
    family,
    kind,
    replacement: {
      moneyAccountId: value.moneyAccountId,
      amountMinor: BigInt(value.amountMinor),
      notes: value.notes,
    },
    requestHash,
  };
}

function normalizeReplacement(
  family: SupplierFinancialCorrectionCommand['family'],
  value: unknown,
): Record<string, unknown> {
  if (family === 'supplier_return') {
    const parsed = returnReplacement.parse(value);
    return { amountMinor: parsed.amountMinor, reason: parsed.reason };
  }
  if (family === 'supplier_credit_application') {
    const parsed = applicationReplacement.parse(value);
    return {
      purchaseInvoiceId: parsed.purchaseInvoiceId,
      amountMinor: parsed.amountMinor,
      notes: parsed.notes ?? null,
    };
  }
  const parsed = refundReplacement.parse(value);
  return {
    moneyAccountId: parsed.moneyAccountId,
    amountMinor: parsed.amountMinor,
    notes: parsed.notes ?? null,
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
