import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { DatabaseTransaction } from '../database/database.types';
import {
  customers,
  products,
  productUnits,
  saleCustomerCreditApplications,
  saleItems,
  saleReturnItems,
  saleReturns,
  sales,
} from '../database/schema';
import {
  allocateHistoricalLineNetValues,
  assertNewCustomerReturnWithinWindow,
  calculateSaleReturnLine,
  calculateSaleReturnSettlement,
} from './sale-return-policy';
import type {
  SaleReturnCommand,
  SaleReturnLineAuthority,
  SaleReturnPlan,
} from './sale-return.types';
import { SaleReturnAuthorityError } from './sale-return.types';

interface AggregateRow extends Record<string, unknown> {
  amount: string;
}

@Injectable()
export class SaleReturnAuthorityRepository {
  async buildNewPlanWithinTransaction(
    transaction: DatabaseTransaction,
    storeId: string,
    command: SaleReturnCommand,
  ): Promise<SaleReturnPlan> {
    const [saleIdentity] = await transaction
      .select({ id: sales.id, customerId: sales.customerId })
      .from(sales)
      .where(and(eq(sales.storeId, storeId), eq(sales.id, command.saleId)))
      .limit(1);
    if (!saleIdentity) throw new SaleReturnAuthorityError('SALE_RETURN_SALE_NOT_FOUND');

    let customerStatus: 'active' | 'archived' | null = null;
    if (saleIdentity.customerId) {
      const [customer] = await transaction
        .select({ status: customers.status })
        .from(customers)
        .where(and(eq(customers.storeId, storeId), eq(customers.id, saleIdentity.customerId)))
        .for('update');
      if (!customer) throw new SaleReturnAuthorityError('SALE_RETURN_INTEGRITY_CONFLICT');
      customerStatus = customer.status;
    }

    const [sale] = await transaction
      .select({
        id: sales.id,
        customerId: sales.customerId,
        displayNumber: sales.displayNumber,
        saleAt: sales.saleAt,
        totalMinor: sales.totalMinor,
        status: sales.status,
        reversedById: sales.reversedById,
      })
      .from(sales)
      .where(and(eq(sales.storeId, storeId), eq(sales.id, command.saleId)))
      .for('update');
    if (sale?.customerId !== saleIdentity.customerId) {
      throw new SaleReturnAuthorityError('SALE_RETURN_INTEGRITY_CONFLICT');
    }
    if (sale.status !== 'posted' || sale.reversedById !== null) {
      throw new SaleReturnAuthorityError('SALE_RETURN_SALE_INACTIVE');
    }

    const acceptedAtResult = await transaction.execute<{ acceptedAt: string }>(
      sql`select transaction_timestamp()::text as "acceptedAt"`,
    );
    const acceptedAtText = acceptedAtResult.rows[0]?.acceptedAt;
    const acceptedAt = acceptedAtText === undefined ? null : new Date(acceptedAtText);
    if (acceptedAt === null || !Number.isFinite(acceptedAt.getTime())) {
      throw new SaleReturnAuthorityError('SALE_RETURN_INTEGRITY_CONFLICT');
    }
    assertNewCustomerReturnWithinWindow(sale.saleAt, acceptedAt);

    const lockedLines = await transaction
      .select({
        id: saleItems.id,
        productId: saleItems.productId,
        productUnitId: saleItems.productUnitId,
        isManualLine: saleItems.isManualLine,
        productNameSnapshot: saleItems.productNameSnapshot,
        unitNameSnapshot: saleItems.unitNameSnapshot,
        quantityMilli: saleItems.quantityMilli,
        conversionFactorNum: saleItems.conversionFactorNum,
        conversionFactorDen: saleItems.conversionFactorDen,
        baseQuantityMilli: saleItems.baseQuantityMilli,
        lineTotalMinor: saleItems.lineTotalMinor,
        costStatus: saleItems.costStatus,
        lineCostMinor: saleItems.lineCostMinor,
        inventoryMovementId: saleItems.inventoryMovementId,
      })
      .from(saleItems)
      .where(and(eq(saleItems.storeId, storeId), eq(saleItems.saleId, sale.id)))
      .orderBy(asc(saleItems.id))
      .for('update');
    const requestedIds = command.lines.map((line) => line.saleItemId);
    const lockedById = new Map(lockedLines.map((line) => [line.id, line]));
    if (requestedIds.some((id) => !lockedById.has(id))) {
      throw new SaleReturnAuthorityError('SALE_RETURN_LINE_NOT_FOUND');
    }

    const historicalValues = allocateHistoricalLineNetValues(
      lockedLines.map((line) => ({ saleItemId: line.id, lineTotalMinor: line.lineTotalMinor })),
      sale.totalMinor,
    );
    const priorQuantities = await transaction
      .select({
        saleItemId: saleReturnItems.saleItemId,
        quantity: sql<string>`sum(${saleReturnItems.quantityMilli})::text`,
      })
      .from(saleReturnItems)
      .innerJoin(
        saleReturns,
        and(
          eq(saleReturns.storeId, saleReturnItems.storeId),
          eq(saleReturns.id, saleReturnItems.saleReturnId),
        ),
      )
      .where(
        and(
          eq(saleReturnItems.storeId, storeId),
          eq(saleReturns.saleId, sale.id),
          eq(saleReturns.status, 'posted'),
          inArray(saleReturnItems.saleItemId, requestedIds),
        ),
      )
      .groupBy(saleReturnItems.saleItemId);
    const priorByLine = new Map(
      priorQuantities.map((row) => [row.saleItemId, BigInt(row.quantity)]),
    );

    const catalog = await this.lockCatalog(transaction, storeId, lockedLines, requestedIds);
    const calculatedLines = command.lines.map((request) => {
      const line = lockedById.get(request.saleItemId);
      const historicalNetValueMinor = historicalValues.get(request.saleItemId);
      if (!line || historicalNetValueMinor === undefined) {
        throw new SaleReturnAuthorityError('SALE_RETURN_INTEGRITY_CONFLICT');
      }
      const product = line.productId ? catalog.products.get(line.productId) : undefined;
      const unit =
        line.productId && line.productUnitId
          ? catalog.units.get(`${line.productId}:${line.productUnitId}`)
          : undefined;
      const authority: SaleReturnLineAuthority = {
        saleItemId: line.id,
        productId: line.productId,
        productUnitId: line.productUnitId,
        isManualLine: line.isManualLine,
        productNameSnapshot: line.productNameSnapshot,
        unitNameSnapshot: line.unitNameSnapshot,
        originalQuantityMilli: line.quantityMilli,
        previousReturnedQuantityMilli: priorByLine.get(line.id) ?? 0n,
        historicalNetValueMinor,
        conversionFactorNum: line.conversionFactorNum,
        conversionFactorDen: line.conversionFactorDen,
        historicalBaseQuantityMilli: line.baseQuantityMilli,
        costStatus: line.costStatus,
        historicalLineCostMinor: line.lineCostMinor,
        wasInventoryTracked: line.inventoryMovementId !== null,
        currentProductStatus: product?.status ?? null,
        currentProductTracksInventory: product?.trackInventory ?? null,
        currentUnitStatus: unit?.status ?? null,
      };
      return calculateSaleReturnLine(authority, request);
    });
    const totalReturnValueMinor = calculatedLines.reduce(
      (sum, line) => sum + line.returnValueMinor,
      0n,
    );

    const currentSaleReceivableMinor = sale.customerId
      ? await this.readCurrentSaleReceivable(transaction, storeId, sale.customerId, sale.id)
      : 0n;
    const historicalCustomerCreditTenderMinor = sale.customerId
      ? await this.readHistoricalCustomerCreditTender(transaction, storeId, sale.id)
      : 0n;
    const previouslyRestoredOriginalCreditMinor = sale.customerId
      ? await this.readPreviouslyRestoredOriginalCredit(transaction, storeId, sale.id)
      : 0n;
    const settlement = calculateSaleReturnSettlement({
      returnValueMinor: totalReturnValueMinor,
      customerId: sale.customerId,
      customerStatus,
      currentSaleReceivableMinor,
      historicalCustomerCreditTenderMinor,
      previouslyRestoredOriginalCreditMinor,
      residualSettlement: command.residualSettlement,
    });

    return {
      operationId: command.operationId,
      requestHash: command.requestHash,
      saleId: sale.id,
      saleDisplayNumber: sale.displayNumber,
      saleAt: sale.saleAt,
      acceptedAt,
      customerId: sale.customerId,
      customerStatus,
      occurredAt: command.occurredAt,
      reason: command.reason,
      lines: calculatedLines,
      totalReturnValueMinor,
      currentSaleReceivableMinor,
      historicalCustomerCreditTenderMinor,
      previouslyRestoredOriginalCreditMinor,
      settlement,
      postingInput: { operationId: command.operationId, occurredAt: command.occurredAt },
    };
  }

  private async lockCatalog(
    transaction: DatabaseTransaction,
    storeId: string,
    lockedLines: readonly {
      id: string;
      productId: string | null;
      productUnitId: string | null;
    }[],
    requestedIds: readonly string[],
  ): Promise<{
    products: Map<string, { status: 'active' | 'archived'; trackInventory: boolean }>;
    units: Map<string, { status: 'active' | 'archived' }>;
  }> {
    const requested = new Set(requestedIds);
    const productIds = [
      ...new Set(
        lockedLines
          .filter((line) => requested.has(line.id))
          .map((line) => line.productId)
          .filter((id): id is string => id !== null),
      ),
    ].sort(compareCanonical);
    const unitIds = [
      ...new Set(
        lockedLines
          .filter((line) => requested.has(line.id))
          .map((line) => line.productUnitId)
          .filter((id): id is string => id !== null),
      ),
    ].sort(compareCanonical);
    const productRows =
      productIds.length === 0
        ? []
        : await transaction
            .select({
              id: products.id,
              status: products.status,
              trackInventory: products.trackInventory,
            })
            .from(products)
            .where(and(eq(products.storeId, storeId), inArray(products.id, productIds)))
            .orderBy(asc(products.id))
            .for('share');
    const unitRows =
      unitIds.length === 0
        ? []
        : await transaction
            .select({
              id: productUnits.id,
              productId: productUnits.productId,
              status: productUnits.status,
            })
            .from(productUnits)
            .where(and(eq(productUnits.storeId, storeId), inArray(productUnits.id, unitIds)))
            .orderBy(asc(productUnits.id))
            .for('share');
    return {
      products: new Map(productRows.map((row) => [row.id, row])),
      units: new Map(unitRows.map((row) => [`${row.productId}:${row.id}`, row])),
    };
  }

  private async readCurrentSaleReceivable(
    transaction: DatabaseTransaction,
    storeId: string,
    customerId: string,
    saleId: string,
  ): Promise<bigint> {
    const result = await transaction.execute<AggregateRow>(sql`
      select coalesce(sum(receivable_delta_minor), 0)::text as amount
      from ledger.customer_ledger_entries
      where store_id = ${storeId}::uuid
        and customer_id = ${customerId}::uuid
        and source_sale_id = ${saleId}::uuid
    `);
    return this.nonnegativeAggregate(result.rows[0]?.amount);
  }

  private async readHistoricalCustomerCreditTender(
    transaction: DatabaseTransaction,
    storeId: string,
    saleId: string,
  ): Promise<bigint> {
    const [application] = await transaction
      .select({ amountMinor: saleCustomerCreditApplications.amountMinor })
      .from(saleCustomerCreditApplications)
      .where(
        and(
          eq(saleCustomerCreditApplications.storeId, storeId),
          eq(saleCustomerCreditApplications.saleId, saleId),
        ),
      );
    return application?.amountMinor ?? 0n;
  }

  private async readPreviouslyRestoredOriginalCredit(
    transaction: DatabaseTransaction,
    storeId: string,
    saleId: string,
  ): Promise<bigint> {
    const result = await transaction.execute<AggregateRow>(sql`
      select coalesce(sum(settlement.amount_minor), 0)::text as amount
      from ledger.sale_return_settlements settlement
      join ledger.sale_returns return_root
        on return_root.store_id = settlement.store_id
       and return_root.id = settlement.sale_return_id
      join ledger.customer_ledger_entries customer_entry
        on customer_entry.store_id = settlement.store_id
       and customer_entry.id = settlement.customer_ledger_entry_id
      where return_root.store_id = ${storeId}::uuid
        and return_root.sale_id = ${saleId}::uuid
        and return_root.status = 'posted'
        and settlement.settlement_type = 'customer_credit'
        and customer_entry.reference_type = 'sale_return_original_credit_restoration'
    `);
    return this.nonnegativeAggregate(result.rows[0]?.amount);
  }

  private nonnegativeAggregate(value: string | undefined): bigint {
    if (value === undefined) {
      throw new SaleReturnAuthorityError('SALE_RETURN_INTEGRITY_CONFLICT');
    }
    const amount = BigInt(value);
    if (amount < 0n) throw new SaleReturnAuthorityError('SALE_RETURN_INTEGRITY_CONFLICT');
    return amount;
  }
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
