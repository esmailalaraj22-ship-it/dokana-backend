import { BadRequestException } from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { ACCOUNTING_PERIOD_MIN_YEAR } from '../accounting-periods/accounting-period-month';
import { isUuid } from '../common/logging/request-id';
import { MAX_MONEY_MINOR } from '../money-movements/money-amount';
import type {
  CustomerCollectionAllocationCommand,
  CustomerCollectionAllocationMode,
} from './customer-payment-posting-command';

const identifier = z
  .string()
  .refine(isUuid)
  .transform((value) => value.toLowerCase());
const positiveMoney = z
  .string()
  .refine((value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= MAX_MONEY_MINOR);
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
const allocation = z
  .object({
    targetType: z.enum(['sale_receivable', 'opening_receivable']),
    targetId: identifier,
    amountMinor: positiveMoney,
  })
  .strict();
const base = { operationId: identifier, occurredAt: instant, amountMinor: positiveMoney };
const targetedRequest = (withReason: boolean) =>
  z.discriminatedUnion('allocationMode', [
    z
      .object({
        ...base,
        ...(withReason ? { reason: safeText(500) } : {}),
        allocationMode: z.literal('fifo'),
      })
      .strict(),
    z
      .object({
        ...base,
        ...(withReason ? { reason: safeText(500) } : {}),
        allocationMode: z.literal('custom'),
        allocations: z.array(allocation).min(1).max(100),
      })
      .strict(),
  ]);
const refundRequest = z
  .object({
    ...base,
    moneyAccountId: identifier,
    notes: safeText(1000).nullable().optional(),
  })
  .strict();

export type CustomerFinancialAction =
  'apply_customer_credit' | 'refund_customer_credit' | 'settle_receivable';

export interface CustomerFinancialCommand {
  action: CustomerFinancialAction;
  operationId: string;
  customerId: string;
  occurredAt: Date;
  amountMinor: bigint;
  allocationMode: CustomerCollectionAllocationMode | null;
  allocations: CustomerCollectionAllocationCommand[];
  moneyAccountId: string | null;
  reason: string | null;
  requestHash: string;
}

export function parseApplyCustomerCreditCommand(
  customerId: string,
  body: unknown,
): CustomerFinancialCommand {
  return parseTargeted('apply_customer_credit', customerId, body, false);
}

export function parseSettleCustomerReceivableCommand(
  customerId: string,
  body: unknown,
): CustomerFinancialCommand {
  return parseTargeted('settle_receivable', customerId, body, true);
}

export function parseRefundCustomerCreditCommand(
  customerIdInput: string,
  body: unknown,
): CustomerFinancialCommand {
  const customerId = identifier.safeParse(customerIdInput);
  const parsed = refundRequest.safeParse(body);
  if (!customerId.success || !parsed.success) throw validationError();
  const semantic = {
    v: 1,
    action: 'refund_customer_credit' as const,
    customerId: customerId.data,
    operationId: parsed.data.operationId,
    occurredAt: parsed.data.occurredAt,
    amountMinor: parsed.data.amountMinor,
    moneyAccountId: parsed.data.moneyAccountId,
    notes: parsed.data.notes ?? null,
  };
  return {
    action: semantic.action,
    operationId: semantic.operationId,
    customerId: semantic.customerId,
    occurredAt: new Date(semantic.occurredAt),
    amountMinor: BigInt(semantic.amountMinor),
    allocationMode: null,
    allocations: [],
    moneyAccountId: semantic.moneyAccountId,
    reason: semantic.notes,
    requestHash: hash(semantic),
  };
}

function parseTargeted(
  action: Extract<CustomerFinancialAction, 'apply_customer_credit' | 'settle_receivable'>,
  customerIdInput: string,
  body: unknown,
  withReason: boolean,
): CustomerFinancialCommand {
  const customerId = identifier.safeParse(customerIdInput);
  const parsed = targetedRequest(withReason).safeParse(body);
  if (!customerId.success || !parsed.success) throw validationError();
  const allocations =
    parsed.data.allocationMode === 'custom'
      ? parsed.data.allocations
          .map((item) => ({
            targetType: item.targetType,
            targetId: item.targetId,
            amountMinor: BigInt(item.amountMinor),
          }))
          .sort((left, right) =>
            `${left.targetType}:${left.targetId}` < `${right.targetType}:${right.targetId}`
              ? -1
              : 1,
          )
      : [];
  if (
    new Set(allocations.map((item) => `${item.targetType}:${item.targetId}`)).size !==
      allocations.length ||
    (parsed.data.allocationMode === 'custom' &&
      allocations.reduce((total, item) => total + item.amountMinor, 0n) !==
        BigInt(parsed.data.amountMinor))
  ) {
    throw validationError();
  }
  const reason =
    'reason' in parsed.data && typeof parsed.data.reason === 'string' ? parsed.data.reason : null;
  const semantic = {
    v: 1,
    action,
    customerId: customerId.data,
    operationId: parsed.data.operationId,
    occurredAt: parsed.data.occurredAt,
    amountMinor: parsed.data.amountMinor,
    allocationMode: parsed.data.allocationMode,
    allocations: allocations.map((item) => ({
      targetType: item.targetType,
      targetId: item.targetId,
      amountMinor: item.amountMinor.toString(),
    })),
    reason,
  };
  return {
    action,
    operationId: semantic.operationId,
    customerId: semantic.customerId,
    occurredAt: new Date(semantic.occurredAt),
    amountMinor: BigInt(semantic.amountMinor),
    allocationMode: semantic.allocationMode,
    allocations,
    moneyAccountId: null,
    reason,
    requestHash: hash(semantic),
  };
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function validationError(): BadRequestException {
  return new BadRequestException({
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed.',
  });
}
