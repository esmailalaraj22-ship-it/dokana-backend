import { z } from 'zod';

import {
  deriveMoneyFactId,
  deriveMoneyFactOperationId,
} from '../money-movements/money-movement-identity';
import { parseStoredSaleReturnPostingResponse } from './sale-return-posting-response';
import type { SaleReturnCorrectionResponse } from './sale-return-correction.types';

const uuid = z.uuid();
const unsigned = z.string().regex(/^(0|[1-9][0-9]*)$/);
const signed = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const instant = z.iso.datetime({ offset: true });
const postingDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ledgerReversal = z
  .object({
    id: uuid,
    operationId: uuid,
    reversalOfId: uuid,
    receivableDeltaMinor: signed,
    creditDeltaMinor: signed,
  })
  .strict();
const moneyReversal = z
  .object({
    id: uuid,
    accountId: uuid,
    accountingPeriodId: uuid,
    movementType: z.literal('correction'),
    amountDeltaMinor: signed,
    transactionGroupId: uuid,
    operationId: uuid,
    occurredAt: instant,
    createdAt: instant,
    reversalOfId: uuid,
  })
  .strict();
const inventoryReversal = z
  .object({
    id: uuid,
    operationId: uuid,
    reversalOfId: uuid,
    productId: uuid,
    productUnitId: uuid,
    quantityDeltaMilli: signed,
    valueDeltaMinor: signed.nullable(),
    costStatus: z.enum(['known', 'unknown', 'pending']),
  })
  .strict();
const schema = z
  .object({
    operationId: uuid,
    transactionGroupId: uuid,
    targetReturnId: uuid,
    intent: z.enum(['cancel', 'replace']),
    correctionReason: z.string().min(1).max(1000),
    occurredAt: instant,
    businessDate: postingDate,
    postingDate,
    accountingPeriodId: uuid,
    outcome: z
      .object({
        targetReturnId: uuid,
        status: z.literal('cancelled'),
        cancelledAt: instant,
        version: unsigned,
        activeReturnId: uuid.nullable(),
      })
      .strict(),
    reversal: z
      .object({
        customerLedgerEffects: z.array(ledgerReversal),
        moneyMovements: z.array(moneyReversal),
        inventoryMovements: z.array(inventoryReversal),
      })
      .strict(),
    replacement: z.unknown().nullable(),
  })
  .strict();

export function parseStoredSaleReturnCorrectionResponse(
  value: unknown,
): SaleReturnCorrectionResponse {
  const parsed = schema.parse(value);
  const replacement =
    parsed.replacement === null ? null : parseStoredSaleReturnPostingResponse(parsed.replacement);
  if (
    parsed.transactionGroupId !== parsed.operationId ||
    parsed.targetReturnId !== parsed.outcome.targetReturnId ||
    (parsed.intent === 'cancel' && (replacement !== null || parsed.outcome.activeReturnId !== null))
  ) {
    throw new Error('Stored Sale Return correction response is inconsistent.');
  }
  if (parsed.intent === 'replace') {
    if (replacement === null) {
      throw new Error('Stored Sale Return correction response is inconsistent.');
    }
    if (
      replacement.operationId !== parsed.operationId ||
      parsed.outcome.activeReturnId !== replacement.return.id
    ) {
      throw new Error('Stored Sale Return correction response is inconsistent.');
    }
  }
  for (const effect of parsed.reversal.customerLedgerEffects) {
    const discriminator = `sale-return-ledger-reversal:${effect.reversalOfId}`;
    if (
      effect.id !== deriveMoneyFactId(parsed.operationId, discriminator) ||
      effect.operationId !== deriveMoneyFactOperationId(parsed.operationId, discriminator)
    ) {
      throw new Error('Stored Sale Return ledger reversal identity is invalid.');
    }
  }
  for (const movement of parsed.reversal.moneyMovements) {
    const discriminator = `sale-return-money-reversal:${movement.reversalOfId}`;
    if (
      movement.id !== deriveMoneyFactId(parsed.operationId, discriminator) ||
      movement.operationId !== deriveMoneyFactOperationId(parsed.operationId, discriminator) ||
      movement.transactionGroupId !== parsed.operationId
    ) {
      throw new Error('Stored Sale Return Money reversal identity is invalid.');
    }
  }
  for (const movement of parsed.reversal.inventoryMovements) {
    const discriminator = `sale-return-inventory-reversal:${movement.reversalOfId}`;
    if (
      movement.id !== deriveMoneyFactId(parsed.operationId, discriminator) ||
      movement.operationId !== deriveMoneyFactOperationId(parsed.operationId, discriminator)
    ) {
      throw new Error('Stored Sale Return inventory reversal identity is invalid.');
    }
  }
  return { ...parsed, replacement };
}
