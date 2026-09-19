import { BadRequestException } from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { ACCOUNTING_PERIOD_MIN_YEAR } from '../accounting-periods/accounting-period-month';
import { isUuid } from '../common/logging/request-id';
import { MAX_MONEY_MINOR } from '../money-movements/money-amount';

export const CUSTOMER_COLLECTION_REQUEST_VERSION = 1;
export const CUSTOMER_COLLECTION_MAX_TENDERS = 20;
export const CUSTOMER_COLLECTION_MAX_CUSTOM_ALLOCATIONS = 100;

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

const tender = z
  .object({
    moneyAccountId: identifier,
    amountMinor: positiveMoney,
    senderAccountName: optionalText(200),
    externalReference: optionalText(200),
    notes: optionalText(1000),
  })
  .strict();

const allocation = z
  .object({
    targetType: z.enum(['sale_receivable', 'opening_receivable']),
    targetId: identifier,
    amountMinor: positiveMoney,
  })
  .strict();

const commonRequest = {
  operationId: identifier,
  occurredAt: instant,
  tenders: z.array(tender).min(1).max(CUSTOMER_COLLECTION_MAX_TENDERS),
};

const collectionCommon = {
  ...commonRequest,
  intent: z.literal('collect_receivable').optional(),
  overpaymentHandling: z.enum(['keep_as_customer_credit', 'refund_excess']).optional(),
  refundMoneyAccountId: identifier.optional(),
};

const collectionRequest = z.discriminatedUnion('allocationMode', [
  z
    .object({
      ...collectionCommon,
      allocationMode: z.literal('fifo'),
    })
    .strict(),
  z
    .object({
      ...collectionCommon,
      allocationMode: z.literal('custom'),
      allocations: z.array(allocation).min(1).max(CUSTOMER_COLLECTION_MAX_CUSTOM_ALLOCATIONS),
    })
    .strict(),
]);

const advanceRequest = z
  .object({
    ...commonRequest,
    intent: z.literal('customer_advance'),
  })
  .strict();

const request = z.union([collectionRequest, advanceRequest]);

export type CustomerCollectionAllocationMode = 'fifo' | 'custom';
export type CustomerReceivableTargetType = 'sale_receivable' | 'opening_receivable';
export type CustomerPaymentIntent = 'collect_receivable' | 'customer_advance';
export type CustomerOverpaymentHandling = 'keep_as_customer_credit' | 'refund_excess';

export interface CustomerCollectionTenderCommand {
  moneyAccountId: string;
  amountMinor: bigint;
  senderAccountName: string | null;
  externalReference: string | null;
  notes: string | null;
}

export interface CustomerCollectionAllocationCommand {
  targetType: CustomerReceivableTargetType;
  targetId: string;
  amountMinor: bigint;
}

export interface CustomerCollectionPostingCommand {
  operationId: string;
  customerId: string;
  occurredAt: Date;
  intent: CustomerPaymentIntent;
  allocationMode: CustomerCollectionAllocationMode;
  overpaymentHandling: CustomerOverpaymentHandling | null;
  refundMoneyAccountId: string | null;
  amountMinor: bigint;
  tenders: CustomerCollectionTenderCommand[];
  allocations: CustomerCollectionAllocationCommand[];
  requestHash: string;
}

export function parseCustomerCollectionPostingCommand(
  customerIdInput: string,
  body: unknown,
): CustomerCollectionPostingCommand {
  const customerId = identifier.safeParse(customerIdInput);
  const parsed = request.safeParse(body);
  if (!customerId.success || !parsed.success) throw validationError();

  const tenders = parsed.data.tenders
    .map((item) => ({
      moneyAccountId: item.moneyAccountId,
      amountMinor: BigInt(item.amountMinor),
      senderAccountName: item.senderAccountName ?? null,
      externalReference: item.externalReference ?? null,
      notes: item.notes ?? null,
    }))
    .sort((left, right) => compareCanonical(left.moneyAccountId, right.moneyAccountId));
  if (new Set(tenders.map((item) => item.moneyAccountId)).size !== tenders.length) {
    throw validationError();
  }
  const amountMinor = sumMoney(tenders.map((item) => item.amountMinor));

  const allocations =
    'allocationMode' in parsed.data && parsed.data.allocationMode === 'custom'
      ? parsed.data.allocations
          .map((item) => ({
            targetType: item.targetType,
            targetId: item.targetId,
            amountMinor: BigInt(item.amountMinor),
          }))
          .sort(compareAllocations)
      : [];
  if (
    new Set(allocations.map((item) => `${item.targetType}:${item.targetId}`)).size !==
    allocations.length
  ) {
    throw validationError();
  }
  if (
    'allocationMode' in parsed.data &&
    parsed.data.allocationMode === 'custom' &&
    (sumMoney(allocations.map((item) => item.amountMinor)) > amountMinor ||
      (!parsed.data.overpaymentHandling &&
        sumMoney(allocations.map((item) => item.amountMinor)) !== amountMinor))
  ) {
    throw validationError();
  }

  if (
    'allocationMode' in parsed.data &&
    (parsed.data.overpaymentHandling === 'refund_excess') !==
      (parsed.data.refundMoneyAccountId !== undefined)
  ) {
    throw validationError();
  }

  const intent: CustomerPaymentIntent =
    'allocationMode' in parsed.data ? 'collect_receivable' : 'customer_advance';
  const allocationMode: CustomerCollectionAllocationMode =
    'allocationMode' in parsed.data ? parsed.data.allocationMode : 'fifo';
  const overpaymentHandling =
    'allocationMode' in parsed.data ? (parsed.data.overpaymentHandling ?? null) : null;
  const refundMoneyAccountId =
    'allocationMode' in parsed.data ? (parsed.data.refundMoneyAccountId ?? null) : null;

  const semanticBase = {
    v: CUSTOMER_COLLECTION_REQUEST_VERSION,
    action: 'customer_collections.post',
    customerId: customerId.data,
    occurredAt: parsed.data.occurredAt,
    allocationMode,
    amountMinor: amountMinor.toString(),
    tenders: tenders.map((item) => ({
      moneyAccountId: item.moneyAccountId,
      amountMinor: item.amountMinor.toString(),
      senderAccountName: item.senderAccountName,
      externalReference: item.externalReference,
      notes: item.notes,
    })),
    allocations: allocations.map((item) => ({
      targetType: item.targetType,
      targetId: item.targetId,
      amountMinor: item.amountMinor.toString(),
    })),
  };
  const legacyRequest =
    'allocationMode' in parsed.data &&
    parsed.data.intent === undefined &&
    parsed.data.overpaymentHandling === undefined &&
    parsed.data.refundMoneyAccountId === undefined;
  const semantic = legacyRequest
    ? semanticBase
    : { ...semanticBase, intent, overpaymentHandling, refundMoneyAccountId };

  return {
    operationId: parsed.data.operationId,
    customerId: customerId.data,
    occurredAt: new Date(parsed.data.occurredAt),
    intent,
    allocationMode,
    overpaymentHandling,
    refundMoneyAccountId,
    amountMinor,
    tenders,
    allocations,
    requestHash: createHash('sha256').update(JSON.stringify(semantic), 'utf8').digest('hex'),
  };
}

function sumMoney(values: bigint[]): bigint {
  let total = 0n;
  for (const value of values) {
    total += value;
    if (total > MAX_MONEY_MINOR) throw validationError();
  }
  return total;
}

function compareAllocations(
  left: CustomerCollectionAllocationCommand,
  right: CustomerCollectionAllocationCommand,
): number {
  return compareCanonical(
    `${left.targetType}:${left.targetId}`,
    `${right.targetType}:${right.targetId}`,
  );
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validationError(): BadRequestException {
  return new BadRequestException({
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed.',
  });
}
