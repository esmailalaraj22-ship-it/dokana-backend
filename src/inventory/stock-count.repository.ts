import { ForbiddenException, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import {
  AccountingPeriodNotPostingEligibleError,
  AccountingPeriodPostingContextService,
} from '../accounting-periods/accounting-period-posting-context.service';
import { AccountingPeriodIntegrityError } from '../accounting-periods/accounting-period-provisioning.service';
import { DatabaseService } from '../database/database.service';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import {
  inventoryMovements,
  products,
  productUnits,
  stockBalances,
  stockCountItems,
  stockCounts,
  stores,
} from '../database/schema';
import { postgresqlErrorCode } from '../money-movements/money-movement-database-error';
import { inventoryBaseQuantity, inventoryCostResponse } from './inventory-math';
import type { StockCountCommand, StockCountCommandItem } from './stock-count-command';
import { stockCountEffect } from './stock-count-math';
import {
  stockCountRejectionSchema,
  stockCountResponseSchema,
  type StockCountResponse,
  type StockCountResult,
} from './stock-count-response';

const failures = {
  STOCK_COUNT_PRODUCT_UNAVAILABLE: [409, 'Stock Count Product is unavailable.'],
  STOCK_COUNT_UNIT_UNAVAILABLE: [409, 'Stock Count ProductUnit is unavailable.'],
  STOCK_COUNT_FULL_SET_MISMATCH: [409, 'Full Stock Count Product set is incomplete.'],
  STOCK_COUNT_AMOUNT_INVALID: [400, 'Stock Count quantity is not representable.'],
  ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE: [409, 'Accounting Period is not eligible for posting.'],
  ACCOUNTING_PERIOD_INTEGRITY_CONFLICT: [
    409,
    'Accounting Period identity or boundaries are inconsistent.',
  ],
  OPERATION_ID_CONFLICT: [409, 'Operation ID was reused with a different request.'],
  OPERATION_IN_PROGRESS: [409, 'The operation is still being processed.'],
} as const;
type FailureCode = keyof typeof failures;

function failure(code: FailureCode): Extract<StockCountResult, { ok: false }> {
  const [statusCode, message] = failures[code];
  return { ok: false, code, statusCode, message };
}

class StockCountRejection extends Error {
  constructor(readonly code: FailureCode) {
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
export class StockCountRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly postingContext: AccountingPeriodPostingContextService,
  ) {}

  post(
    context: TenantTransactionContext,
    command: StockCountCommand,
    postingDate: string,
  ): Promise<StockCountResult> {
    return this.database.withTenantTransaction(context, async (tx) => {
      const prior = await this.operation(tx, context.storeId, command.operationId);
      if (prior) return this.replay(tx, context, command, prior);
      const [store] = await tx
        .select({ status: stores.status })
        .from(stores)
        .where(eq(stores.id, context.storeId))
        .for('share');
      if (store?.status !== 'active') {
        throw new ForbiddenException({
          code: 'BUSINESS_WRITE_NOT_ALLOWED',
          message: 'Business writes are not allowed.',
        });
      }
      let claimed = false;
      try {
        const result = await tx.transaction((sp) =>
          sp.execute<{ claimed: boolean }>(sql`
            select sync.claim_operation(
              ${context.storeId}::uuid, ${command.operationId}::uuid,
              ${context.deviceId}::uuid, 'stock_counts', ${command.operationId}::uuid,
              'inventory.stock_count', ${command.requestHash}) as claimed`),
        );
        claimed = result.rows[0]?.claimed === true;
      } catch (error) {
        if (postgresqlErrorCode(error) !== '23505') throw error;
      }
      if (!claimed) {
        const concurrent = await this.operation(tx, context.storeId, command.operationId);
        if (!concurrent) throw new Error('Stock Count operation claim is missing.');
        return this.replay(tx, context, command, concurrent);
      }
      let response: StockCountResponse;
      try {
        response = await tx.transaction((sp) => this.insert(sp, context, command, postingDate));
      } catch (error) {
        let code: FailureCode;
        if (error instanceof StockCountRejection) code = error.code;
        else if (error instanceof AccountingPeriodNotPostingEligibleError) {
          code = 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE';
        } else if (error instanceof AccountingPeriodIntegrityError) {
          code = 'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT';
        } else if (error instanceof RangeError) code = 'STOCK_COUNT_AMOUNT_INVALID';
        else throw error;
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
    command: StockCountCommand,
    postingDate: string,
  ): Promise<StockCountResponse> {
    const posting = await this.postingContext.resolveForWrite(tx, context, {
      postingDate,
      operationId: command.operationId,
    });
    const submittedIds = command.items.map((item) => item.productId);
    const lockedProducts =
      command.countType === 'full'
        ? await tx
            .select()
            .from(products)
            .where(
              and(
                eq(products.storeId, context.storeId),
                eq(products.status, 'active'),
                eq(products.trackInventory, true),
              ),
            )
            .orderBy(asc(products.id))
            .for('update')
        : submittedIds.length === 0
          ? []
          : await tx
              .select()
              .from(products)
              .where(and(eq(products.storeId, context.storeId), inArray(products.id, submittedIds)))
              .orderBy(asc(products.id))
              .for('update');
    const lockedIds = lockedProducts.map((product) => product.id);
    if (
      command.countType === 'full' &&
      (lockedIds.length !== submittedIds.length ||
        lockedIds.some((id, index) => id !== submittedIds[index]))
    ) {
      throw new StockCountRejection('STOCK_COUNT_FULL_SET_MISMATCH');
    }
    if (
      command.countType === 'partial' &&
      (lockedIds.length !== submittedIds.length ||
        lockedProducts.some((product) => product.status !== 'active' || !product.trackInventory))
    ) {
      throw new StockCountRejection('STOCK_COUNT_PRODUCT_UNAVAILABLE');
    }
    const productById = new Map(lockedProducts.map((product) => [product.id, product]));
    const accepted: {
      input: StockCountCommandItem;
      unit: typeof productUnits.$inferSelect;
      movementUnit: typeof productUnits.$inferSelect;
    }[] = [];
    for (const input of command.items) {
      const product = productById.get(input.productId);
      if (product?.status !== 'active' || !product.trackInventory) {
        throw new StockCountRejection('STOCK_COUNT_PRODUCT_UNAVAILABLE');
      }
      const units = await tx
        .select()
        .from(productUnits)
        .where(
          and(
            eq(productUnits.storeId, context.storeId),
            eq(productUnits.productId, input.productId),
          ),
        )
        .orderBy(asc(productUnits.id))
        .for('share');
      const unit = units.find((candidate) => candidate.id === input.productUnitId);
      const movementUnit = units.find(
        (candidate) => candidate.isBase && candidate.status === 'active',
      );
      if (
        !unit ||
        !movementUnit ||
        unit.status !== 'active' ||
        unit.measurementType !== product.measurementType ||
        movementUnit.measurementType !== product.measurementType ||
        movementUnit.factorNum !== 1 ||
        movementUnit.factorDen !== 1
      ) {
        throw new StockCountRejection('STOCK_COUNT_UNIT_UNAVAILABLE');
      }
      accepted.push({ input, unit, movementUnit });
    }

    const countId = randomUUID();
    await tx.insert(stockCounts).values({
      id: countId,
      storeId: context.storeId,
      accountingPeriodId: posting.accountingPeriodId,
      displayNumber: `SC-${command.operationId}`,
      countType: command.countType,
      startedAt: command.occurredAt,
      status: 'draft',
      deviceId: context.deviceId,
      operationId: command.operationId,
      occurredAt: command.occurredAt,
      businessDate: postingDate,
      postingDate,
    });

    const responseItems: StockCountResponse['items'] = [];
    for (const { input, unit, movementUnit } of accepted) {
      const actual = inventoryBaseQuantity(
        input.actualQuantityMilli,
        unit.factorNum,
        unit.factorDen,
      );
      const [balance] = await tx
        .select()
        .from(stockBalances)
        .where(
          and(
            eq(stockBalances.storeId, context.storeId),
            eq(stockBalances.productId, input.productId),
          ),
        );
      const effect = stockCountEffect(balance ?? null, actual);
      const previousProjectionState = balance ? 'established' : 'missing';
      const variance = balance ? effect.quantityDeltaMilli : null;
      const requiresMovement = !balance || effect.quantityDeltaMilli !== 0n;
      const itemId = randomUUID();
      const movementId = requiresMovement ? randomUUID() : null;
      const quantityFactKind =
        !balance && actual === 0n ? ('count_zero_establishment' as const) : ('movement' as const);
      await tx.insert(stockCountItems).values({
        id: itemId,
        storeId: context.storeId,
        stockCountId: countId,
        productId: input.productId,
        systemQuantityMilli: balance?.quantityMilli ?? null,
        actualQuantityMilli: actual,
        differenceMilli: variance,
        adjustmentMovementId: movementId,
        productUnitId: unit.id,
        selectedQuantityMilli: input.actualQuantityMilli,
        factorNum: unit.factorNum,
        factorDen: unit.factorDen,
        previousProjectionState,
      });
      if (movementId) {
        const movementSnapshotUnit =
          quantityFactKind === 'count_zero_establishment' ? unit : movementUnit;
        await tx.insert(inventoryMovements).values({
          id: movementId,
          storeId: context.storeId,
          productId: input.productId,
          accountingPeriodId: posting.accountingPeriodId,
          movementType: 'stock_count',
          quantityBeforeMilli: balance?.quantityMilli ?? 0n,
          quantityDeltaMilli: effect.quantityDeltaMilli,
          quantityAfterMilli: effect.quantityAfterMilli,
          inventoryValueBeforeMinor: balance?.inventoryValueMinor ?? 0n,
          valueDeltaMinor: effect.valueDeltaMinor,
          inventoryValueAfterMinor: effect.inventoryValueAfterMinor,
          averageUnitCostAfterMinor: effect.averageUnitCostAfterMinor,
          costStatus: effect.costStatus,
          hasPendingCostAfter: effect.hasPendingCostAfter,
          referenceType: 'stock_count',
          referenceId: countId,
          transactionGroupId: command.operationId,
          occurredAt: command.occurredAt,
          reason: null,
          deviceId: context.deviceId,
          operationId: randomUUID(),
          productUnitId: movementSnapshotUnit.id,
          selectedQuantityMilli:
            quantityFactKind === 'count_zero_establishment'
              ? 0n
              : effect.quantityDeltaMilli < 0n
                ? -effect.quantityDeltaMilli
                : effect.quantityDeltaMilli,
          factorNum: movementSnapshotUnit.factorNum,
          factorDen: movementSnapshotUnit.factorDen,
          businessDate: postingDate,
          postingDate,
          costStateBefore: effect.costStateBefore,
          costStateAfter: effect.costStateAfter,
          quantityFactKind,
        });
      }
      const [after] = await tx
        .select()
        .from(stockBalances)
        .where(
          and(
            eq(stockBalances.storeId, context.storeId),
            eq(stockBalances.productId, input.productId),
          ),
        );
      if (!after || (movementId && after.lastMovementId !== movementId)) {
        throw new Error('Stock Count projection was not updated.');
      }
      responseItems.push({
        itemId,
        productId: input.productId,
        productUnitId: unit.id,
        factorNum: unit.factorNum,
        factorDen: unit.factorDen,
        actualSelectedQuantityMilli: input.actualQuantityMilli.toString(),
        actualBaseQuantityMilli: actual.toString(),
        previousProjectionState: balance ? 'ESTABLISHED' : 'MISSING',
        previousBaseQuantityMilli: balance?.quantityMilli.toString() ?? null,
        varianceMilli: variance?.toString() ?? null,
        adjustmentKind: !balance ? 'establishment' : movementId ? 'variance' : 'none',
        quantityFactKind: movementId ? quantityFactKind : null,
        movementId,
        stock: {
          projectionState: 'PRESENT',
          baseQuantityMilli: after.quantityMilli.toString(),
          version: after.version.toString(),
          lastMovementId: after.lastMovementId,
          cost: inventoryCostResponse(
            after.costState,
            after.inventoryValueMinor,
            after.averageUnitCostMinor,
          ),
        },
      });
    }
    const updated = await tx
      .update(stockCounts)
      .set({ status: 'posted', completedAt: new Date() })
      .where(and(eq(stockCounts.storeId, context.storeId), eq(stockCounts.id, countId)))
      .returning({ id: stockCounts.id });
    if (updated.length !== 1) throw new Error('Stock Count finalization failed.');
    await tx.execute(sql`set constraints
      ledger.stock_count_items_store_id_adjustment_movement_id_fkey,
      ledger.stock_count_items_movement_product_fkey,
      ledger.stock_balances_last_movement_fkey,
      ledger.trg_stock_counts_inventory_facts immediate`);
    return {
      operationId: command.operationId,
      countId,
      countType: command.countType,
      status: 'posted',
      occurredAt: command.occurredAt.toISOString(),
      businessDate: postingDate,
      postingDate,
      accountingPeriodId: posting.accountingPeriodId,
      items: responseItems,
    };
  }

  private async operation(tx: DatabaseTransaction, storeId: string, operationId: string) {
    return (
      await tx.execute<OperationRow>(sql`
        select device_id as "deviceId", aggregate_type as "aggregateType",
          aggregate_id as "aggregateId", action, request_hash as "requestHash", status,
          response_body as "responseBody", response_code as "responseCode",
          error_code as "errorCode"
        from sync.processed_operations
        where store_id=${storeId}::uuid and operation_id=${operationId}::uuid`)
    ).rows[0];
  }

  private async replay(
    tx: DatabaseTransaction,
    context: TenantTransactionContext,
    command: StockCountCommand,
    row: OperationRow,
  ): Promise<StockCountResult> {
    if (
      row.deviceId !== context.deviceId ||
      row.aggregateType !== 'stock_counts' ||
      row.aggregateId !== command.operationId ||
      row.action !== 'inventory.stock_count' ||
      row.requestHash !== command.requestHash
    ) {
      await tx.execute(sql`
        insert into sync.conflicts(
          store_id, operation_id, entity_type, entity_id, conflict_type, client_payload)
        values(
          ${context.storeId}::uuid, ${command.operationId}::uuid, 'stock_counts',
          ${command.operationId}::uuid, 'duplicate_identity',
          jsonb_build_object('action', 'inventory.stock_count', 'requestHash', ${command.requestHash}::text))`);
      return failure('OPERATION_ID_CONFLICT');
    }
    if (row.status === 'applied') {
      if (row.responseCode !== 201) throw new Error('Invalid Stock Count replay status.');
      return { ok: true, response: stockCountResponseSchema.parse(row.responseBody) };
    }
    if (row.status === 'rejected') {
      const code = row.errorCode;
      if (!code || !Object.hasOwn(failures, code))
        throw new Error('Invalid Stock Count rejection.');
      const result = failure(code as FailureCode);
      const stored = stockCountRejectionSchema.parse(row.responseBody);
      if (row.responseCode !== result.statusCode || stored.code !== code) {
        throw new Error('Invalid Stock Count rejection status.');
      }
      return { ...result, message: stored.message };
    }
    return failure('OPERATION_IN_PROGRESS');
  }

  private async complete(
    tx: DatabaseTransaction,
    storeId: string,
    operationId: string,
    result: StockCountResult,
  ): Promise<void> {
    const body = result.ok ? result.response : { code: result.code, message: result.message };
    const rows = await tx.execute(sql`
      update sync.processed_operations
      set status=${result.ok ? 'applied' : 'rejected'},
          response_code=${result.ok ? 201 : result.statusCode},
          response_body=${JSON.stringify(body)}::jsonb,
          error_code=${result.ok ? null : result.code},
          completed_at=clock_timestamp()
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid
        and status='processing'
      returning operation_id`);
    if (rows.rows.length !== 1) throw new Error('Stock Count operation completion failed.');
  }
}
