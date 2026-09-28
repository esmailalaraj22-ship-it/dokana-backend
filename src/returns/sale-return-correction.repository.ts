import { ForbiddenException, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

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
  saleReturnItems,
  saleReturnSettlements,
  saleReturns,
  sales,
  stores,
} from '../database/schema';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import {
  InventoryPostingRepository,
  SaleReturnInventoryError,
  SaleReturnInventoryReversalError,
} from '../inventory/inventory-posting.repository';
import { postgresqlErrorCode } from '../money-movements/money-movement-database-error';
import { deriveTransactionGroupId } from '../money-movements/money-movement-identity';
import { MoneyMovementPostingRepository } from '../money-movements/money-movement-posting.repository';
import type { PostedMoneyMovement } from '../money-movements/money-movement.types';
import {
  CustomerCreditRepository,
  CustomerReturnCreditDependencyError,
} from '../sales/customer-credit.repository';
import type { SaleReturnCorrectionCommand } from './sale-return-correction-command';
import {
  assertNonExpansiveReplacementLines,
  assertNonExpansiveReplacementTotal,
  SaleReturnCorrectionScopeError,
} from './sale-return-correction-policy';
import { parseStoredSaleReturnCorrectionResponse } from './sale-return-correction-response';
import type {
  SaleReturnCorrectionFailure,
  SaleReturnCorrectionFailureCode,
  SaleReturnCorrectionResponse,
  SaleReturnCorrectionResult,
  SaleReturnMoneyReversalResponse,
} from './sale-return-correction.types';
import {
  saleReturnPostingFailureDefinitions,
  SaleReturnPostingRepository,
} from './sale-return-posting.repository';
import { parseStoredSaleReturnPostingResponse } from './sale-return-posting-response';
import type { SaleReturnPostingResponse } from './sale-return-posting.types';
import { CUSTOMER_RETURN_WINDOW_MS, SaleReturnAuthorityError } from './sale-return.types';

type SaleReturnRow = typeof saleReturns.$inferSelect;
type SaleReturnItemRow = typeof saleReturnItems.$inferSelect;
type SaleReturnSettlementRow = typeof saleReturnSettlements.$inferSelect;
type CustomerLedgerEntryRow = typeof customerLedgerEntries.$inferSelect;
type MoneyMovementRow = typeof moneyMovements.$inferSelect;
type InventoryMovementRow = typeof inventoryMovements.$inferSelect;

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

interface SaleIdentity {
  id: string;
  customerId: string | null;
  saleAt: Date;
  status: 'draft' | 'posted' | 'corrected' | 'cancelled';
  reversedById: string | null;
}

interface SaleReturnCorrectionTarget {
  root: SaleReturnRow;
  sale: SaleIdentity;
  snapshot: SaleReturnPostingResponse;
  items: SaleReturnItemRow[];
  settlements: SaleReturnSettlementRow[];
  ledgerEffects: CustomerLedgerEntryRow[];
  moneyEffects: MoneyMovementRow[];
  inventoryEffects: InventoryMovementRow[];
}

const correctionFailureDefinitions: Readonly<
  Record<
    Exclude<SaleReturnCorrectionFailureCode, keyof typeof saleReturnPostingFailureDefinitions>,
    SaleReturnCorrectionFailure
  >
> = {
  SALE_RETURN_CORRECTION_CREDIT_DEPENDENCY: definition(
    'SALE_RETURN_CORRECTION_CREDIT_DEPENDENCY',
    'Available Customer Credit is insufficient to reverse this Return.',
    409,
  ),
  SALE_RETURN_CORRECTION_INVENTORY_STATE_CONFLICT: definition(
    'SALE_RETURN_CORRECTION_INVENTORY_STATE_CONFLICT',
    'The historical Return inventory effect cannot be reversed from the current state.',
    409,
  ),
  SALE_RETURN_CORRECTION_NEGATIVE_STOCK_NOT_ALLOWED: definition(
    'SALE_RETURN_CORRECTION_NEGATIVE_STOCK_NOT_ALLOWED',
    'The Return correction would violate the current negative-stock policy.',
    409,
  ),
  SALE_RETURN_CORRECTION_SCOPE_EXPANDED: definition(
    'SALE_RETURN_CORRECTION_SCOPE_EXPANDED',
    'An expired Return replacement cannot expand the active merchandise scope.',
    409,
  ),
  SALE_RETURN_CORRECTION_TARGET_INTEGRITY_CONFLICT: definition(
    'SALE_RETURN_CORRECTION_TARGET_INTEGRITY_CONFLICT',
    'Sale Return correction target is inconsistent.',
    409,
  ),
  SALE_RETURN_CORRECTION_TARGET_NOT_ACTIVE: definition(
    'SALE_RETURN_CORRECTION_TARGET_NOT_ACTIVE',
    'Sale Return correction target is not the active Return leaf.',
    409,
  ),
  SALE_RETURN_CORRECTION_TARGET_NOT_FOUND: definition(
    'SALE_RETURN_CORRECTION_TARGET_NOT_FOUND',
    'Sale Return correction target not found.',
    404,
  ),
};

const failureDefinitions: Readonly<
  Record<SaleReturnCorrectionFailureCode, SaleReturnCorrectionFailure>
> = { ...saleReturnPostingFailureDefinitions, ...correctionFailureDefinitions };

class SaleReturnCorrectionRejectedError extends Error {
  constructor(readonly error: SaleReturnCorrectionFailure) {
    super(error.message);
    this.name = 'SaleReturnCorrectionRejectedError';
  }
}

function definition(
  code: SaleReturnCorrectionFailureCode,
  message: string,
  statusCode: 400 | 404 | 409,
): SaleReturnCorrectionFailure {
  return { code, message, statusCode };
}

function reject(code: SaleReturnCorrectionFailureCode): never {
  throw new SaleReturnCorrectionRejectedError(failureDefinitions[code]);
}

@Injectable()
export class SaleReturnCorrectionRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly postingContext: AccountingPeriodPostingContextService,
    private readonly returnPosting: SaleReturnPostingRepository,
    private readonly customerCredit: CustomerCreditRepository,
    private readonly moneyPosting: MoneyMovementPostingRepository,
    private readonly inventoryPosting: InventoryPostingRepository,
  ) {}

  correct(
    context: TenantTransactionContext,
    command: SaleReturnCorrectionCommand,
    postingDate: string,
  ): Promise<SaleReturnCorrectionResult> {
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
    command: SaleReturnCorrectionCommand,
    postingDate: string,
  ): Promise<SaleReturnCorrectionResponse> {
    const target = await this.loadAndLockTarget(
      transaction,
      context.storeId,
      command.targetReturnId,
    );
    const posting = await this.resolvePosting(transaction, context, command, postingDate);
    const acceptedAt = await this.transactionTime(transaction);
    const expired = acceptedAt.getTime() > target.sale.saleAt.getTime() + CUSTOMER_RETURN_WINDOW_MS;
    if (command.kind === 'replace' && expired) {
      assertNonExpansiveReplacementLines(target.items, command.replacement.lines);
    }

    await transaction.execute(
      sql`select set_config('app.audit_reason', ${command.correctionReason}::text, true)`,
    );
    const customerLedgerEffects = target.root.customerId
      ? await this.customerCredit.insertReturnLedgerReversalsWithinTransaction(
          transaction,
          context,
          {
            commandOperationId: command.operationId,
            returnId: target.root.id,
            saleId: target.sale.id,
            customerId: target.root.customerId,
            accountingPeriodId: posting.accountingPeriodId,
            transactionGroupId: deriveTransactionGroupId(command.operationId),
            occurredAt: command.occurredAt,
            reason: command.correctionReason,
            effects: target.ledgerEffects.map((effect) => ({
              id: effect.id,
              receivableDeltaMinor: effect.receivableDeltaMinor,
              creditDeltaMinor: effect.creditDeltaMinor,
            })),
          },
        )
      : [];
    const inventoryEffects =
      await this.inventoryPosting.insertCustomerReturnRestockReversalsWithinTransaction(
        transaction,
        context,
        {
          operationId: command.operationId,
          returnId: target.root.id,
          occurredAt: command.occurredAt,
          reason: command.correctionReason,
          posting,
          movementIds: target.inventoryEffects.map((movement) => movement.id),
        },
      );
    const moneyEffects = await this.insertMoneyReversals(
      transaction,
      context,
      command,
      posting,
      target,
    );

    const cancelledRows = await transaction
      .update(saleReturns)
      .set({ status: 'cancelled', cancelledAt: command.occurredAt })
      .where(
        and(
          eq(saleReturns.storeId, context.storeId),
          eq(saleReturns.id, target.root.id),
          eq(saleReturns.status, 'posted'),
        ),
      )
      .returning({ version: saleReturns.version });
    const cancelled = cancelledRows[0];
    if (!cancelled) reject('SALE_RETURN_CORRECTION_TARGET_NOT_ACTIVE');

    let replacement: SaleReturnPostingResponse | null = null;
    if (command.kind === 'replace') {
      replacement = await this.returnPosting.insertCorrectionReplacementWithinTransaction(
        transaction,
        context,
        {
          operationId: command.operationId,
          saleId: target.sale.id,
          occurredAt: command.occurredAt,
          reason: command.replacement.reason,
          lines: command.replacement.lines,
          residualSettlement: command.replacement.residualSettlement,
          requestHash: command.requestHash,
        },
        posting,
      );
      if (expired) {
        assertNonExpansiveReplacementTotal(
          target.root.totalMinor,
          BigInt(replacement.return.totalMinor),
        );
      }
    }

    return {
      operationId: command.operationId,
      transactionGroupId: deriveTransactionGroupId(command.operationId),
      targetReturnId: target.root.id,
      intent: command.kind,
      correctionReason: command.correctionReason,
      occurredAt: command.occurredAt.toISOString(),
      businessDate: posting.postingDate,
      postingDate: posting.postingDate,
      accountingPeriodId: posting.accountingPeriodId,
      outcome: {
        targetReturnId: target.root.id,
        status: 'cancelled',
        cancelledAt: command.occurredAt.toISOString(),
        version: cancelled.version.toString(),
        activeReturnId: replacement?.return.id ?? null,
      },
      reversal: {
        customerLedgerEffects,
        moneyMovements: moneyEffects,
        inventoryMovements: inventoryEffects,
      },
      replacement,
    };
  }

  private async loadAndLockTarget(
    transaction: DatabaseTransaction,
    storeId: string,
    returnId: string,
  ): Promise<SaleReturnCorrectionTarget> {
    const identityRows = await transaction
      .select({ saleId: saleReturns.saleId, customerId: saleReturns.customerId })
      .from(saleReturns)
      .where(and(eq(saleReturns.storeId, storeId), eq(saleReturns.id, returnId)))
      .limit(1);
    const identity = identityRows[0];
    if (!identity) reject('SALE_RETURN_CORRECTION_TARGET_NOT_FOUND');
    if (identity.customerId) {
      const customerRows = await transaction
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.storeId, storeId), eq(customers.id, identity.customerId)))
        .limit(1)
        .for('update');
      if (!customerRows[0]) reject('SALE_RETURN_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    const saleRows = await transaction
      .select({
        id: sales.id,
        customerId: sales.customerId,
        saleAt: sales.saleAt,
        status: sales.status,
        reversedById: sales.reversedById,
      })
      .from(sales)
      .where(and(eq(sales.storeId, storeId), eq(sales.id, identity.saleId)))
      .limit(1)
      .for('update');
    const sale = saleRows[0];
    if (!sale) reject('SALE_RETURN_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    if (sale.status !== 'posted' || sale.reversedById !== null) {
      reject('SALE_RETURN_SALE_INACTIVE');
    }

    const rootRows = await transaction
      .select()
      .from(saleReturns)
      .where(and(eq(saleReturns.storeId, storeId), eq(saleReturns.id, returnId)))
      .limit(1)
      .for('update');
    const root = rootRows[0];
    if (!root) reject('SALE_RETURN_CORRECTION_TARGET_NOT_FOUND');
    if (
      root.status !== 'posted' ||
      root.cancelledAt !== null ||
      root.accountingPeriodId === null ||
      root.saleId !== sale.id ||
      root.customerId !== sale.customerId
    ) {
      reject('SALE_RETURN_CORRECTION_TARGET_NOT_ACTIVE');
    }
    await this.assertNoAppliedCorrection(transaction, storeId, root.id);

    const operation = await this.readOperation(transaction, storeId, root.operationId);
    const snapshot = this.resolvePostingSnapshot(operation, root);
    const [items, settlements] = await Promise.all([
      transaction
        .select()
        .from(saleReturnItems)
        .where(and(eq(saleReturnItems.storeId, storeId), eq(saleReturnItems.saleReturnId, root.id)))
        .orderBy(asc(saleReturnItems.id)),
      transaction
        .select()
        .from(saleReturnSettlements)
        .where(
          and(
            eq(saleReturnSettlements.storeId, storeId),
            eq(saleReturnSettlements.saleReturnId, root.id),
          ),
        )
        .orderBy(asc(saleReturnSettlements.id)),
    ]);
    const ledgerIds = settlements.flatMap((row) =>
      row.customerLedgerEntryId ? [row.customerLedgerEntryId] : [],
    );
    const moneyIds = settlements.flatMap((row) =>
      row.moneyMovementId ? [row.moneyMovementId] : [],
    );
    const inventoryIds = items.flatMap((row) =>
      row.inventoryMovementId ? [row.inventoryMovementId] : [],
    );
    const [ledgerEffects, moneyEffects, inventoryEffects] = await Promise.all([
      ledgerIds.length
        ? transaction
            .select()
            .from(customerLedgerEntries)
            .where(
              and(
                eq(customerLedgerEntries.storeId, storeId),
                inArray(customerLedgerEntries.id, ledgerIds),
              ),
            )
        : Promise.resolve([]),
      moneyIds.length
        ? transaction
            .select()
            .from(moneyMovements)
            .where(and(eq(moneyMovements.storeId, storeId), inArray(moneyMovements.id, moneyIds)))
        : Promise.resolve([]),
      inventoryIds.length
        ? transaction
            .select()
            .from(inventoryMovements)
            .where(
              and(
                eq(inventoryMovements.storeId, storeId),
                inArray(inventoryMovements.id, inventoryIds),
              ),
            )
        : Promise.resolve([]),
    ]);
    this.validateTarget(
      root,
      sale,
      snapshot,
      items,
      settlements,
      ledgerEffects,
      moneyEffects,
      inventoryEffects,
    );
    await this.assertNoPriorReversals(
      transaction,
      storeId,
      ledgerEffects,
      moneyEffects,
      inventoryEffects,
    );
    return {
      root,
      sale,
      snapshot,
      items,
      settlements,
      ledgerEffects,
      moneyEffects,
      inventoryEffects,
    };
  }

  private resolvePostingSnapshot(
    operation: ProcessedOperationRow | undefined,
    root: SaleReturnRow,
  ): SaleReturnPostingResponse {
    if (operation?.status !== 'applied' || operation.responseCode !== 201) {
      reject('SALE_RETURN_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    try {
      if (
        operation.aggregateType === 'sale_returns' &&
        operation.aggregateId === root.id &&
        operation.action === 'sale_returns.post'
      ) {
        return parseStoredSaleReturnPostingResponse(operation.responseBody);
      }
      if (
        operation.aggregateType === 'sale_return_corrections' &&
        operation.action === 'sale_returns.replace'
      ) {
        const correction = parseStoredSaleReturnCorrectionResponse(operation.responseBody);
        if (correction.replacement?.return.id === root.id) return correction.replacement;
      }
    } catch {
      reject('SALE_RETURN_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    reject('SALE_RETURN_CORRECTION_TARGET_INTEGRITY_CONFLICT');
  }

  private validateTarget(
    root: SaleReturnRow,
    sale: SaleIdentity,
    snapshot: SaleReturnPostingResponse,
    items: SaleReturnItemRow[],
    settlements: SaleReturnSettlementRow[],
    ledgerEffects: CustomerLedgerEntryRow[],
    moneyEffects: MoneyMovementRow[],
    inventoryEffects: InventoryMovementRow[],
  ): void {
    if (
      snapshot.operationId !== root.operationId ||
      snapshot.transactionGroupId !== root.operationId ||
      snapshot.return.id !== root.id ||
      snapshot.return.saleId !== sale.id ||
      snapshot.return.customerId !== root.customerId ||
      BigInt(snapshot.return.totalMinor) !== root.totalMinor ||
      snapshot.return.returnAt !== root.returnAt.toISOString() ||
      snapshot.posting.accountingPeriodId !== root.accountingPeriodId ||
      items.length !== snapshot.lines.length ||
      settlements.length !== snapshot.settlements.length
    ) {
      reject('SALE_RETURN_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    const itemById = new Map(items.map((item) => [item.id, item]));
    const inventoryById = new Map(inventoryEffects.map((movement) => [movement.id, movement]));
    for (const line of snapshot.lines) {
      const item = itemById.get(line.id);
      const movement = item?.inventoryMovementId
        ? inventoryById.get(item.inventoryMovementId)
        : undefined;
      if (!item) {
        reject('SALE_RETURN_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      if (
        item.saleReturnId !== root.id ||
        item.saleItemId !== line.saleItemId ||
        item.quantityMilli.toString() !== line.quantityMilli ||
        item.baseQuantityMilli?.toString() !== (line.baseQuantityMilli ?? undefined) ||
        item.lineRefundMinor.toString() !== line.lineRefundMinor ||
        item.itemCondition !== line.itemCondition ||
        item.inventoryMovementId !== (line.inventoryMovement?.id ?? null) ||
        (line.inventoryMovement === null && movement !== undefined)
      ) {
        reject('SALE_RETURN_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      if (line.inventoryMovement !== null) {
        if (!movement) reject('SALE_RETURN_CORRECTION_TARGET_INTEGRITY_CONFLICT');
        if (
          movement.operationId !== line.inventoryMovement.operationId ||
          movement.productId !== line.productId ||
          movement.productUnitId !== line.productUnitId ||
          movement.accountingPeriodId !== root.accountingPeriodId ||
          movement.movementType !== 'customer_return_saleable' ||
          movement.referenceType !== 'sale_return' ||
          movement.referenceId !== root.id ||
          movement.transactionGroupId !== snapshot.transactionGroupId ||
          movement.occurredAt.toISOString() !== snapshot.return.returnAt ||
          movement.quantityDeltaMilli.toString() !== line.inventoryMovement.quantityDeltaMilli ||
          (line.inventoryMovement.valueDeltaMinor === null
            ? movement.costStatus === 'known' || movement.valueDeltaMinor !== 0n
            : movement.costStatus !== 'known' ||
              movement.valueDeltaMinor.toString() !== line.inventoryMovement.valueDeltaMinor) ||
          movement.reversalOfId !== null
        ) {
          reject('SALE_RETURN_CORRECTION_TARGET_INTEGRITY_CONFLICT');
        }
      }
    }
    if (
      inventoryById.size !== inventoryEffects.length ||
      inventoryEffects.length !==
        itemById.size - items.filter((item) => item.inventoryMovementId === null).length
    ) {
      reject('SALE_RETURN_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }

    const settlementById = new Map(settlements.map((row) => [row.id, row]));
    const ledgerById = new Map(ledgerEffects.map((row) => [row.id, row]));
    const moneyById = new Map(moneyEffects.map((row) => [row.id, row]));
    for (const effect of snapshot.settlements) {
      const row = settlementById.get(effect.id);
      if (!row) reject('SALE_RETURN_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      if (row.saleReturnId !== root.id || row.amountMinor.toString() !== effect.amountMinor) {
        reject('SALE_RETURN_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      if (effect.kind === 'money_refund') {
        const expectedMovement = effect.moneyMovement;
        if (!expectedMovement) reject('SALE_RETURN_CORRECTION_TARGET_INTEGRITY_CONFLICT');
        const movement = row.moneyMovementId ? moneyById.get(row.moneyMovementId) : undefined;
        if (!movement) reject('SALE_RETURN_CORRECTION_TARGET_INTEGRITY_CONFLICT');
        if (
          row.settlementType !== 'money_refund' ||
          row.customerLedgerEntryId !== null ||
          row.moneyAccountId !== effect.moneyAccountId ||
          row.moneyMovementId !== expectedMovement.id ||
          movement.operationId !== expectedMovement.operationId ||
          movement.accountId !== row.moneyAccountId ||
          movement.accountingPeriodId !== root.accountingPeriodId ||
          movement.movementType !== 'customer_refund' ||
          movement.amountDeltaMinor !== -row.amountMinor ||
          movement.referenceType !== 'sale_return' ||
          movement.referenceId !== root.id ||
          movement.transactionGroupId !== snapshot.transactionGroupId ||
          movement.occurredAt.toISOString() !== snapshot.return.returnAt ||
          movement.reversalOfId !== null
        ) {
          reject('SALE_RETURN_CORRECTION_TARGET_INTEGRITY_CONFLICT');
        }
        continue;
      }
      const ledger = row.customerLedgerEntryId
        ? ledgerById.get(row.customerLedgerEntryId)
        : undefined;
      if (!ledger) reject('SALE_RETURN_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      const receivable = effect.kind === 'receivable_reduction';
      const expectedReference =
        effect.kind === 'original_customer_credit_restoration'
          ? 'sale_return_original_credit_restoration'
          : 'sale_return';
      if (
        row.settlementType !== (receivable ? 'reduce_receivable' : 'customer_credit') ||
        row.moneyAccountId !== null ||
        row.moneyMovementId !== null ||
        row.customerLedgerEntryId !== effect.customerLedgerEntryId ||
        ledger.operationId !== effect.customerLedgerOperationId ||
        ledger.customerId !== root.customerId ||
        ledger.accountingPeriodId !== root.accountingPeriodId ||
        ledger.sourceSaleId !== sale.id ||
        ledger.referenceType !== expectedReference ||
        ledger.referenceId !== root.id ||
        ledger.transactionGroupId !== snapshot.transactionGroupId ||
        ledger.occurredAt.toISOString() !== snapshot.return.returnAt ||
        ledger.reversalOfId !== null ||
        (receivable &&
          (ledger.entryType !== 'return' ||
            ledger.receivableDeltaMinor !== -row.amountMinor ||
            ledger.creditDeltaMinor !== 0n)) ||
        (!receivable &&
          (ledger.entryType !== 'credit_created' ||
            ledger.receivableDeltaMinor !== 0n ||
            ledger.creditDeltaMinor !== row.amountMinor))
      ) {
        reject('SALE_RETURN_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
    }
    if (
      ledgerById.size !== ledgerEffects.length ||
      moneyById.size !== moneyEffects.length ||
      items.reduce((sum, item) => sum + item.lineRefundMinor, 0n) !== root.totalMinor ||
      settlements.reduce((sum, settlement) => sum + settlement.amountMinor, 0n) !== root.totalMinor
    ) {
      reject('SALE_RETURN_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
  }

  private async assertNoPriorReversals(
    transaction: DatabaseTransaction,
    storeId: string,
    ledgerEffects: CustomerLedgerEntryRow[],
    moneyEffects: MoneyMovementRow[],
    inventoryEffects: InventoryMovementRow[],
  ): Promise<void> {
    const ledgerIds = ledgerEffects.map((row) => row.id);
    const moneyIds = moneyEffects.map((row) => row.id);
    const inventoryIds = inventoryEffects.map((row) => row.id);
    const [ledger, money, inventory] = await Promise.all([
      ledgerIds.length
        ? transaction
            .select({ id: customerLedgerEntries.id })
            .from(customerLedgerEntries)
            .where(
              and(
                eq(customerLedgerEntries.storeId, storeId),
                inArray(customerLedgerEntries.reversalOfId, ledgerIds),
              ),
            )
            .limit(1)
        : Promise.resolve([]),
      moneyIds.length
        ? transaction
            .select({ id: moneyMovements.id })
            .from(moneyMovements)
            .where(
              and(
                eq(moneyMovements.storeId, storeId),
                inArray(moneyMovements.reversalOfId, moneyIds),
              ),
            )
            .limit(1)
        : Promise.resolve([]),
      inventoryIds.length
        ? transaction
            .select({ id: inventoryMovements.id })
            .from(inventoryMovements)
            .where(
              and(
                eq(inventoryMovements.storeId, storeId),
                inArray(inventoryMovements.reversalOfId, inventoryIds),
              ),
            )
            .limit(1)
        : Promise.resolve([]),
    ]);
    if (ledger.length || money.length || inventory.length) {
      reject('SALE_RETURN_CORRECTION_TARGET_NOT_ACTIVE');
    }
  }

  private async insertMoneyReversals(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SaleReturnCorrectionCommand,
    posting: AccountingPeriodPostingContext,
    target: SaleReturnCorrectionTarget,
  ): Promise<SaleReturnMoneyReversalResponse[]> {
    const accountIds = [
      ...new Set(target.moneyEffects.map((movement) => movement.accountId)),
    ].sort();
    if (accountIds.length > 0) {
      const accounts = await transaction
        .select({ id: moneyAccounts.id })
        .from(moneyAccounts)
        .where(
          and(eq(moneyAccounts.storeId, context.storeId), inArray(moneyAccounts.id, accountIds)),
        )
        .orderBy(asc(moneyAccounts.id))
        .for('update');
      if (accounts.length !== accountIds.length) {
        reject('SALE_RETURN_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
    }
    const effects: SaleReturnMoneyReversalResponse[] = [];
    for (const original of [...target.moneyEffects].sort((left, right) =>
      left.accountId === right.accountId
        ? left.id.localeCompare(right.id)
        : left.accountId.localeCompare(right.accountId),
    )) {
      const movement: PostedMoneyMovement = await this.moneyPosting.insertMovementWithinTransaction(
        transaction,
        context,
        {
          commandOperationId: command.operationId,
          discriminator: `sale-return-money-reversal:${original.id}`,
          accountId: original.accountId,
          amountDeltaMinor: -original.amountDeltaMinor,
          movementType: 'correction',
          referenceType: 'sale_return_correction',
          referenceId: target.root.id,
          accountingPeriodId: posting.accountingPeriodId,
          occurredAt: command.occurredAt,
          transactionGroupId: deriveTransactionGroupId(command.operationId),
          notes: command.correctionReason,
          reversalOfId: original.id,
        },
      );
      effects.push({ ...movement, reversalOfId: original.id });
    }
    return effects;
  }

  private async assertNoAppliedCorrection(
    transaction: DatabaseTransaction,
    storeId: string,
    returnId: string,
  ): Promise<void> {
    const result = await transaction.execute<{ corrected: boolean }>(sql`
      select exists(
        select 1 from sync.processed_operations
        where store_id=${storeId}::uuid and status='applied'
          and action in ('sale_returns.cancel','sale_returns.replace')
          and response_body ->> 'targetReturnId'=${returnId}
      ) as corrected
    `);
    if (result.rows[0]?.corrected) reject('SALE_RETURN_CORRECTION_TARGET_NOT_ACTIVE');
  }

  private async transactionTime(transaction: DatabaseTransaction): Promise<Date> {
    const result = await transaction.execute<{ acceptedAt: string }>(
      sql`select transaction_timestamp()::text as "acceptedAt"`,
    );
    const value = result.rows[0]?.acceptedAt;
    const acceptedAt = value ? new Date(value) : new Date(Number.NaN);
    if (!Number.isFinite(acceptedAt.getTime())) {
      reject('SALE_RETURN_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    return acceptedAt;
  }

  private async resolvePosting(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SaleReturnCorrectionCommand,
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

  private action(
    command: SaleReturnCorrectionCommand,
  ): 'sale_returns.cancel' | 'sale_returns.replace' {
    return command.kind === 'cancel' ? 'sale_returns.cancel' : 'sale_returns.replace';
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
    command: SaleReturnCorrectionCommand,
    action: string,
  ): Promise<SaleReturnCorrectionResult | null> {
    let claimed: boolean;
    try {
      const result = await transaction.transaction((savepoint) =>
        savepoint.execute<{ claimed: boolean }>(sql`
          select sync.claim_operation(
            ${context.storeId}::uuid, ${command.operationId}::uuid,
            ${context.deviceId}::uuid, 'sale_return_corrections', ${command.targetReturnId}::uuid,
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
    if (!existing) throw new Error('Claimed Sale Return correction operation could not be read.');
    return this.replay(transaction, context, command, action, existing);
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
    command: SaleReturnCorrectionCommand,
    action: string,
    row: ProcessedOperationRow,
  ): Promise<SaleReturnCorrectionResult> {
    if (
      row.deviceId !== context.deviceId ||
      row.aggregateType !== 'sale_return_corrections' ||
      row.aggregateId !== command.targetReturnId ||
      row.action !== action ||
      row.requestHash !== command.requestHash
    ) {
      await transaction.execute(sql`
        insert into sync.conflicts(
          store_id, operation_id, entity_type, entity_id, conflict_type, client_payload)
        values(
          ${context.storeId}::uuid, ${command.operationId}::uuid,
          'sale_return_corrections', ${command.targetReturnId}::uuid, 'duplicate_identity',
          jsonb_build_object('action', ${action}::text, 'requestHash', ${command.requestHash}::text))
      `);
      return { ok: false, error: failureDefinitions.OPERATION_ID_CONFLICT };
    }
    if (row.status === 'applied') {
      if (row.responseCode !== 201)
        throw new Error('Invalid Sale Return correction replay status.');
      return { ok: true, response: parseStoredSaleReturnCorrectionResponse(row.responseBody) };
    }
    if (row.status === 'rejected') {
      const code = row.errorCode;
      if (!code || !(code in failureDefinitions)) {
        throw new Error('Invalid Sale Return correction rejection status.');
      }
      const error = failureDefinitions[code as SaleReturnCorrectionFailureCode];
      if (row.responseCode !== error.statusCode) {
        throw new Error('Invalid Sale Return correction rejection response.');
      }
      return { ok: false, error };
    }
    return { ok: false, error: failureDefinitions.OPERATION_IN_PROGRESS };
  }

  private knownFailure(error: unknown): SaleReturnCorrectionFailure | undefined {
    if (error instanceof SaleReturnCorrectionRejectedError) return error.error;
    if (error instanceof SaleReturnCorrectionScopeError) {
      return failureDefinitions.SALE_RETURN_CORRECTION_SCOPE_EXPANDED;
    }
    if (error instanceof CustomerReturnCreditDependencyError) {
      return error.code === 'CREDIT_DEPENDENCY'
        ? failureDefinitions.SALE_RETURN_CORRECTION_CREDIT_DEPENDENCY
        : failureDefinitions.SALE_RETURN_CORRECTION_TARGET_INTEGRITY_CONFLICT;
    }
    if (error instanceof SaleReturnInventoryReversalError) {
      if (error.code === 'NEGATIVE_STOCK_NOT_ALLOWED') {
        return failureDefinitions.SALE_RETURN_CORRECTION_NEGATIVE_STOCK_NOT_ALLOWED;
      }
      return error.code === 'INVENTORY_STATE_CONFLICT'
        ? failureDefinitions.SALE_RETURN_CORRECTION_INVENTORY_STATE_CONFLICT
        : failureDefinitions.SALE_RETURN_CORRECTION_TARGET_INTEGRITY_CONFLICT;
    }
    if (error instanceof SaleReturnAuthorityError) {
      return failureDefinitions[error.code];
    }
    if (error instanceof SaleReturnInventoryError) {
      return failureDefinitions[error.code];
    }
    if (error instanceof AccountingPeriodNotPostingEligibleError) {
      return failureDefinitions.ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE;
    }
    if (error instanceof AccountingPeriodIntegrityError) {
      return failureDefinitions.ACCOUNTING_PERIOD_INTEGRITY_CONFLICT;
    }
    if (error instanceof RangeError) return failureDefinitions.SALE_RETURN_AMOUNT_INVALID;
    return undefined;
  }

  private async completeApplied(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    response: SaleReturnCorrectionResponse,
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
    if (completed.rows.length !== 1) throw new Error('Sale Return correction completion failed.');
  }

  private async completeRejected(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    error: SaleReturnCorrectionFailure,
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
    if (completed.rows.length !== 1) {
      throw new Error('Sale Return correction rejection completion failed.');
    }
  }
}
