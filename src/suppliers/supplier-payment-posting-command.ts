import { BadRequestException } from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { ACCOUNTING_PERIOD_MIN_YEAR } from '../accounting-periods/accounting-period-month';
import { isUuid } from '../common/logging/request-id';
import { MAX_MONEY_MINOR } from '../money-movements/money-amount';

export const SUPPLIER_PAYMENT_REQUEST_VERSION = 1;
export const SUPPLIER_PAYMENT_MAX_ALLOCATIONS = 100;

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
const safeText = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !value.includes('\0'));
const optionalText = (maximum: number) => safeText(maximum).nullable().optional();

const allocation = z
  .object({
    targetType: z.enum(['purchase_invoice', 'opening_payable']),
    targetId: identifier,
    amountMinor: positiveMoney,
  })
  .strict();

const request = z
  .object({
    operationId: identifier,
    paymentSource: z.enum(['money_account', 'owner_pocket']),
    moneyAccountId: identifier.nullable().optional(),
    amountMinor: positiveMoney,
    occurredAt: instant,
    externalReference: optionalText(200),
    notes: optionalText(1000),
    allocations: z.array(allocation).min(1).max(SUPPLIER_PAYMENT_MAX_ALLOCATIONS),
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

export type SupplierPaymentSource = 'money_account' | 'owner_pocket';
export type SupplierPaymentAllocationTargetType = 'purchase_invoice' | 'opening_payable';

export interface SupplierPaymentAllocationCommand {
  targetType: SupplierPaymentAllocationTargetType;
  targetId: string;
  amountMinor: bigint;
}

export interface SupplierPaymentPostingCommand {
  operationId: string;
  supplierId: string;
  paymentSource: SupplierPaymentSource;
  moneyAccountId: string | null;
  amountMinor: bigint;
  occurredAt: Date;
  externalReference: string | null;
  notes: string | null;
  allocations: SupplierPaymentAllocationCommand[];
  requestHash: string;
}

export function parseSupplierPaymentPostingCommand(
  supplierIdInput: string,
  body: unknown,
): SupplierPaymentPostingCommand {
  const supplierId = parseIdentifier(supplierIdInput);
  const parsed = request.safeParse(body);
  if (!parsed.success) throw validationError();

  const allocations = parsed.data.allocations
    .map((item) => ({
      targetType: item.targetType,
      targetId: item.targetId,
      amountMinor: BigInt(item.amountMinor),
    }))
    .sort(compareAllocations);

  let allocatedTotalMinor = 0n;
  let previousKey: string | null = null;
  for (const item of allocations) {
    const key = `${item.targetType}:${item.targetId}`;
    if (key === previousKey) throw validationError();
    previousKey = key;
    allocatedTotalMinor += item.amountMinor;
    if (allocatedTotalMinor > MAX_MONEY_MINOR) throw validationError();
  }

  const amountMinor = BigInt(parsed.data.amountMinor);
  if (allocatedTotalMinor !== amountMinor) throw validationError();

  const moneyAccountId = parsed.data.moneyAccountId ?? null;
  const externalReference = parsed.data.externalReference ?? null;
  const notes = parsed.data.notes ?? null;
  const semantic = {
    v: SUPPLIER_PAYMENT_REQUEST_VERSION,
    action: 'supplier_payments.post',
    supplierId,
    paymentSource: parsed.data.paymentSource,
    moneyAccountId,
    amountMinor: amountMinor.toString(),
    occurredAt: parsed.data.occurredAt,
    externalReference,
    notes,
    allocations: allocations.map((item) => ({
      targetType: item.targetType,
      targetId: item.targetId,
      amountMinor: item.amountMinor.toString(),
    })),
  };

  return {
    operationId: parsed.data.operationId,
    supplierId,
    paymentSource: parsed.data.paymentSource,
    moneyAccountId,
    amountMinor,
    occurredAt: new Date(parsed.data.occurredAt),
    externalReference,
    notes,
    allocations,
    requestHash: createHash('sha256').update(JSON.stringify(semantic), 'utf8').digest('hex'),
  };
}

function compareAllocations(
  left: SupplierPaymentAllocationCommand,
  right: SupplierPaymentAllocationCommand,
): number {
  const leftKey = `${left.targetType}:${left.targetId}`;
  const rightKey = `${right.targetType}:${right.targetId}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function parseIdentifier(value: string): string {
  const parsed = identifier.safeParse(value);
  if (!parsed.success) throw validationError();
  return parsed.data;
}

function validationError(): BadRequestException {
  return new BadRequestException({
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed.',
  });
}
