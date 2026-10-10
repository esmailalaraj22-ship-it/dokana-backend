import { ForbiddenException, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
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
  stores,
} from '../database/schema';
import { postgresqlErrorCode } from '../money-movements/money-movement-database-error';
import { inventoryBaseQuantity, inventoryCostResponse, inventoryUnitCost } from './inventory-math';
import type { InventoryPostingCommand } from './inventory-posting-command';
import { inventoryHistoricalInboundEffect, inventoryPostingEffect } from './inventory-posting-math';
import {
  inventoryPostingResponseSchema,
  inventoryPostingRejectionSchema,
  type InventoryPostingResponse,
  type InventoryPostingResult,
} from './inventory-posting-response';
import type {
  CustomerReturnRestockInput,
  CustomerReturnRestockReversalInput,
  PostedCustomerReturnRestock,
  PostedCustomerReturnRestockReversal,
} from './inventory-return.types';
import {
  deriveMoneyFactId,
  deriveMoneyFactOperationId,
  deriveTransactionGroupId,
} from '../money-movements/money-movement-identity';

const failures = {
  INVENTORY_PRODUCT_NOT_FOUND: [404, 'Inventory Product not found.'],
  INVENTORY_PRODUCT_UNAVAILABLE: [409, 'Product is not active and inventory tracked.'],
  INVENTORY_UNIT_NOT_FOUND: [404, 'Inventory ProductUnit not found.'],
  INVENTORY_UNIT_UNAVAILABLE: [409, 'Inventory ProductUnit is not available.'],
  INVENTORY_OPENING_ALREADY_EXISTS: [409, 'An original inventory opening already exists.'],
  INVENTORY_NEGATIVE_NOT_ALLOWED: [409, 'Negative inventory is not permitted.'],
  INVENTORY_AMOUNT_INVALID: [400, 'Inventory quantity or value is not representable.'],
  ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE: [409, 'Accounting Period is not eligible for posting.'],
  ACCOUNTING_PERIOD_INTEGRITY_CONFLICT: [
    409,
    'Accounting Period identity or boundaries are inconsistent.',
  ],
  OPERATION_ID_CONFLICT: [409, 'Operation ID was reused with a different request.'],
  OPERATION_IN_PROGRESS: [409, 'The operation is still being processed.'],
} as const;
export type InventoryPostingFailureCode = keyof typeof failures;
function failure(
  code: InventoryPostingFailureCode,
): Extract<InventoryPostingResult, { ok: false }> {
  const [statusCode, message] = failures[code];
  return { ok: false, code, statusCode, message };
}
export class InventoryPostingRejection extends Error {
  constructor(readonly code: InventoryPostingFailureCode) {
    super(failures[code][1]);
  }
}
interface OperationRow extends Record<string, unknown> {
  deviceId: string;
  aggregateType: string;
  aggregateId: string;
  action: string;
  requestHash: string;
  status: string;
  responseBody: unknown;
  responseCode: number | null;
  errorCode: string | null;
}

@Injectable()
export class InventoryPostingRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly postingContext: AccountingPeriodPostingContextService,
  ) {}

  post(
    context: TenantTransactionContext,
    command: InventoryPostingCommand,
    postingDate: string,
  ): Promise<InventoryPostingResult> {
    // Same replay-first tenant transaction + active-store lock/savepoint pattern as
    // Owner Ledger. A completed historical operation never re-enters new posting.
    return this.database.withTenantTransaction(context, async (tx) => {
      const prior = await this.operation(tx, context.storeId, command.operationId);
      if (prior) return this.replay(tx, context, command, prior);
      const [store] = await tx
        .select({ status: stores.status })
        .from(stores)
        .where(eq(stores.id, context.storeId))
        .for('share');
      if (store?.status !== 'active')
        throw new ForbiddenException({
          code: 'BUSINESS_WRITE_NOT_ALLOWED',
          message: 'Business writes are not allowed.',
        });
      await this.database.assertBusinessWriteAllowed(tx, context.storeId);
      let claimed = false;
      try {
        const result = await tx.transaction((sp) =>
          sp.execute<{ claimed: boolean }>(sql`
          select sync.claim_operation(${context.storeId}::uuid, ${command.operationId}::uuid,
          ${context.deviceId}::uuid, 'manual_inventory_entries', ${command.operationId}::uuid,
          ${`inventory.${command.kind}`}, ${command.requestHash}) as claimed`),
        );
        claimed = result.rows[0]?.claimed === true;
      } catch (error) {
        if (postgresqlErrorCode(error) !== '23505') throw error;
      }
      if (!claimed) {
        const concurrent = await this.operation(tx, context.storeId, command.operationId);
        if (!concurrent) throw new Error('Inventory operation claim is missing.');
        return this.replay(tx, context, command, concurrent);
      }
      let response: InventoryPostingResponse;
      try {
        response = await tx.transaction((sp) => this.insert(sp, context, command, postingDate));
      } catch (error) {
        let code: InventoryPostingFailureCode;
        if (error instanceof InventoryPostingRejection) code = error.code;
        else if (error instanceof AccountingPeriodNotPostingEligibleError)
          code = 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE';
        else if (error instanceof AccountingPeriodIntegrityError)
          code = 'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT';
        else if (error instanceof RangeError) code = 'INVENTORY_AMOUNT_INVALID';
        else throw error; // Unknown failures roll back the claim as well as all effects.
        const rejected = failure(code);
        await this.complete(tx, context.storeId, command.operationId, rejected);
        return rejected;
      }
      const result = { ok: true, response } as const;
      await this.complete(tx, context.storeId, command.operationId, result);
      return result;
    });
  }

  private async insert(
    tx: DatabaseTransaction,
    context: TenantTransactionContext,
    c: InventoryPostingCommand,
    postingDate: string,
  ): Promise<InventoryPostingResponse> {
    const posting = await this.postingContext.resolveForWrite(tx, context, {
      postingDate,
      operationId: c.operationId,
    });
    return this.insertAccepted(tx, context, c, posting, false);
  }

  insertCorrectionReplacementWithinTransaction(
    tx: DatabaseTransaction,
    context: TenantTransactionContext,
    command: InventoryPostingCommand,
    posting: AccountingPeriodPostingContext,
  ): Promise<InventoryPostingResponse> {
    return this.insertAccepted(tx, context, command, posting, true);
  }

  async insertCustomerReturnRestocksWithinTransaction(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: CustomerReturnRestockInput,
  ): Promise<PostedCustomerReturnRestock[]> {
    if (input.lines.length === 0) return [];

    const productIds = [...new Set(input.lines.map((line) => line.productId))].sort();
    const unitIds = [...new Set(input.lines.map((line) => line.productUnitId))].sort();
    const productRows = await transaction
      .select({ id: products.id, status: products.status, trackInventory: products.trackInventory })
      .from(products)
      .where(and(eq(products.storeId, context.storeId), inArray(products.id, productIds)))
      .orderBy(asc(products.id))
      .for('update');
    const productById = new Map(productRows.map((row) => [row.id, row]));
    const unitRows = await transaction
      .select({
        id: productUnits.id,
        productId: productUnits.productId,
        status: productUnits.status,
        factorNum: productUnits.factorNum,
        factorDen: productUnits.factorDen,
      })
      .from(productUnits)
      .where(and(eq(productUnits.storeId, context.storeId), inArray(productUnits.id, unitIds)))
      .orderBy(asc(productUnits.id))
      .for('share');
    const unitById = new Map(unitRows.map((row) => [`${row.productId}:${row.id}`, row]));

    const ordered = [...input.lines].sort((left, right) => {
      if (left.productId !== right.productId) return left.productId.localeCompare(right.productId);
      return left.saleItemId.localeCompare(right.saleItemId);
    });
    const effects: PostedCustomerReturnRestock[] = [];
    for (const line of ordered) {
      const product = productById.get(line.productId);
      const unit = unitById.get(`${line.productId}:${line.productUnitId}`);
      if (product?.status !== 'active' || !product.trackInventory) {
        throw new SaleReturnInventoryError('SALE_RETURN_RESTOCK_UNAVAILABLE');
      }
      if (
        unit?.status !== 'active' ||
        unit.factorNum !== line.factorNum ||
        unit.factorDen !== line.factorDen
      ) {
        throw new SaleReturnInventoryError('SALE_RETURN_RESTOCK_UNAVAILABLE');
      }
      let baseQuantity: bigint;
      try {
        baseQuantity = inventoryBaseQuantity(
          line.selectedQuantityMilli,
          line.factorNum,
          line.factorDen,
        );
      } catch (error) {
        if (error instanceof RangeError) {
          throw new SaleReturnInventoryError('SALE_RETURN_AMOUNT_INVALID');
        }
        throw error;
      }
      if (baseQuantity !== line.expectedBaseQuantityMilli || baseQuantity <= 0n) {
        throw new SaleReturnInventoryError('SALE_RETURN_INTEGRITY_CONFLICT');
      }

      const [balance] = await transaction
        .select()
        .from(stockBalances)
        .where(
          and(
            eq(stockBalances.storeId, context.storeId),
            eq(stockBalances.productId, line.productId),
          ),
        );
      const before = balance ?? {
        quantityMilli: 0n,
        inventoryValueMinor: 0n,
        costState: 'known' as const,
      };
      let effect: ReturnType<typeof inventoryHistoricalInboundEffect>;
      try {
        effect = inventoryHistoricalInboundEffect(
          before,
          baseQuantity,
          line.historicalCostState,
          line.historicalCostMinor,
        );
      } catch (error) {
        if (error instanceof RangeError) {
          throw new SaleReturnInventoryError('SALE_RETURN_AMOUNT_INVALID');
        }
        throw error;
      }

      const discriminator = `sale-return-item:${line.saleItemId}:inventory`;
      const movementId = deriveMoneyFactId(input.operationId, discriminator);
      const movementOperationId = deriveMoneyFactOperationId(input.operationId, discriminator);
      await transaction.insert(inventoryMovements).values({
        id: movementId,
        storeId: context.storeId,
        productId: line.productId,
        productUnitId: line.productUnitId,
        accountingPeriodId: input.posting.accountingPeriodId,
        movementType: 'customer_return_saleable',
        quantityBeforeMilli: before.quantityMilli,
        quantityDeltaMilli: baseQuantity,
        quantityAfterMilli: effect.quantityAfterMilli,
        inventoryValueBeforeMinor: before.inventoryValueMinor,
        valueDeltaMinor: effect.valueDeltaMinor,
        inventoryValueAfterMinor: effect.inventoryValueAfterMinor,
        averageUnitCostAfterMinor: effect.averageUnitCostAfterMinor,
        costStatus: effect.costStatus,
        hasPendingCostAfter: effect.hasPendingCostAfter,
        referenceType: 'sale_return',
        referenceId: input.returnId,
        transactionGroupId: deriveTransactionGroupId(input.operationId),
        occurredAt: input.occurredAt,
        reason: input.reason,
        deviceId: context.deviceId,
        operationId: movementOperationId,
        selectedQuantityMilli: line.selectedQuantityMilli,
        factorNum: line.factorNum,
        factorDen: line.factorDen,
        businessDate: input.posting.postingDate,
        postingDate: input.posting.postingDate,
        costStateBefore: before.costState,
        costStateAfter: effect.costStateAfter,
      });
      effects.push({
        saleItemId: line.saleItemId,
        returnItemId: line.returnItemId,
        movementId,
        movementOperationId,
        productId: line.productId,
        productUnitId: line.productUnitId,
        quantityDeltaMilli: baseQuantity.toString(),
        valueDeltaMinor:
          line.historicalCostState === 'known' ? effect.valueDeltaMinor.toString() : null,
        costStatus: line.historicalCostState,
      });
    }
    return effects;
  }

  async insertCustomerReturnRestockReversalsWithinTransaction(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: CustomerReturnRestockReversalInput,
  ): Promise<PostedCustomerReturnRestockReversal[]> {
    if (input.movementIds.length === 0) return [];
    const requestedIds = [...new Set(input.movementIds)].sort();
    if (requestedIds.length !== input.movementIds.length) {
      throw new SaleReturnInventoryReversalError('INTEGRITY_CONFLICT');
    }

    const discovered = await transaction
      .select({ id: inventoryMovements.id, productId: inventoryMovements.productId })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.storeId, context.storeId),
          inArray(inventoryMovements.id, requestedIds),
        ),
      );
    if (discovered.length !== requestedIds.length) {
      throw new SaleReturnInventoryReversalError('INTEGRITY_CONFLICT');
    }
    const productIds = [...new Set(discovered.map((row) => row.productId))].sort();
    const productRows = await transaction
      .select()
      .from(products)
      .where(and(eq(products.storeId, context.storeId), inArray(products.id, productIds)))
      .orderBy(asc(products.id))
      .for('update');
    const productById = new Map(productRows.map((row) => [row.id, row]));
    if (productIds.some((id) => !productById.get(id)?.trackInventory)) {
      throw new SaleReturnInventoryReversalError('INTEGRITY_CONFLICT');
    }

    const originals = await transaction
      .select()
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.storeId, context.storeId),
          inArray(inventoryMovements.id, requestedIds),
        ),
      )
      .orderBy(asc(inventoryMovements.productId), asc(inventoryMovements.id));
    if (
      originals.length !== requestedIds.length ||
      originals.some(
        (movement) =>
          movement.movementType !== 'customer_return_saleable' ||
          movement.referenceType !== 'sale_return' ||
          movement.referenceId !== input.returnId ||
          movement.reversalOfId !== null ||
          movement.quantityDeltaMilli <= 0n,
      )
    ) {
      throw new SaleReturnInventoryReversalError('INTEGRITY_CONFLICT');
    }

    const unitIds = [...new Set(originals.map((movement) => movement.productUnitId))].sort();
    const unitRows = await transaction
      .select({ id: productUnits.id, productId: productUnits.productId })
      .from(productUnits)
      .where(and(eq(productUnits.storeId, context.storeId), inArray(productUnits.id, unitIds)))
      .orderBy(asc(productUnits.productId), asc(productUnits.id))
      .for('share');
    if (unitRows.length !== unitIds.length) {
      throw new SaleReturnInventoryReversalError('INTEGRITY_CONFLICT');
    }
    const priorReversals = await transaction
      .select({ id: inventoryMovements.id })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.storeId, context.storeId),
          inArray(inventoryMovements.reversalOfId, requestedIds),
        ),
      )
      .limit(1);
    if (priorReversals.length > 0) {
      throw new SaleReturnInventoryReversalError('INTEGRITY_CONFLICT');
    }

    const [settings] = await transaction
      .select({ allowNegativeStock: appSettings.allowNegativeStock })
      .from(appSettings)
      .where(eq(appSettings.storeId, context.storeId))
      .for('share');
    const effects: PostedCustomerReturnRestockReversal[] = [];
    for (const original of originals) {
      const [before] = await transaction
        .select()
        .from(stockBalances)
        .where(
          and(
            eq(stockBalances.storeId, context.storeId),
            eq(stockBalances.productId, original.productId),
          ),
        )
        .limit(1);
      if (!before) {
        throw new SaleReturnInventoryReversalError('INVENTORY_STATE_CONFLICT');
      }
      if (
        before.lastMovementId !== original.id ||
        before.quantityMilli !== original.quantityAfterMilli ||
        before.inventoryValueMinor !== original.inventoryValueAfterMinor ||
        before.averageUnitCostMinor !== original.averageUnitCostAfterMinor ||
        before.costState !== original.costStateAfter ||
        before.hasPendingCost !== original.hasPendingCostAfter
      ) {
        throw new SaleReturnInventoryReversalError('INVENTORY_STATE_CONFLICT');
      }

      const quantityAfterMilli = original.quantityBeforeMilli;
      const inventoryValueAfterMinor = original.inventoryValueBeforeMinor;
      if (
        inventoryValueAfterMinor < 0n ||
        (quantityAfterMilli === 0n && inventoryValueAfterMinor !== 0n) ||
        (original.costStateBefore !== 'known' && inventoryValueAfterMinor !== 0n)
      ) {
        throw new SaleReturnInventoryReversalError('INVENTORY_STATE_CONFLICT');
      }
      const product = productById.get(original.productId);
      if (
        quantityAfterMilli < 0n &&
        !(product?.allowNegativeStockOverride ?? settings?.allowNegativeStock ?? false)
      ) {
        throw new SaleReturnInventoryReversalError('NEGATIVE_STOCK_NOT_ALLOWED');
      }
      const costStateAfter = original.costStateBefore;
      const averageUnitCostAfterMinor =
        costStateAfter === 'known' && quantityAfterMilli > 0n
          ? inventoryUnitCost(inventoryValueAfterMinor, quantityAfterMilli)
          : 0n;
      const discriminator = `sale-return-inventory-reversal:${original.id}`;
      const id = deriveMoneyFactId(input.operationId, discriminator);
      const operationId = deriveMoneyFactOperationId(input.operationId, discriminator);
      await transaction.insert(inventoryMovements).values({
        id,
        storeId: context.storeId,
        productId: original.productId,
        productUnitId: original.productUnitId,
        accountingPeriodId: input.posting.accountingPeriodId,
        movementType: 'correction',
        quantityBeforeMilli: before.quantityMilli,
        quantityDeltaMilli: -original.quantityDeltaMilli,
        quantityAfterMilli,
        inventoryValueBeforeMinor: before.inventoryValueMinor,
        valueDeltaMinor: -original.valueDeltaMinor,
        inventoryValueAfterMinor,
        averageUnitCostAfterMinor,
        costStatus: original.costStatus,
        hasPendingCostAfter: costStateAfter === 'pending',
        referenceType: 'sale_return_correction',
        referenceId: input.returnId,
        transactionGroupId: deriveTransactionGroupId(input.operationId),
        occurredAt: input.occurredAt,
        reversalOfId: original.id,
        reason: input.reason,
        deviceId: context.deviceId,
        operationId,
        selectedQuantityMilli: original.selectedQuantityMilli,
        factorNum: original.factorNum,
        factorDen: original.factorDen,
        businessDate: input.posting.postingDate,
        postingDate: input.posting.postingDate,
        costStateBefore: before.costState,
        costStateAfter,
      });
      effects.push({
        id,
        operationId,
        reversalOfId: original.id,
        productId: original.productId,
        productUnitId: original.productUnitId,
        quantityDeltaMilli: (-original.quantityDeltaMilli).toString(),
        valueDeltaMinor:
          original.costStatus === 'known' ? (-original.valueDeltaMinor).toString() : null,
        costStatus: original.costStatus,
      });
    }
    await transaction.execute(
      sql`set constraints ledger.stock_balances_last_movement_fkey immediate`,
    );
    return effects;
  }

  private async insertAccepted(
    tx: DatabaseTransaction,
    context: TenantTransactionContext,
    c: InventoryPostingCommand,
    posting: AccountingPeriodPostingContext,
    correctionReplacement: boolean,
  ): Promise<InventoryPostingResponse> {
    const postingDate = posting.postingDate;
    const [product] = await tx
      .select()
      .from(products)
      .where(and(eq(products.storeId, context.storeId), eq(products.id, c.productId)))
      .for('update');
    if (!product) throw new InventoryPostingRejection('INVENTORY_PRODUCT_NOT_FOUND');
    if (product.status !== 'active' || !product.trackInventory)
      throw new InventoryPostingRejection('INVENTORY_PRODUCT_UNAVAILABLE');
    const [unit] = await tx
      .select()
      .from(productUnits)
      .where(
        and(
          eq(productUnits.storeId, context.storeId),
          eq(productUnits.productId, c.productId),
          eq(productUnits.id, c.productUnitId),
        ),
      )
      .for('share');
    if (!unit) throw new InventoryPostingRejection('INVENTORY_UNIT_NOT_FOUND');
    if (unit.status !== 'active' || unit.measurementType !== product.measurementType)
      throw new InventoryPostingRejection('INVENTORY_UNIT_UNAVAILABLE');
    if (c.kind === 'opening' && !correctionReplacement) {
      const existingHistory = await tx
        .select({ id: inventoryMovements.id })
        .from(inventoryMovements)
        .where(
          and(
            eq(inventoryMovements.storeId, context.storeId),
            eq(inventoryMovements.productId, c.productId),
            isNull(inventoryMovements.reversalOfId),
          ),
        )
        .limit(1);
      if (existingHistory.length)
        throw new InventoryPostingRejection('INVENTORY_OPENING_ALREADY_EXISTS');
    }
    const quantity = inventoryBaseQuantity(c.selectedQuantityMilli, unit.factorNum, unit.factorDen);
    if (quantity <= 0n) throw new InventoryPostingRejection('INVENTORY_AMOUNT_INVALID');
    const delta = c.kind === 'decrease' ? -quantity : quantity;
    const [balance] = await tx
      .select()
      .from(stockBalances)
      .where(
        and(eq(stockBalances.storeId, context.storeId), eq(stockBalances.productId, c.productId)),
      );
    const before = balance ?? {
      quantityMilli: 0n,
      inventoryValueMinor: 0n,
      costState: 'known' as const,
    };
    const effect = inventoryPostingEffect(before, delta, c.totalPurchaseCostMinor);
    const [settings] = await tx
      .select({ allow: appSettings.allowNegativeStock })
      .from(appSettings)
      .where(eq(appSettings.storeId, context.storeId))
      .for('share');
    if (
      effect.quantityAfterMilli < 0n &&
      !(product.allowNegativeStockOverride ?? settings?.allow ?? false)
    )
      throw new InventoryPostingRejection('INVENTORY_NEGATIVE_NOT_ALLOWED');
    const entryId = c.entryId ?? randomUUID();
    const movementId = deriveMoneyFactId(c.operationId, 'manual_inventory:movement');
    const snapshot = {
      storeId: context.storeId,
      productId: c.productId,
      productUnitId: c.productUnitId,
      selectedQuantityMilli: c.selectedQuantityMilli,
      factorNum: unit.factorNum,
      factorDen: unit.factorDen,
      occurredAt: c.occurredAt,
      businessDate: postingDate,
      postingDate,
      accountingPeriodId: posting.accountingPeriodId,
      transactionGroupId: c.operationId,
      deviceId: context.deviceId,
      reason: c.reason,
      costStatus: effect.costStatus,
    };
    await tx.insert(manualInventoryEntries).values({
      ...snapshot,
      id: entryId,
      operationId: c.operationId,
      baseQuantityMilli: quantity,
      totalPurchaseCostMinor: c.totalPurchaseCostMinor,
      movementId,
    });
    await tx.insert(inventoryMovements).values({
      ...snapshot,
      ...effect,
      id: movementId,
      operationId: deriveMoneyFactOperationId(c.operationId, 'manual_inventory:movement'),
      movementType: correctionReplacement
        ? 'correction'
        : c.kind === 'opening'
          ? 'opening_balance'
          : c.kind === 'increase'
            ? 'adjustment_in'
            : 'adjustment_out',
      quantityBeforeMilli: before.quantityMilli,
      quantityDeltaMilli: delta,
      inventoryValueBeforeMinor: before.inventoryValueMinor,
      costStateBefore: before.costState,
      referenceType: 'manual_inventory_entry',
      referenceId: entryId,
    });
    // Evaluate the deferred manual-fact links before acknowledging completion.
    await tx.execute(
      sql`set constraints ledger.trg_manual_inventory_entries_movement, ledger.trg_inventory_manual_reference, ledger.manual_inventory_entries_movement_fkey, ledger.stock_balances_last_movement_fkey immediate`,
    );
    const [after] = await tx
      .select()
      .from(stockBalances)
      .where(
        and(eq(stockBalances.storeId, context.storeId), eq(stockBalances.productId, c.productId)),
      );
    if (after?.lastMovementId !== movementId)
      throw new Error('Inventory projection was not updated.');
    return {
      operationId: c.operationId,
      kind: c.kind,
      entryId,
      movementId,
      productId: c.productId,
      productUnitId: c.productUnitId,
      factorNum: unit.factorNum,
      factorDen: unit.factorDen,
      selectedQuantityMilli: c.selectedQuantityMilli.toString(),
      baseQuantityMilli: quantity.toString(),
      quantityDeltaMilli: delta.toString(),
      totalPurchaseCostMinor: c.totalPurchaseCostMinor?.toString() ?? null,
      costStatus: effect.costStatus,
      occurredAt: c.occurredAt.toISOString(),
      businessDate: postingDate,
      postingDate,
      accountingPeriodId: posting.accountingPeriodId,
      reason: c.reason,
      stock: {
        baseQuantityMilli: after.quantityMilli.toString(),
        version: after.version.toString(),
        cost: inventoryCostResponse(
          after.costState,
          after.inventoryValueMinor,
          after.averageUnitCostMinor,
        ),
      },
    };
  }

  private async operation(tx: DatabaseTransaction, storeId: string, operationId: string) {
    return (
      await tx.execute<OperationRow>(sql`select device_id as "deviceId", aggregate_type as "aggregateType",
      aggregate_id as "aggregateId", action, request_hash as "requestHash", status, response_body as "responseBody",
      response_code as "responseCode", error_code as "errorCode" from sync.processed_operations
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid`)
    ).rows[0];
  }

  private async replay(
    tx: DatabaseTransaction,
    ctx: TenantTransactionContext,
    c: InventoryPostingCommand,
    row: OperationRow,
  ): Promise<InventoryPostingResult> {
    if (
      row.deviceId !== ctx.deviceId ||
      row.aggregateType !== 'manual_inventory_entries' ||
      row.aggregateId !== c.operationId ||
      row.action !== `inventory.${c.kind}` ||
      row.requestHash !== c.requestHash
    ) {
      await tx.execute(sql`insert into sync.conflicts(store_id,operation_id,entity_type,entity_id,conflict_type,client_payload)
        values(${ctx.storeId}::uuid,${c.operationId}::uuid,'manual_inventory_entries',${c.operationId}::uuid,'duplicate_identity',
        jsonb_build_object('action',${`inventory.${c.kind}`}::text,'requestHash',${c.requestHash}::text))`);
      return failure('OPERATION_ID_CONFLICT');
    }
    if (row.status === 'applied') {
      if (row.responseCode !== 201) throw new Error('Invalid inventory replay status.');
      return { ok: true, response: inventoryPostingResponseSchema.parse(row.responseBody) };
    }
    if (row.status === 'rejected') {
      const code = row.errorCode;
      if (!code || !Object.hasOwn(failures, code)) throw new Error('Invalid inventory rejection.');
      const result = failure(code as InventoryPostingFailureCode);
      const stored = inventoryPostingRejectionSchema.parse(row.responseBody);
      if (row.responseCode !== result.statusCode || stored.code !== code)
        throw new Error('Invalid inventory rejection status.');
      return { ...result, message: stored.message };
    }
    return failure('OPERATION_IN_PROGRESS');
  }

  private async complete(
    tx: DatabaseTransaction,
    storeId: string,
    operationId: string,
    result: InventoryPostingResult,
  ) {
    const body = result.ok ? result.response : { code: result.code, message: result.message };
    const rows =
      await tx.execute(sql`update sync.processed_operations set status=${result.ok ? 'applied' : 'rejected'},
      response_code=${result.ok ? 201 : result.statusCode}, response_body=${JSON.stringify(body)}::jsonb,
      error_code=${result.ok ? null : result.code}, completed_at=clock_timestamp()
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid and status='processing' returning operation_id`);
    if (rows.rows.length !== 1) throw new Error('Inventory operation completion failed.');
  }
}

export class SaleReturnInventoryError extends Error {
  constructor(
    readonly code:
      | 'SALE_RETURN_AMOUNT_INVALID'
      | 'SALE_RETURN_INTEGRITY_CONFLICT'
      | 'SALE_RETURN_RESTOCK_UNAVAILABLE',
  ) {
    super(code);
  }
}

export class SaleReturnInventoryReversalError extends Error {
  constructor(
    readonly code: 'INTEGRITY_CONFLICT' | 'INVENTORY_STATE_CONFLICT' | 'NEGATIVE_STOCK_NOT_ALLOWED',
  ) {
    super(code);
    this.name = 'SaleReturnInventoryReversalError';
  }
}
