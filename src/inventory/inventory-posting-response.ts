import { z } from 'zod';
import { isUuid } from '../common/logging/request-id';

const identifier = z.string().refine(isUuid);
const integer = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const state = z.enum(['known', 'unknown', 'pending']);
export const inventoryPostingResponseSchema = z
  .object({
    operationId: identifier,
    kind: z.enum(['opening', 'increase', 'decrease']),
    entryId: identifier,
    movementId: identifier,
    productId: identifier,
    productUnitId: identifier,
    factorNum: z.number().int().positive(),
    factorDen: z.number().int().positive(),
    selectedQuantityMilli: integer,
    baseQuantityMilli: integer,
    quantityDeltaMilli: integer,
    totalPurchaseCostMinor: integer.nullable(),
    costStatus: state,
    occurredAt: z.string(),
    businessDate: z.string(),
    postingDate: z.string(),
    accountingPeriodId: identifier,
    reason: z.string().nullable(),
    stock: z
      .object({
        baseQuantityMilli: integer,
        version: integer,
        cost: z
          .object({
            status: state,
            valueMinor: integer.nullable(),
            averageUnitCostMinor: integer.nullable(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export type InventoryPostingResponse = z.infer<typeof inventoryPostingResponseSchema>;
export const inventoryPostingRejectionSchema = z
  .object({ code: z.string(), message: z.string() })
  .strict();
export type InventoryPostingResult =
  | { ok: true; response: InventoryPostingResponse }
  | { ok: false; statusCode: number; code: string; message: string };
