import { z } from 'zod';

import { isUuid } from '../common/logging/request-id';
import type { SupplierPaymentPostingResponse } from './supplier-payment-posting.types';

const identifier = z.string().refine(isUuid);
const integer = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const instant = z.string();
const movement = z
  .object({
    id: identifier,
    accountId: identifier,
    accountingPeriodId: identifier,
    movementType: z.literal('supplier_payment'),
    amountDeltaMinor: integer,
    transactionGroupId: identifier,
    operationId: identifier,
    occurredAt: instant,
    createdAt: instant,
  })
  .strict();
const ownerEntry = z
  .object({
    id: identifier,
    entryType: z.literal('owner_paid_supplier'),
    ownerLiabilityDeltaMinor: integer,
    equityDeltaMinor: integer,
    moneyAccountId: z.null(),
    transactionGroupId: identifier,
    operationId: identifier,
    occurredAt: instant,
    createdAt: instant,
  })
  .strict();

const responseSchema = z
  .object({
    operationId: identifier,
    supplierId: identifier,
    businessDate: z.string(),
    postingDate: z.string(),
    accountingPeriodId: identifier,
    payment: z
      .object({
        id: identifier,
        paymentSource: z.enum(['money_account', 'owner_pocket']),
        moneyAccountId: identifier.nullable(),
        amountMinor: integer,
        allocatedTotalMinor: integer,
        creditCreatedMinor: integer,
        paymentAt: instant,
        externalReference: z.string().nullable(),
        notes: z.string().nullable(),
        status: z.literal('posted'),
        moneyMovementId: identifier.nullable(),
        ownerLedgerEntryId: identifier.nullable(),
        version: integer,
      })
      .strict(),
    allocations: z.array(
      z
        .object({
          id: identifier,
          targetType: z.enum(['purchase_invoice', 'opening_payable']),
          targetId: identifier,
          amountMinor: integer,
          createdAt: instant,
        })
        .strict(),
    ),
    payable: z
      .object({
        id: identifier,
        payableDeltaMinor: integer,
        transactionGroupId: identifier,
        operationId: identifier,
        occurredAt: instant,
        createdAt: instant,
      })
      .strict(),
    moneyMovement: movement.nullable(),
    ownerLedgerEntry: ownerEntry.nullable(),
  })
  .strict();

export function parseStoredSupplierPaymentPostingResponse(
  value: unknown,
): SupplierPaymentPostingResponse {
  return responseSchema.parse(value);
}
