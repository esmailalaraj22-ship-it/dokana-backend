import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import type { TenantTransactionContext } from '../database/database.types';
import {
  inventoryMovements,
  manualInventoryEntries,
  products,
  productUnits,
  stockBalances,
} from '../database/schema';
import type { InventoryOperationRecord, InventoryStockRecord } from './inventory-read.types';

@Injectable()
export class InventoryReadRepository {
  constructor(private readonly database: DatabaseService) {}

  findStock(
    context: TenantTransactionContext,
    productId: string,
  ): Promise<InventoryStockRecord | undefined> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      // One statement snapshot keeps tracking, projection and current units consistent.
      const rows = await transaction
        .select({
          product: {
            id: products.id,
            trackInventory: products.trackInventory,
            measurementType: products.measurementType,
          },
          balance: stockBalances,
          unit: {
            id: productUnits.id,
            unitName: productUnits.unitName,
            unitCode: productUnits.unitCode,
            isBase: productUnits.isBase,
            factorNum: productUnits.factorNum,
            factorDen: productUnits.factorDen,
            status: productUnits.status,
            measurementType: productUnits.measurementType,
          },
        })
        .from(products)
        .leftJoin(
          stockBalances,
          and(
            eq(stockBalances.storeId, products.storeId),
            eq(stockBalances.productId, products.id),
          ),
        )
        .leftJoin(
          productUnits,
          and(eq(productUnits.storeId, products.storeId), eq(productUnits.productId, products.id)),
        )
        .where(and(eq(products.storeId, context.storeId), eq(products.id, productId)))
        .orderBy(desc(productUnits.isBase), asc(productUnits.id));
      const first = rows[0];
      if (!first) return undefined;
      return {
        product: first.product,
        balance: first.balance,
        units: rows.flatMap((row) => (row.unit ? [row.unit] : [])),
      };
    });
  }

  findOperation(
    context: TenantTransactionContext,
    operationId: string,
  ): Promise<InventoryOperationRecord | undefined> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const rows = await transaction
        .select({ entry: manualInventoryEntries, movement: inventoryMovements })
        .from(manualInventoryEntries)
        .innerJoin(
          inventoryMovements,
          and(
            eq(inventoryMovements.storeId, manualInventoryEntries.storeId),
            eq(inventoryMovements.productId, manualInventoryEntries.productId),
            eq(inventoryMovements.id, manualInventoryEntries.movementId),
          ),
        )
        .where(
          and(
            eq(manualInventoryEntries.storeId, context.storeId),
            eq(manualInventoryEntries.operationId, operationId),
          ),
        )
        .limit(1);
      return rows[0];
    });
  }
}
