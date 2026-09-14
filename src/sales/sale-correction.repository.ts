import { ForbiddenException, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  AccountingPeriodNotPostingEligibleError,
  AccountingPeriodPostingContextService,
} from '../accounting-periods/accounting-period-posting-context.service';
import type { AccountingPeriodPostingContext } from '../accounting-periods/accounting-period-posting-context.types';
import { AccountingPeriodIntegrityError } from '../accounting-periods/accounting-period-provisioning.service';
import { DatabaseService } from '../database/database.service';
import {
  customerLedgerEntries,
  customers,
  inventoryMovements,
  moneyAccounts,
  moneyMovements,
  products,
  productUnits,
  saleItems,
  salePayments,
  sales,
  stockBalances,
  stores,
} from '../database/schema';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { inventoryPostingEffect } from '../inventory/inventory-posting-math';
import { postgresqlErrorCode } from '../money-movements/money-movement-database-error';
import {
  deriveMoneyFactId,
  deriveMoneyFactOperationId,
  deriveTransactionGroupId,
} from '../money-movements/money-movement-identity';
import { MoneyMovementPostingRepository } from '../money-movements/money-movement-posting.repository';
import type { SaleCorrectionCommand } from './sale-correction-command';
import { parseStoredSaleCorrectionResponse } from './sale-correction-response';
import type {
  SaleCorrectionFailure,
  SaleCorrectionFailureCode,
  SaleCorrectionResponse,
  SaleCorrectionResult,
} from './sale-correction.types';
import { SalePostingRejectedError, SalePostingRepository } from './sale-posting.repository';
import { parseStoredSalePostingResponse } from './sale-posting-response';
import type { SalePostingFailureCode } from './sale-posting.types';

type SaleRow = typeof sales.$inferSelect;
type SaleItemRow = typeof saleItems.$inferSelect;
type SalePaymentRow = typeof salePayments.$inferSelect;
type MoneyMovementRow = typeof moneyMovements.$inferSelect;
type InventoryMovementRow = typeof inventoryMovements.$inferSelect;
type CustomerLedgerEntryRow = typeof customerLedgerEntries.$inferSelect;

interface ProcessedOperationRow extends Record<string, unknown> {
  deviceId: string;
  aggregateType: string;
  aggregateId: string;
  action: string;
  requestHash: string;
  status: 'processing' | 'applied' | 'rejected';
  responseCode: number | null;
  responseBody: unknown;
  errorCode: string | null;
}

interface TargetDescriptor {
  saleId: string;
  original: boolean;
}

interface SaleCorrectionTarget {
  sale: SaleRow;
  items: SaleItemRow[];
  payments: SalePaymentRow[];
  moneyMovements: MoneyMovementRow[];
  inventoryMovements: InventoryMovementRow[];
  receivable: CustomerLedgerEntryRow | null;
}

interface FailureResult {
  ok: false;
  error: SaleCorrectionFailure;
}

const correctionFailures: Readonly<
  Record<Exclude<SaleCorrectionFailureCode, SalePostingFailureCode>, SaleCorrectionFailure>
> = {
  SALE_CORRECTION_DEPENDENT_FACTS: {
    code: 'SALE_CORRECTION_DEPENDENT_FACTS',
    message: 'Sale has dependent facts that require a later correction workflow.',
    statusCode: 409,
  },
  SALE_CORRECTION_INVENTORY_STATE_CONFLICT: {
    code: 'SALE_CORRECTION_INVENTORY_STATE_CONFLICT',
    message: 'Sale inventory cost cannot be reversed exactly from the current state.',
    statusCode: 409,
  },
  SALE_CORRECTION_TARGET_INTEGRITY_CONFLICT: {
    code: 'SALE_CORRECTION_TARGET_INTEGRITY_CONFLICT',
    message: 'Sale correction target is inconsistent.',
    statusCode: 409,
  },
  SALE_CORRECTION_TARGET_NOT_ACTIVE: {
    code: 'SALE_CORRECTION_TARGET_NOT_ACTIVE',
    message: 'Sale correction target is not the active Sale.',
    statusCode: 409,
  },
  SALE_CORRECTION_TARGET_NOT_FOUND: {
    code: 'SALE_CORRECTION_TARGET_NOT_FOUND',
    message: 'Sale correction target not found.',
    statusCode: 404,
  },
};

const postingFailures: Readonly<Record<SalePostingFailureCode, SaleCorrectionFailure>> = {
  ACCOUNTING_PERIOD_INTEGRITY_CONFLICT: {
    code: 'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT',
    message: 'Accounting Period identity or boundaries are inconsistent.',
    statusCode: 409,
  },
  ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE: {
    code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE',
    message: 'Accounting Period is not eligible for posting.',
    statusCode: 409,
  },
  CUSTOMER_CREDIT_LIMIT_EXCEEDED: {
    code: 'CUSTOMER_CREDIT_LIMIT_EXCEEDED',
    message: 'Customer credit limit would be exceeded.',
    statusCode: 409,
  },
  CUSTOMER_NOT_FOUND: {
    code: 'CUSTOMER_NOT_FOUND',
    message: 'Customer not found.',
    statusCode: 404,
  },
  CUSTOMER_UNAVAILABLE: {
    code: 'CUSTOMER_UNAVAILABLE',
    message: 'Customer is not available for new Sales.',
    statusCode: 409,
  },
  MONEY_ACCOUNT_NOT_FOUND: {
    code: 'MONEY_ACCOUNT_NOT_FOUND',
    message: 'Money Account not found.',
    statusCode: 404,
  },
  MONEY_ACCOUNT_UNAVAILABLE: {
    code: 'MONEY_ACCOUNT_UNAVAILABLE',
    message: 'Money Account is not available for new posting.',
    statusCode: 409,
  },
  OPERATION_ID_CONFLICT: {
    code: 'OPERATION_ID_CONFLICT',
    message: 'Operation ID was reused with a different request.',
    statusCode: 409,
  },
  OPERATION_IN_PROGRESS: {
    code: 'OPERATION_IN_PROGRESS',
    message: 'The operation is still being processed.',
    statusCode: 409,
  },
  PRODUCT_NOT_FOUND: {
    code: 'PRODUCT_NOT_FOUND',
    message: 'Product not found.',
    statusCode: 404,
  },
  PRODUCT_UNAVAILABLE: {
    code: 'PRODUCT_UNAVAILABLE',
    message: 'Product is not available for new Sales.',
    statusCode: 409,
  },
  PRODUCT_UNIT_NOT_FOUND: {
    code: 'PRODUCT_UNIT_NOT_FOUND',
    message: 'Product Unit not found.',
    statusCode: 404,
  },
  PRODUCT_UNIT_UNAVAILABLE: {
    code: 'PRODUCT_UNIT_UNAVAILABLE',
    message: 'Product Unit is not available for new Sales.',
    statusCode: 409,
  },
  SALE_AMOUNT_INVALID: {
    code: 'SALE_AMOUNT_INVALID',
    message: 'Sale quantity, cost, or amount is not representable.',
    statusCode: 400,
  },
  SALE_NEGATIVE_STOCK_NOT_ALLOWED: {
    code: 'SALE_NEGATIVE_STOCK_NOT_ALLOWED',
    message: 'Negative inventory is not permitted.',
    statusCode: 409,
  },
};

const failureDefinitions: Readonly<Record<SaleCorrectionFailureCode, SaleCorrectionFailure>> = {
  ...postingFailures,
  ...correctionFailures,
};

class SaleCorrectionRejectedError extends Error {
  constructor(readonly error: SaleCorrectionFailure) {
    super(error.message);
    this.name = 'SaleCorrectionRejectedError';
  }
}

function reject(code: SaleCorrectionFailureCode): never {
  throw new SaleCorrectionRejectedError(failureDefinitions[code]);
}

function failure(code: SaleCorrectionFailureCode): FailureResult {
  return { ok: false, error: failureDefinitions[code] };
}

@Injectable()
export class SaleCorrectionRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly postingContext: AccountingPeriodPostingContextService,
    private readonly salePosting: SalePostingRepository,
    private readonly moneyMovementPosting: MoneyMovementPostingRepository,
  ) {}

  correct(
    context: TenantTransactionContext,
    command: SaleCorrectionCommand,
    postingDate: string,
  ): Promise<SaleCorrectionResult> {
    const action = this.action(command);
    return this.database.withTenantTransaction(context, async (transaction) => {
      const prior = await this.readOperation(transaction, context.storeId, command.operationId);
      if (prior) return this.replay(transaction, context, command, action, prior);

      await this.lockActiveStore(transaction, context.storeId);
      const claimed = await this.claimOperation(transaction, context, command, action);
      if (claimed) return claimed;

      try {
        const response = await transaction.transaction((savepoint) =>
          this.applyCorrection(savepoint, context, command, postingDate),
        );
        await this.completeApplied(transaction, context.storeId, command.operationId, response);
        return { ok: true, response };
      } catch (error) {
        const known = this.knownFailure(error);
        if (!known) throw error;
        await this.completeRejected(transaction, context.storeId, command.operationId, known);
        return { ok: false, error: known };
      }
    });
  }

  private async applyCorrection(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SaleCorrectionCommand,
    postingDate: string,
  ): Promise<SaleCorrectionResponse> {
    const targetOperation = await this.lockTargetOperation(
      transaction,
      context.storeId,
      command.targetOperationId,
    );
    const descriptor = this.resolveTarget(targetOperation, command.targetOperationId);
    await this.assertTargetIsActive(transaction, context.storeId, command.targetOperationId);
    const target = await this.loadAndValidateTarget(
      transaction,
      context.storeId,
      command.targetOperationId,
      descriptor,
    );
    const posting = await this.resolvePosting(transaction, context, command, postingDate);
    await this.lockAffectedResources(transaction, context.storeId, target, command);
    await this.assertTargetIsActive(transaction, context.storeId, command.targetOperationId);

    await transaction.execute(
      sql`select set_config('app.audit_reason', ${
        command.kind === 'edit' ? 'Sale edited' : 'Sale cancelled'
      }, true)`,
    );
    await this.insertMoneyReversals(transaction, context, command, posting, target);
    await this.insertReceivableReversal(transaction, context, command, posting, target);
    await this.insertInventoryReversals(transaction, context, command, posting, target);

    if (command.kind === 'cancel') {
      const cancelled = await transaction
        .update(sales)
        .set({ status: 'cancelled', cancelledAt: command.occurredAt })
        .where(
          and(
            eq(sales.storeId, context.storeId),
            eq(sales.id, target.sale.id),
            eq(sales.status, 'posted'),
          ),
        )
        .returning({ version: sales.version });
      const row = cancelled[0];
      if (!row) reject('SALE_CORRECTION_TARGET_NOT_ACTIVE');
      await transaction.execute(
        sql`set constraints ledger.stock_balances_last_movement_fkey immediate`,
      );
      return {
        operationId: command.operationId,
        targetOperationId: command.targetOperationId,
        intent: 'cancel',
        occurredAt: command.occurredAt.toISOString(),
        businessDate: posting.postingDate,
        postingDate: posting.postingDate,
        accountingPeriodId: posting.accountingPeriodId,
        outcome: {
          saleId: target.sale.id,
          status: 'cancelled',
          cancelledAt: command.occurredAt.toISOString(),
          version: row.version.toString(),
        },
        currentSale: null,
      };
    }

    const currentSale = await this.salePosting.insertCorrectionReplacementWithinTransaction(
      transaction,
      context,
      command.replacement,
      posting,
      target.sale.id,
    );
    await transaction.execute(sql`select set_config('app.audit_reason', 'Sale edited', true)`);
    const corrected = await transaction
      .update(sales)
      .set({ status: 'corrected', reversedById: currentSale.sale.id })
      .where(
        and(
          eq(sales.storeId, context.storeId),
          eq(sales.id, target.sale.id),
          eq(sales.status, 'posted'),
        ),
      )
      .returning({ id: sales.id });
    if (!corrected[0]) reject('SALE_CORRECTION_TARGET_NOT_ACTIVE');
    await transaction.execute(
      sql`set constraints ledger.stock_balances_last_movement_fkey immediate`,
    );
    return {
      operationId: command.operationId,
      targetOperationId: command.targetOperationId,
      intent: 'edit',
      occurredAt: command.occurredAt.toISOString(),
      businessDate: posting.postingDate,
      postingDate: posting.postingDate,
      accountingPeriodId: posting.accountingPeriodId,
      outcome: {
        saleId: currentSale.sale.id,
        status: 'posted',
        cancelledAt: null,
        version: currentSale.sale.version,
      },
      currentSale,
    };
  }

  private resolveTarget(
    row: ProcessedOperationRow | undefined,
    targetOperationId: string,
  ): TargetDescriptor {
    if (!row) reject('SALE_CORRECTION_TARGET_NOT_FOUND');
    if (row.status !== 'applied') reject('SALE_CORRECTION_TARGET_NOT_ACTIVE');
    if (row.responseCode !== 201) reject('SALE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    if (row.action === 'sales.post' && row.aggregateType === 'sales') {
      const response = this.parsePostingTarget(row.responseBody);
      const expectedSaleId = deriveMoneyFactId(targetOperationId, 'sale');
      if (
        row.aggregateId !== expectedSaleId ||
        response.operationId !== targetOperationId ||
        response.sale.id !== expectedSaleId
      ) {
        reject('SALE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      return { saleId: expectedSaleId, original: true };
    }
    if (row.action === 'sales.edit' && row.aggregateType === 'sale_corrections') {
      const response = this.parseCorrectionTarget(row.responseBody);
      if (
        row.aggregateId !== targetOperationId ||
        response.intent !== 'edit' ||
        response.operationId !== targetOperationId ||
        response.currentSale.operationId !== targetOperationId ||
        response.outcome.saleId !== response.currentSale.sale.id
      ) {
        reject('SALE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      return { saleId: response.outcome.saleId, original: false };
    }
    if (row.action === 'sales.cancel') reject('SALE_CORRECTION_TARGET_NOT_ACTIVE');
    reject('SALE_CORRECTION_TARGET_NOT_FOUND');
  }

  private parsePostingTarget(value: unknown) {
    try {
      return parseStoredSalePostingResponse(value);
    } catch {
      reject('SALE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
  }

  private parseCorrectionTarget(value: unknown): SaleCorrectionResponse {
    try {
      return parseStoredSaleCorrectionResponse(value);
    } catch {
      reject('SALE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
  }

  private async loadAndValidateTarget(
    transaction: DatabaseTransaction,
    storeId: string,
    targetOperationId: string,
    descriptor: TargetDescriptor,
  ): Promise<SaleCorrectionTarget> {
    const saleRows = await transaction
      .select()
      .from(sales)
      .where(and(eq(sales.storeId, storeId), eq(sales.id, descriptor.saleId)))
      .limit(1)
      .for('update');
    const sale = saleRows[0];
    if (!sale) reject('SALE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    if (
      sale.status !== 'posted' ||
      sale.operationId !== targetOperationId ||
      sale.accountingPeriodId === null ||
      sale.cancelledAt !== null ||
      sale.reversedById !== null ||
      (descriptor.original ? sale.correctionOfId !== null : sale.correctionOfId === null)
    ) {
      reject('SALE_CORRECTION_TARGET_NOT_ACTIVE');
    }
    if (!descriptor.original) {
      const correctionOfId = sale.correctionOfId;
      if (!correctionOfId) reject('SALE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      const predecessor = await transaction
        .select({ status: sales.status, reversedById: sales.reversedById })
        .from(sales)
        .where(and(eq(sales.storeId, storeId), eq(sales.id, correctionOfId)))
        .limit(1);
      if (predecessor[0]?.status !== 'corrected' || predecessor[0].reversedById !== sale.id) {
        reject('SALE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
    }

    const items = await transaction
      .select()
      .from(saleItems)
      .where(and(eq(saleItems.storeId, storeId), eq(saleItems.saleId, sale.id)));
    const payments = await transaction
      .select()
      .from(salePayments)
      .where(and(eq(salePayments.storeId, storeId), eq(salePayments.saleId, sale.id)));
    const customerEntries = await transaction
      .select()
      .from(customerLedgerEntries)
      .where(
        and(
          eq(customerLedgerEntries.storeId, storeId),
          eq(customerLedgerEntries.sourceSaleId, sale.id),
        ),
      );
    const inventoryFacts = await transaction
      .select()
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.storeId, storeId),
          eq(inventoryMovements.referenceType, 'sale'),
          eq(inventoryMovements.referenceId, sale.id),
        ),
      );
    const movementIds = payments.flatMap((payment) =>
      payment.moneyMovementId ? [payment.moneyMovementId] : [],
    );
    const moneyFacts =
      movementIds.length === 0
        ? []
        : await transaction
            .select()
            .from(moneyMovements)
            .where(
              and(eq(moneyMovements.storeId, storeId), inArray(moneyMovements.id, movementIds)),
            );

    this.validateSaleFacts(sale, items, payments);
    this.validateMoneyFacts(sale, payments, moneyFacts);
    this.validateInventoryFacts(sale, items, inventoryFacts);
    const receivable = this.validateReceivableFacts(sale, customerEntries);
    await this.assertNoDependentFacts(transaction, storeId, sale.id, customerEntries, receivable);
    await this.assertNoPriorReversals(transaction, storeId, moneyFacts, inventoryFacts, receivable);
    return {
      sale,
      items,
      payments,
      moneyMovements: moneyFacts,
      inventoryMovements: inventoryFacts,
      receivable,
    };
  }

  private validateSaleFacts(sale: SaleRow, items: SaleItemRow[], payments: SalePaymentRow[]): void {
    if (items.length === 0) reject('SALE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    const subtotal = items.reduce((sum, item) => sum + item.lineGrossMinor, 0n);
    const lineDiscounts = items.reduce((sum, item) => sum + item.lineDiscountMinor, 0n);
    const lineTotals = items.reduce((sum, item) => sum + item.lineTotalMinor, 0n);
    const paid = payments.reduce((sum, payment) => sum + payment.amountMinor, 0n);
    const knownCost = items.reduce(
      (sum, item) => sum + (item.costStatus === 'known' ? (item.lineCostMinor ?? 0n) : 0n),
      0n,
    );
    if (
      subtotal !== sale.itemsSubtotalMinor ||
      lineDiscounts !== sale.lineDiscountTotalMinor ||
      lineTotals - sale.invoiceDiscountMinor + sale.roundingMinor !== sale.totalMinor ||
      paid !== sale.paidTotalMinor ||
      sale.paidTotalMinor + sale.creditTotalMinor !== sale.totalMinor ||
      knownCost !== sale.knownCostTotalMinor ||
      items.filter((item) => item.costStatus === 'pending').length !== sale.pendingCostLineCount ||
      items.filter((item) => item.costStatus === 'unknown').length !== sale.unknownCostLineCount
    ) {
      reject('SALE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
  }

  private validateMoneyFacts(
    sale: SaleRow,
    payments: SalePaymentRow[],
    movements: MoneyMovementRow[],
  ): void {
    const byId = new Map(movements.map((movement) => [movement.id, movement]));
    for (const payment of payments) {
      const movement = payment.moneyMovementId ? byId.get(payment.moneyMovementId) : undefined;
      if (
        movement?.accountId !== payment.moneyAccountId ||
        movement.accountingPeriodId !== sale.accountingPeriodId ||
        movement.movementType !== 'sale_payment' ||
        movement.amountDeltaMinor !== payment.amountMinor ||
        movement.referenceType !== 'sale_payment' ||
        movement.referenceId !== payment.id ||
        movement.operationId !==
          deriveMoneyFactOperationId(
            sale.operationId,
            `sale-payment-money:${payment.moneyAccountId}`,
          ) ||
        movement.transactionGroupId !== deriveTransactionGroupId(sale.operationId) ||
        movement.reversalOfId !== null
      ) {
        reject('SALE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
    }
    if (byId.size !== payments.length) reject('SALE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
  }

  private validateInventoryFacts(
    sale: SaleRow,
    items: SaleItemRow[],
    movements: InventoryMovementRow[],
  ): void {
    const byId = new Map(movements.map((movement) => [movement.id, movement]));
    for (const item of items) {
      if (item.inventoryMovementId === null) {
        if (
          item.costStatus !== 'unknown' ||
          item.unitCostMinor !== null ||
          item.lineCostMinor !== null
        ) {
          reject('SALE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
        }
        continue;
      }
      const movement = byId.get(item.inventoryMovementId);
      if (
        !movement ||
        item.isManualLine ||
        item.productId === null ||
        item.productUnitId === null ||
        item.baseQuantityMilli === null ||
        movement.productId !== item.productId ||
        movement.productUnitId !== item.productUnitId ||
        movement.accountingPeriodId !== sale.accountingPeriodId ||
        movement.movementType !== 'sale' ||
        movement.quantityDeltaMilli !== -item.baseQuantityMilli ||
        movement.selectedQuantityMilli !== item.quantityMilli ||
        movement.factorNum !== item.conversionFactorNum ||
        movement.factorDen !== item.conversionFactorDen ||
        movement.referenceType !== 'sale' ||
        movement.referenceId !== sale.id ||
        movement.transactionGroupId !== deriveTransactionGroupId(sale.operationId) ||
        movement.reversalOfId !== null ||
        movement.costStatus !== item.costStatus ||
        (item.costStatus === 'known' &&
          (item.lineCostMinor === null || movement.valueDeltaMinor !== -item.lineCostMinor)) ||
        (item.costStatus === 'unknown' &&
          (item.lineCostMinor !== null || item.unitCostMinor !== null))
      ) {
        reject('SALE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
    }
    if (byId.size !== items.filter((item) => item.inventoryMovementId !== null).length) {
      reject('SALE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
  }

  private validateReceivableFacts(
    sale: SaleRow,
    entries: CustomerLedgerEntryRow[],
  ): CustomerLedgerEntryRow | null {
    const origins = entries.filter(
      (entry) => entry.entryType === 'sale_credit' && entry.reversalOfId === null,
    );
    if (sale.creditTotalMinor === 0n) {
      if (origins.length !== 0) reject('SALE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      return null;
    }
    const origin = origins[0];
    if (
      origins.length !== 1 ||
      !origin ||
      sale.customerId === null ||
      origin.customerId !== sale.customerId ||
      origin.accountingPeriodId !== sale.accountingPeriodId ||
      origin.receivableDeltaMinor !== sale.creditTotalMinor ||
      origin.creditDeltaMinor !== 0n ||
      origin.referenceType !== 'sale' ||
      origin.referenceId !== sale.id ||
      origin.transactionGroupId !== deriveTransactionGroupId(sale.operationId)
    ) {
      reject('SALE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    return origin;
  }

  private async assertNoDependentFacts(
    transaction: DatabaseTransaction,
    storeId: string,
    saleId: string,
    customerEntries: CustomerLedgerEntryRow[],
    receivable: CustomerLedgerEntryRow | null,
  ): Promise<void> {
    if (customerEntries.some((entry) => entry.id !== receivable?.id)) {
      reject('SALE_CORRECTION_DEPENDENT_FACTS');
    }
    const result = await transaction.execute<{ dependent: boolean }>(sql`
      select exists(
        select 1 from ledger.customer_payment_allocations
        where store_id=${storeId}::uuid and sale_id=${saleId}::uuid
        union all
        select 1 from ledger.sale_returns
        where store_id=${storeId}::uuid and sale_id=${saleId}::uuid
      ) as dependent
    `);
    if (result.rows[0]?.dependent) reject('SALE_CORRECTION_DEPENDENT_FACTS');
  }

  private async assertNoPriorReversals(
    transaction: DatabaseTransaction,
    storeId: string,
    moneyFacts: MoneyMovementRow[],
    inventoryFacts: InventoryMovementRow[],
    receivable: CustomerLedgerEntryRow | null,
  ): Promise<void> {
    const moneyIds = moneyFacts.map((fact) => fact.id);
    const inventoryIds = inventoryFacts.map((fact) => fact.id);
    const priorMoney =
      moneyIds.length === 0
        ? []
        : await transaction
            .select({ id: moneyMovements.id })
            .from(moneyMovements)
            .where(
              and(
                eq(moneyMovements.storeId, storeId),
                inArray(moneyMovements.reversalOfId, moneyIds),
              ),
            )
            .limit(1);
    const priorInventory =
      inventoryIds.length === 0
        ? []
        : await transaction
            .select({ id: inventoryMovements.id })
            .from(inventoryMovements)
            .where(
              and(
                eq(inventoryMovements.storeId, storeId),
                inArray(inventoryMovements.reversalOfId, inventoryIds),
              ),
            )
            .limit(1);
    const priorReceivable = receivable
      ? await transaction
          .select({ id: customerLedgerEntries.id })
          .from(customerLedgerEntries)
          .where(
            and(
              eq(customerLedgerEntries.storeId, storeId),
              eq(customerLedgerEntries.reversalOfId, receivable.id),
            ),
          )
          .limit(1)
      : [];
    if (priorMoney.length || priorInventory.length || priorReceivable.length) {
      reject('SALE_CORRECTION_TARGET_NOT_ACTIVE');
    }
  }

  private async lockAffectedResources(
    transaction: DatabaseTransaction,
    storeId: string,
    target: SaleCorrectionTarget,
    command: SaleCorrectionCommand,
  ): Promise<void> {
    const replacementItems = command.kind === 'edit' ? command.replacement.items : [];
    const customerIds = new Set<string>();
    if (target.sale.customerId) customerIds.add(target.sale.customerId);
    if (command.kind === 'edit' && command.replacement.customerId) {
      customerIds.add(command.replacement.customerId);
    }
    for (const id of [...customerIds].sort()) {
      await transaction
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.storeId, storeId), eq(customers.id, id)))
        .limit(1)
        .for('update');
    }

    const productIds = new Set(
      target.items.flatMap((item) => (item.productId ? [item.productId] : [])),
    );
    for (const item of replacementItems) if (!item.isManualLine) productIds.add(item.productId);
    for (const id of [...productIds].sort()) {
      await transaction
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.storeId, storeId), eq(products.id, id)))
        .limit(1)
        .for('update');
    }

    const unitPairs = new Map<string, { productId: string; unitId: string }>();
    for (const item of target.items) {
      if (item.productId && item.productUnitId) {
        unitPairs.set(`${item.productId}:${item.productUnitId}`, {
          productId: item.productId,
          unitId: item.productUnitId,
        });
      }
    }
    for (const item of replacementItems) {
      if (!item.isManualLine) {
        unitPairs.set(`${item.productId}:${item.productUnitId}`, {
          productId: item.productId,
          unitId: item.productUnitId,
        });
      }
    }
    for (const pair of [...unitPairs.values()].sort((left, right) =>
      `${left.productId}:${left.unitId}`.localeCompare(`${right.productId}:${right.unitId}`),
    )) {
      await transaction
        .select({ id: productUnits.id })
        .from(productUnits)
        .where(
          and(
            eq(productUnits.storeId, storeId),
            eq(productUnits.productId, pair.productId),
            eq(productUnits.id, pair.unitId),
          ),
        )
        .limit(1)
        .for('share');
    }

    const accountIds = new Set(target.payments.map((payment) => payment.moneyAccountId));
    if (command.kind === 'edit') {
      for (const payment of command.replacement.payments) accountIds.add(payment.moneyAccountId);
    }
    for (const id of [...accountIds].sort()) {
      await transaction
        .select({ id: moneyAccounts.id })
        .from(moneyAccounts)
        .where(and(eq(moneyAccounts.storeId, storeId), eq(moneyAccounts.id, id)))
        .limit(1)
        .for('update');
    }
  }

  private async insertMoneyReversals(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SaleCorrectionCommand,
    posting: AccountingPeriodPostingContext,
    target: SaleCorrectionTarget,
  ): Promise<void> {
    for (const movement of [...target.moneyMovements].sort((left, right) =>
      left.accountId === right.accountId
        ? left.id.localeCompare(right.id)
        : left.accountId.localeCompare(right.accountId),
    )) {
      await this.moneyMovementPosting.insertMovementWithinTransaction(transaction, context, {
        commandOperationId: command.operationId,
        discriminator: `sale-money-reversal:${movement.id}`,
        accountId: movement.accountId,
        amountDeltaMinor: -movement.amountDeltaMinor,
        movementType: 'correction',
        referenceType: 'sale_correction',
        referenceId: target.sale.id,
        accountingPeriodId: posting.accountingPeriodId,
        occurredAt: command.occurredAt,
        transactionGroupId: deriveTransactionGroupId(command.operationId),
        notes: `Sale ${command.kind}`,
        reversalOfId: movement.id,
      });
    }
  }

  private async insertReceivableReversal(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SaleCorrectionCommand,
    posting: AccountingPeriodPostingContext,
    target: SaleCorrectionTarget,
  ): Promise<void> {
    const receivable = target.receivable;
    if (!receivable) return;
    await transaction.insert(customerLedgerEntries).values({
      id: deriveMoneyFactId(command.operationId, 'sale-receivable-reversal'),
      storeId: context.storeId,
      customerId: receivable.customerId,
      accountingPeriodId: posting.accountingPeriodId,
      entryType: 'correction',
      receivableDeltaMinor: -receivable.receivableDeltaMinor,
      creditDeltaMinor: -receivable.creditDeltaMinor,
      sourceSaleId: target.sale.id,
      referenceType: 'sale_correction',
      referenceId: target.sale.id,
      transactionGroupId: deriveTransactionGroupId(command.operationId),
      occurredAt: command.occurredAt,
      reversalOfId: receivable.id,
      reason: `Sale ${command.kind}`,
      deviceId: context.deviceId,
      operationId: deriveMoneyFactOperationId(command.operationId, 'sale-receivable-reversal'),
    });
  }

  private async insertInventoryReversals(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SaleCorrectionCommand,
    posting: AccountingPeriodPostingContext,
    target: SaleCorrectionTarget,
  ): Promise<void> {
    const ordered = [...target.inventoryMovements].sort((left, right) => {
      if (left.productId !== right.productId) return left.productId.localeCompare(right.productId);
      const time = right.createdAt.getTime() - left.createdAt.getTime();
      return time !== 0 ? time : right.id.localeCompare(left.id);
    });
    for (const movement of ordered) {
      const balanceRows = await transaction
        .select()
        .from(stockBalances)
        .where(
          and(
            eq(stockBalances.storeId, context.storeId),
            eq(stockBalances.productId, movement.productId),
          ),
        )
        .limit(1);
      const before = balanceRows[0];
      if (!before) reject('SALE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      let effect: ReturnType<typeof inventoryPostingEffect>;
      try {
        effect = inventoryPostingEffect(
          {
            quantityMilli: before.quantityMilli,
            inventoryValueMinor: before.inventoryValueMinor,
            costState: before.costState,
          },
          -movement.quantityDeltaMilli,
          movement.costStatus === 'known' ? -movement.valueDeltaMinor : null,
        );
      } catch (error) {
        if (error instanceof RangeError) reject('SALE_CORRECTION_INVENTORY_STATE_CONFLICT');
        throw error;
      }
      if (effect.valueDeltaMinor !== -movement.valueDeltaMinor) {
        reject('SALE_CORRECTION_INVENTORY_STATE_CONFLICT');
      }
      await transaction.insert(inventoryMovements).values({
        id: deriveMoneyFactId(command.operationId, `sale-inventory-reversal:${movement.id}`),
        storeId: context.storeId,
        productId: movement.productId,
        productUnitId: movement.productUnitId,
        accountingPeriodId: posting.accountingPeriodId,
        movementType: 'correction',
        quantityBeforeMilli: before.quantityMilli,
        quantityDeltaMilli: -movement.quantityDeltaMilli,
        quantityAfterMilli: effect.quantityAfterMilli,
        inventoryValueBeforeMinor: before.inventoryValueMinor,
        valueDeltaMinor: effect.valueDeltaMinor,
        inventoryValueAfterMinor: effect.inventoryValueAfterMinor,
        averageUnitCostAfterMinor: effect.averageUnitCostAfterMinor,
        costStatus: movement.costStatus,
        hasPendingCostAfter: effect.hasPendingCostAfter,
        referenceType: 'sale_correction',
        referenceId: target.sale.id,
        transactionGroupId: deriveTransactionGroupId(command.operationId),
        occurredAt: command.occurredAt,
        reversalOfId: movement.id,
        reason: `Sale ${command.kind}`,
        deviceId: context.deviceId,
        operationId: deriveMoneyFactOperationId(
          command.operationId,
          `sale-inventory-reversal:${movement.id}`,
        ),
        selectedQuantityMilli: movement.selectedQuantityMilli,
        factorNum: movement.factorNum,
        factorDen: movement.factorDen,
        businessDate: posting.postingDate,
        postingDate: posting.postingDate,
        costStateBefore: before.costState,
        costStateAfter: effect.costStateAfter,
      });
    }
  }

  private action(command: SaleCorrectionCommand): 'sales.cancel' | 'sales.edit' {
    return command.kind === 'cancel' ? 'sales.cancel' : 'sales.edit';
  }

  private async assertTargetIsActive(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
  ): Promise<void> {
    const result = await transaction.execute<{ superseded: boolean }>(sql`
      select exists(
        select 1 from sync.processed_operations
        where store_id=${storeId}::uuid and status='applied'
          and action in ('sales.cancel', 'sales.edit')
          and response_body ->> 'targetOperationId'=${operationId}
      ) as superseded
    `);
    if (result.rows[0]?.superseded) reject('SALE_CORRECTION_TARGET_NOT_ACTIVE');
  }

  private async resolvePosting(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SaleCorrectionCommand,
    postingDate: string,
  ): Promise<AccountingPeriodPostingContext> {
    try {
      return await this.postingContext.resolveForWrite(transaction, context, {
        operationId: command.operationId,
        postingDate,
      });
    } catch (error) {
      if (error instanceof AccountingPeriodNotPostingEligibleError) {
        reject('ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE');
      }
      if (error instanceof AccountingPeriodIntegrityError) {
        reject('ACCOUNTING_PERIOD_INTEGRITY_CONFLICT');
      }
      throw error;
    }
  }

  private async lockActiveStore(transaction: DatabaseTransaction, storeId: string): Promise<void> {
    const rows = await transaction
      .select({ status: stores.status })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1)
      .for('share');
    if (rows[0]?.status !== 'active') {
      throw new ForbiddenException({
        code: 'BUSINESS_WRITE_NOT_ALLOWED',
        message: 'Business writes are not allowed.',
      });
    }
  }

  private async claimOperation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SaleCorrectionCommand,
    action: string,
  ): Promise<SaleCorrectionResult | null> {
    let claimed: boolean;
    try {
      const result = await transaction.transaction((savepoint) =>
        savepoint.execute<{ claimed: boolean }>(sql`
          select sync.claim_operation(
            ${context.storeId}::uuid, ${command.operationId}::uuid,
            ${context.deviceId}::uuid, 'sale_corrections', ${command.operationId}::uuid,
            ${action}, ${command.requestHash}) as claimed
        `),
      );
      claimed = result.rows[0]?.claimed === true;
    } catch (error) {
      if (postgresqlErrorCode(error) !== '23505') throw error;
      const concurrent = await this.readOperation(
        transaction,
        context.storeId,
        command.operationId,
      );
      if (!concurrent) throw error;
      return this.replay(transaction, context, command, action, concurrent);
    }
    if (claimed) return null;
    const existing = await this.readOperation(transaction, context.storeId, command.operationId);
    if (!existing) throw new Error('Claimed Sale correction operation could not be read.');
    return this.replay(transaction, context, command, action, existing);
  }

  private async lockTargetOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
  ): Promise<ProcessedOperationRow | undefined> {
    return (
      await transaction.execute<ProcessedOperationRow>(sql`
        select device_id as "deviceId", aggregate_type as "aggregateType",
          aggregate_id as "aggregateId", action, request_hash as "requestHash", status,
          response_code as "responseCode", response_body as "responseBody",
          error_code as "errorCode"
        from sync.processed_operations
        where store_id=${storeId}::uuid and operation_id=${operationId}::uuid
        for update
      `)
    ).rows[0];
  }

  private async readOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
  ): Promise<ProcessedOperationRow | undefined> {
    return (
      await transaction.execute<ProcessedOperationRow>(sql`
        select device_id as "deviceId", aggregate_type as "aggregateType",
          aggregate_id as "aggregateId", action, request_hash as "requestHash", status,
          response_code as "responseCode", response_body as "responseBody",
          error_code as "errorCode"
        from sync.processed_operations
        where store_id=${storeId}::uuid and operation_id=${operationId}::uuid
      `)
    ).rows[0];
  }

  private async replay(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SaleCorrectionCommand,
    action: string,
    row: ProcessedOperationRow,
  ): Promise<SaleCorrectionResult> {
    if (
      row.deviceId !== context.deviceId ||
      row.aggregateType !== 'sale_corrections' ||
      row.aggregateId !== command.operationId ||
      row.action !== action ||
      row.requestHash !== command.requestHash
    ) {
      await transaction.execute(sql`
        insert into sync.conflicts(
          store_id, operation_id, entity_type, entity_id, conflict_type, client_payload)
        values(
          ${context.storeId}::uuid, ${command.operationId}::uuid,
          'sale_corrections', ${command.operationId}::uuid, 'duplicate_identity',
          jsonb_build_object('action', ${action}::text, 'requestHash', ${command.requestHash}::text))
      `);
      return failure('OPERATION_ID_CONFLICT');
    }
    if (row.status === 'applied') {
      if (row.responseCode !== 201) throw new Error('Invalid Sale correction replay status.');
      return { ok: true, response: parseStoredSaleCorrectionResponse(row.responseBody) };
    }
    if (row.status === 'rejected') {
      const code = row.errorCode;
      if (
        !code ||
        !Object.hasOwn(failureDefinitions, code) ||
        row.responseCode !== failureDefinitions[code as SaleCorrectionFailureCode].statusCode
      ) {
        throw new Error('Invalid Sale correction rejection status.');
      }
      return failure(code as SaleCorrectionFailureCode);
    }
    return failure('OPERATION_IN_PROGRESS');
  }

  private knownFailure(error: unknown): SaleCorrectionFailure | undefined {
    if (error instanceof SaleCorrectionRejectedError) return error.error;
    if (error instanceof SalePostingRejectedError) {
      return postingFailures[error.result.error.code];
    }
    if (error instanceof AccountingPeriodNotPostingEligibleError) {
      return postingFailures.ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE;
    }
    if (error instanceof AccountingPeriodIntegrityError) {
      return postingFailures.ACCOUNTING_PERIOD_INTEGRITY_CONFLICT;
    }
    return undefined;
  }

  private async completeApplied(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    response: SaleCorrectionResponse,
  ): Promise<void> {
    const completed = await transaction.execute(sql`
      update sync.processed_operations
      set status='applied', response_code=201,
        response_body=${JSON.stringify(response)}::jsonb, error_code=null,
        completed_at=clock_timestamp()
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid
        and status='processing'
      returning operation_id
    `);
    if (completed.rows.length !== 1) throw new Error('Sale correction completion failed.');
  }

  private async completeRejected(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    error: SaleCorrectionFailure,
  ): Promise<void> {
    const completed = await transaction.execute(sql`
      update sync.processed_operations
      set status='rejected', response_code=${error.statusCode},
        response_body=${JSON.stringify({ code: error.code, message: error.message })}::jsonb,
        error_code=${error.code}, completed_at=clock_timestamp()
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid
        and status='processing'
      returning operation_id
    `);
    if (completed.rows.length !== 1) throw new Error('Sale correction rejection failed.');
  }
}
