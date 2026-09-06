import { z } from 'zod';

const identifier = z.uuid();
const integer = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const costState = z.enum(['known', 'unknown', 'pending']);
const stock = z
  .object({
    projectionState: z.literal('PRESENT'),
    baseQuantityMilli: integer,
    version: integer,
    lastMovementId: identifier.nullable(),
    cost: z
      .object({
        status: costState,
        valueMinor: integer.nullable(),
        averageUnitCostMinor: integer.nullable(),
      })
      .strict(),
  })
  .strict();

export const stockCountResponseSchema = z
  .object({
    operationId: identifier,
    countId: identifier,
    countType: z.enum(['full', 'partial']),
    status: z.literal('posted'),
    occurredAt: z.string(),
    businessDate: z.string(),
    postingDate: z.string(),
    accountingPeriodId: identifier,
    items: z.array(
      z
        .object({
          itemId: identifier,
          productId: identifier,
          productUnitId: identifier,
          factorNum: z.number().int().positive(),
          factorDen: z.number().int().positive(),
          actualSelectedQuantityMilli: integer,
          actualBaseQuantityMilli: integer,
          previousProjectionState: z.enum(['MISSING', 'ESTABLISHED']),
          previousBaseQuantityMilli: integer.nullable(),
          varianceMilli: integer.nullable(),
          adjustmentKind: z.enum(['establishment', 'variance', 'none']),
          quantityFactKind: z.enum(['movement', 'count_zero_establishment']).nullable(),
          movementId: identifier.nullable(),
          stock,
        })
        .strict(),
    ),
  })
  .strict();

export type StockCountResponse = z.infer<typeof stockCountResponseSchema>;
export const stockCountRejectionSchema = z
  .object({ code: z.string(), message: z.string() })
  .strict();
export type StockCountResult =
  | { ok: true; response: StockCountResponse }
  | { ok: false; statusCode: number; code: string; message: string };
