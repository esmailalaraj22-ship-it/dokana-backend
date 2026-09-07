import { ForbiddenException, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import {
  AccountingPeriodNotPostingEligibleError,
  AccountingPeriodPostingContextService,
} from '../accounting-periods/accounting-period-posting-context.service';
import type { AccountingPeriodPostingContext } from '../accounting-periods/accounting-period-posting-context.types';
import { AccountingPeriodIntegrityError } from '../accounting-periods/accounting-period-provisioning.service';
import { DatabaseService } from '../database/database.service';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import {
  appSettings,
  inventoryMovements,
  manualInventoryEntries,
  products,
  productUnits,
  stockBalances,
  stockCountItems,
  stockCounts,
  stores,
  type InventoryMovement,
  type ManualInventoryEntry,
  type StockBalance,
  type StockCount,
  type StockCountItem,
} from '../database/schema';
import { postgresqlErrorCode } from '../money-movements/money-movement-database-error';
import type {
  InventoryCorrectionCommand,
  InventoryCorrectionFamily,
} from './inventory-correction-command';
import {
  inventoryCorrectionResponseSchema,
  type InventoryCorrectionFailure,
  type InventoryCorrectionFailureCode,
  type InventoryCorrectionResponse,
  type InventoryCorrectionResult,
} from './inventory-correction-response';
import { inventoryUnitCost } from './inventory-math';
import {
  InventoryPostingRejection,
  InventoryPostingRepository,
} from './inventory-posting.repository';
import { StockCountRejection, StockCountRepository } from './stock-count.repository';

interface ProcessedOperationRow extends Record<string, unknown> {
  deviceId: string;
  aggregateType: string;
  aggregateId: string;
  action: string;
  requestHash: string;
  status: 'processing' | 'applied' | 'rejected';
  responseBody: unknown;
  responseCode: number | null;
  errorCode: string | null;
}

interface ManualTarget {
  family: Exclude<InventoryCorrectionFamily, 'stock_count'>;
  entry: ManualInventoryEntry;
  movements: InventoryMovement[];
  productIds: string[];
}

interface StockCountTarget {
  family: 'stock_count';
  count: StockCount;
  items: StockCountItem[];
  movements: InventoryMovement[];
  productIds: string[];
}

type CorrectionTarget = ManualTarget | StockCountTarget;

const failureDefinitions: Readonly<
  Record<InventoryCorrectionFailureCode, InventoryCorrectionFailure>
> = {
  ACCOUNTING_PERIOD_INTEGRITY_CONFLICT: defineFailure(
    'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT',
    409,
    'Accounting Period identity or boundaries are inconsistent.',
  ),
  ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE: defineFailure(
    'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE',
    409,
    'Accounting Period is not eligible for posting.',
  ),
  INVENTORY_AMOUNT_INVALID: defineFailure(
    'INVENTORY_AMOUNT_INVALID',
    400,
    'Inventory quantity or amount is not representable.',
  ),
  INVENTORY_CORRECTION_FAMILY_MISMATCH: defineFailure(
    'INVENTORY_CORRECTION_FAMILY_MISMATCH',
    409,
    'The replacement must use the same inventory operation family.',
  ),
  INVENTORY_CORRECTION_MISSING_PROJECTION_UNSUPPORTED: defineFailure(
    'INVENTORY_CORRECTION_MISSING_PROJECTION_UNSUPPORTED',
    409,
    'This Stock Count cannot be historically corrected.',
  ),
  INVENTORY_CORRECTION_REQUIRES_RECOST: defineFailure(
    'INVENTORY_CORRECTION_REQUIRES_RECOST',
    409,
    'This inventory correction would require rewriting later inventory history.',
  ),
  INVENTORY_CORRECTION_TARGET_INTEGRITY_CONFLICT: defineFailure(
    'INVENTORY_CORRECTION_TARGET_INTEGRITY_CONFLICT',
    409,
    'The target inventory history is incomplete or inconsistent.',
  ),
  INVENTORY_CORRECTION_TARGET_NOT_ACTIVE: defineFailure(
    'INVENTORY_CORRECTION_TARGET_NOT_ACTIVE',
    409,
    'The target is not the active correctable inventory operation.',
  ),
  INVENTORY_CORRECTION_TARGET_NOT_FOUND: defineFailure(
    'INVENTORY_CORRECTION_TARGET_NOT_FOUND',
    404,
    'Inventory correction target not found.',
  ),
  INVENTORY_NEGATIVE_NOT_ALLOWED: defineFailure(
    'INVENTORY_NEGATIVE_NOT_ALLOWED',
    409,
    'Negative inventory is not permitted.',
  ),
  INVENTORY_OPENING_ALREADY_EXISTS: defineFailure(
    'INVENTORY_OPENING_ALREADY_EXISTS',
    409,
    'Opening inventory already exists for this Product.',
  ),
  INVENTORY_PRODUCT_NOT_FOUND: defineFailure(
    'INVENTORY_PRODUCT_NOT_FOUND',
    404,
    'Inventory Product not found.',
  ),
  INVENTORY_PRODUCT_UNAVAILABLE: defineFailure(
    'INVENTORY_PRODUCT_UNAVAILABLE',
    409,
    'Inventory Product is unavailable.',
  ),
  INVENTORY_UNIT_NOT_FOUND: defineFailure(
    'INVENTORY_UNIT_NOT_FOUND',
    404,
    'Inventory ProductUnit not found.',
  ),
  INVENTORY_UNIT_UNAVAILABLE: defineFailure(
    'INVENTORY_UNIT_UNAVAILABLE',
    409,
    'Inventory ProductUnit is unavailable.',
  ),
  OPERATION_ID_CONFLICT: defineFailure(
    'OPERATION_ID_CONFLICT',
    409,
    'Operation ID was reused with a different request.',
  ),
  OPERATION_IN_PROGRESS: defineFailure(
    'OPERATION_IN_PROGRESS',
    409,
    'The operation is still being processed.',
  ),
  STOCK_COUNT_AMOUNT_INVALID: defineFailure(
    'STOCK_COUNT_AMOUNT_INVALID',
    400,
    'Stock Count quantity is not representable.',
  ),
  STOCK_COUNT_FULL_SET_MISMATCH: defineFailure(
    'STOCK_COUNT_FULL_SET_MISMATCH',
    409,
    'Full Stock Count Product set is incomplete.',
  ),
  STOCK_COUNT_PRODUCT_UNAVAILABLE: defineFailure(
    'STOCK_COUNT_PRODUCT_UNAVAILABLE',
    409,
    'Stock Count Product is unavailable.',
  ),
  STOCK_COUNT_UNIT_UNAVAILABLE: defineFailure(
    'STOCK_COUNT_UNIT_UNAVAILABLE',
    409,
    'Stock Count ProductUnit is unavailable.',
  ),
};

class InventoryCorrectionRejectedError extends Error {
  constructor(readonly error: InventoryCorrectionFailure) {
    super(error.message);
    this.name = 'InventoryCorrectionRejectedError';
  }
}

function defineFailure(
  code: InventoryCorrectionFailureCode,
  statusCode: 400 | 404 | 409,
  message: string,
): InventoryCorrectionFailure {
  return { code, statusCode, message };
}

function failure(
  code: InventoryCorrectionFailureCode,
): Extract<InventoryCorrectionResult, { ok: false }> {
  return { ok: false, error: failureDefinitions[code] };
}

function reject(code: InventoryCorrectionFailureCode): never {
  throw new InventoryCorrectionRejectedError(failureDefinitions[code]);
}

@Injectable()
export class InventoryCorrectionRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly postingContext: AccountingPeriodPostingContextService,
    private readonly inventoryPosting: InventoryPostingRepository,
    private readonly stockCountPosting: StockCountRepository,
  ) {}

  correct(
    context: TenantTransactionContext,
    command: InventoryCorrectionCommand,
    postingDate: string,
  ): Promise<InventoryCorrectionResult> {
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
        const known = this.knownFailure(error, command);
        if (!known) throw error;
        await this.completeRejected(transaction, context.storeId, command.operationId, known);
        return { ok: false, error: known };
      }
    });
  }

  private async applyCorrection(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: InventoryCorrectionCommand,
    postingDate: string,
  ): Promise<InventoryCorrectionResponse> {
    const targetOperation = await this.lockTargetOperation(
      transaction,
      context.storeId,
      command.targetOperationId,
    );
    const targetFamily = this.resolveTargetFamily(targetOperation);
    await this.assertTargetIsActive(transaction, context.storeId, command.targetOperationId);
    if (command.replacement && command.replacement.family !== targetFamily) {
      reject('INVENTORY_CORRECTION_FAMILY_MISMATCH');
    }

    const target = await this.loadTarget(
      transaction,
      context.storeId,
      command.targetOperationId,
      targetFamily,
      targetOperation,
    );
    const posting = await this.resolvePosting(transaction, context, command, postingDate);
    const lockedProducts = await this.lockAffectedProducts(
      transaction,
      context.storeId,
      target,
      command,
    );
    await this.assertTargetIsActive(transaction, context.storeId, command.targetOperationId);
    await this.assertCurrentProjection(transaction, context.storeId, target.movements);
    this.assertReversibleCostState(target.movements);
    await this.assertNegativePolicy(transaction, context.storeId, target.movements, lockedProducts);
    await this.assertOpeningReplacement(transaction, context.storeId, target, command);

    const baseUnits = await this.loadBaseUnits(
      transaction,
      context.storeId,
      target.movements.map((movement) => movement.productId),
    );
    const reversalMovements: InventoryCorrectionResponse['reversalMovements'] = [];
    for (const movement of [...target.movements].sort((left, right) =>
      left.productId.localeCompare(right.productId),
    )) {
      const unit = baseUnits.get(movement.productId);
      if (!unit) reject('INVENTORY_UNIT_UNAVAILABLE');
      const movementId = randomUUID();
      const delta = -movement.quantityDeltaMilli;
      const selectedQuantity = delta < 0n ? -delta : delta;
      const averageAfter =
        movement.costStateBefore === 'known' && movement.quantityBeforeMilli > 0n
          ? inventoryUnitCost(movement.inventoryValueBeforeMinor, movement.quantityBeforeMilli)
          : 0n;
      await transaction.insert(inventoryMovements).values({
        id: movementId,
        storeId: context.storeId,
        productId: movement.productId,
        accountingPeriodId: posting.accountingPeriodId,
        movementType: 'correction',
        quantityBeforeMilli: movement.quantityAfterMilli,
        quantityDeltaMilli: delta,
        quantityAfterMilli: movement.quantityBeforeMilli,
        inventoryValueBeforeMinor: movement.inventoryValueAfterMinor,
        valueDeltaMinor: -movement.valueDeltaMinor,
        inventoryValueAfterMinor: movement.inventoryValueBeforeMinor,
        averageUnitCostAfterMinor: averageAfter,
        costStatus: movement.costStateBefore,
        hasPendingCostAfter: movement.costStateBefore === 'pending',
        referenceType: movement.referenceType,
        referenceId: movement.referenceId,
        transactionGroupId: movement.transactionGroupId,
        occurredAt: command.occurredAt,
        reversalOfId: movement.id,
        reason: 'Inventory operation correction reversal',
        deviceId: context.deviceId,
        operationId: randomUUID(),
        productUnitId: unit.id,
        selectedQuantityMilli: selectedQuantity,
        factorNum: 1,
        factorDen: 1,
        businessDate: posting.postingDate,
        postingDate: posting.postingDate,
        costStateBefore: movement.costStateAfter,
        costStateAfter: movement.costStateBefore,
        quantityFactKind: 'movement',
      });
      reversalMovements.push({
        movementId,
        reversedMovementId: movement.id,
        productId: movement.productId,
        productUnitId: unit.id,
        selectedQuantityMilli: selectedQuantity.toString(),
        factorNum: 1,
        factorDen: 1,
        quantityBeforeMilli: movement.quantityAfterMilli.toString(),
        quantityDeltaMilli: delta.toString(),
        quantityAfterMilli: movement.quantityBeforeMilli.toString(),
        costStateBefore: movement.costStateAfter,
        costStateAfter: movement.costStateBefore,
      });
    }

    const replacement = await this.insertReplacement(
      transaction,
      context,
      command,
      targetFamily,
      posting,
    );
    await transaction.execute(
      sql`set constraints ledger.stock_balances_last_movement_fkey immediate`,
    );
    return {
      operationId: command.operationId,
      targetOperationId: command.targetOperationId,
      targetFamily,
      correctionType: command.kind === 'reversal' ? 'REVERSAL' : 'REPLACEMENT',
      occurredAt: command.occurredAt.toISOString(),
      businessDate: posting.postingDate,
      postingDate: posting.postingDate,
      accountingPeriodId: posting.accountingPeriodId,
      reversalMovements,
      replacement,
    };
  }

  private resolveTargetFamily(row: ProcessedOperationRow | undefined): InventoryCorrectionFamily {
    if (!row) reject('INVENTORY_CORRECTION_TARGET_NOT_FOUND');
    if (row.status !== 'applied') reject('INVENTORY_CORRECTION_TARGET_NOT_ACTIVE');
    if (
      row.aggregateType === 'manual_inventory_entries' &&
      row.aggregateId &&
      ['inventory.opening', 'inventory.increase', 'inventory.decrease'].includes(row.action)
    ) {
      return row.action.slice('inventory.'.length) as Exclude<
        InventoryCorrectionFamily,
        'stock_count'
      >;
    }
    if (row.aggregateType === 'stock_counts' && row.action === 'inventory.stock_count') {
      return 'stock_count';
    }
    if (
      row.aggregateType === 'inventory_corrections' &&
      row.action === 'inventory.correction.replacement'
    ) {
      try {
        const response = inventoryCorrectionResponseSchema.parse(row.responseBody);
        if (response.correctionType !== 'REPLACEMENT' || !response.replacement) {
          reject('INVENTORY_CORRECTION_TARGET_INTEGRITY_CONFLICT');
        }
        if (
          response.operationId !== row.aggregateId ||
          response.replacement.operation.operationId !== row.aggregateId
        ) {
          reject('INVENTORY_CORRECTION_TARGET_INTEGRITY_CONFLICT');
        }
        return response.targetFamily;
      } catch (error) {
        if (error instanceof InventoryCorrectionRejectedError) throw error;
        reject('INVENTORY_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
    }
    if (row.action.startsWith('inventory.correction.')) {
      reject('INVENTORY_CORRECTION_TARGET_NOT_ACTIVE');
    }
    reject('INVENTORY_CORRECTION_FAMILY_MISMATCH');
  }

  private async loadTarget(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    family: InventoryCorrectionFamily,
    operation: ProcessedOperationRow | undefined,
  ): Promise<CorrectionTarget> {
    if (operation?.aggregateId !== operationId) {
      reject('INVENTORY_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    if (family === 'stock_count') {
      return this.loadStockCountTarget(transaction, storeId, operationId);
    }
    return this.loadManualTarget(transaction, storeId, operationId, family, operation);
  }

  private async loadManualTarget(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    family: ManualTarget['family'],
    operation: ProcessedOperationRow,
  ): Promise<ManualTarget> {
    const [entry] = await transaction
      .select()
      .from(manualInventoryEntries)
      .where(
        and(
          eq(manualInventoryEntries.storeId, storeId),
          eq(manualInventoryEntries.operationId, operationId),
        ),
      )
      .limit(1);
    if (!entry) reject('INVENTORY_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    const [movement] = await transaction
      .select()
      .from(inventoryMovements)
      .where(
        and(eq(inventoryMovements.storeId, storeId), eq(inventoryMovements.id, entry.movementId)),
      )
      .limit(1);
    const expectedMovementType =
      operation.aggregateType === 'inventory_corrections'
        ? 'correction'
        : family === 'opening'
          ? 'opening_balance'
          : family === 'increase'
            ? 'adjustment_in'
            : 'adjustment_out';
    const expectedDelta =
      family === 'decrease' ? -entry.baseQuantityMilli : entry.baseQuantityMilli;
    if (
      !movement ||
      entry.transactionGroupId !== operationId ||
      movement.reversalOfId !== null ||
      movement.movementType !== expectedMovementType ||
      movement.productId !== entry.productId ||
      movement.productUnitId !== entry.productUnitId ||
      movement.selectedQuantityMilli !== entry.selectedQuantityMilli ||
      movement.factorNum !== entry.factorNum ||
      movement.factorDen !== entry.factorDen ||
      movement.quantityDeltaMilli !== expectedDelta ||
      movement.quantityBeforeMilli + movement.quantityDeltaMilli !== movement.quantityAfterMilli ||
      movement.inventoryValueBeforeMinor + movement.valueDeltaMinor !==
        movement.inventoryValueAfterMinor ||
      movement.referenceType !== 'manual_inventory_entry' ||
      movement.referenceId !== entry.id ||
      movement.transactionGroupId !== operationId ||
      movement.accountingPeriodId !== entry.accountingPeriodId ||
      movement.occurredAt.getTime() !== entry.occurredAt.getTime() ||
      movement.businessDate !== entry.businessDate ||
      movement.postingDate !== entry.postingDate ||
      movement.deviceId !== entry.deviceId ||
      movement.costStatus !== entry.costStatus ||
      movement.quantityFactKind !== 'movement'
    ) {
      reject('INVENTORY_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    return { family, entry, movements: [movement], productIds: [entry.productId] };
  }

  private async loadStockCountTarget(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
  ): Promise<StockCountTarget> {
    const [count] = await transaction
      .select()
      .from(stockCounts)
      .where(and(eq(stockCounts.storeId, storeId), eq(stockCounts.operationId, operationId)))
      .limit(1);
    if (
      count?.status !== 'posted' ||
      !count.accountingPeriodId ||
      !count.occurredAt ||
      !count.businessDate ||
      !count.postingDate ||
      !count.deviceId
    ) {
      reject('INVENTORY_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    const items = await transaction
      .select()
      .from(stockCountItems)
      .where(and(eq(stockCountItems.storeId, storeId), eq(stockCountItems.stockCountId, count.id)))
      .orderBy(asc(stockCountItems.productId));
    if (items.some((item) => item.previousProjectionState === 'missing')) {
      reject('INVENTORY_CORRECTION_MISSING_PROJECTION_UNSUPPORTED');
    }
    const movementIds = items.flatMap((item) =>
      item.adjustmentMovementId ? [item.adjustmentMovementId] : [],
    );
    const movements =
      movementIds.length === 0
        ? []
        : await transaction
            .select()
            .from(inventoryMovements)
            .where(
              and(
                eq(inventoryMovements.storeId, storeId),
                inArray(inventoryMovements.id, movementIds),
              ),
            );
    const movementById = new Map(movements.map((movement) => [movement.id, movement]));
    for (const item of items) {
      if (item.systemQuantityMilli === null || item.differenceMilli === null) {
        reject('INVENTORY_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      const movement = item.adjustmentMovementId
        ? movementById.get(item.adjustmentMovementId)
        : undefined;
      if (item.differenceMilli === 0n) {
        if (movement) reject('INVENTORY_CORRECTION_TARGET_INTEGRITY_CONFLICT');
        continue;
      }
      if (
        movement?.movementType !== 'stock_count' ||
        movement.reversalOfId !== null ||
        movement.productId !== item.productId ||
        movement.quantityBeforeMilli !== item.systemQuantityMilli ||
        movement.quantityDeltaMilli !== item.differenceMilli ||
        movement.quantityAfterMilli !== item.actualQuantityMilli ||
        movement.referenceType !== 'stock_count' ||
        movement.referenceId !== count.id ||
        movement.transactionGroupId !== operationId ||
        movement.accountingPeriodId !== count.accountingPeriodId ||
        movement.occurredAt.getTime() !== count.occurredAt.getTime() ||
        movement.businessDate !== count.businessDate ||
        movement.postingDate !== count.postingDate ||
        movement.deviceId !== count.deviceId ||
        movement.quantityFactKind !== 'movement'
      ) {
        reject('INVENTORY_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
    }
    if (movementById.size !== movementIds.length) {
      reject('INVENTORY_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    return {
      family: 'stock_count',
      count,
      items,
      movements,
      productIds: items.map((item) => item.productId),
    };
  }

  private async lockAffectedProducts(
    transaction: DatabaseTransaction,
    storeId: string,
    target: CorrectionTarget,
    command: InventoryCorrectionCommand,
  ) {
    const explicitIds = new Set(target.productIds);
    if (command.replacement?.family === 'stock_count') {
      command.replacement.command.items.forEach((item) => explicitIds.add(item.productId));
    } else if (command.replacement) {
      explicitIds.add(command.replacement.command.productId);
    }
    const ids = [...explicitIds].sort();
    const includeFullCatalog =
      command.replacement?.family === 'stock_count' &&
      command.replacement.command.countType === 'full';
    const predicate = includeFullCatalog
      ? or(
          ids.length ? inArray(products.id, ids) : undefined,
          and(eq(products.status, 'active'), eq(products.trackInventory, true)),
        )
      : ids.length
        ? inArray(products.id, ids)
        : undefined;
    const locked = predicate
      ? await transaction
          .select()
          .from(products)
          .where(and(eq(products.storeId, storeId), predicate))
          .orderBy(asc(products.id))
          .for('update')
      : [];
    const byId = new Map(locked.map((product) => [product.id, product]));
    if (
      ids.some((id) => {
        const product = byId.get(id);
        if (product?.status !== 'active') return true;
        return !product.trackInventory;
      })
    ) {
      reject('INVENTORY_PRODUCT_UNAVAILABLE');
    }
    return byId;
  }

  private async loadBaseUnits(
    transaction: DatabaseTransaction,
    storeId: string,
    productIds: string[],
  ) {
    const ids = [...new Set(productIds)].sort();
    if (ids.length === 0) return new Map<string, typeof productUnits.$inferSelect>();
    const units = await transaction
      .select()
      .from(productUnits)
      .where(
        and(
          eq(productUnits.storeId, storeId),
          inArray(productUnits.productId, ids),
          eq(productUnits.isBase, true),
          eq(productUnits.status, 'active'),
        ),
      )
      .orderBy(asc(productUnits.productId), asc(productUnits.id))
      .for('share');
    const result = new Map<string, typeof productUnits.$inferSelect>();
    for (const unit of units) {
      if (unit.factorNum !== 1 || unit.factorDen !== 1 || result.has(unit.productId)) {
        reject('INVENTORY_UNIT_UNAVAILABLE');
      }
      result.set(unit.productId, unit);
    }
    if (ids.some((id) => !result.has(id))) reject('INVENTORY_UNIT_UNAVAILABLE');
    return result;
  }

  private async assertCurrentProjection(
    transaction: DatabaseTransaction,
    storeId: string,
    movements: InventoryMovement[],
  ): Promise<void> {
    if (movements.length === 0) return;
    const productIds = movements.map((movement) => movement.productId);
    const balances = await transaction
      .select()
      .from(stockBalances)
      .where(and(eq(stockBalances.storeId, storeId), inArray(stockBalances.productId, productIds)))
      .orderBy(asc(stockBalances.productId));
    const byProduct = new Map(balances.map((balance) => [balance.productId, balance]));
    for (const movement of movements) {
      const balance = byProduct.get(movement.productId);
      if (!balance || !this.projectionMatchesMovement(balance, movement)) {
        reject('INVENTORY_CORRECTION_REQUIRES_RECOST');
      }
    }
  }

  private projectionMatchesMovement(balance: StockBalance, movement: InventoryMovement): boolean {
    return (
      balance.lastMovementId === movement.id &&
      balance.quantityMilli === movement.quantityAfterMilli &&
      balance.inventoryValueMinor === movement.inventoryValueAfterMinor &&
      balance.averageUnitCostMinor === movement.averageUnitCostAfterMinor &&
      balance.costState === movement.costStateAfter &&
      balance.hasPendingCost === movement.hasPendingCostAfter
    );
  }

  private assertReversibleCostState(movements: InventoryMovement[]): void {
    if (
      movements.some(
        (movement) =>
          movement.costStateAfter !== 'known' &&
          movement.costStateBefore === 'known' &&
          movement.quantityAfterMilli !== 0n &&
          movement.quantityBeforeMilli !== 0n,
      )
    ) {
      reject('INVENTORY_CORRECTION_REQUIRES_RECOST');
    }
  }

  private async assertOpeningReplacement(
    transaction: DatabaseTransaction,
    storeId: string,
    target: CorrectionTarget,
    command: InventoryCorrectionCommand,
  ): Promise<void> {
    if (
      target.family !== 'opening' ||
      command.replacement?.family !== 'opening' ||
      command.replacement.command.productId === target.entry.productId
    ) {
      return;
    }
    const existing = await transaction
      .select({ id: inventoryMovements.id })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.storeId, storeId),
          eq(inventoryMovements.productId, command.replacement.command.productId),
          isNull(inventoryMovements.reversalOfId),
        ),
      )
      .limit(1);
    if (existing.length) reject('INVENTORY_OPENING_ALREADY_EXISTS');
  }

  private async assertNegativePolicy(
    transaction: DatabaseTransaction,
    storeId: string,
    movements: InventoryMovement[],
    productById: Map<string, typeof products.$inferSelect>,
  ): Promise<void> {
    if (!movements.some((movement) => movement.quantityBeforeMilli < 0n)) return;
    const [settings] = await transaction
      .select({ allowNegativeStock: appSettings.allowNegativeStock })
      .from(appSettings)
      .where(eq(appSettings.storeId, storeId))
      .for('share');
    for (const movement of movements) {
      if (
        movement.quantityBeforeMilli < 0n &&
        !(
          productById.get(movement.productId)?.allowNegativeStockOverride ??
          settings?.allowNegativeStock ??
          false
        )
      ) {
        reject('INVENTORY_NEGATIVE_NOT_ALLOWED');
      }
    }
  }

  private async insertReplacement(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: InventoryCorrectionCommand,
    targetFamily: InventoryCorrectionFamily,
    posting: AccountingPeriodPostingContext,
  ): Promise<InventoryCorrectionResponse['replacement']> {
    if (!command.replacement) return null;
    if (command.replacement.family !== targetFamily) {
      reject('INVENTORY_CORRECTION_FAMILY_MISMATCH');
    }
    if (command.replacement.family === 'stock_count') {
      const operation = await this.stockCountPosting.insertCorrectionReplacementWithinTransaction(
        transaction,
        context,
        command.replacement.command,
        posting,
      );
      return { family: 'stock_count', operation };
    }
    const operation = await this.inventoryPosting.insertCorrectionReplacementWithinTransaction(
      transaction,
      context,
      command.replacement.command,
      posting,
    );
    return { family: command.replacement.family, operation };
  }

  private async resolvePosting(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: InventoryCorrectionCommand,
    postingDate: string,
  ): Promise<AccountingPeriodPostingContext> {
    try {
      return await this.postingContext.resolveForWrite(transaction, context, {
        postingDate,
        operationId: command.operationId,
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

  private async assertTargetIsActive(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
  ): Promise<void> {
    const result = await transaction.execute<{ superseded: boolean }>(sql`
      select exists (
        select 1
        from sync.processed_operations
        where store_id = ${storeId}::uuid
          and status = 'applied'
          and action in ('inventory.correction.reversal', 'inventory.correction.replacement')
          and response_body ->> 'targetOperationId' = ${operationId}
      ) as superseded
    `);
    if (result.rows[0]?.superseded) reject('INVENTORY_CORRECTION_TARGET_NOT_ACTIVE');
  }

  private async lockActiveStore(transaction: DatabaseTransaction, storeId: string): Promise<void> {
    const [store] = await transaction
      .select({ status: stores.status })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1)
      .for('share');
    if (store?.status !== 'active') {
      throw new ForbiddenException({
        code: 'BUSINESS_WRITE_NOT_ALLOWED',
        message: 'Business writes are not allowed.',
      });
    }
  }

  private async claimOperation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: InventoryCorrectionCommand,
    action: string,
  ): Promise<InventoryCorrectionResult | null> {
    let claimed = false;
    try {
      const result = await transaction.transaction((savepoint) =>
        savepoint.execute<{ claimed: boolean }>(sql`
          select sync.claim_operation(
            ${context.storeId}::uuid,
            ${command.operationId}::uuid,
            ${context.deviceId}::uuid,
            'inventory_corrections',
            ${command.operationId}::uuid,
            ${action},
            ${command.requestHash}
          ) as claimed
        `),
      );
      claimed = result.rows[0]?.claimed === true;
    } catch (error) {
      if (postgresqlErrorCode(error) !== '23505') throw error;
    }
    if (claimed) return null;
    const existing = await this.readOperation(transaction, context.storeId, command.operationId);
    if (!existing) throw new Error('Inventory correction operation claim is missing.');
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
          response_body as "responseBody", response_code as "responseCode",
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
          response_body as "responseBody", response_code as "responseCode",
          error_code as "errorCode"
        from sync.processed_operations
        where store_id=${storeId}::uuid and operation_id=${operationId}::uuid
      `)
    ).rows[0];
  }

  private async replay(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: InventoryCorrectionCommand,
    action: string,
    row: ProcessedOperationRow,
  ): Promise<InventoryCorrectionResult> {
    if (
      row.deviceId !== context.deviceId ||
      row.aggregateType !== 'inventory_corrections' ||
      row.aggregateId !== command.operationId ||
      row.action !== action ||
      row.requestHash !== command.requestHash
    ) {
      await transaction.execute(sql`
        insert into sync.conflicts(
          store_id, operation_id, entity_type, entity_id, conflict_type, client_payload)
        values(
          ${context.storeId}::uuid, ${command.operationId}::uuid,
          'inventory_corrections', ${command.operationId}::uuid, 'duplicate_identity',
          jsonb_build_object('action', ${action}::text, 'requestHash', ${command.requestHash}::text))
      `);
      return failure('OPERATION_ID_CONFLICT');
    }
    if (row.status === 'applied') {
      if (row.responseCode !== 201) throw new Error('Invalid inventory correction replay status.');
      return { ok: true, response: inventoryCorrectionResponseSchema.parse(row.responseBody) };
    }
    if (row.status === 'rejected') {
      const code = row.errorCode;
      if (
        !code ||
        !Object.hasOwn(failureDefinitions, code) ||
        row.responseCode !== failureDefinitions[code as InventoryCorrectionFailureCode].statusCode
      ) {
        throw new Error('Invalid inventory correction rejection status.');
      }
      return failure(code as InventoryCorrectionFailureCode);
    }
    return failure('OPERATION_IN_PROGRESS');
  }

  private knownFailure(
    error: unknown,
    command: InventoryCorrectionCommand,
  ): InventoryCorrectionFailure | undefined {
    if (error instanceof InventoryCorrectionRejectedError) return error.error;
    if (error instanceof InventoryPostingRejection) return failureDefinitions[error.code];
    if (error instanceof StockCountRejection) return failureDefinitions[error.code];
    if (error instanceof AccountingPeriodNotPostingEligibleError) {
      return failureDefinitions.ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE;
    }
    if (error instanceof AccountingPeriodIntegrityError) {
      return failureDefinitions.ACCOUNTING_PERIOD_INTEGRITY_CONFLICT;
    }
    if (error instanceof RangeError) {
      return command.replacement?.family === 'stock_count'
        ? failureDefinitions.STOCK_COUNT_AMOUNT_INVALID
        : failureDefinitions.INVENTORY_AMOUNT_INVALID;
    }
    return undefined;
  }

  private async completeApplied(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    response: InventoryCorrectionResponse,
  ): Promise<void> {
    const completed = await transaction.execute(sql`
      update sync.processed_operations
      set status='applied', response_code=201, response_body=${JSON.stringify(response)}::jsonb,
          error_code=null, completed_at=clock_timestamp()
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid and status='processing'
      returning operation_id
    `);
    if (completed.rows.length !== 1) throw new Error('Inventory correction completion failed.');
  }

  private async completeRejected(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    error: InventoryCorrectionFailure,
  ): Promise<void> {
    const completed = await transaction.execute(sql`
      update sync.processed_operations
      set status='rejected', response_code=${error.statusCode},
          response_body=${JSON.stringify({ code: error.code, message: error.message })}::jsonb,
          error_code=${error.code}, completed_at=clock_timestamp()
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid and status='processing'
      returning operation_id
    `);
    if (completed.rows.length !== 1) throw new Error('Inventory correction rejection failed.');
  }

  private action(command: InventoryCorrectionCommand): string {
    return `inventory.correction.${command.kind}`;
  }
}
