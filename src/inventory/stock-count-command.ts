import { BadRequestException } from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { ACCOUNTING_PERIOD_MIN_YEAR } from '../accounting-periods/accounting-period-month';
import { isUuid } from '../common/logging/request-id';
import { INVENTORY_INT8_MAX } from './inventory-math';

export type StockCountType = 'full' | 'partial';

const identifier = z
  .string()
  .refine(isUuid)
  .transform((value) => value.toLowerCase());
const quantity = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .pipe(z.string().refine((value) => BigInt(value) <= INVENTORY_INT8_MAX));
const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/)
  .refine((value) => isISO8601(value, { strict: true }) && Number.isFinite(Date.parse(value)))
  .refine((value) => new Date(value).getUTCFullYear() >= ACCOUNTING_PERIOD_MIN_YEAR - 1)
  .transform((value) => new Date(value).toISOString());
const item = z
  .object({
    productId: identifier,
    productUnitId: identifier,
    actualQuantityMilli: quantity,
  })
  .strict();
const command = z
  .object({
    operationId: identifier,
    countType: z.enum(['full', 'partial']),
    occurredAt: instant,
    items: z.array(item),
  })
  .strict();

export interface StockCountCommandItem {
  productId: string;
  productUnitId: string;
  actualQuantityMilli: bigint;
}

export interface StockCountCommand {
  operationId: string;
  countType: StockCountType;
  occurredAt: Date;
  items: StockCountCommandItem[];
  requestHash: string;
}

export function parseStockCountCommand(body: unknown): StockCountCommand {
  const parsed = command.safeParse(body);
  if (!parsed.success) throw validationError();
  const sorted = [...parsed.data.items].sort((left, right) =>
    left.productId.localeCompare(right.productId),
  );
  if (
    sorted.some((value, index) => index > 0 && sorted[index - 1]?.productId === value.productId)
  ) {
    throw validationError();
  }
  const semantic = {
    v: 1,
    action: 'inventory.stock_count',
    countType: parsed.data.countType,
    occurredAt: parsed.data.occurredAt,
    items: sorted.map((value) => ({
      productId: value.productId,
      productUnitId: value.productUnitId,
      actualQuantityMilli: value.actualQuantityMilli,
    })),
  };
  return {
    operationId: parsed.data.operationId,
    countType: parsed.data.countType,
    occurredAt: new Date(parsed.data.occurredAt),
    items: sorted.map((value) => ({
      ...value,
      actualQuantityMilli: BigInt(value.actualQuantityMilli),
    })),
    requestHash: createHash('sha256').update(JSON.stringify(semantic)).digest('hex'),
  };
}

function validationError(): BadRequestException {
  return new BadRequestException({
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed.',
  });
}
