import { z } from 'zod';

import { inventoryPostingResponseSchema } from './inventory-posting-response';
import { stockCountResponseSchema } from './stock-count-response';

const identifier = z.uuid();
const integer = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const family = z.enum(['opening', 'increase', 'decrease', 'stock_count']);
const reversalMovement = z
  .object({
    movementId: identifier,
    reversedMovementId: identifier,
    productId: identifier,
    productUnitId: identifier,
    selectedQuantityMilli: integer,
    factorNum: z.number().int().positive(),
    factorDen: z.number().int().positive(),
    quantityBeforeMilli: integer,
    quantityDeltaMilli: integer,
    quantityAfterMilli: integer,
    costStateBefore: z.enum(['known', 'unknown', 'pending']),
    costStateAfter: z.enum(['known', 'unknown', 'pending']),
  })
  .strict();
const replacement = z.discriminatedUnion('family', [
  z
    .object({
      family: z.enum(['opening', 'increase', 'decrease']),
      operation: inventoryPostingResponseSchema,
    })
    .strict(),
  z.object({ family: z.literal('stock_count'), operation: stockCountResponseSchema }).strict(),
]);

export const inventoryCorrectionResponseSchema = z
  .object({
    operationId: identifier,
    targetOperationId: identifier,
    targetFamily: family,
    correctionType: z.enum(['REVERSAL', 'REPLACEMENT']),
    occurredAt: z.string(),
    businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    postingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    accountingPeriodId: identifier,
    reversalMovements: z.array(reversalMovement),
    replacement: replacement.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.correctionType === 'REVERSAL') !== (value.replacement === null)) {
      context.addIssue({ code: 'custom', message: 'Correction replacement shape is invalid.' });
    }
    if (value.replacement && value.replacement.family !== value.targetFamily) {
      context.addIssue({ code: 'custom', message: 'Correction replacement family is invalid.' });
    }
    if (
      value.replacement &&
      value.replacement.family !== 'stock_count' &&
      value.replacement.operation.kind !== value.replacement.family
    ) {
      context.addIssue({ code: 'custom', message: 'Correction replacement operation is invalid.' });
    }
  });

export type InventoryCorrectionResponse = z.infer<typeof inventoryCorrectionResponseSchema>;

export type InventoryCorrectionFailureCode =
  | 'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT'
  | 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE'
  | 'INVENTORY_AMOUNT_INVALID'
  | 'INVENTORY_CORRECTION_FAMILY_MISMATCH'
  | 'INVENTORY_CORRECTION_MISSING_PROJECTION_UNSUPPORTED'
  | 'INVENTORY_CORRECTION_REQUIRES_RECOST'
  | 'INVENTORY_CORRECTION_TARGET_INTEGRITY_CONFLICT'
  | 'INVENTORY_CORRECTION_TARGET_NOT_ACTIVE'
  | 'INVENTORY_CORRECTION_TARGET_NOT_FOUND'
  | 'INVENTORY_NEGATIVE_NOT_ALLOWED'
  | 'INVENTORY_OPENING_ALREADY_EXISTS'
  | 'INVENTORY_PRODUCT_NOT_FOUND'
  | 'INVENTORY_PRODUCT_UNAVAILABLE'
  | 'INVENTORY_UNIT_NOT_FOUND'
  | 'INVENTORY_UNIT_UNAVAILABLE'
  | 'OPERATION_ID_CONFLICT'
  | 'OPERATION_IN_PROGRESS'
  | 'STOCK_COUNT_AMOUNT_INVALID'
  | 'STOCK_COUNT_FULL_SET_MISMATCH'
  | 'STOCK_COUNT_PRODUCT_UNAVAILABLE'
  | 'STOCK_COUNT_UNIT_UNAVAILABLE';

export interface InventoryCorrectionFailure {
  code: InventoryCorrectionFailureCode;
  message: string;
  statusCode: 400 | 404 | 409;
}

export type InventoryCorrectionResult =
  | { ok: true; response: InventoryCorrectionResponse }
  | { ok: false; error: InventoryCorrectionFailure };
