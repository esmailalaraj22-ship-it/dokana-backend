import { BadRequestException } from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { ACCOUNTING_PERIOD_MIN_YEAR } from '../accounting-periods/accounting-period-month';
import { isUuid } from '../common/logging/request-id';
import { INVENTORY_INT8_MAX, roundInventoryMoneyHalfUp } from '../inventory/inventory-math';

export const SALE_POSTING_REQUEST_VERSION = 1;
export const SALE_POSTING_MAX_ITEMS = 100;
export const SALE_POSTING_MAX_PAYMENTS = 20;

const identifier = z
  .string()
  .refine(isUuid)
  .transform((value) => value.toLowerCase());
const nonnegativeIntegerPattern = /^(0|[1-9][0-9]{0,18})$/;
const positiveIntegerPattern = /^[1-9][0-9]{0,18}$/;
const nonnegativeMoney = z
  .string()
  .refine((value) => nonnegativeIntegerPattern.test(value) && BigInt(value) <= INVENTORY_INT8_MAX);
const positiveMoney = z
  .string()
  .refine((value) => positiveIntegerPattern.test(value) && BigInt(value) <= INVENTORY_INT8_MAX);
const positiveQuantity = positiveMoney;
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

const pricedLine = {
  quantityMilli: positiveQuantity,
  unitPriceMinor: nonnegativeMoney,
  lineDiscountMinor: nonnegativeMoney.optional(),
  roundingMinor: rounding.optional(),
  lineTotalMinor: nonnegativeMoney.optional(),
};

const productLine = z
  .object({
    isManualLine: z.literal(false),
    productId: identifier,
    productUnitId: identifier,
    ...pricedLine,
  })
  .strict();
const manualLine = z
  .object({
    isManualLine: z.literal(true),
    description: safeText(500),
    unitName: optionalText(100),
    ...pricedLine,
  })
  .strict();
const saleLine = z.discriminatedUnion('isManualLine', [productLine, manualLine]);

const payment = z
  .object({
    moneyAccountId: identifier,
    amountMinor: positiveMoney,
    senderAccountName: optionalText(200),
    externalReference: optionalText(200),
  })
  .strict();

const saleRequest = z
  .object({
    operationId: identifier,
    customerId: identifier.nullable().optional(),
    occurredAt: instant,
    notes: optionalText(1000),
    invoiceDiscountMinor: nonnegativeMoney.optional(),
    roundingMinor: rounding.optional(),
    totalMinor: nonnegativeMoney.optional(),
    items: z.array(saleLine).min(1).max(SALE_POSTING_MAX_ITEMS),
    payments: z.array(payment).max(SALE_POSTING_MAX_PAYMENTS).optional(),
    customerCreditAmountMinor: positiveMoney.optional(),
  })
  .strict();

const openingReceivableRequest = z
  .object({
    operationId: identifier,
    amountMinor: positiveMoney,
    occurredAt: instant,
    notes: optionalText(1000),
  })
  .strict();

interface SaleLineAmounts {
  quantityMilli: bigint;
  unitPriceMinor: bigint;
  lineGrossMinor: bigint;
  lineDiscountMinor: bigint;
  roundingMinor: bigint;
  lineTotalMinor: bigint;
}

export interface ProductSaleLineCommand extends SaleLineAmounts {
  isManualLine: false;
  productId: string;
  productUnitId: string;
}

export interface ManualSaleLineCommand extends SaleLineAmounts {
  isManualLine: true;
  description: string;
  unitName: string | null;
}

export type SaleLineCommand = ProductSaleLineCommand | ManualSaleLineCommand;

export interface SalePaymentCommand {
  moneyAccountId: string;
  amountMinor: bigint;
  senderAccountName: string | null;
  externalReference: string | null;
}

export interface SalePostingCommand {
  operationId: string;
  customerId: string | null;
  occurredAt: Date;
  notes: string | null;
  itemsSubtotalMinor: bigint;
  lineDiscountTotalMinor: bigint;
  invoiceDiscountMinor: bigint;
  roundingMinor: bigint;
  totalMinor: bigint;
  moneyPaidTotalMinor: bigint;
  customerCreditAmountMinor: bigint;
  paidTotalMinor: bigint;
  creditTotalMinor: bigint;
  paymentStatus: 'paid' | 'partial' | 'credit';
  items: SaleLineCommand[];
  payments: SalePaymentCommand[];
  requestHash: string;
}

export interface CustomerOpeningReceivableCommand {
  operationId: string;
  customerId: string;
  amountMinor: bigint;
  occurredAt: Date;
  notes: string | null;
  requestHash: string;
}

export function parseSalePostingCommand(body: unknown): SalePostingCommand {
  const parsed = saleRequest.safeParse(body);
  if (!parsed.success) throw validationError();

  const items: SaleLineCommand[] = parsed.data.items.map((item) => {
    const quantityMilli = BigInt(item.quantityMilli);
    const unitPriceMinor = BigInt(item.unitPriceMinor);
    const lineGrossMinor = roundInventoryMoneyHalfUp(quantityMilli * unitPriceMinor, 1000n);
    const lineDiscountMinor = BigInt(item.lineDiscountMinor ?? '0');
    const roundingMinor = BigInt(item.roundingMinor ?? '0');
    const lineTotalMinor = lineGrossMinor - lineDiscountMinor + roundingMinor;
    assertMoney(lineGrossMinor);
    assertMoney(lineTotalMinor);
    if (
      lineTotalMinor < 0n ||
      (item.lineTotalMinor !== undefined && BigInt(item.lineTotalMinor) !== lineTotalMinor)
    ) {
      throw validationError();
    }
    const amounts = {
      quantityMilli,
      unitPriceMinor,
      lineGrossMinor,
      lineDiscountMinor,
      roundingMinor,
      lineTotalMinor,
    };
    return item.isManualLine
      ? {
          ...amounts,
          isManualLine: true,
          description: item.description,
          unitName: item.unitName ?? null,
        }
      : {
          ...amounts,
          isManualLine: false,
          productId: item.productId,
          productUnitId: item.productUnitId,
        };
  });

  const itemsSubtotalMinor = sumMoney(items.map((item) => item.lineGrossMinor));
  const lineDiscountTotalMinor = sumMoney(items.map((item) => item.lineDiscountMinor));
  const lineRoundingTotalMinor = items.reduce((sum, item) => sum + item.roundingMinor, 0n);
  if (lineRoundingTotalMinor !== 0n) throw validationError();
  const lineTotalMinor = sumMoney(items.map((item) => item.lineTotalMinor));
  const invoiceDiscountMinor = BigInt(parsed.data.invoiceDiscountMinor ?? '0');
  const roundingMinor = BigInt(parsed.data.roundingMinor ?? '0');
  const totalMinor = lineTotalMinor - invoiceDiscountMinor + roundingMinor;
  assertMoney(totalMinor);
  if (
    totalMinor <= 0n ||
    (parsed.data.totalMinor !== undefined && BigInt(parsed.data.totalMinor) !== totalMinor)
  ) {
    throw validationError();
  }

  const payments = (parsed.data.payments ?? [])
    .map((item) => ({
      moneyAccountId: item.moneyAccountId,
      amountMinor: BigInt(item.amountMinor),
      senderAccountName: item.senderAccountName ?? null,
      externalReference: item.externalReference ?? null,
    }))
    .sort((left, right) => compareCanonical(left.moneyAccountId, right.moneyAccountId));
  if (new Set(payments.map((item) => item.moneyAccountId)).size !== payments.length) {
    throw validationError();
  }
  const moneyPaidTotalMinor = sumMoney(payments.map((item) => item.amountMinor));
  const customerCreditAmountMinor = BigInt(parsed.data.customerCreditAmountMinor ?? '0');
  const paidTotalMinor = sumMoney([moneyPaidTotalMinor, customerCreditAmountMinor]);
  if (paidTotalMinor > totalMinor) throw validationError();
  const creditTotalMinor = totalMinor - paidTotalMinor;
  const customerId = parsed.data.customerId ?? null;
  if ((creditTotalMinor > 0n || customerCreditAmountMinor > 0n) && customerId === null) {
    throw validationError();
  }
  const paymentStatus =
    creditTotalMinor === 0n ? 'paid' : paidTotalMinor === 0n ? 'credit' : 'partial';
  const notes = parsed.data.notes ?? null;

  return {
    operationId: parsed.data.operationId,
    customerId,
    occurredAt: new Date(parsed.data.occurredAt),
    notes,
    itemsSubtotalMinor,
    lineDiscountTotalMinor,
    invoiceDiscountMinor,
    roundingMinor,
    totalMinor,
    moneyPaidTotalMinor,
    customerCreditAmountMinor,
    paidTotalMinor,
    creditTotalMinor,
    paymentStatus,
    items,
    payments,
    requestHash: hash({
      v: SALE_POSTING_REQUEST_VERSION,
      action: 'sales.post',
      customerId,
      occurredAt: parsed.data.occurredAt,
      notes,
      invoiceDiscountMinor: invoiceDiscountMinor.toString(),
      roundingMinor: roundingMinor.toString(),
      items: items.map((item) =>
        item.isManualLine
          ? {
              isManualLine: true,
              description: item.description,
              unitName: item.unitName,
              quantityMilli: item.quantityMilli.toString(),
              unitPriceMinor: item.unitPriceMinor.toString(),
              lineDiscountMinor: item.lineDiscountMinor.toString(),
              roundingMinor: item.roundingMinor.toString(),
            }
          : {
              isManualLine: false,
              productId: item.productId,
              productUnitId: item.productUnitId,
              quantityMilli: item.quantityMilli.toString(),
              unitPriceMinor: item.unitPriceMinor.toString(),
              lineDiscountMinor: item.lineDiscountMinor.toString(),
              roundingMinor: item.roundingMinor.toString(),
            },
      ),
      payments: payments.map((item) => ({
        moneyAccountId: item.moneyAccountId,
        amountMinor: item.amountMinor.toString(),
        senderAccountName: item.senderAccountName,
        externalReference: item.externalReference,
      })),
      ...(customerCreditAmountMinor > 0n
        ? { customerCreditAmountMinor: customerCreditAmountMinor.toString() }
        : {}),
    }),
  };
}

export function parseCustomerOpeningReceivableCommand(
  customerIdInput: string,
  body: unknown,
): CustomerOpeningReceivableCommand {
  const customerId = identifier.safeParse(customerIdInput);
  const parsed = openingReceivableRequest.safeParse(body);
  if (!customerId.success || !parsed.success) throw validationError();
  const notes = parsed.data.notes ?? null;
  return {
    operationId: parsed.data.operationId,
    customerId: customerId.data,
    amountMinor: BigInt(parsed.data.amountMinor),
    occurredAt: new Date(parsed.data.occurredAt),
    notes,
    requestHash: hash({
      v: SALE_POSTING_REQUEST_VERSION,
      action: 'customer_receivables.opening',
      customerId: customerId.data,
      amountMinor: parsed.data.amountMinor,
      occurredAt: parsed.data.occurredAt,
      notes,
    }),
  };
}

function sumMoney(values: bigint[]): bigint {
  let result = 0n;
  for (const value of values) {
    result += value;
    assertMoney(result);
  }
  return result;
}

function assertMoney(value: bigint): void {
  if (value < 0n || value > INVENTORY_INT8_MAX) throw validationError();
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
