import { BadRequestException } from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { ACCOUNTING_PERIOD_MIN_YEAR } from '../accounting-periods/accounting-period-month';
import { isUuid } from '../common/logging/request-id';
import {
  parseInventoryPostingCommand,
  type InventoryCommandKind,
  type InventoryPostingCommand,
} from './inventory-posting-command';
import { parseStockCountCommand, type StockCountCommand } from './stock-count-command';

export const inventoryCorrectionFamilies = [
  'opening',
  'increase',
  'decrease',
  'stock_count',
] as const;
export type InventoryCorrectionFamily = (typeof inventoryCorrectionFamilies)[number];
export type InventoryCorrectionKind = 'reversal' | 'replacement';

export type InventoryCorrectionReplacement =
  | { family: InventoryCommandKind; command: InventoryPostingCommand }
  | { family: 'stock_count'; command: StockCountCommand };

export interface InventoryCorrectionCommand {
  operationId: string;
  targetOperationId: string;
  kind: InventoryCorrectionKind;
  occurredAt: Date;
  replacement: InventoryCorrectionReplacement | null;
  requestHash: string;
}

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
const replacementEnvelope = z.object({ family: z.enum(inventoryCorrectionFamilies) }).loose();
const reversalRequest = z
  .object({
    operationId: identifier,
    targetOperationId: identifier,
    correctionType: z.literal('REVERSAL'),
    occurredAt: instant,
  })
  .strict();
const replacementRequest = z
  .object({
    operationId: identifier,
    targetOperationId: identifier,
    correctionType: z.literal('REPLACEMENT'),
    occurredAt: instant,
    replacement: replacementEnvelope,
  })
  .strict();

export function parseInventoryCorrectionCommand(body: unknown): InventoryCorrectionCommand {
  const parsed = z.union([reversalRequest, replacementRequest]).safeParse(body);
  if (!parsed.success) throw validationError();
  const kind: InventoryCorrectionKind =
    parsed.data.correctionType === 'REVERSAL' ? 'reversal' : 'replacement';
  const replacement =
    kind === 'replacement' && 'replacement' in parsed.data
      ? parseReplacement(parsed.data.operationId, parsed.data.occurredAt, parsed.data.replacement)
      : null;
  const semantic = {
    v: 1,
    action: `inventory.correction.${kind}`,
    targetOperationId: parsed.data.targetOperationId,
    occurredAt: parsed.data.occurredAt,
    replacement: replacement ? semanticReplacement(replacement) : null,
  };
  return {
    operationId: parsed.data.operationId,
    targetOperationId: parsed.data.targetOperationId,
    kind,
    occurredAt: new Date(parsed.data.occurredAt),
    replacement,
    requestHash: createHash('sha256').update(JSON.stringify(semantic)).digest('hex'),
  };
}

function parseReplacement(
  operationId: string,
  occurredAt: string,
  value: z.infer<typeof replacementEnvelope>,
): InventoryCorrectionReplacement {
  const { family, ...payload } = value;
  if ('operationId' in payload || 'occurredAt' in payload) throw validationError();
  try {
    if (family === 'stock_count') {
      return {
        family,
        command: parseStockCountCommand({ ...payload, operationId, occurredAt }),
      };
    }
    return {
      family,
      command: parseInventoryPostingCommand(family, { ...payload, operationId, occurredAt }),
    };
  } catch (error) {
    if (error instanceof BadRequestException) throw validationError();
    throw error;
  }
}

function semanticReplacement(replacement: InventoryCorrectionReplacement) {
  if (replacement.family === 'stock_count') {
    return {
      family: replacement.family,
      countType: replacement.command.countType,
      items: replacement.command.items.map((item) => ({
        productId: item.productId,
        productUnitId: item.productUnitId,
        actualQuantityMilli: item.actualQuantityMilli.toString(),
      })),
    };
  }
  return {
    family: replacement.family,
    productId: replacement.command.productId,
    productUnitId: replacement.command.productUnitId,
    selectedQuantityMilli: replacement.command.selectedQuantityMilli.toString(),
    totalPurchaseCostMinor: replacement.command.totalPurchaseCostMinor?.toString() ?? null,
    reason: replacement.command.reason,
  };
}

function validationError(): BadRequestException {
  return new BadRequestException({
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed.',
  });
}
