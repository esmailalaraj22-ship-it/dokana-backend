import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  accountingPeriods,
  devices,
  ledgerSchema,
  moneyAccounts,
  moneyMovements,
  ownerLedgerEntries,
  stores,
} from './ledger';

export const expenseCategoryStatuses = ['active', 'archived'] as const;
export type ExpenseCategoryStatus = (typeof expenseCategoryStatuses)[number];

export const expensePaymentTimings = ['paid_now', 'due_later'] as const;
export type ExpensePaymentTiming = (typeof expensePaymentTimings)[number];

export const expenseStatuses = ['draft', 'posted', 'cancelled'] as const;
export type ExpenseStatus = (typeof expenseStatuses)[number];

export const expensePaymentSources = ['money_account', 'owner_pocket'] as const;
export type ExpensePaymentSource = (typeof expensePaymentSources)[number];

export const expensePaymentStatuses = ['draft', 'posted', 'cancelled'] as const;
export type ExpensePaymentStatus = (typeof expensePaymentStatuses)[number];

export const expenseCategories = ledgerSchema.table(
  'expense_categories',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    status: text('status').$type<ExpenseCategoryStatus>().notNull().default('active'),
    deviceId: uuid('device_id'),
    operationId: uuid('operation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  },
  (table) => [
    foreignKey({
      name: 'expense_categories_store_id_fkey',
      columns: [table.storeId],
      foreignColumns: [stores.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'expense_categories_store_id_device_id_fkey',
      columns: [table.storeId, table.deviceId],
      foreignColumns: [devices.storeId, devices.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    unique('expense_categories_store_id_id_key').on(table.storeId, table.id),
    unique('expense_categories_store_id_normalized_name_key').on(
      table.storeId,
      table.normalizedName,
    ),
    unique('expense_categories_store_id_operation_id_key').on(table.storeId, table.operationId),
    check('expense_categories_name_check', sql`length(trim(${table.name})) > 0`),
    check(
      'expense_categories_normalized_name_check',
      sql`length(trim(${table.normalizedName})) > 0`,
    ),
    check('expense_categories_status_check', sql`${table.status} in ('active', 'archived')`),
    check('expense_categories_version_check', sql`${table.version} >= 1`),
  ],
);

export const expenses = ledgerSchema.table(
  'expenses',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    categoryId: uuid('category_id'),
    accountingPeriodId: uuid('accounting_period_id'),
    description: text('description').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    paidTotalMinor: bigint('paid_total_minor', { mode: 'bigint' }).notNull().default(0n),
    expenseAt: timestamp('expense_at', { withTimezone: true, mode: 'date' }).notNull(),
    dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }),
    paymentTiming: text('payment_timing').$type<ExpensePaymentTiming>().notNull(),
    status: text('status').$type<ExpenseStatus>().notNull().default('draft'),
    notes: text('notes'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    deviceId: uuid('device_id'),
    operationId: uuid('operation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  },
  (table) => [
    foreignKey({
      name: 'expenses_store_id_category_id_fkey',
      columns: [table.storeId, table.categoryId],
      foreignColumns: [expenseCategories.storeId, expenseCategories.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'expenses_store_id_accounting_period_id_fkey',
      columns: [table.storeId, table.accountingPeriodId],
      foreignColumns: [accountingPeriods.storeId, accountingPeriods.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'expenses_store_id_device_id_fkey',
      columns: [table.storeId, table.deviceId],
      foreignColumns: [devices.storeId, devices.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    unique('expenses_store_id_id_key').on(table.storeId, table.id),
    unique('expenses_store_id_operation_id_key').on(table.storeId, table.operationId),
    check('expenses_description_check', sql`length(trim(${table.description})) > 0`),
    check('expenses_amount_minor_check', sql`${table.amountMinor} > 0`),
    check('expenses_paid_total_minor_check', sql`${table.paidTotalMinor} >= 0`),
    check(
      'expenses_payment_timing_check',
      sql`${table.paymentTiming} in ('paid_now', 'due_later')`,
    ),
    check('expenses_status_check', sql`${table.status} in ('draft', 'posted', 'cancelled')`),
    check('expenses_check', sql`${table.paidTotalMinor} <= ${table.amountMinor}`),
    check(
      'expenses_check1',
      sql`${table.status} <> 'posted' or (${table.paymentTiming} = 'paid_now' and ${table.paidTotalMinor} = ${table.amountMinor}) or ${table.paymentTiming} = 'due_later'`,
    ),
    check(
      'expenses_check2',
      sql`(${table.status} = 'cancelled' and ${table.cancelledAt} is not null) or ${table.status} <> 'cancelled'`,
    ),
    check('expenses_version_check', sql`${table.version} >= 1`),
    index('idx_expenses_due')
      .on(table.storeId, table.status, table.dueAt)
      .where(sql`${table.status} in ('posted', 'partially_paid')`),
  ],
);

export const expensePayments = ledgerSchema.table(
  'expense_payments',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    expenseId: uuid('expense_id').notNull(),
    accountingPeriodId: uuid('accounting_period_id'),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    paymentSource: text('payment_source').$type<ExpensePaymentSource>().notNull(),
    moneyAccountId: uuid('money_account_id'),
    moneyMovementId: uuid('money_movement_id'),
    ownerLedgerEntryId: uuid('owner_ledger_entry_id'),
    paymentAt: timestamp('payment_at', { withTimezone: true, mode: 'date' }).notNull(),
    notes: text('notes'),
    status: text('status').$type<ExpensePaymentStatus>().notNull().default('draft'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    deviceId: uuid('device_id'),
    operationId: uuid('operation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  },
  (table) => [
    foreignKey({
      name: 'expense_payments_store_id_expense_id_fkey',
      columns: [table.storeId, table.expenseId],
      foreignColumns: [expenses.storeId, expenses.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'expense_payments_store_id_accounting_period_id_fkey',
      columns: [table.storeId, table.accountingPeriodId],
      foreignColumns: [accountingPeriods.storeId, accountingPeriods.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'expense_payments_store_id_money_account_id_fkey',
      columns: [table.storeId, table.moneyAccountId],
      foreignColumns: [moneyAccounts.storeId, moneyAccounts.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'expense_payments_store_id_money_movement_id_fkey',
      columns: [table.storeId, table.moneyMovementId],
      foreignColumns: [moneyMovements.storeId, moneyMovements.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'expense_payments_store_id_owner_ledger_entry_id_fkey',
      columns: [table.storeId, table.ownerLedgerEntryId],
      foreignColumns: [ownerLedgerEntries.storeId, ownerLedgerEntries.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'expense_payments_store_id_device_id_fkey',
      columns: [table.storeId, table.deviceId],
      foreignColumns: [devices.storeId, devices.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    unique('expense_payments_store_id_id_key').on(table.storeId, table.id),
    unique('expense_payments_store_id_money_movement_id_key').on(
      table.storeId,
      table.moneyMovementId,
    ),
    unique('expense_payments_store_id_owner_ledger_entry_id_key').on(
      table.storeId,
      table.ownerLedgerEntryId,
    ),
    unique('expense_payments_store_id_operation_id_key').on(table.storeId, table.operationId),
    check('expense_payments_amount_minor_check', sql`${table.amountMinor} > 0`),
    check(
      'expense_payments_payment_source_check',
      sql`${table.paymentSource} in ('money_account', 'owner_pocket')`,
    ),
    check(
      'expense_payments_status_check',
      sql`${table.status} in ('draft', 'posted', 'cancelled')`,
    ),
    check(
      'expense_payments_check',
      sql`${table.status} <> 'posted' or (${table.paymentSource} = 'money_account' and ${table.moneyAccountId} is not null and ${table.moneyMovementId} is not null and ${table.ownerLedgerEntryId} is null) or (${table.paymentSource} = 'owner_pocket' and ${table.moneyAccountId} is null and ${table.moneyMovementId} is null and ${table.ownerLedgerEntryId} is not null)`,
    ),
    check(
      'expense_payments_check1',
      sql`(${table.status} = 'cancelled' and ${table.cancelledAt} is not null) or ${table.status} <> 'cancelled'`,
    ),
    check('expense_payments_version_check', sql`${table.version} >= 1`),
    index('idx_expense_payments_expense').on(
      table.storeId,
      table.expenseId,
      table.paymentAt.desc(),
    ),
  ],
);

export const expenseBalances = ledgerSchema
  .view('v_expense_balances', {
    storeId: uuid('store_id').notNull(),
    expenseId: uuid('expense_id').notNull(),
    description: text('description').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    paidMinor: bigint('paid_minor', { mode: 'bigint' }).notNull(),
    dueMinor: bigint('due_minor', { mode: 'bigint' }).notNull(),
  })
  .existing();
