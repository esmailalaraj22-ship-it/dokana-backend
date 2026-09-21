import { BadRequestException } from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { ACCOUNTING_PERIOD_MIN_YEAR } from '../accounting-periods/accounting-period-month';
import { isUuid } from '../common/logging/request-id';
import {
  parseApplyCustomerCreditCommand,
  parseRefundCustomerCreditCommand,
  parseSettleCustomerReceivableCommand,
  type CustomerFinancialCommand,
} from './customer-credit-command';
import {
  parseCustomerCollectionPostingCommand,
  type CustomerCollectionPostingCommand,
} from './customer-payment-posting-command';

export const CUSTOMER_FINANCIAL_CORRECTION_REQUEST_VERSION = 1;

export const customerFinancialCorrectionFamilies = [
  'customer_collection',
  'customer_credit_application',
  'customer_credit_refund',
  'customer_receivable_settlement',
] as const;

export type CustomerFinancialCorrectionFamily =
  (typeof customerFinancialCorrectionFamilies)[number];
export type CustomerFinancialCorrectionReplacement =
  CustomerCollectionPostingCommand | CustomerFinancialCommand;

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
  .max(500)
  .refine((value) => !value.includes('\0'));
const record = z.custom<Record<string, unknown>>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
);
const cancelRequest = z.object({ operationId: identifier, occurredAt: instant, reason }).strict();
const editRequest = z
  .object({ operationId: identifier, occurredAt: instant, reason, replacement: record })
  .strict();

interface CustomerFinancialCorrectionBase {
  operationId: string;
  targetOperationId: string;
  customerId: string;
  family: CustomerFinancialCorrectionFamily;
  occurredAt: Date;
  reason: string;
  requestHash: string;
}

export interface CustomerFinancialCancelCommand extends CustomerFinancialCorrectionBase {
  kind: 'cancel';
}

export interface CustomerFinancialEditCommand extends CustomerFinancialCorrectionBase {
  kind: 'edit';
  replacement: CustomerFinancialCorrectionReplacement;
}

export type CustomerFinancialCorrectionCommand =
  CustomerFinancialCancelCommand | CustomerFinancialEditCommand;

export function parseCustomerFinancialCancelCommand(
  family: CustomerFinancialCorrectionFamily,
  customerIdInput: string,
  targetOperationIdInput: string,
  body: unknown,
): CustomerFinancialCancelCommand {
  const customerId = parseIdentifier(customerIdInput);
  const targetOperationId = parseIdentifier(targetOperationIdInput);
  const parsed = cancelRequest.safeParse(body);
  if (!parsed.success) throw validationError();
  const semantic = {
    v: CUSTOMER_FINANCIAL_CORRECTION_REQUEST_VERSION,
    action: correctionAction(family, 'cancel'),
    customerId,
    targetOperationId,
    occurredAt: parsed.data.occurredAt,
    reason: parsed.data.reason,
  };
  return {
    kind: 'cancel',
    family,
    operationId: parsed.data.operationId,
    targetOperationId,
    customerId,
    occurredAt: new Date(parsed.data.occurredAt),
    reason: parsed.data.reason,
    requestHash: hash(semantic),
  };
}

export function parseCustomerFinancialEditCommand(
  family: CustomerFinancialCorrectionFamily,
  customerIdInput: string,
  targetOperationIdInput: string,
  body: unknown,
): CustomerFinancialEditCommand {
  const customerId = parseIdentifier(customerIdInput);
  const targetOperationId = parseIdentifier(targetOperationIdInput);
  const parsed = editRequest.safeParse(body);
  if (!parsed.success) throw validationError();
  if (
    Object.hasOwn(parsed.data.replacement, 'operationId') ||
    Object.hasOwn(parsed.data.replacement, 'occurredAt') ||
    Object.hasOwn(parsed.data.replacement, 'customerId')
  ) {
    throw validationError();
  }

  const replacementBody = {
    ...parsed.data.replacement,
    operationId: parsed.data.operationId,
    occurredAt: parsed.data.occurredAt,
  };
  const replacement = parseReplacement(family, customerId, replacementBody);
  const semantic = {
    v: CUSTOMER_FINANCIAL_CORRECTION_REQUEST_VERSION,
    action: correctionAction(family, 'edit'),
    customerId,
    targetOperationId,
    occurredAt: parsed.data.occurredAt,
    reason: parsed.data.reason,
    replacementRequestHash: replacement.requestHash,
  };
  return {
    kind: 'edit',
    family,
    operationId: parsed.data.operationId,
    targetOperationId,
    customerId,
    occurredAt: new Date(parsed.data.occurredAt),
    reason: parsed.data.reason,
    replacement,
    requestHash: hash(semantic),
  };
}

export function correctionAction(
  family: CustomerFinancialCorrectionFamily,
  kind: 'cancel' | 'edit',
): string {
  return `customer_financial_corrections.${family}.${kind}`;
}

function parseReplacement(
  family: CustomerFinancialCorrectionFamily,
  customerId: string,
  body: Record<string, unknown>,
): CustomerFinancialCorrectionReplacement {
  if (family === 'customer_collection') {
    return parseCustomerCollectionPostingCommand(customerId, body);
  }
  if (family === 'customer_credit_application') {
    return parseApplyCustomerCreditCommand(customerId, body);
  }
  if (family === 'customer_credit_refund') {
    return parseRefundCustomerCreditCommand(customerId, body);
  }
  return parseSettleCustomerReceivableCommand(customerId, body);
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
