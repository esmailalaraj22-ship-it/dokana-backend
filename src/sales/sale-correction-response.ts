import { z } from 'zod';

import { isUuid } from '../common/logging/request-id';
import { parseStoredSalePostingResponse } from './sale-posting-response';
import type {
  SaleCancelResponse,
  SaleCorrectionResponse,
  SaleEditResponse,
} from './sale-correction.types';

const identifier = z.string().refine(isUuid);
const integer = z.string().regex(/^(0|[1-9][0-9]*)$/);
const common = {
  operationId: identifier,
  targetOperationId: identifier,
  occurredAt: z.string(),
  businessDate: z.string(),
  postingDate: z.string(),
  accountingPeriodId: identifier,
};
const cancelSchema = z
  .object({
    ...common,
    intent: z.literal('cancel'),
    outcome: z
      .object({
        saleId: identifier,
        status: z.literal('cancelled'),
        cancelledAt: z.string(),
        version: integer,
      })
      .strict(),
    currentSale: z.null(),
  })
  .strict();
const editSchema = z
  .object({
    ...common,
    intent: z.literal('edit'),
    outcome: z
      .object({
        saleId: identifier,
        status: z.literal('posted'),
        cancelledAt: z.null(),
        version: integer,
      })
      .strict(),
    currentSale: z.unknown(),
  })
  .strict();

export function parseStoredSaleCorrectionResponse(value: unknown): SaleCorrectionResponse {
  if (isCancel(value)) {
    return cancelSchema.parse(value) satisfies SaleCancelResponse;
  }
  const parsed = editSchema.parse(value);
  return {
    ...parsed,
    currentSale: parseStoredSalePostingResponse(parsed.currentSale),
  } satisfies SaleEditResponse;
}

function isCancel(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'intent' in value &&
    value.intent === 'cancel'
  );
}
