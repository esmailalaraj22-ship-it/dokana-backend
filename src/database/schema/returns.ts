import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { inventoryMovements } from './inventory';
import {
  accountingPeriods,
  customers,
  devices,
  ledgerSchema,
  moneyAccounts,
  moneyMovements,
  products,
  productUnits,
  suppliers,
} from './ledger';
import { customerLedgerEntries, saleItems, sales } from './sales';
import { purchaseInvoices, supplierLedgerEntries } from './supplier-finance';

export const returnStatuses = ['draft', 'posted', 'cancelled'] as const;
export type ReturnStatus = (typeof returnStatuses)[number];

export const saleReturnItemConditions = ['saleable', 'damaged'] as const;
export type SaleReturnItemCondition = (typeof saleReturnItemConditions)[number];

export const saleReturnSettlementTypes = [
  'reduce_receivable',
  'customer_credit',
  'money_refund',
] as const;
export type SaleReturnSettlementType = (typeof saleReturnSettlementTypes)[number];

export const supplierReturnSettlementTypes = [
  'reduce_payable',
  'supplier_credit',
  'money_refund_received',
] as const;
export type SupplierReturnSettlementType = (typeof supplierReturnSettlementTypes)[number];

export const saleReturns = ledgerSchema.table(
  'sale_returns',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    saleId: uuid('sale_id').notNull(),
    customerId: uuid('customer_id'),
    accountingPeriodId: uuid('accounting_period_id'),
    displayNumber: text('display_number').notNull(),
    returnAt: timestamp('return_at', { withTimezone: true, mode: 'date' }).notNull(),
    totalMinor: bigint('total_minor', { mode: 'bigint' }).notNull().default(0n),
    status: text('status').$type<ReturnStatus>().notNull().default('draft'),
    notes: text('notes'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    deviceId: uuid('device_id'),
    operationId: uuid('operation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  },
  (table) => [
    unique('sale_returns_store_id_id_key').on(table.storeId, table.id),
    unique('sale_returns_store_id_display_number_key').on(table.storeId, table.displayNumber),
    unique('sale_returns_store_id_operation_id_key').on(table.storeId, table.operationId),
    foreignKey({
      name: 'sale_returns_store_id_sale_id_fkey',
      columns: [table.storeId, table.saleId],
      foreignColumns: [sales.storeId, sales.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'sale_returns_store_id_customer_id_fkey',
      columns: [table.storeId, table.customerId],
      foreignColumns: [customers.storeId, customers.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'sale_returns_store_id_accounting_period_id_fkey',
      columns: [table.storeId, table.accountingPeriodId],
      foreignColumns: [accountingPeriods.storeId, accountingPeriods.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'sale_returns_store_id_device_id_fkey',
      columns: [table.storeId, table.deviceId],
      foreignColumns: [devices.storeId, devices.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    check('sale_returns_total_minor_check', sql`${table.totalMinor} >= 0`),
    check('sale_returns_status_check', sql`${table.status} in ('draft', 'posted', 'cancelled')`),
    check('sale_returns_version_check', sql`${table.version} >= 1`),
    check(
      'sale_returns_check',
      sql`(${table.status} = 'cancelled' and ${table.cancelledAt} is not null) or ${table.status} <> 'cancelled'`,
    ),
    index('idx_sale_returns_sale').on(
      table.storeId,
      table.saleId,
      table.returnAt.desc(),
      table.status,
    ),
  ],
);

export const saleReturnItems = ledgerSchema.table(
  'sale_return_items',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    saleReturnId: uuid('sale_return_id').notNull(),
    saleItemId: uuid('sale_item_id').notNull(),
    quantityMilli: bigint('quantity_milli', { mode: 'bigint' }).notNull(),
    baseQuantityMilli: bigint('base_quantity_milli', { mode: 'bigint' }),
    lineRefundMinor: bigint('line_refund_minor', { mode: 'bigint' }).notNull(),
    itemCondition: text('item_condition').$type<SaleReturnItemCondition>().notNull(),
    inventoryMovementId: uuid('inventory_movement_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  },
  (table) => [
    unique('sale_return_items_store_id_id_key').on(table.storeId, table.id),
    unique('sale_return_items_store_id_inventory_movement_id_key').on(
      table.storeId,
      table.inventoryMovementId,
    ),
    foreignKey({
      name: 'sale_return_items_store_id_sale_return_id_fkey',
      columns: [table.storeId, table.saleReturnId],
      foreignColumns: [saleReturns.storeId, saleReturns.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'sale_return_items_store_id_sale_item_id_fkey',
      columns: [table.storeId, table.saleItemId],
      foreignColumns: [saleItems.storeId, saleItems.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'sale_return_items_store_id_inventory_movement_id_fkey',
      columns: [table.storeId, table.inventoryMovementId],
      foreignColumns: [inventoryMovements.storeId, inventoryMovements.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    check('sale_return_items_quantity_milli_check', sql`${table.quantityMilli} > 0`),
    check('sale_return_items_line_refund_minor_check', sql`${table.lineRefundMinor} >= 0`),
    check(
      'sale_return_items_item_condition_check',
      sql`${table.itemCondition} in ('saleable', 'damaged')`,
    ),
    check('sale_return_items_version_check', sql`${table.version} >= 1`),
  ],
);

export const supplierReturns = ledgerSchema.table(
  'supplier_returns',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    supplierId: uuid('supplier_id').notNull(),
    purchaseInvoiceId: uuid('purchase_invoice_id'),
    accountingPeriodId: uuid('accounting_period_id'),
    displayNumber: text('display_number').notNull(),
    returnAt: timestamp('return_at', { withTimezone: true, mode: 'date' }).notNull(),
    totalMinor: bigint('total_minor', { mode: 'bigint' }).notNull().default(0n),
    status: text('status').$type<ReturnStatus>().notNull().default('draft'),
    notes: text('notes'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    deviceId: uuid('device_id'),
    operationId: uuid('operation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  },
  (table) => [
    unique('supplier_returns_store_id_id_key').on(table.storeId, table.id),
    unique('supplier_returns_store_id_display_number_key').on(table.storeId, table.displayNumber),
    unique('supplier_returns_store_id_operation_id_key').on(table.storeId, table.operationId),
    foreignKey({
      name: 'supplier_returns_store_id_supplier_id_fkey',
      columns: [table.storeId, table.supplierId],
      foreignColumns: [suppliers.storeId, suppliers.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'supplier_returns_store_id_purchase_invoice_id_fkey',
      columns: [table.storeId, table.purchaseInvoiceId],
      foreignColumns: [purchaseInvoices.storeId, purchaseInvoices.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'supplier_returns_store_id_accounting_period_id_fkey',
      columns: [table.storeId, table.accountingPeriodId],
      foreignColumns: [accountingPeriods.storeId, accountingPeriods.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'supplier_returns_store_id_device_id_fkey',
      columns: [table.storeId, table.deviceId],
      foreignColumns: [devices.storeId, devices.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    check('supplier_returns_total_minor_check', sql`${table.totalMinor} >= 0`),
    check(
      'supplier_returns_status_check',
      sql`${table.status} in ('draft', 'posted', 'cancelled')`,
    ),
    check('supplier_returns_version_check', sql`${table.version} >= 1`),
    check(
      'supplier_returns_check',
      sql`(${table.status} = 'cancelled' and ${table.cancelledAt} is not null) or ${table.status} <> 'cancelled'`,
    ),
    index('idx_supplier_returns_supplier').on(
      table.storeId,
      table.supplierId,
      table.returnAt.desc(),
      table.status,
    ),
  ],
);

export const supplierReturnItems = ledgerSchema.table(
  'supplier_return_items',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    supplierReturnId: uuid('supplier_return_id').notNull(),
    productId: uuid('product_id').notNull(),
    productUnitId: uuid('product_unit_id').notNull(),
    quantityMilli: bigint('quantity_milli', { mode: 'bigint' }).notNull(),
    conversionFactorNum: integer('conversion_factor_num').notNull(),
    conversionFactorDen: integer('conversion_factor_den').notNull(),
    baseQuantityMilli: bigint('base_quantity_milli', { mode: 'bigint' }).notNull(),
    unitCostMinor: bigint('unit_cost_minor', { mode: 'bigint' }).notNull(),
    lineTotalMinor: bigint('line_total_minor', { mode: 'bigint' }).notNull(),
    inventoryMovementId: uuid('inventory_movement_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  },
  (table) => [
    unique('supplier_return_items_store_id_id_key').on(table.storeId, table.id),
    unique('supplier_return_items_store_id_inventory_movement_id_key').on(
      table.storeId,
      table.inventoryMovementId,
    ),
    foreignKey({
      name: 'supplier_return_items_store_id_supplier_return_id_fkey',
      columns: [table.storeId, table.supplierReturnId],
      foreignColumns: [supplierReturns.storeId, supplierReturns.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'supplier_return_items_store_id_product_id_fkey',
      columns: [table.storeId, table.productId],
      foreignColumns: [products.storeId, products.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'supplier_return_items_store_id_product_id_product_unit_id_fkey',
      columns: [table.storeId, table.productId, table.productUnitId],
      foreignColumns: [productUnits.storeId, productUnits.productId, productUnits.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'supplier_return_items_store_id_inventory_movement_id_fkey',
      columns: [table.storeId, table.inventoryMovementId],
      foreignColumns: [inventoryMovements.storeId, inventoryMovements.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    check('supplier_return_items_quantity_milli_check', sql`${table.quantityMilli} > 0`),
    check(
      'supplier_return_items_conversion_factor_num_check',
      sql`${table.conversionFactorNum} > 0`,
    ),
    check(
      'supplier_return_items_conversion_factor_den_check',
      sql`${table.conversionFactorDen} > 0`,
    ),
    check('supplier_return_items_base_quantity_milli_check', sql`${table.baseQuantityMilli} > 0`),
    check('supplier_return_items_unit_cost_minor_check', sql`${table.unitCostMinor} >= 0`),
    check('supplier_return_items_line_total_minor_check', sql`${table.lineTotalMinor} >= 0`),
    check('supplier_return_items_version_check', sql`${table.version} >= 1`),
    check(
      'supplier_return_items_check',
      sql`${table.baseQuantityMilli} * ${table.conversionFactorDen} = ${table.quantityMilli} * ${table.conversionFactorNum}`,
    ),
  ],
);

export const saleReturnSettlements = ledgerSchema.table(
  'sale_return_settlements',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    saleReturnId: uuid('sale_return_id').notNull(),
    settlementType: text('settlement_type').$type<SaleReturnSettlementType>().notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    moneyAccountId: uuid('money_account_id'),
    moneyMovementId: uuid('money_movement_id'),
    customerLedgerEntryId: uuid('customer_ledger_entry_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('sale_return_settlements_store_id_id_key').on(table.storeId, table.id),
    unique('sale_return_settlements_store_id_money_movement_id_key').on(
      table.storeId,
      table.moneyMovementId,
    ),
    unique('sale_return_settlements_store_id_customer_ledger_entry_id_key').on(
      table.storeId,
      table.customerLedgerEntryId,
    ),
    foreignKey({
      name: 'sale_return_settlements_store_id_sale_return_id_fkey',
      columns: [table.storeId, table.saleReturnId],
      foreignColumns: [saleReturns.storeId, saleReturns.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'sale_return_settlements_store_id_money_account_id_fkey',
      columns: [table.storeId, table.moneyAccountId],
      foreignColumns: [moneyAccounts.storeId, moneyAccounts.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'sale_return_settlements_store_id_money_movement_id_fkey',
      columns: [table.storeId, table.moneyMovementId],
      foreignColumns: [moneyMovements.storeId, moneyMovements.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'sale_return_settlements_store_id_customer_ledger_entry_id_fkey',
      columns: [table.storeId, table.customerLedgerEntryId],
      foreignColumns: [customerLedgerEntries.storeId, customerLedgerEntries.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    check('sale_return_settlements_amount_minor_check', sql`${table.amountMinor} > 0`),
    check(
      'sale_return_settlements_settlement_type_check',
      sql`${table.settlementType} in ('reduce_receivable', 'customer_credit', 'money_refund')`,
    ),
    check(
      'sale_return_settlements_check',
      sql`(${table.settlementType} = 'money_refund' and ${table.moneyAccountId} is not null and ${table.moneyMovementId} is not null and ${table.customerLedgerEntryId} is null) or (${table.settlementType} in ('reduce_receivable', 'customer_credit') and ${table.moneyAccountId} is null and ${table.moneyMovementId} is null and ${table.customerLedgerEntryId} is not null)`,
    ),
  ],
);

export const supplierReturnSettlements = ledgerSchema.table(
  'supplier_return_settlements',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    supplierReturnId: uuid('supplier_return_id').notNull(),
    settlementType: text('settlement_type').$type<SupplierReturnSettlementType>().notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    moneyAccountId: uuid('money_account_id'),
    moneyMovementId: uuid('money_movement_id'),
    supplierLedgerEntryId: uuid('supplier_ledger_entry_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('supplier_return_settlements_store_id_id_key').on(table.storeId, table.id),
    unique('supplier_return_settlements_store_id_money_movement_id_key').on(
      table.storeId,
      table.moneyMovementId,
    ),
    unique('supplier_return_settlements_store_id_supplier_ledger_entry__key').on(
      table.storeId,
      table.supplierLedgerEntryId,
    ),
    foreignKey({
      name: 'supplier_return_settlements_store_id_supplier_return_id_fkey',
      columns: [table.storeId, table.supplierReturnId],
      foreignColumns: [supplierReturns.storeId, supplierReturns.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'supplier_return_settlements_store_id_money_account_id_fkey',
      columns: [table.storeId, table.moneyAccountId],
      foreignColumns: [moneyAccounts.storeId, moneyAccounts.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'supplier_return_settlements_store_id_money_movement_id_fkey',
      columns: [table.storeId, table.moneyMovementId],
      foreignColumns: [moneyMovements.storeId, moneyMovements.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'supplier_return_settlements_store_id_supplier_ledger_entry_fkey',
      columns: [table.storeId, table.supplierLedgerEntryId],
      foreignColumns: [supplierLedgerEntries.storeId, supplierLedgerEntries.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    check('supplier_return_settlements_amount_minor_check', sql`${table.amountMinor} > 0`),
    check(
      'supplier_return_settlements_settlement_type_check',
      sql`${table.settlementType} in ('reduce_payable', 'supplier_credit', 'money_refund_received')`,
    ),
    check(
      'supplier_return_settlements_check',
      sql`(${table.settlementType} = 'money_refund_received' and ${table.moneyAccountId} is not null and ${table.moneyMovementId} is not null and ${table.supplierLedgerEntryId} is null) or (${table.settlementType} in ('reduce_payable', 'supplier_credit') and ${table.moneyAccountId} is null and ${table.moneyMovementId} is null and ${table.supplierLedgerEntryId} is not null)`,
    ),
  ],
);
