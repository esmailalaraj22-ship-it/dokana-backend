import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  accountingPeriods,
  devices,
  ledgerSchema,
  products,
  productUnits,
  suppliers,
} from './ledger';

export const purchaseInvoiceStatuses = ['draft', 'open', 'closed', 'cancelled'] as const;
export type PurchaseInvoiceStatus = (typeof purchaseInvoiceStatuses)[number];

export const supplierLedgerEntryTypes = [
  'supplier_invoice',
  'goods_receipt',
  'payment',
  'return',
  'opening_balance',
  'credit_created',
  'credit_used',
  'refund',
  'correction',
] as const;
export type SupplierLedgerEntryType = (typeof supplierLedgerEntryTypes)[number];

// Migration 0009 owns Supplier Invoice period enforcement and the remaining
// receipt-decoupling trigger behavior. These mappings model the resulting facts.
export const purchaseInvoices = ledgerSchema.table(
  'purchase_invoices',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    supplierId: uuid('supplier_id').notNull(),
    invoiceNumber: text('invoice_number'),
    displayNumber: text('display_number').notNull(),
    invoiceDateAt: timestamp('invoice_date_at', { withTimezone: true, mode: 'date' }).notNull(),
    dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }),
    itemsSubtotalMinor: bigint('items_subtotal_minor', { mode: 'bigint' }).notNull().default(0n),
    lineDiscountTotalMinor: bigint('line_discount_total_minor', { mode: 'bigint' })
      .notNull()
      .default(0n),
    invoiceDiscountMinor: bigint('invoice_discount_minor', { mode: 'bigint' })
      .notNull()
      .default(0n),
    roundingMinor: bigint('rounding_minor', { mode: 'bigint' }).notNull().default(0n),
    totalMinor: bigint('total_minor', { mode: 'bigint' }).notNull().default(0n),
    status: text('status').$type<PurchaseInvoiceStatus>().notNull().default('draft'),
    notes: text('notes'),
    correctionOfId: uuid('correction_of_id'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    deviceId: uuid('device_id'),
    operationId: uuid('operation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
    accountingPeriodId: uuid('accounting_period_id'),
    postingDate: date('posting_date', { mode: 'string' }),
  },
  (table) => [
    unique('purchase_invoices_store_id_id_key').on(table.storeId, table.id),
    unique('purchase_invoices_store_id_display_number_key').on(table.storeId, table.displayNumber),
    unique('purchase_invoices_store_id_operation_id_key').on(table.storeId, table.operationId),
    foreignKey({
      name: 'purchase_invoices_store_id_supplier_id_fkey',
      columns: [table.storeId, table.supplierId],
      foreignColumns: [suppliers.storeId, suppliers.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'purchase_invoices_store_id_correction_of_id_fkey',
      columns: [table.storeId, table.correctionOfId],
      foreignColumns: [table.storeId, table.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'purchase_invoices_store_id_device_id_fkey',
      columns: [table.storeId, table.deviceId],
      foreignColumns: [devices.storeId, devices.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'purchase_invoices_store_id_accounting_period_id_fkey',
      columns: [table.storeId, table.accountingPeriodId],
      foreignColumns: [accountingPeriods.storeId, accountingPeriods.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    check('purchase_invoices_display_number_check', sql`length(trim(${table.displayNumber})) > 0`),
    check('purchase_invoices_items_subtotal_minor_check', sql`${table.itemsSubtotalMinor} >= 0`),
    check(
      'purchase_invoices_line_discount_total_minor_check',
      sql`${table.lineDiscountTotalMinor} >= 0`,
    ),
    check(
      'purchase_invoices_invoice_discount_minor_check',
      sql`${table.invoiceDiscountMinor} >= 0`,
    ),
    check('purchase_invoices_rounding_minor_check', sql`${table.roundingMinor} between -1 and 1`),
    check('purchase_invoices_total_minor_check', sql`${table.totalMinor} >= 0`),
    check(
      'purchase_invoices_status_check',
      sql`${table.status} in ('draft', 'open', 'closed', 'cancelled')`,
    ),
    check(
      'purchase_invoices_check',
      sql`${table.totalMinor} = ${table.itemsSubtotalMinor} - ${table.lineDiscountTotalMinor} - ${table.invoiceDiscountMinor} + ${table.roundingMinor}`,
    ),
    check(
      'purchase_invoices_check1',
      sql`(${table.status} = 'cancelled' and ${table.cancelledAt} is not null) or ${table.status} <> 'cancelled'`,
    ),
    check('purchase_invoices_version_check', sql`${table.version} >= 1`),
    check(
      'purchase_invoices_posting_context_check',
      sql`(${table.accountingPeriodId} is null) = (${table.postingDate} is null) and (${table.status} not in ('open', 'closed') or ${table.accountingPeriodId} is not null)`,
    ),
    index('idx_purchase_invoices_supplier').on(
      table.storeId,
      table.supplierId,
      table.invoiceDateAt.desc(),
      table.status,
    ),
  ],
);

export const purchaseItems = ledgerSchema.table(
  'purchase_items',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    purchaseInvoiceId: uuid('purchase_invoice_id').notNull(),
    productId: uuid('product_id').notNull(),
    productUnitId: uuid('product_unit_id').notNull(),
    productNameSnapshot: text('product_name_snapshot').notNull(),
    unitNameSnapshot: text('unit_name_snapshot').notNull(),
    quantityMilli: bigint('quantity_milli', { mode: 'bigint' }).notNull(),
    conversionFactorNum: integer('conversion_factor_num').notNull(),
    conversionFactorDen: integer('conversion_factor_den').notNull(),
    baseQuantityMilli: bigint('base_quantity_milli', { mode: 'bigint' }).notNull(),
    unitCostMinor: bigint('unit_cost_minor', { mode: 'bigint' }).notNull(),
    lineGrossMinor: bigint('line_gross_minor', { mode: 'bigint' }).notNull(),
    lineDiscountMinor: bigint('line_discount_minor', { mode: 'bigint' }).notNull().default(0n),
    roundingMinor: bigint('rounding_minor', { mode: 'bigint' }).notNull().default(0n),
    lineTotalMinor: bigint('line_total_minor', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  },
  (table) => [
    unique('purchase_items_store_id_id_key').on(table.storeId, table.id),
    foreignKey({
      name: 'purchase_items_store_id_purchase_invoice_id_fkey',
      columns: [table.storeId, table.purchaseInvoiceId],
      foreignColumns: [purchaseInvoices.storeId, purchaseInvoices.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'purchase_items_store_id_product_id_fkey',
      columns: [table.storeId, table.productId],
      foreignColumns: [products.storeId, products.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'purchase_items_store_id_product_id_product_unit_id_fkey',
      columns: [table.storeId, table.productId, table.productUnitId],
      foreignColumns: [productUnits.storeId, productUnits.productId, productUnits.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    check('purchase_items_quantity_milli_check', sql`${table.quantityMilli} > 0`),
    check('purchase_items_conversion_factor_num_check', sql`${table.conversionFactorNum} > 0`),
    check('purchase_items_conversion_factor_den_check', sql`${table.conversionFactorDen} > 0`),
    check('purchase_items_base_quantity_milli_check', sql`${table.baseQuantityMilli} > 0`),
    check('purchase_items_unit_cost_minor_check', sql`${table.unitCostMinor} >= 0`),
    check('purchase_items_line_gross_minor_check', sql`${table.lineGrossMinor} >= 0`),
    check('purchase_items_line_discount_minor_check', sql`${table.lineDiscountMinor} >= 0`),
    check('purchase_items_rounding_minor_check', sql`${table.roundingMinor} between -1 and 1`),
    check('purchase_items_line_total_minor_check', sql`${table.lineTotalMinor} >= 0`),
    check(
      'purchase_items_check',
      sql`${table.baseQuantityMilli} * ${table.conversionFactorDen} = ${table.quantityMilli} * ${table.conversionFactorNum}`,
    ),
    check(
      'purchase_items_check1',
      sql`${table.lineTotalMinor} = ${table.lineGrossMinor} - ${table.lineDiscountMinor} + ${table.roundingMinor}`,
    ),
    check(
      'purchase_items_check2',
      sql`${table.lineDiscountMinor} <= ${table.lineGrossMinor} + ${table.roundingMinor}`,
    ),
    check('purchase_items_version_check', sql`${table.version} >= 1`),
    index('idx_purchase_items_invoice').on(table.storeId, table.purchaseInvoiceId),
  ],
);

export const supplierLedgerEntries = ledgerSchema.table(
  'supplier_ledger_entries',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    supplierId: uuid('supplier_id').notNull(),
    accountingPeriodId: uuid('accounting_period_id').notNull(),
    entryType: text('entry_type').$type<SupplierLedgerEntryType>().notNull(),
    payableDeltaMinor: bigint('payable_delta_minor', { mode: 'bigint' }).notNull().default(0n),
    creditDeltaMinor: bigint('credit_delta_minor', { mode: 'bigint' }).notNull().default(0n),
    sourcePurchaseInvoiceId: uuid('source_purchase_invoice_id'),
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
    unique('supplier_ledger_entries_store_id_id_key').on(table.storeId, table.id),
    unique('supplier_ledger_entries_store_id_operation_id_key').on(
      table.storeId,
      table.operationId,
    ),
    foreignKey({
      name: 'supplier_ledger_entries_store_id_supplier_id_fkey',
      columns: [table.storeId, table.supplierId],
      foreignColumns: [suppliers.storeId, suppliers.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'supplier_ledger_entries_store_id_accounting_period_id_fkey',
      columns: [table.storeId, table.accountingPeriodId],
      foreignColumns: [accountingPeriods.storeId, accountingPeriods.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'supplier_ledger_entries_store_id_source_purchase_invoice_i_fkey',
      columns: [table.storeId, table.sourcePurchaseInvoiceId],
      foreignColumns: [purchaseInvoices.storeId, purchaseInvoices.id],
    }),
    foreignKey({
      name: 'supplier_ledger_entries_store_id_reversal_of_id_fkey',
      columns: [table.storeId, table.reversalOfId],
      foreignColumns: [table.storeId, table.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'supplier_ledger_entries_store_id_device_id_fkey',
      columns: [table.storeId, table.deviceId],
      foreignColumns: [devices.storeId, devices.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    check(
      'supplier_ledger_entries_entry_type_check',
      sql`${table.entryType} in ('supplier_invoice', 'goods_receipt', 'payment', 'return', 'opening_balance', 'credit_created', 'credit_used', 'refund', 'correction')`,
    ),
    check(
      'supplier_ledger_entries_check',
      sql`${table.payableDeltaMinor} <> 0 or ${table.creditDeltaMinor} <> 0`,
    ),
    index('idx_supplier_ledger_purchase').on(
      table.storeId,
      table.sourcePurchaseInvoiceId,
      table.occurredAt.desc(),
    ),
    index('idx_supplier_ledger_supplier_time').on(
      table.storeId,
      table.supplierId,
      table.occurredAt.desc(),
    ),
    index('idx_supplier_ledger_time_brin').using('brin', table.occurredAt),
  ],
);
