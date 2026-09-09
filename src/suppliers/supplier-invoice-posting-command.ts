import { BadRequestException } from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { ACCOUNTING_PERIOD_MIN_YEAR } from '../accounting-periods/accounting-period-month';
import { isUuid } from '../common/logging/request-id';
import { MAX_MONEY_MINOR } from '../money-movements/money-amount';

export const SUPPLIER_INVOICE_REQUEST_VERSION = 1;
export const SUPPLIER_INVOICE_MAX_ITEMS = 100;

const identifier = z
  .string()
  .refine(isUuid)
  .transform((value) => value.toLowerCase());
const nonnegativeMoneyPattern = /^(0|[1-9][0-9]{0,18})$/;
const positiveQuantityPattern = /^[1-9][0-9]{0,18}$/;
const nonnegativeMoney = z
  .string()
  .refine((value) => nonnegativeMoneyPattern.test(value) && BigInt(value) <= MAX_MONEY_MINOR);
const positiveQuantity = z
  .string()
  .refine((value) => positiveQuantityPattern.test(value) && BigInt(value) <= MAX_MONEY_MINOR);
const positiveMoney = z
  .string()
  .refine((value) => positiveQuantityPattern.test(value) && BigInt(value) <= MAX_MONEY_MINOR);
const rounding = z.string().regex(/^-?1$|^0$/);
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

const invoiceItem = z
  .object({
    description: safeText(500),
    unitName: safeText(100),
    quantityMilli: positiveQuantity,
    unitCostMinor: nonnegativeMoney,
    lineDiscountMinor: nonnegativeMoney.optional(),
    roundingMinor: rounding.optional(),
    lineTotalMinor: nonnegativeMoney.optional(),
    productId: identifier.nullable().optional(),
    productUnitId: identifier.nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.productId == null) !== (value.productUnitId == null)) {
      context.addIssue({ code: 'custom', path: ['productId'], message: 'pairedProductLink' });
    }
  });

const invoiceRequest = z
  .object({
    operationId: identifier,
    invoiceNumber: optionalText(200),
    occurredAt: instant,
    dueAt: instant.nullable().optional(),
    notes: optionalText(1000),
    invoiceDiscountMinor: nonnegativeMoney.optional(),
    roundingMinor: rounding.optional(),
    totalMinor: nonnegativeMoney.optional(),
    items: z.array(invoiceItem).min(1).max(SUPPLIER_INVOICE_MAX_ITEMS),
  })
  .strict();

const openingPayableRequest = z
  .object({
    operationId: identifier,
    amountMinor: positiveMoney,
    occurredAt: instant,
    notes: optionalText(1000),
  })
  .strict();

export interface SupplierInvoicePostingItemCommand {
  description: string;
  unitName: string;
  quantityMilli: bigint;
  unitCostMinor: bigint;
  lineGrossMinor: bigint;
  lineDiscountMinor: bigint;
  roundingMinor: bigint;
  lineTotalMinor: bigint;
  productId: string | null;
  productUnitId: string | null;
}

export interface SupplierInvoicePostingCommand {
  operationId: string;
  supplierId: string;
  invoiceNumber: string | null;
  occurredAt: Date;
  dueAt: Date | null;
  notes: string | null;
  itemsSubtotalMinor: bigint;
  lineDiscountTotalMinor: bigint;
  invoiceDiscountMinor: bigint;
  roundingMinor: bigint;
  totalMinor: bigint;
  items: SupplierInvoicePostingItemCommand[];
  requestHash: string;
}

export interface SupplierOpeningPayableCommand {
  operationId: string;
  supplierId: string;
  amountMinor: bigint;
  occurredAt: Date;
  notes: string | null;
  requestHash: string;
}

export function parseSupplierInvoicePostingCommand(
  supplierIdInput: string,
  body: unknown,
): SupplierInvoicePostingCommand {
  const supplierId = parseIdentifier(supplierIdInput);
  const parsed = invoiceRequest.safeParse(body);
  if (!parsed.success) throw validationError();

  const items = parsed.data.items.map((item) => {
    const quantityMilli = BigInt(item.quantityMilli);
    const unitCostMinor = BigInt(item.unitCostMinor);
    const lineGrossMinor = roundHalfUp(quantityMilli * unitCostMinor, 1000n);
    const lineDiscountMinor = BigInt(item.lineDiscountMinor ?? '0');
    const roundingMinor = BigInt(item.roundingMinor ?? '0');
    const lineTotalMinor = lineGrossMinor - lineDiscountMinor + roundingMinor;
    assertRepresentable(lineGrossMinor);
    assertRepresentable(lineTotalMinor);
    if (lineTotalMinor < 0n || item.lineTotalMinor !== undefined) {
      if (lineTotalMinor < 0n || BigInt(item.lineTotalMinor ?? '0') !== lineTotalMinor) {
        throw validationError();
      }
    }
    return {
      description: item.description,
      unitName: item.unitName,
      quantityMilli,
      unitCostMinor,
      lineGrossMinor,
      lineDiscountMinor,
      roundingMinor,
      lineTotalMinor,
      productId: item.productId ?? null,
      productUnitId: item.productUnitId ?? null,
    };
  });

  const itemsSubtotalMinor = sumMoney(items.map((item) => item.lineGrossMinor));
  const lineDiscountTotalMinor = sumMoney(items.map((item) => item.lineDiscountMinor));
  const lineRoundingTotalMinor = items.reduce((total, item) => total + item.roundingMinor, 0n);
  if (lineRoundingTotalMinor !== 0n) throw validationError();
  const lineTotalMinor = sumMoney(items.map((item) => item.lineTotalMinor));
  const invoiceDiscountMinor = BigInt(parsed.data.invoiceDiscountMinor ?? '0');
  const roundingMinor = BigInt(parsed.data.roundingMinor ?? '0');
  const totalMinor = lineTotalMinor - invoiceDiscountMinor + roundingMinor;
  assertRepresentable(totalMinor);
  if (
    totalMinor <= 0n ||
    (parsed.data.totalMinor !== undefined && BigInt(parsed.data.totalMinor) !== totalMinor)
  ) {
    throw validationError();
  }

  const invoiceNumber = parsed.data.invoiceNumber ?? null;
  const dueAt = parsed.data.dueAt ?? null;
  const notes = parsed.data.notes ?? null;
  const semantic = {
    v: SUPPLIER_INVOICE_REQUEST_VERSION,
    action: 'supplier_invoices.post',
    supplierId,
    invoiceNumber,
    occurredAt: parsed.data.occurredAt,
    dueAt,
    notes,
    invoiceDiscountMinor: invoiceDiscountMinor.toString(),
    roundingMinor: roundingMinor.toString(),
    items: items.map((item) => ({
      description: item.description,
      unitName: item.unitName,
      quantityMilli: item.quantityMilli.toString(),
      unitCostMinor: item.unitCostMinor.toString(),
      lineDiscountMinor: item.lineDiscountMinor.toString(),
      roundingMinor: item.roundingMinor.toString(),
      productId: item.productId,
      productUnitId: item.productUnitId,
    })),
  };
  return {
    operationId: parsed.data.operationId,
    supplierId,
    invoiceNumber,
    occurredAt: new Date(parsed.data.occurredAt),
    dueAt: dueAt === null ? null : new Date(dueAt),
    notes,
    itemsSubtotalMinor,
    lineDiscountTotalMinor,
    invoiceDiscountMinor,
    roundingMinor,
    totalMinor,
    items,
    requestHash: hash(semantic),
  };
}

export function parseSupplierOpeningPayableCommand(
  supplierIdInput: string,
  body: unknown,
): SupplierOpeningPayableCommand {
  const supplierId = parseIdentifier(supplierIdInput);
  const parsed = openingPayableRequest.safeParse(body);
  if (!parsed.success) throw validationError();
  const notes = parsed.data.notes ?? null;
  return {
    operationId: parsed.data.operationId,
    supplierId,
    amountMinor: BigInt(parsed.data.amountMinor),
    occurredAt: new Date(parsed.data.occurredAt),
    notes,
    requestHash: hash({
      v: SUPPLIER_INVOICE_REQUEST_VERSION,
      action: 'supplier_payables.opening',
      supplierId,
      amountMinor: parsed.data.amountMinor,
      occurredAt: parsed.data.occurredAt,
      notes,
    }),
  };
}

function parseIdentifier(value: string): string {
  const parsed = identifier.safeParse(value);
  if (!parsed.success) throw validationError();
  return parsed.data;
}

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return quotient + (remainder * 2n >= denominator ? 1n : 0n);
}

function sumMoney(values: bigint[]): bigint {
  let total = 0n;
  for (const value of values) {
    total += value;
    assertRepresentable(total);
  }
  return total;
}

function assertRepresentable(value: bigint): void {
  if (value < 0n || value > MAX_MONEY_MINOR) throw validationError();
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
