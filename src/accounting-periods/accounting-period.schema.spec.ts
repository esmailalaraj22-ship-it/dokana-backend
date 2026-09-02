import { getTableConfig } from 'drizzle-orm/pg-core';

import { accountingPeriods, devices, stores } from '../database/schema';
import { ACCOUNTING_PERIOD_STATUSES, type AccountingPeriodRow } from './accounting-period.types';

type InferredAccountingPeriodRow = typeof accountingPeriods.$inferSelect;

const tableConfig = getTableConfig(accountingPeriods);
const physicalRowTypeMatches: [
  AccountingPeriodRow extends InferredAccountingPeriodRow ? true : false,
  InferredAccountingPeriodRow extends AccountingPeriodRow ? true : false,
] = [true, true];

describe('accounting_periods Drizzle and domain foundation', () => {
  it('maps the schema identity, physical columns, nullability, and lossless version exactly', () => {
    expect({ schema: tableConfig.schema, table: tableConfig.name }).toEqual({
      schema: 'ledger',
      table: 'accounting_periods',
    });
    expect(tableConfig.columns.map((column) => column.name)).toEqual([
      'id',
      'store_id',
      'period_year',
      'period_month',
      'starts_at',
      'ends_at',
      'status',
      'closed_at',
      'device_id',
      'operation_id',
      'created_at',
      'updated_at',
      'version',
    ]);
    expect(accountingPeriods.id.primary).toBe(true);
    expect(accountingPeriods.closedAt.notNull).toBe(false);
    expect(accountingPeriods.deviceId.notNull).toBe(false);
    expect(accountingPeriods.operationId.notNull).toBe(true);
    expect(accountingPeriods.startsAt.getSQLType()).toBe('timestamp with time zone');
    expect(accountingPeriods.endsAt.getSQLType()).toBe('timestamp with time zone');
    expect(accountingPeriods.version.dataType).toBe('bigint');
    expect(physicalRowTypeMatches).toEqual([true, true]);
  });

  it('maps tenant/device foreign keys and Store-scoped unique identities', () => {
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
        name: 'accounting_periods_store_id_fkey',
        columns: ['store_id'],
        foreignTable: stores,
        foreignColumns: ['id'],
        onUpdate: 'cascade',
        onDelete: 'restrict',
      },
      {
        name: 'accounting_periods_store_id_device_id_fkey',
        columns: ['store_id', 'device_id'],
        foreignTable: devices,
        foreignColumns: ['store_id', 'id'],
        onUpdate: 'cascade',
        onDelete: 'restrict',
      },
    ]);
    expect(tableConfig.uniqueConstraints.map((constraint) => constraint.getName()).sort()).toEqual([
      'accounting_periods_store_id_id_key',
      'accounting_periods_store_id_operation_id_key',
      'accounting_periods_store_id_period_year_period_month_key',
    ]);
  });

  it('maps every ordinary CHECK while leaving the GiST exclusion constraint to PostgreSQL', () => {
    expect(tableConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      'accounting_periods_check',
      'accounting_periods_check1',
      'accounting_periods_period_month_check',
      'accounting_periods_period_year_check',
      'accounting_periods_status_check',
      'accounting_periods_version_check',
    ]);
    expect(tableConfig.indexes).toEqual([]);
  });

  it('preserves the complete physical lifecycle vocabulary', () => {
    expect(ACCOUNTING_PERIOD_STATUSES).toEqual(['open', 'closing', 'closed']);
  });
});
