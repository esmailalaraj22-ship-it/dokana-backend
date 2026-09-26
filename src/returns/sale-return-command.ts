import { BadRequestException } from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { ACCOUNTING_PERIOD_MIN_YEAR } from '../accounting-periods/accounting-period-month';
import { isUuid } from '../common/logging/request-id';
import { INVENTORY_INT8_MAX } from '../inventory/inventory-math';
import type { SaleReturnCommand } from './sale-return.types';

const identifier = z
  .string()
  .refine(isUuid)
  .transform((value) => value.toLowerCase());
const positiveQuantity = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= INVENTORY_INT8_MAX);
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
  .max(1000)
  .refine((value) => !value.includes('\0'));
const line = z
  .object({
    saleItemId: identifier,
    quantityMilli: positiveQuantity,
    disposition: z.enum(['RESTOCK_SALEABLE', 'DAMAGED_NO_RESTOCK']),
  })
  .strict();
const residualSettlement = z.discriminatedUnion('choice', [
  z.object({ choice: z.literal('REFUND'), moneyAccountId: identifier }).strict(),
  z.object({ choice: z.literal('KEEP_AS_CUSTOMER_CREDIT') }).strict(),
]);
const request = z
  .object({
    operationId: identifier,
    occurredAt: instant,
    reason,
    lines: z.array(line).min(1).max(100),
    residualSettlement: residualSettlement.nullable().optional(),
  })
  .strict();

export function parseSaleReturnCommand(saleIdInput: string, body: unknown): SaleReturnCommand {
  const saleId = identifier.safeParse(saleIdInput);
  const parsed = request.safeParse(body);
  if (!saleId.success || !parsed.success) throw validationError();

  const lines = parsed.data.lines
    .map((item) => ({ ...item, quantityMilli: BigInt(item.quantityMilli) }))
    .sort((left, right) => compareCanonical(left.saleItemId, right.saleItemId));
  if (new Set(lines.map((item) => item.saleItemId)).size !== lines.length) {
    throw validationError();
  }
  const residualSettlement = parsed.data.residualSettlement
    ? {
        choice: parsed.data.residualSettlement.choice,
        moneyAccountId:
          parsed.data.residualSettlement.choice === 'REFUND'
            ? parsed.data.residualSettlement.moneyAccountId
            : null,
      }
    : null;
  const semantic = {
    v: 1,
    action: 'sale_returns.post',
    saleId: saleId.data,
    occurredAt: parsed.data.occurredAt,
    reason: parsed.data.reason,
    lines: lines.map((item) => ({
      saleItemId: item.saleItemId,
      quantityMilli: item.quantityMilli.toString(),
      disposition: item.disposition,
    })),
    residualSettlement,
  };

  return {
    operationId: parsed.data.operationId,
    saleId: saleId.data,
    occurredAt: new Date(parsed.data.occurredAt),
    reason: parsed.data.reason,
    lines,
    residualSettlement,
    requestHash: createHash('sha256').update(JSON.stringify(semantic), 'utf8').digest('hex'),
  };
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
