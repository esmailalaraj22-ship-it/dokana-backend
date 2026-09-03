import { getTableConfig, getViewConfig } from 'drizzle-orm/pg-core';

import {
  accountingPeriods,
  devices,
  moneyAccounts,
  ownerLedgerEntries,
  ownerLedgerEntryTypes,
  ownerPosition,
} from '../database/schema';

const tableConfig = getTableConfig(ownerLedgerEntries);

describe('owner_ledger_entries Drizzle foundation', () => {
  it('maps the physical table, columns, nullability, and bigint deltas exactly', () => {
    expect({ schema: tableConfig.schema, table: tableConfig.name }).toEqual({
      schema: 'ledger',
      table: 'owner_ledger_entries',
    });
    expect(tableConfig.columns.map((column) => column.name)).toEqual([
      'id',
      'store_id',
      'accounting_period_id',
      'entry_type',
      'owner_liability_delta_minor',
      'equity_delta_minor',
      'money_account_id',
      'reference_type',
      'reference_id',
      'transaction_group_id',
      'occurred_at',
      'reversal_of_id',
      'reason',
      'device_id',
      'operation_id',
      'created_at',
    ]);
    expect(ownerLedgerEntries.ownerLiabilityDeltaMinor.dataType).toBe('bigint');
    expect(ownerLedgerEntries.equityDeltaMinor.dataType).toBe('bigint');
    expect(ownerLedgerEntries.moneyAccountId.notNull).toBe(false);
    expect(ownerLedgerEntries.referenceType.notNull).toBe(false);
    expect(ownerLedgerEntries.referenceId.notNull).toBe(false);
    expect(ownerLedgerEntries.reversalOfId.notNull).toBe(false);
    expect(ownerLedgerEntries.reason.notNull).toBe(false);
    expect(ownerLedgerEntries.deviceId.notNull).toBe(false);
  });

  it('maps same-Store foreign keys and physical uniqueness exactly', () => {
    expect(
      tableConfig.foreignKeys.map((foreignKey) => {
        const reference = foreignKey.reference();
        return {
          name: foreignKey.getName(),
          columns: reference.columns.map((column) => column.name),
          foreignTable: reference.foreignTable,
          foreignColumns: reference.foreignColumns.map((column) => column.name),
          onUpdate: foreignKey.onUpdate,
          onDelete: foreignKey.onDelete,
        };
      }),
    ).toEqual([
      {
        name: 'owner_ledger_entries_store_id_accounting_period_id_fkey',
        columns: ['store_id', 'accounting_period_id'],
        foreignTable: accountingPeriods,
        foreignColumns: ['store_id', 'id'],
        onUpdate: 'cascade',
        onDelete: 'restrict',
      },
      {
        name: 'owner_ledger_entries_store_id_money_account_id_fkey',
        columns: ['store_id', 'money_account_id'],
        foreignTable: moneyAccounts,
        foreignColumns: ['store_id', 'id'],
        onUpdate: 'cascade',
        onDelete: 'restrict',
      },
      {
        name: 'owner_ledger_entries_store_id_reversal_of_id_fkey',
        columns: ['store_id', 'reversal_of_id'],
        foreignTable: ownerLedgerEntries,
        foreignColumns: ['store_id', 'id'],
        onUpdate: 'cascade',
        onDelete: 'restrict',
      },
      {
        name: 'owner_ledger_entries_store_id_device_id_fkey',
        columns: ['store_id', 'device_id'],
        foreignTable: devices,
        foreignColumns: ['store_id', 'id'],
        onUpdate: 'cascade',
        onDelete: 'restrict',
      },
    ]);
    expect(tableConfig.uniqueConstraints.map((constraint) => constraint.getName()).sort()).toEqual([
      'owner_ledger_entries_store_id_id_key',
      'owner_ledger_entries_store_id_operation_id_key',
    ]);
    expect(tableConfig.indexes).toHaveLength(1);
    expect(tableConfig.indexes[0]?.config).toMatchObject({
      name: 'idx_owner_ledger_time',
      unique: false,
    });
  });

  it('preserves the full physical vocabulary while S10.3 exposes no profit command', () => {
    expect(ownerLedgerEntryTypes).toEqual([
      'capital_contribution',
      'owner_loan_to_store',
      'owner_paid_expense',
      'owner_paid_supplier',
      'owner_reimbursement',
      'personal_withdrawal',
      'profit_withdrawal',
      'capital_withdrawal',
      'correction',
    ]);
    expect(tableConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      'owner_ledger_entries_check',
      'owner_ledger_entries_entry_type_check',
    ]);
  });

  it('maps the existing owner-position projection with lossless bigint totals', () => {
    const viewConfig = getViewConfig(ownerPosition);
    expect({
      schema: viewConfig.schema,
      name: viewConfig.name,
      existing: viewConfig.isExisting,
    }).toEqual({
      schema: 'ledger',
      name: 'v_owner_position',
      existing: true,
    });
    expect([
      ownerPosition.storeId.name,
      ownerPosition.storeOwesOwnerMinor.name,
      ownerPosition.ownerEquityMovementMinor.name,
    ]).toEqual(['store_id', 'store_owes_owner_minor', 'owner_equity_movement_minor']);
    expect(ownerPosition.storeOwesOwnerMinor.dataType).toBe('bigint');
    expect(ownerPosition.ownerEquityMovementMinor.dataType).toBe('bigint');
  });
});
