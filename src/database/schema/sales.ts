import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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
  stores,
} from './ledger';

export const salePaymentStatuses = ['paid', 'partial', 'credit'] as const;
export type SalePaymentStatus = (typeof salePaymentStatuses)[number];

export const customerPaymentStatuses = ['draft', 'posted', 'cancelled'] as const;
export type CustomerPaymentStatus = (typeof customerPaymentStatuses)[number];

export const saleStatuses = ['draft', 'posted', 'cancelled', 'corrected'] as const;
export type SaleStatus = (typeof saleStatuses)[number];

// `estimated` remains readable because it exists in the approved physical schema.
// New S14 writes must use only the cost states approved by the S14 contract.
export const saleItemCostStatuses = ['known', 'estimated', 'pending', 'unknown'] as const;
export type SaleItemCostStatus = (typeof saleItemCostStatuses)[number];

export const customerLedgerEntryTypes = [
  'sale_credit',
  'payment',
  'return',
  'settlement',
  'opening_balance',
  'credit_created',
  'credit_used',
  'refund',
  'correction',
] as const;
export type CustomerLedgerEntryType = (typeof customerLedgerEntryTypes)[number];

export const sales = ledgerSchema.table(
  'sales',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    customerId: uuid('customer_id'),
    accountingPeriodId: uuid('accounting_period_id'),
    displayNumber: text('display_number').notNull(),
    saleAt: timestamp('sale_at', { withTimezone: true, mode: 'date' }).notNull(),
    itemsSubtotalMinor: bigint('items_subtotal_minor', { mode: 'bigint' }).notNull().default(0n),
    lineDiscountTotalMinor: bigint('line_discount_total_minor', { mode: 'bigint' })
      .notNull()
      .default(0n),
    invoiceDiscountMinor: bigint('invoice_discount_minor', { mode: 'bigint' })
      .notNull()
      .default(0n),
    roundingMinor: bigint('rounding_minor', { mode: 'bigint' }).notNull().default(0n),
    totalMinor: bigint('total_minor', { mode: 'bigint' }).notNull().default(0n),
    paidTotalMinor: bigint('paid_total_minor', { mode: 'bigint' }).notNull().default(0n),
    creditTotalMinor: bigint('credit_total_minor', { mode: 'bigint' }).notNull().default(0n),
    knownCostTotalMinor: bigint('known_cost_total_minor', { mode: 'bigint' }).notNull().default(0n),
    pendingCostLineCount: integer('pending_cost_line_count').notNull().default(0),
    unknownCostLineCount: integer('unknown_cost_line_count').notNull().default(0),
    paymentStatus: text('payment_status').$type<SalePaymentStatus>().notNull().default('paid'),
    status: text('status').$type<SaleStatus>().notNull().default('draft'),
    notes: text('notes'),
    correctionOfId: uuid('correction_of_id'),
    reversedById: uuid('reversed_by_id'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    deviceId: uuid('device_id'),
    operationId: uuid('operation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  },
  (table) => [
    unique('sales_store_id_id_key').on(table.storeId, table.id),
    unique('sales_store_id_display_number_key').on(table.storeId, table.displayNumber),
    unique('sales_store_id_operation_id_key').on(table.storeId, table.operationId),
    foreignKey({
      name: 'sales_store_id_fkey',
      columns: [table.storeId],
      foreignColumns: [stores.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'sales_store_id_customer_id_fkey',
      columns: [table.storeId, table.customerId],
      foreignColumns: [customers.storeId, customers.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'sales_store_id_accounting_period_id_fkey',
      columns: [table.storeId, table.accountingPeriodId],
      foreignColumns: [accountingPeriods.storeId, accountingPeriods.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'sales_store_id_correction_of_id_fkey',
      columns: [table.storeId, table.correctionOfId],
      foreignColumns: [table.storeId, table.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'sales_store_id_reversed_by_id_fkey',
      columns: [table.storeId, table.reversedById],
      foreignColumns: [table.storeId, table.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'sales_store_id_device_id_fkey',
      columns: [table.storeId, table.deviceId],
      foreignColumns: [devices.storeId, devices.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    check('sales_display_number_check', sql`length(trim(${table.displayNumber})) > 0`),
    check('sales_items_subtotal_minor_check', sql`${table.itemsSubtotalMinor} >= 0`),
    check('sales_line_discount_total_minor_check', sql`${table.lineDiscountTotalMinor} >= 0`),
    check('sales_invoice_discount_minor_check', sql`${table.invoiceDiscountMinor} >= 0`),
    check('sales_rounding_minor_check', sql`${table.roundingMinor} between -1 and 1`),
    check('sales_total_minor_check', sql`${table.totalMinor} >= 0`),
    check('sales_paid_total_minor_check', sql`${table.paidTotalMinor} >= 0`),
    check('sales_credit_total_minor_check', sql`${table.creditTotalMinor} >= 0`),
    check('sales_known_cost_total_minor_check', sql`${table.knownCostTotalMinor} >= 0`),
    check('sales_pending_cost_line_count_check', sql`${table.pendingCostLineCount} >= 0`),
    check('sales_unknown_cost_line_count_check', sql`${table.unknownCostLineCount} >= 0`),
    check(
      'sales_payment_status_check',
      sql`${table.paymentStatus} in ('paid', 'partial', 'credit')`,
    ),
    check(
      'sales_status_check',
      sql`${table.status} in ('draft', 'posted', 'cancelled', 'corrected')`,
    ),
    check('sales_version_check', sql`${table.version} >= 1`),
    check(
      'sales_check',
      sql`${table.totalMinor} = ${table.itemsSubtotalMinor} - ${table.lineDiscountTotalMinor} - ${table.invoiceDiscountMinor} + ${table.roundingMinor}`,
    ),
    check(
      'sales_check1',
      sql`${table.paidTotalMinor} + ${table.creditTotalMinor} = ${table.totalMinor}`,
    ),
    check('sales_check2', sql`${table.creditTotalMinor} = 0 or ${table.customerId} is not null`),
    check(
      'sales_check3',
      sql`(${table.status} = 'cancelled' and ${table.cancelledAt} is not null) or ${table.status} <> 'cancelled'`,
    ),
    index('idx_sales_customer_time').on(
      table.storeId,
      table.customerId,
      table.saleAt.desc(),
      table.status,
    ),
    index('idx_sales_time').on(table.storeId, table.saleAt.desc(), table.status),
  ],
);

export const saleItems = ledgerSchema.table(
  'sale_items',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    saleId: uuid('sale_id').notNull(),
    productId: uuid('product_id'),
    productUnitId: uuid('product_unit_id'),
    isManualLine: boolean('is_manual_line').notNull().default(false),
    productNameSnapshot: text('product_name_snapshot').notNull(),
    unitNameSnapshot: text('unit_name_snapshot'),
    quantityMilli: bigint('quantity_milli', { mode: 'bigint' }).notNull(),
    conversionFactorNum: integer('conversion_factor_num').notNull(),
    conversionFactorDen: integer('conversion_factor_den').notNull(),
    baseQuantityMilli: bigint('base_quantity_milli', { mode: 'bigint' }),
    unitPriceMinor: bigint('unit_price_minor', { mode: 'bigint' }).notNull(),
    lineGrossMinor: bigint('line_gross_minor', { mode: 'bigint' }).notNull(),
    lineDiscountMinor: bigint('line_discount_minor', { mode: 'bigint' }).notNull().default(0n),
    roundingMinor: bigint('rounding_minor', { mode: 'bigint' }).notNull().default(0n),
    lineTotalMinor: bigint('line_total_minor', { mode: 'bigint' }).notNull(),
    costStatus: text('cost_status').$type<SaleItemCostStatus>().notNull().default('known'),
    unitCostMinor: bigint('unit_cost_minor', { mode: 'bigint' }),
    lineCostMinor: bigint('line_cost_minor', { mode: 'bigint' }),
    inventoryMovementId: uuid('inventory_movement_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  },
  (table) => [
    unique('sale_items_store_id_id_key').on(table.storeId, table.id),
    unique('sale_items_store_id_inventory_movement_id_key').on(
      table.storeId,
      table.inventoryMovementId,
    ),
    foreignKey({
      name: 'sale_items_store_id_sale_id_fkey',
      columns: [table.storeId, table.saleId],
      foreignColumns: [sales.storeId, sales.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'sale_items_store_id_product_id_fkey',
      columns: [table.storeId, table.productId],
      foreignColumns: [products.storeId, products.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'sale_items_store_id_product_id_product_unit_id_fkey',
      columns: [table.storeId, table.productId, table.productUnitId],
      foreignColumns: [productUnits.storeId, productUnits.productId, productUnits.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'sale_items_store_id_inventory_movement_id_fkey',
      columns: [table.storeId, table.inventoryMovementId],
      foreignColumns: [inventoryMovements.storeId, inventoryMovements.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    check(
      'sale_items_product_name_snapshot_check',
      sql`length(trim(${table.productNameSnapshot})) > 0`,
    ),
    check('sale_items_quantity_milli_check', sql`${table.quantityMilli} > 0`),
    check('sale_items_conversion_factor_num_check', sql`${table.conversionFactorNum} > 0`),
    check('sale_items_conversion_factor_den_check', sql`${table.conversionFactorDen} > 0`),
    check('sale_items_unit_price_minor_check', sql`${table.unitPriceMinor} >= 0`),
    check('sale_items_line_gross_minor_check', sql`${table.lineGrossMinor} >= 0`),
    check('sale_items_line_discount_minor_check', sql`${table.lineDiscountMinor} >= 0`),
    check('sale_items_rounding_minor_check', sql`${table.roundingMinor} between -1 and 1`),
    check('sale_items_line_total_minor_check', sql`${table.lineTotalMinor} >= 0`),
    check(
      'sale_items_cost_status_check',
      sql`${table.costStatus} in ('known', 'estimated', 'pending', 'unknown')`,
    ),
    check(
      'sale_items_unit_cost_minor_check',
      sql`${table.unitCostMinor} is null or ${table.unitCostMinor} >= 0`,
    ),
    check(
      'sale_items_line_cost_minor_check',
      sql`${table.lineCostMinor} is null or ${table.lineCostMinor} >= 0`,
    ),
    check('sale_items_version_check', sql`${table.version} >= 1`),
    check(
      'sale_items_check',
      sql`${table.lineTotalMinor} = ${table.lineGrossMinor} - ${table.lineDiscountMinor} + ${table.roundingMinor}`,
    ),
    check(
      'sale_items_check1',
      sql`${table.lineDiscountMinor} <= ${table.lineGrossMinor} + ${table.roundingMinor}`,
    ),
    check(
      'sale_items_check2',
      sql`(${table.isManualLine} = true and ${table.productId} is null and ${table.productUnitId} is null and ${table.baseQuantityMilli} is null and ${table.costStatus} = 'unknown' and ${table.unitCostMinor} is null and ${table.lineCostMinor} is null) or (${table.isManualLine} = false and ${table.productId} is not null and ${table.productUnitId} is not null and ${table.baseQuantityMilli} is not null and ${table.baseQuantityMilli} > 0 and ${table.baseQuantityMilli} * ${table.conversionFactorDen} = ${table.quantityMilli} * ${table.conversionFactorNum})`,
    ),
    check(
      'sale_items_check3',
      sql`(${table.costStatus} = 'unknown' and ${table.unitCostMinor} is null and ${table.lineCostMinor} is null) or (${table.costStatus} <> 'unknown' and ${table.lineCostMinor} is not null)`,
    ),
    index('idx_sale_items_sale').on(table.storeId, table.saleId),
  ],
);

export const salePayments = ledgerSchema.table(
  'sale_payments',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    saleId: uuid('sale_id').notNull(),
    moneyAccountId: uuid('money_account_id').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    paymentAt: timestamp('payment_at', { withTimezone: true, mode: 'date' }).notNull(),
    senderAccountName: text('sender_account_name'),
    externalReference: text('external_reference'),
    moneyMovementId: uuid('money_movement_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  },
  (table) => [
    unique('sale_payments_store_id_id_key').on(table.storeId, table.id),
    unique('sale_payments_store_id_money_movement_id_key').on(table.storeId, table.moneyMovementId),
    foreignKey({
      name: 'sale_payments_store_id_sale_id_fkey',
      columns: [table.storeId, table.saleId],
      foreignColumns: [sales.storeId, sales.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'sale_payments_store_id_money_account_id_fkey',
      columns: [table.storeId, table.moneyAccountId],
      foreignColumns: [moneyAccounts.storeId, moneyAccounts.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'sale_payments_store_id_money_movement_id_fkey',
      columns: [table.storeId, table.moneyMovementId],
      foreignColumns: [moneyMovements.storeId, moneyMovements.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    check('sale_payments_amount_minor_check', sql`${table.amountMinor} > 0`),
    check('sale_payments_version_check', sql`${table.version} >= 1`),
    index('idx_sale_payments_sale').on(table.storeId, table.saleId),
  ],
);

export const customerPayments = ledgerSchema.table(
  'customer_payments',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    accountingPeriodId: uuid('accounting_period_id'),
    moneyAccountId: uuid('money_account_id').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    allocatedTotalMinor: bigint('allocated_total_minor', { mode: 'bigint' }).notNull().default(0n),
    creditCreatedMinor: bigint('credit_created_minor', { mode: 'bigint' }).notNull().default(0n),
    paymentAt: timestamp('payment_at', { withTimezone: true, mode: 'date' }).notNull(),
    senderAccountName: text('sender_account_name'),
    externalReference: text('external_reference'),
    notes: text('notes'),
    status: text('status').$type<CustomerPaymentStatus>().notNull().default('draft'),
    moneyMovementId: uuid('money_movement_id'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    deviceId: uuid('device_id'),
    operationId: uuid('operation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  },
  (table) => [
    unique('customer_payments_store_id_id_key').on(table.storeId, table.id),
    unique('customer_payments_store_id_money_movement_id_key').on(
      table.storeId,
      table.moneyMovementId,
    ),
    unique('customer_payments_store_id_operation_id_key').on(table.storeId, table.operationId),
    foreignKey({
      name: 'customer_payments_store_id_customer_id_fkey',
      columns: [table.storeId, table.customerId],
      foreignColumns: [customers.storeId, customers.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'customer_payments_store_id_accounting_period_id_fkey',
      columns: [table.storeId, table.accountingPeriodId],
      foreignColumns: [accountingPeriods.storeId, accountingPeriods.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'customer_payments_store_id_money_account_id_fkey',
      columns: [table.storeId, table.moneyAccountId],
      foreignColumns: [moneyAccounts.storeId, moneyAccounts.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'customer_payments_store_id_money_movement_id_fkey',
      columns: [table.storeId, table.moneyMovementId],
      foreignColumns: [moneyMovements.storeId, moneyMovements.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'customer_payments_store_id_device_id_fkey',
      columns: [table.storeId, table.deviceId],
      foreignColumns: [devices.storeId, devices.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    check('customer_payments_amount_minor_check', sql`${table.amountMinor} > 0`),
    check('customer_payments_allocated_total_minor_check', sql`${table.allocatedTotalMinor} >= 0`),
    check('customer_payments_credit_created_minor_check', sql`${table.creditCreatedMinor} >= 0`),
    check(
      'customer_payments_status_check',
      sql`${table.status} in ('draft', 'posted', 'cancelled')`,
    ),
    check(
      'customer_payments_check',
      sql`${table.status} <> 'posted' or ${table.allocatedTotalMinor} + ${table.creditCreatedMinor} = ${table.amountMinor}`,
    ),
    check(
      'customer_payments_check1',
      sql`(${table.status} = 'cancelled' and ${table.cancelledAt} is not null) or ${table.status} <> 'cancelled'`,
    ),
    check('customer_payments_version_check', sql`${table.version} >= 1`),
    index('idx_customer_payments_customer_time').on(
      table.storeId,
      table.customerId,
      table.paymentAt.desc(),
      table.status,
    ),
  ],
);

export const customerLedgerEntries = ledgerSchema.table(
  'customer_ledger_entries',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    accountingPeriodId: uuid('accounting_period_id').notNull(),
    entryType: text('entry_type').$type<CustomerLedgerEntryType>().notNull(),
    receivableDeltaMinor: bigint('receivable_delta_minor', { mode: 'bigint' })
      .notNull()
      .default(0n),
    creditDeltaMinor: bigint('credit_delta_minor', { mode: 'bigint' }).notNull().default(0n),
    sourceSaleId: uuid('source_sale_id'),
    referenceType: text('reference_type').notNull(),
    referenceId: uuid('reference_id').notNull(),
    transactionGroupId: uuid('transaction_group_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    reversalOfId: uuid('reversal_of_id'),
    reason: text('reason'),
    deviceId: uuid('device_id'),
    operationId: uuid('operation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('customer_ledger_entries_store_id_id_key').on(table.storeId, table.id),
    unique('customer_ledger_entries_store_id_operation_id_key').on(
      table.storeId,
      table.operationId,
    ),
    foreignKey({
      name: 'customer_ledger_entries_store_id_customer_id_fkey',
      columns: [table.storeId, table.customerId],
      foreignColumns: [customers.storeId, customers.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'customer_ledger_entries_store_id_accounting_period_id_fkey',
      columns: [table.storeId, table.accountingPeriodId],
      foreignColumns: [accountingPeriods.storeId, accountingPeriods.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    // The physical FK remains DEFERRABLE INITIALLY DEFERRED for atomic Sale posting.
    foreignKey({
      name: 'customer_ledger_entries_store_id_source_sale_id_fkey',
      columns: [table.storeId, table.sourceSaleId],
      foreignColumns: [sales.storeId, sales.id],
    }),
    foreignKey({
      name: 'customer_ledger_entries_store_id_reversal_of_id_fkey',
      columns: [table.storeId, table.reversalOfId],
      foreignColumns: [table.storeId, table.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'customer_ledger_entries_store_id_device_id_fkey',
      columns: [table.storeId, table.deviceId],
      foreignColumns: [devices.storeId, devices.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    check(
      'customer_ledger_entries_entry_type_check',
      sql`${table.entryType} in ('sale_credit', 'payment', 'return', 'settlement', 'opening_balance', 'credit_created', 'credit_used', 'refund', 'correction')`,
    ),
    check(
      'customer_ledger_entries_check',
      sql`${table.receivableDeltaMinor} <> 0 or ${table.creditDeltaMinor} <> 0`,
    ),
    index('idx_customer_ledger_customer_time').on(
      table.storeId,
      table.customerId,
      table.occurredAt.desc(),
    ),
    index('idx_customer_ledger_sale').on(
      table.storeId,
      table.sourceSaleId,
      table.occurredAt.desc(),
    ),
    index('idx_customer_ledger_time_brin').using('brin', table.occurredAt),
  ],
);

export const customerPaymentAllocations = ledgerSchema.table(
  'customer_payment_allocations',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    customerPaymentId: uuid('customer_payment_id').notNull(),
    saleId: uuid('sale_id'),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    customerLedgerEntryId: uuid('customer_ledger_entry_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    openingReceivableLedgerEntryId: uuid('opening_receivable_ledger_entry_id'),
  },
  (table) => [
    unique('customer_payment_allocations_store_id_id_key').on(table.storeId, table.id),
    unique('customer_payment_allocations_store_id_customer_ledger_entry_key').on(
      table.storeId,
      table.customerLedgerEntryId,
    ),
    unique('customer_payment_allocations_customer_payment_id_sale_id_key').on(
      table.customerPaymentId,
      table.saleId,
    ),
    unique('customer_payment_allocations_payment_opening_key').on(
      table.customerPaymentId,
      table.openingReceivableLedgerEntryId,
    ),
    foreignKey({
      name: 'customer_payment_allocations_store_id_customer_payment_id_fkey',
      columns: [table.storeId, table.customerPaymentId],
      foreignColumns: [customerPayments.storeId, customerPayments.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'customer_payment_allocations_store_id_sale_id_fkey',
      columns: [table.storeId, table.saleId],
      foreignColumns: [sales.storeId, sales.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'customer_payment_allocations_store_id_customer_ledger_entr_fkey',
      columns: [table.storeId, table.customerLedgerEntryId],
      foreignColumns: [customerLedgerEntries.storeId, customerLedgerEntries.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'customer_payment_allocations_store_opening_receivable_fkey',
      columns: [table.storeId, table.openingReceivableLedgerEntryId],
      foreignColumns: [customerLedgerEntries.storeId, customerLedgerEntries.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    check('customer_payment_allocations_amount_minor_check', sql`${table.amountMinor} > 0`),
    check(
      'customer_payment_allocations_target_xor_check',
      sql`(${table.saleId} is not null)::integer + (${table.openingReceivableLedgerEntryId} is not null)::integer = 1`,
    ),
    index('idx_customer_allocations_sale').on(table.storeId, table.saleId),
    index('idx_customer_allocations_opening_receivable').on(
      table.storeId,
      table.openingReceivableLedgerEntryId,
    ),
  ],
);

export type Sale = typeof sales.$inferSelect;
export type SaleItem = typeof saleItems.$inferSelect;
export type SalePayment = typeof salePayments.$inferSelect;
export type CustomerPayment = typeof customerPayments.$inferSelect;
export type CustomerLedgerEntry = typeof customerLedgerEntries.$inferSelect;
export type CustomerPaymentAllocation = typeof customerPaymentAllocations.$inferSelect;
