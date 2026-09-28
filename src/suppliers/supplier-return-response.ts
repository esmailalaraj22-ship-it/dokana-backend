import { z } from 'zod';

import {
  deriveMoneyFactId,
  deriveMoneyFactOperationId,
  deriveTransactionGroupId,
} from '../money-movements/money-movement-identity';
import type {
  SupplierFinancialCorrectionResponse,
  SupplierFinancialMutationResponse,
  SupplierFinancialPostingResponse,
} from './supplier-return.types';

const uuid = z.uuid();
const integer = z.string().regex(/^-?(?:0|[1-9][0-9]*)$/);
const nonNegative = z.string().regex(/^(?:0|[1-9][0-9]*)$/);
const positive = z.string().regex(/^[1-9][0-9]*$/);
const instant = z.iso.datetime({ offset: true });
const posting = z.object({
  businessDate: z.string(),
  postingDate: z.string(),
  accountingPeriodId: uuid,
  occurredAt: instant,
});
const moneyMovement = z.object({
  id: uuid,
  accountId: uuid,
  accountingPeriodId: uuid,
  movementType: z.string(),
  amountDeltaMinor: integer,
  transactionGroupId: uuid,
  operationId: uuid,
  occurredAt: instant,
  createdAt: instant,
});

const returnResponse = z.object({
  family: z.literal('supplier_return'),
  operationId: uuid,
  transactionGroupId: uuid,
  supplierId: uuid,
  posting,
  return: z.object({
    id: uuid,
    purchaseInvoiceId: uuid,
    amountMinor: positive,
    payableReductionMinor: nonNegative,
    supplierCreditCreatedMinor: nonNegative,
    reason: z.string().min(1),
    status: z.literal('posted'),
    version: positive,
    createdAt: instant,
  }),
  effects: z.object({
    payableLedgerEntryId: uuid.nullable(),
    supplierCreditLedgerEntryId: uuid.nullable(),
  }),
  inventoryEffectMinor: z.literal('0'),
});

const applicationResponse = z.object({
  family: z.literal('supplier_credit_application'),
  operationId: uuid,
  transactionGroupId: uuid,
  supplierId: uuid,
  posting,
  application: z.object({
    id: uuid,
    purchaseInvoiceId: uuid,
    amountMinor: positive,
    notes: z.string().nullable(),
    supplierCreditBeforeMinor: nonNegative,
    supplierCreditAfterMinor: nonNegative,
    invoiceOutstandingBeforeMinor: nonNegative,
    invoiceOutstandingAfterMinor: nonNegative,
    createdAt: instant,
  }),
});

const refundResponse = z.object({
  family: z.literal('supplier_refund'),
  operationId: uuid,
  transactionGroupId: uuid,
  supplierId: uuid,
  posting,
  refund: z.object({
    id: uuid,
    moneyAccountId: uuid,
    amountMinor: positive,
    notes: z.string().nullable(),
    supplierCreditBeforeMinor: nonNegative,
    supplierCreditAfterMinor: nonNegative,
    moneyMovement,
    createdAt: instant,
  }),
});

const postingResponse = z.discriminatedUnion('family', [
  returnResponse,
  applicationResponse,
  refundResponse,
]);

const correctionResponse = z.object({
  family: z.enum(['supplier_return', 'supplier_credit_application', 'supplier_refund']),
  operationId: uuid,
  targetOperationId: uuid,
  transactionGroupId: uuid,
  intent: z.enum(['cancel', 'replace']),
  correctionReason: z.string().min(1),
  supplierId: uuid,
  posting,
  target: z.object({ id: uuid, status: z.enum(['cancelled', 'reversed']) }),
  reversal: z.object({
    supplierLedgerEntryIds: z.array(uuid),
    moneyMovement: moneyMovement.nullable(),
  }),
  replacement: postingResponse.nullable(),
});

export function parseStoredSupplierFinancialPostingResponse(
  value: unknown,
): SupplierFinancialPostingResponse {
  const response = postingResponse.parse(value) as SupplierFinancialPostingResponse;
  assertPostingIdentity(response);
  return response;
}

export function parseStoredSupplierFinancialCorrectionResponse(
  value: unknown,
): SupplierFinancialCorrectionResponse {
  const response = correctionResponse.parse(value) as SupplierFinancialCorrectionResponse;
  if (response.transactionGroupId !== deriveTransactionGroupId(response.operationId)) {
    throw new Error('Stored Supplier correction transaction identity is invalid.');
  }
  if ((response.intent === 'cancel') !== (response.replacement === null)) {
    throw new Error('Stored Supplier correction replacement state is invalid.');
  }
  if (
    response.target.id !== deriveMoneyFactId(response.targetOperationId, response.family) ||
    response.target.status !== (response.family === 'supplier_return' ? 'cancelled' : 'reversed')
  ) {
    throw new Error('Stored Supplier correction target identity is invalid.');
  }
  if (response.replacement) {
    assertPostingIdentity(response.replacement);
    if (
      response.replacement.family !== response.family ||
      response.replacement.operationId !== response.operationId ||
      response.replacement.supplierId !== response.supplierId
    ) {
      throw new Error('Stored Supplier correction replacement identity is invalid.');
    }
  }
  return response;
}

export function parseStoredSupplierFinancialMutationResponse(
  value: unknown,
): SupplierFinancialMutationResponse {
  const parsedCorrection = correctionResponse.safeParse(value);
  if (parsedCorrection.success) {
    return parseStoredSupplierFinancialCorrectionResponse(parsedCorrection.data);
  }
  return parseStoredSupplierFinancialPostingResponse(value);
}

function assertPostingIdentity(response: SupplierFinancialPostingResponse): void {
  if (response.transactionGroupId !== deriveTransactionGroupId(response.operationId)) {
    throw new Error('Stored Supplier financial transaction identity is invalid.');
  }
  const expectedId = deriveMoneyFactId(response.operationId, response.family);
  const actualId =
    response.family === 'supplier_return'
      ? response.return.id
      : response.family === 'supplier_credit_application'
        ? response.application.id
        : response.refund.id;
  if (actualId !== expectedId) {
    throw new Error('Stored Supplier financial root identity is invalid.');
  }
  if (response.family === 'supplier_refund') {
    const movement = response.refund.moneyMovement;
    if (
      movement.id !== deriveMoneyFactId(response.operationId, 'supplier_refund_money') ||
      movement.operationId !==
        deriveMoneyFactOperationId(response.operationId, 'supplier_refund_money')
    ) {
      throw new Error('Stored Supplier Refund Money identity is invalid.');
    }
  }
}
