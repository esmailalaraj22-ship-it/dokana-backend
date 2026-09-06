import { BadRequestException } from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { ACCOUNTING_PERIOD_MIN_YEAR } from '../accounting-periods/accounting-period-month';
import { isUuid } from '../common/logging/request-id';
import { INVENTORY_INT8_MAX } from './inventory-math';

export type InventoryCommandKind = 'opening' | 'increase' | 'decrease';

const identifier = z
  .string()
  .refine(isUuid)
  .transform((value) => value.toLowerCase());
const magnitude = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .pipe(z.string().refine((value) => BigInt(value) <= INVENTORY_INT8_MAX));
const cost = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .pipe(z.string().refine((value) => BigInt(value) <= INVENTORY_INT8_MAX));
const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/)
  .refine((value) => isISO8601(value, { strict: true }) && Number.isFinite(Date.parse(value)))
  // Leave the boundary year to S9's local-date validation; reject ancient instants
  // before the operational timezone formatter encounters historical second offsets.
  .refine((value) => new Date(value).getUTCFullYear() >= ACCOUNTING_PERIOD_MIN_YEAR - 1)
  .transform((value) => new Date(value).toISOString());
const reason = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine((value) => !value.includes('\0'));
const fields = {
  operationId: identifier,
  productId: identifier,
  productUnitId: identifier,
  selectedQuantityMilli: magnitude,
  occurredAt: instant,
};
const addition = z
  .object({ ...fields, totalPurchaseCostMinor: cost.optional(), reason: reason.optional() })
  .strict();
const decrease = z.object({ ...fields, reason }).strict();

export interface InventoryPostingCommand {
  kind: InventoryCommandKind;
  operationId: string;
  productId: string;
  productUnitId: string;
  selectedQuantityMilli: bigint;
  totalPurchaseCostMinor: bigint | null;
  occurredAt: Date;
  reason: string | null;
  requestHash: string;
}

export function parseInventoryPostingCommand(
  kind: InventoryCommandKind,
  body: unknown,
): InventoryPostingCommand {
  const parsed = (kind === 'decrease' ? decrease : addition).safeParse(body);
  if (!parsed.success)
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed.',
    });
  const data = parsed.data;
  const total = 'totalPurchaseCostMinor' in data ? (data.totalPurchaseCostMinor ?? null) : null;
  const semantic = {
    v: 1,
    action: `inventory.${kind}`,
    productId: data.productId,
    productUnitId: data.productUnitId,
    selectedQuantityMilli: data.selectedQuantityMilli,
    totalPurchaseCostMinor: total,
    occurredAt: data.occurredAt,
    reason: data.reason ?? null,
  };
  return {
    ...data,
    kind,
    selectedQuantityMilli: BigInt(data.selectedQuantityMilli),
    totalPurchaseCostMinor: total === null ? null : BigInt(total),
    occurredAt: new Date(data.occurredAt),
    reason: semantic.reason,
    requestHash: createHash('sha256').update(JSON.stringify(semantic)).digest('hex'),
  };
}
