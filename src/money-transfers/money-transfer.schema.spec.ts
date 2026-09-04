import { getTableConfig } from 'drizzle-orm/pg-core';

import {
  accountingPeriods,
  devices,
  moneyAccounts,
  moneyMovements,
  moneyTransfers,
  moneyTransferStatuses,
} from '../database/schema';

const tableConfig = getTableConfig(moneyTransfers);

describe('money_transfers Drizzle foundation', () => {
  it('maps the complete existing physical header without changing the database contract', () => {
    expect({ schema: tableConfig.schema, table: tableConfig.name }).toEqual({
      schema: 'ledger',
      table: 'money_transfers',
    });
    expect(tableConfig.columns.map((column) => column.name)).toEqual([
      'id',
      'store_id',
      'accounting_period_id',
      'display_number',
      'source_account_id',
      'destination_account_id',
      'amount_minor',
      'transfer_at',
      'source_movement_id',
      'destination_movement_id',
      'status',
      'notes',
      'cancelled_at',
      'device_id',
      'operation_id',
      'created_at',
      'updated_at',
      'version',
    ]);
    expect(moneyTransfers.amountMinor.dataType).toBe('bigint');
    expect(moneyTransfers.version.dataType).toBe('bigint');
    expect(moneyTransfers.accountingPeriodId.notNull).toBe(false);
    expect(moneyTransfers.sourceMovementId.notNull).toBe(false);
    expect(moneyTransfers.destinationMovementId.notNull).toBe(false);
    expect(moneyTransferStatuses).toEqual(['draft', 'posted', 'cancelled']);
  });

  it('maps every same-Store foreign key and physical uniqueness constraint', () => {
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
        name: 'money_transfers_store_id_accounting_period_id_fkey',
        columns: ['store_id', 'accounting_period_id'],
        foreignTable: accountingPeriods,
        foreignColumns: ['store_id', 'id'],
        onUpdate: 'cascade',
        onDelete: 'restrict',
      },
      {
        name: 'money_transfers_store_id_source_account_id_fkey',
        columns: ['store_id', 'source_account_id'],
        foreignTable: moneyAccounts,
        foreignColumns: ['store_id', 'id'],
        onUpdate: 'cascade',
        onDelete: 'restrict',
      },
      {
        name: 'money_transfers_store_id_destination_account_id_fkey',
        columns: ['store_id', 'destination_account_id'],
        foreignTable: moneyAccounts,
        foreignColumns: ['store_id', 'id'],
        onUpdate: 'cascade',
        onDelete: 'restrict',
      },
      {
        name: 'money_transfers_store_id_source_movement_id_fkey',
        columns: ['store_id', 'source_movement_id'],
        foreignTable: moneyMovements,
        foreignColumns: ['store_id', 'id'],
        onUpdate: 'cascade',
        onDelete: 'restrict',
      },
      {
        name: 'money_transfers_store_id_destination_movement_id_fkey',
        columns: ['store_id', 'destination_movement_id'],
        foreignTable: moneyMovements,
        foreignColumns: ['store_id', 'id'],
        onUpdate: 'cascade',
        onDelete: 'restrict',
      },
      {
        name: 'money_transfers_store_id_device_id_fkey',
        columns: ['store_id', 'device_id'],
        foreignTable: devices,
        foreignColumns: ['store_id', 'id'],
        onUpdate: 'cascade',
        onDelete: 'restrict',
      },
    ]);
    expect(tableConfig.uniqueConstraints.map((constraint) => constraint.getName()).sort()).toEqual([
      'money_transfers_store_id_destination_movement_id_key',
      'money_transfers_store_id_display_number_key',
      'money_transfers_store_id_id_key',
      'money_transfers_store_id_operation_id_key',
      'money_transfers_store_id_source_movement_id_key',
    ]);
    expect(tableConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      'money_transfers_amount_minor_check',
      'money_transfers_check',
      'money_transfers_check1',
      'money_transfers_status_check',
      'money_transfers_version_check',
    ]);
  });
});
