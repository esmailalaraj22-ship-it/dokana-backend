import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { accountingPeriods, devices, ledgerSchema, products, productUnits } from './ledger';

export const inventoryCostStates = ['known', 'unknown', 'pending'] as const;
export type InventoryCostState = (typeof inventoryCostStates)[number];
export const inventoryMovementTypes = [
  'opening_balance',
  'purchase_receipt',
  'sale',
  'customer_return_saleable',
  'supplier_return',
  'adjustment_in',
  'adjustment_out',
  'stock_count',
  'correction',
  'owner_use',
  'gift',
  'damage',
  'loss',
  'expiry',
] as const;
export type InventoryMovementType = (typeof inventoryMovementTypes)[number];

// SQL migration 0007 owns RLS, triggers, grants and deferred constraints. Drizzle
// models their columns/relationships without trying to regenerate that behavior.
export const inventoryMovements = ledgerSchema.table(
  'inventory_movements',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    productId: uuid('product_id').notNull(),
    accountingPeriodId: uuid('accounting_period_id').notNull(),
    movementType: text('movement_type').$type<InventoryMovementType>().notNull(),
    quantityBeforeMilli: bigint('quantity_before_milli', { mode: 'bigint' }).notNull(),
    quantityDeltaMilli: bigint('quantity_delta_milli', { mode: 'bigint' }).notNull(),
    quantityAfterMilli: bigint('quantity_after_milli', { mode: 'bigint' }).notNull(),
    inventoryValueBeforeMinor: bigint('inventory_value_before_minor', { mode: 'bigint' }).notNull(),
    valueDeltaMinor: bigint('value_delta_minor', { mode: 'bigint' }).notNull(),
    inventoryValueAfterMinor: bigint('inventory_value_after_minor', { mode: 'bigint' }).notNull(),
    averageUnitCostAfterMinor: bigint('average_unit_cost_after_minor', {
      mode: 'bigint',
    }).notNull(),
    costStatus: text('cost_status').$type<InventoryCostState>().notNull(),
    hasPendingCostAfter: boolean('has_pending_cost_after').notNull().default(false),
    referenceType: text('reference_type').notNull(),
    referenceId: uuid('reference_id').notNull(),
    transactionGroupId: uuid('transaction_group_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    reversalOfId: uuid('reversal_of_id'),
    reason: text('reason'),
    deviceId: uuid('device_id'),
    operationId: uuid('operation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    productUnitId: uuid('product_unit_id').notNull(),
    selectedQuantityMilli: bigint('selected_quantity_milli', { mode: 'bigint' }).notNull(),
    factorNum: integer('factor_num').notNull(),
    factorDen: integer('factor_den').notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    postingDate: date('posting_date', { mode: 'string' }).notNull(),
    costStateBefore: text('cost_state_before').$type<InventoryCostState>().notNull(),
    costStateAfter: text('cost_state_after').$type<InventoryCostState>().notNull(),
  },
  (t) => [
    unique('inventory_movements_store_id_id_key').on(t.storeId, t.id),
    unique('inventory_movements_store_id_operation_id_key').on(t.storeId, t.operationId),
    unique('inventory_movements_product_identity_key').on(t.storeId, t.productId, t.id),
    foreignKey({
      name: 'inventory_movements_store_id_product_id_fkey',
      columns: [t.storeId, t.productId],
      foreignColumns: [products.storeId, products.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'inventory_movements_store_id_accounting_period_id_fkey',
      columns: [t.storeId, t.accountingPeriodId],
      foreignColumns: [accountingPeriods.storeId, accountingPeriods.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'inventory_movements_store_id_reversal_of_id_fkey',
      columns: [t.storeId, t.reversalOfId],
      foreignColumns: [t.storeId, t.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'inventory_movements_store_id_device_id_fkey',
      columns: [t.storeId, t.deviceId],
      foreignColumns: [devices.storeId, devices.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'inventory_movements_unit_fkey',
      columns: [t.storeId, t.productId, t.productUnitId],
      foreignColumns: [productUnits.storeId, productUnits.productId, productUnits.id],
    }).onDelete('restrict'),
    check(
      'inventory_movements_movement_type_check',
      sql`${t.movementType} in ('opening_balance', 'purchase_receipt', 'sale', 'customer_return_saleable', 'supplier_return', 'adjustment_in', 'adjustment_out', 'stock_count', 'correction', 'owner_use', 'gift', 'damage', 'loss', 'expiry')`,
    ),
    check('inventory_movements_quantity_delta_milli_check', sql`${t.quantityDeltaMilli} <> 0`),
    check(
      'inventory_movements_average_unit_cost_after_minor_check',
      sql`${t.averageUnitCostAfterMinor} >= 0`,
    ),
    check(
      'inventory_movements_cost_status_check',
      sql`${t.costStatus} in ('known', 'unknown', 'pending')`,
    ),
    check(
      'inventory_movements_cost_state_before_check',
      sql`${t.costStateBefore} in ('known', 'unknown', 'pending')`,
    ),
    check(
      'inventory_movements_cost_state_after_check',
      sql`${t.costStateAfter} in ('known', 'unknown', 'pending')`,
    ),
    check(
      'inventory_movements_check',
      sql`${t.quantityAfterMilli} = ${t.quantityBeforeMilli} + ${t.quantityDeltaMilli}`,
    ),
    check(
      'inventory_movements_check1',
      sql`${t.inventoryValueAfterMinor} = ${t.inventoryValueBeforeMinor} + ${t.valueDeltaMinor}`,
    ),
    check(
      'inventory_movements_check2',
      sql`(${t.quantityAfterMilli} = 0 and ${t.inventoryValueAfterMinor} = 0 and ${t.averageUnitCostAfterMinor} = 0) or ${t.quantityAfterMilli} <> 0`,
    ),
    check(
      'inventory_movements_quantity_snapshot_check',
      sql`${t.selectedQuantityMilli} > 0 and ${t.factorNum} > 0 and ${t.factorDen} > 0 and abs(${t.quantityDeltaMilli}::numeric) = ledger.inventory_base_quantity(${t.selectedQuantityMilli}, ${t.factorNum}, ${t.factorDen})::numeric`,
    ),
    check(
      'inventory_movements_dates_check',
      sql`isfinite(${t.occurredAt}) and ${t.businessDate} = (${t.occurredAt} at time zone 'Asia/Hebron')::date and ${t.postingDate} = ${t.businessDate}`,
    ),
    check(
      'inventory_movements_cost_values_check',
      sql`(${t.costStateBefore} = 'known' or ${t.inventoryValueBeforeMinor} = 0) and (${t.costStateAfter} = 'known' or (${t.inventoryValueAfterMinor} = 0 and ${t.averageUnitCostAfterMinor} = 0)) and (${t.costStateAfter} <> 'known' or ${t.inventoryValueAfterMinor} >= 0) and ${t.hasPendingCostAfter} = (${t.costStateAfter} = 'pending') and (${t.quantityAfterMilli} >= 0 or ${t.costStateAfter} = 'pending')`,
    ),
    check(
      'inventory_movements_cost_transition_check',
      sql`(${t.costStatus} <> 'unknown' or ${t.costStateAfter} <> 'known' or ${t.quantityAfterMilli} = 0) and (${t.costStateBefore} = 'known' or ${t.costStateAfter} <> 'known' or ${t.quantityBeforeMilli} = 0 or ${t.quantityAfterMilli} = 0)`,
    ),
    foreignKey({
      name: 'inventory_movements_reversal_product_fkey',
      columns: [t.storeId, t.productId, t.reversalOfId],
      foreignColumns: [t.storeId, t.productId, t.id],
    }).onDelete('restrict'),
    check(
      'inventory_movements_reversal_identity_check',
      sql`${t.reversalOfId} is null or ${t.reversalOfId} <> ${t.id}`,
    ),
    index('idx_inventory_movements_product_time').on(t.storeId, t.productId, t.occurredAt.desc()),
    index('idx_inventory_movements_time_brin').using('brin', t.occurredAt),
    index('idx_inventory_movements_group').on(t.storeId, t.transactionGroupId, t.id),
    uniqueIndex('uq_inventory_movement_reversal')
      .on(t.storeId, t.reversalOfId)
      .where(sql`${t.reversalOfId} is not null`),
  ],
);

export const stockBalances = ledgerSchema.table(
  'stock_balances',
  {
    storeId: uuid('store_id').notNull(),
    productId: uuid('product_id').notNull(),
    quantityMilli: bigint('quantity_milli', { mode: 'bigint' }).notNull().default(0n),
    averageUnitCostMinor: bigint('average_unit_cost_minor', { mode: 'bigint' })
      .notNull()
      .default(0n),
    inventoryValueMinor: bigint('inventory_value_minor', { mode: 'bigint' }).notNull().default(0n),
    hasPendingCost: boolean('has_pending_cost').notNull().default(false),
    lastMovementId: uuid('last_movement_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
    costState: text('cost_state').$type<InventoryCostState>().notNull(),
  },
  (t) => [
    primaryKey({ name: 'stock_balances_pkey', columns: [t.storeId, t.productId] }),
    foreignKey({
      name: 'stock_balances_store_id_product_id_fkey',
      columns: [t.storeId, t.productId],
      foreignColumns: [products.storeId, products.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    // Deferred in SQL because the BEFORE movement trigger writes this projection.
    foreignKey({
      name: 'stock_balances_last_movement_fkey',
      columns: [t.storeId, t.productId, t.lastMovementId],
      foreignColumns: [
        inventoryMovements.storeId,
        inventoryMovements.productId,
        inventoryMovements.id,
      ],
    }),
    check('stock_balances_average_unit_cost_minor_check', sql`${t.averageUnitCostMinor} >= 0`),
    check('stock_balances_version_check', sql`${t.version} >= 1`),
    check(
      'stock_balances_cost_state_check',
      sql`${t.costState} in ('known', 'unknown', 'pending')`,
    ),
    check(
      'stock_balances_cost_values_check',
      sql`(${t.costState} = 'known' or (${t.inventoryValueMinor} = 0 and ${t.averageUnitCostMinor} = 0)) and (${t.costState} <> 'known' or ${t.inventoryValueMinor} >= 0) and ${t.hasPendingCost} = (${t.costState} = 'pending') and (${t.quantityMilli} >= 0 or ${t.costState} = 'pending') and (${t.quantityMilli} <> 0 or (${t.inventoryValueMinor} = 0 and ${t.averageUnitCostMinor} = 0))`,
    ),
  ],
);

export const manualInventoryEntries = ledgerSchema.table(
  'manual_inventory_entries',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    operationId: uuid('operation_id').notNull(),
    productId: uuid('product_id').notNull(),
    productUnitId: uuid('product_unit_id').notNull(),
    selectedQuantityMilli: bigint('selected_quantity_milli', { mode: 'bigint' }).notNull(),
    baseQuantityMilli: bigint('base_quantity_milli', { mode: 'bigint' }).notNull(),
    factorNum: integer('factor_num').notNull(),
    factorDen: integer('factor_den').notNull(),
    totalPurchaseCostMinor: bigint('total_purchase_cost_minor', { mode: 'bigint' }),
    costStatus: text('cost_status').$type<InventoryCostState>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    postingDate: date('posting_date', { mode: 'string' }).notNull(),
    accountingPeriodId: uuid('accounting_period_id').notNull(),
    movementId: uuid('movement_id').notNull(),
    transactionGroupId: uuid('transaction_group_id').notNull(),
    reason: text('reason'),
    deviceId: uuid('device_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    unique('manual_inventory_entries_store_id_id_key').on(t.storeId, t.id),
    unique('manual_inventory_entries_store_id_operation_id_key').on(t.storeId, t.operationId),
    unique('manual_inventory_entries_store_id_movement_id_key').on(t.storeId, t.movementId),
    foreignKey({
      name: 'manual_inventory_entries_product_fkey',
      columns: [t.storeId, t.productId],
      foreignColumns: [products.storeId, products.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'manual_inventory_entries_unit_fkey',
      columns: [t.storeId, t.productId, t.productUnitId],
      foreignColumns: [productUnits.storeId, productUnits.productId, productUnits.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'manual_inventory_entries_period_fkey',
      columns: [t.storeId, t.accountingPeriodId],
      foreignColumns: [accountingPeriods.storeId, accountingPeriods.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'manual_inventory_entries_device_fkey',
      columns: [t.storeId, t.deviceId],
      foreignColumns: [devices.storeId, devices.id],
    }).onDelete('restrict'),
    // DEFERRABLE INITIALLY DEFERRED is maintained by migration 0007.
    foreignKey({
      name: 'manual_inventory_entries_movement_fkey',
      columns: [t.storeId, t.productId, t.movementId],
      foreignColumns: [
        inventoryMovements.storeId,
        inventoryMovements.productId,
        inventoryMovements.id,
      ],
    }),
    check(
      'manual_inventory_entries_selected_quantity_milli_check',
      sql`${t.selectedQuantityMilli} > 0`,
    ),
    check('manual_inventory_entries_base_quantity_milli_check', sql`${t.baseQuantityMilli} > 0`),
    check('manual_inventory_entries_factor_num_check', sql`${t.factorNum} > 0`),
    check('manual_inventory_entries_factor_den_check', sql`${t.factorDen} > 0`),
    check(
      'manual_inventory_entries_total_purchase_cost_minor_check',
      sql`${t.totalPurchaseCostMinor} >= 0`,
    ),
    check(
      'manual_inventory_entries_cost_status_check',
      sql`${t.costStatus} in ('known', 'unknown', 'pending')`,
    ),
    check(
      'manual_inventory_entries_quantity_check',
      sql`${t.baseQuantityMilli} = ledger.inventory_base_quantity(${t.selectedQuantityMilli}, ${t.factorNum}, ${t.factorDen})`,
    ),
    check(
      'manual_inventory_entries_cost_check',
      sql`(${t.totalPurchaseCostMinor} is null or ${t.costStatus} = 'known') and (${t.costStatus} <> 'unknown' or ${t.totalPurchaseCostMinor} is null)`,
    ),
    check(
      'manual_inventory_entries_dates_check',
      sql`isfinite(${t.occurredAt}) and ${t.businessDate} = (${t.occurredAt} at time zone 'Asia/Hebron')::date and ${t.postingDate} = ${t.businessDate}`,
    ),
    check('manual_inventory_entries_group_check', sql`${t.transactionGroupId} = ${t.operationId}`),
    index('idx_manual_inventory_entries_product_time').on(
      t.storeId,
      t.productId,
      t.occurredAt,
      t.id,
    ),
  ],
);

export const stockCounts = ledgerSchema.table(
  'stock_counts',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    accountingPeriodId: uuid('accounting_period_id'),
    displayNumber: text('display_number').notNull(),
    countType: text('count_type').$type<'full' | 'partial'>().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    status: text('status')
      .$type<'draft' | 'counting' | 'posted' | 'cancelled'>()
      .notNull()
      .default('draft'),
    notes: text('notes'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    deviceId: uuid('device_id'),
    operationId: uuid('operation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }),
    businessDate: date('business_date', { mode: 'string' }),
    postingDate: date('posting_date', { mode: 'string' }),
  },
  (t) => [
    unique('stock_counts_store_id_id_key').on(t.storeId, t.id),
    unique('stock_counts_store_id_display_number_key').on(t.storeId, t.displayNumber),
    unique('stock_counts_store_id_operation_id_key').on(t.storeId, t.operationId),
    foreignKey({
      name: 'stock_counts_store_id_accounting_period_id_fkey',
      columns: [t.storeId, t.accountingPeriodId],
      foreignColumns: [accountingPeriods.storeId, accountingPeriods.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'stock_counts_store_id_device_id_fkey',
      columns: [t.storeId, t.deviceId],
      foreignColumns: [devices.storeId, devices.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    check('stock_counts_count_type_check', sql`${t.countType} in ('full', 'partial')`),
    check(
      'stock_counts_status_check',
      sql`${t.status} in ('draft', 'counting', 'posted', 'cancelled')`,
    ),
    check('stock_counts_version_check', sql`${t.version} >= 1`),
    check(
      'stock_counts_check',
      sql`(${t.status} = 'posted' and ${t.completedAt} is not null) or ${t.status} <> 'posted'`,
    ),
    check(
      'stock_counts_check1',
      sql`(${t.status} = 'cancelled' and ${t.cancelledAt} is not null) or ${t.status} <> 'cancelled'`,
    ),
    check(
      'stock_counts_posting_context_check',
      sql`${t.status} <> 'posted' or (${t.accountingPeriodId} is not null and ${t.occurredAt} is not null and ${t.businessDate} is not null and ${t.postingDate} is not null and isfinite(${t.occurredAt}) and ${t.businessDate} = (${t.occurredAt} at time zone 'Asia/Hebron')::date and ${t.postingDate} = ${t.businessDate})`,
    ),
    index('idx_stock_counts_time').on(t.storeId, t.startedAt.desc(), t.status),
  ],
);

export const stockCountItems = ledgerSchema.table(
  'stock_count_items',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    stockCountId: uuid('stock_count_id').notNull(),
    productId: uuid('product_id').notNull(),
    systemQuantityMilli: bigint('system_quantity_milli', { mode: 'bigint' }).notNull(),
    actualQuantityMilli: bigint('actual_quantity_milli', { mode: 'bigint' }).notNull(),
    differenceMilli: bigint('difference_milli', { mode: 'bigint' }).notNull(),
    adjustmentMovementId: uuid('adjustment_movement_id'),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
    productUnitId: uuid('product_unit_id').notNull(),
    selectedQuantityMilli: bigint('selected_quantity_milli', { mode: 'bigint' }).notNull(),
    factorNum: integer('factor_num').notNull(),
    factorDen: integer('factor_den').notNull(),
  },
  (t) => [
    unique('stock_count_items_store_id_id_key').on(t.storeId, t.id),
    unique('stock_count_items_stock_count_id_product_id_key').on(t.stockCountId, t.productId),
    unique('stock_count_items_store_id_adjustment_movement_id_key').on(
      t.storeId,
      t.adjustmentMovementId,
    ),
    foreignKey({
      name: 'stock_count_items_store_id_stock_count_id_fkey',
      columns: [t.storeId, t.stockCountId],
      foreignColumns: [stockCounts.storeId, stockCounts.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'stock_count_items_store_id_product_id_fkey',
      columns: [t.storeId, t.productId],
      foreignColumns: [products.storeId, products.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'stock_count_items_store_id_adjustment_movement_id_fkey',
      columns: [t.storeId, t.adjustmentMovementId],
      foreignColumns: [inventoryMovements.storeId, inventoryMovements.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'stock_count_items_unit_fkey',
      columns: [t.storeId, t.productId, t.productUnitId],
      foreignColumns: [productUnits.storeId, productUnits.productId, productUnits.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'stock_count_items_movement_product_fkey',
      columns: [t.storeId, t.productId, t.adjustmentMovementId],
      foreignColumns: [
        inventoryMovements.storeId,
        inventoryMovements.productId,
        inventoryMovements.id,
      ],
    }).onDelete('restrict'),
    check(
      'stock_count_items_check',
      sql`${t.differenceMilli} = ${t.actualQuantityMilli} - ${t.systemQuantityMilli}`,
    ),
    check('stock_count_items_version_check', sql`${t.version} >= 1`),
    check(
      'stock_count_items_actual_quantity_check',
      sql`${t.actualQuantityMilli} >= 0 and ${t.selectedQuantityMilli} >= 0 and ${t.factorNum} > 0 and ${t.factorDen} > 0 and ${t.actualQuantityMilli} = ledger.inventory_base_quantity(${t.selectedQuantityMilli}, ${t.factorNum}, ${t.factorDen})`,
    ),
  ],
);

export type InventoryMovement = typeof inventoryMovements.$inferSelect;
export type StockBalance = typeof stockBalances.$inferSelect;
export type ManualInventoryEntry = typeof manualInventoryEntries.$inferSelect;
export type StockCount = typeof stockCounts.$inferSelect;
export type StockCountItem = typeof stockCountItems.$inferSelect;
