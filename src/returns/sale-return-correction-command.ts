import { BadRequestException } from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { ACCOUNTING_PERIOD_MIN_YEAR } from '../accounting-periods/accounting-period-month';
import { isUuid } from '../common/logging/request-id';
import { INVENTORY_INT8_MAX } from '../inventory/inventory-math';
import type { SaleReturnRequestedLine, SaleReturnResidualSettlement } from './sale-return.types';

export const SALE_RETURN_CORRECTION_REQUEST_VERSION = 1;

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
  .max(1000)
  .refine((value) => !value.includes('\0'));
const quantity = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= INVENTORY_INT8_MAX);
const replacementLine = z
  .object({
    saleItemId: identifier,
    quantityMilli: quantity,
    disposition: z.enum(['RESTOCK_SALEABLE', 'DAMAGED_NO_RESTOCK']),
  })
  .strict();
const residualSettlement = z.discriminatedUnion('choice', [
  z.object({ choice: z.literal('REFUND'), moneyAccountId: identifier }).strict(),
  z.object({ choice: z.literal('KEEP_AS_CUSTOMER_CREDIT') }).strict(),
]);
const replacement = z
  .object({
    reason,
    lines: z.array(replacementLine).min(1).max(100),
    residualSettlement: residualSettlement.nullable().optional(),
  })
  .strict();
const cancelRequest = z.object({ operationId: identifier, occurredAt: instant, reason }).strict();
const replaceRequest = cancelRequest.extend({ replacement }).strict();

export interface SaleReturnReplacementInput {
  reason: string;
  lines: SaleReturnRequestedLine[];
  residualSettlement: SaleReturnResidualSettlement | null;
}

interface SaleReturnCorrectionBase {
  operationId: string;
  targetReturnId: string;
  occurredAt: Date;
  correctionReason: string;
  requestHash: string;
}

export interface SaleReturnCancelCommand extends SaleReturnCorrectionBase {
  kind: 'cancel';
}

export interface SaleReturnReplaceCommand extends SaleReturnCorrectionBase {
  kind: 'replace';
  replacement: SaleReturnReplacementInput;
}

export type SaleReturnCorrectionCommand = SaleReturnCancelCommand | SaleReturnReplaceCommand;

export function parseSaleReturnCancelCommand(
  targetReturnIdInput: string,
  body: unknown,
): SaleReturnCancelCommand {
  const targetReturnId = parseIdentifier(targetReturnIdInput);
  const parsed = cancelRequest.safeParse(body);
  if (!parsed.success) throw validationError();
  return {
    kind: 'cancel',
    operationId: parsed.data.operationId,
    targetReturnId,
    occurredAt: new Date(parsed.data.occurredAt),
    correctionReason: parsed.data.reason,
    requestHash: hash({
      v: SALE_RETURN_CORRECTION_REQUEST_VERSION,
      action: 'sale_returns.cancel',
      targetReturnId,
      occurredAt: parsed.data.occurredAt,
      correctionReason: parsed.data.reason,
    }),
  };
}

export function parseSaleReturnReplaceCommand(
  targetReturnIdInput: string,
  body: unknown,
): SaleReturnReplaceCommand {
  const targetReturnId = parseIdentifier(targetReturnIdInput);
  const parsed = replaceRequest.safeParse(body);
  if (!parsed.success) throw validationError();
  const lines = parsed.data.replacement.lines
    .map((line) => ({ ...line, quantityMilli: BigInt(line.quantityMilli) }))
    .sort((left, right) => compareCanonical(left.saleItemId, right.saleItemId));
  if (new Set(lines.map((line) => line.saleItemId)).size !== lines.length) {
    throw validationError();
  }
  const residual = parsed.data.replacement.residualSettlement;
  const replacementInput: SaleReturnReplacementInput = {
    reason: parsed.data.replacement.reason,
    lines,
    residualSettlement: residual
      ? {
          choice: residual.choice,
          moneyAccountId: residual.choice === 'REFUND' ? residual.moneyAccountId : null,
        }
      : null,
  };
  return {
    kind: 'replace',
    operationId: parsed.data.operationId,
    targetReturnId,
    occurredAt: new Date(parsed.data.occurredAt),
    correctionReason: parsed.data.reason,
    replacement: replacementInput,
    requestHash: hash({
      v: SALE_RETURN_CORRECTION_REQUEST_VERSION,
      action: 'sale_returns.replace',
      targetReturnId,
      occurredAt: parsed.data.occurredAt,
      correctionReason: parsed.data.reason,
      replacement: {
        reason: replacementInput.reason,
        lines: replacementInput.lines.map((line) => ({
          ...line,
          quantityMilli: line.quantityMilli.toString(),
        })),
        residualSettlement: replacementInput.residualSettlement,
      },
    }),
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

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validationError(): BadRequestException {
  return new BadRequestException({
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed.',
  });
}
