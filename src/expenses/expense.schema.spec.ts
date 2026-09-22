import { getTableConfig, getViewConfig } from 'drizzle-orm/pg-core';

import { expenseBalances, expenseCategories, expensePayments, expenses } from '../database/schema';

describe('Expense Drizzle foundation', () => {
  it('maps Expense Categories exactly', () => {
    const config = getTableConfig(expenseCategories);
    expect({ schema: config.schema, table: config.name }).toEqual({
      schema: 'ledger',
      table: 'expense_categories',
    });
    expect(config.columns.map((column) => column.name)).toEqual([
      'id',
      'store_id',
      'name',
      'normalized_name',
      'status',
      'device_id',
      'operation_id',
      'created_at',
      'updated_at',
      'version',
    ]);
    expect(config.uniqueConstraints.map((constraint) => constraint.getName()).sort()).toEqual([
      'expense_categories_store_id_id_key',
      'expense_categories_store_id_normalized_name_key',
      'expense_categories_store_id_operation_id_key',
    ]);
  });

  it('maps Expense recognition and Payment facts without inventing allocation columns', () => {
    const expense = getTableConfig(expenses);
    const payment = getTableConfig(expensePayments);
    expect(expense.columns.map((column) => column.name)).toEqual([
      'id',
      'store_id',
      'category_id',
      'accounting_period_id',
      'description',
      'amount_minor',
      'paid_total_minor',
      'expense_at',
      'due_at',
      'payment_timing',
      'status',
      'notes',
      'cancelled_at',
      'device_id',
      'operation_id',
      'created_at',
      'updated_at',
      'version',
    ]);
    expect(payment.columns.map((column) => column.name)).toEqual([
      'id',
      'store_id',
      'expense_id',
      'accounting_period_id',
      'amount_minor',
      'payment_source',
      'money_account_id',
      'money_movement_id',
      'owner_ledger_entry_id',
      'payment_at',
      'notes',
      'status',
      'cancelled_at',
      'device_id',
      'operation_id',
      'created_at',
      'updated_at',
      'version',
    ]);
    expect(payment.columns.some((column) => column.name.includes('allocation'))).toBe(false);
    expect(expenses.amountMinor.dataType).toBe('bigint');
    expect(expensePayments.amountMinor.dataType).toBe('bigint');
  });

  it('maps the authoritative derived outstanding view', () => {
    const config = getViewConfig(expenseBalances);
    expect({ schema: config.schema, view: config.name }).toEqual({
      schema: 'ledger',
      view: 'v_expense_balances',
    });
    expect([
      expenseBalances.storeId.name,
      expenseBalances.expenseId.name,
      expenseBalances.description.name,
      expenseBalances.amountMinor.name,
      expenseBalances.paidMinor.name,
      expenseBalances.dueMinor.name,
    ]).toEqual([
      'store_id',
      'expense_id',
      'description',
      'amount_minor',
      'paid_minor',
      'due_minor',
    ]);
  });
});
