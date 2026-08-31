import { getTableConfig } from 'drizzle-orm/pg-core';

import { devices, moneyAccounts, stores } from '../database/schema';
import { normalizeMoneyAccountNameV1 } from './money-account-normalization';
import {
  MONEY_ACCOUNT_CONTROLLED_FIELDS,
  MONEY_ACCOUNT_MVP_CREATED_AVAILABILITIES,
  MONEY_ACCOUNT_MVP_USER_CREATABLE_TYPES,
  MONEY_ACCOUNT_PHYSICAL_AVAILABILITIES,
  MONEY_ACCOUNT_PHYSICAL_TYPES,
  MONEY_ACCOUNT_STATUSES,
  MONEY_ACCOUNT_USER_INPUT_FIELDS,
  MVP_ELECTRONIC_MONEY_ACCOUNT_DEFAULTS,
  type MoneyAccountRow,
  SYSTEM_CASH_MONEY_ACCOUNT,
} from './money-account.types';

type InferredMoneyAccountRow = typeof moneyAccounts.$inferSelect;

const tableConfig = getTableConfig(moneyAccounts);
const physicalRowTypeMatches: [
  MoneyAccountRow extends InferredMoneyAccountRow ? true : false,
  InferredMoneyAccountRow extends MoneyAccountRow ? true : false,
] = [true, true];

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

describe('money_accounts Drizzle and domain foundation', () => {
  it('maps the schema identity and physical columns exactly without balance authority', () => {
    expect({ schema: tableConfig.schema, table: tableConfig.name }).toEqual({
      schema: 'ledger',
      table: 'money_accounts',
    });
    expect(tableConfig.columns.map((column) => column.name)).toEqual([
      'id',
      'store_id',
      'name',
      'normalized_name',
      'account_type',
      'availability',
      'is_default',
      'status',
      'archived_at',
      'device_id',
      'operation_id',
      'created_at',
      'updated_at',
      'version',
    ]);
    expect(tableConfig.columns.some((column) => column.name.includes('balance'))).toBe(false);
    expect(moneyAccounts.version.dataType).toBe('bigint');
    expect(physicalRowTypeMatches).toEqual([true, true]);
  });

  it('maps tenant/device foreign keys, uniqueness, checks, and the active Cash index', () => {
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
        name: 'money_accounts_store_id_fkey',
        columns: ['store_id'],
        foreignTable: stores,
        foreignColumns: ['id'],
        onUpdate: 'cascade',
        onDelete: 'restrict',
      },
      {
        name: 'money_accounts_store_id_device_id_fkey',
        columns: ['store_id', 'device_id'],
        foreignTable: devices,
        foreignColumns: ['store_id', 'id'],
        onUpdate: 'cascade',
        onDelete: 'restrict',
      },
    ]);
    expect(tableConfig.uniqueConstraints.map((constraint) => constraint.getName()).sort()).toEqual([
      'money_accounts_store_id_id_key',
      'money_accounts_store_id_normalized_name_key',
      'money_accounts_store_id_operation_id_key',
    ]);
    expect(tableConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      'money_accounts_account_type_check',
      'money_accounts_availability_check',
      'money_accounts_check',
      'money_accounts_name_check',
      'money_accounts_normalized_name_check',
      'money_accounts_status_check',
      'money_accounts_version_check',
    ]);
    expect(tableConfig.indexes).toHaveLength(1);
    expect(tableConfig.indexes[0]?.config).toMatchObject({
      name: 'uq_store_single_cash_account',
      unique: true,
    });
  });

  it('separates physical compatibility values from current MVP creation values', () => {
    expect(MONEY_ACCOUNT_PHYSICAL_TYPES).toEqual(['cash', 'transfer', 'external_party']);
    expect(MONEY_ACCOUNT_MVP_USER_CREATABLE_TYPES).toEqual(['transfer']);
    expect(MONEY_ACCOUNT_PHYSICAL_AVAILABILITIES).toEqual(['available', 'held_by_external_party']);
    expect(MONEY_ACCOUNT_MVP_CREATED_AVAILABILITIES).toEqual(['available']);
    expect(MONEY_ACCOUNT_STATUSES).toEqual(['active', 'archived']);
    expect(MVP_ELECTRONIC_MONEY_ACCOUNT_DEFAULTS).toEqual({
      accountType: 'transfer',
      availability: 'available',
      isDefault: false,
    });
  });

  it('keeps the frozen Cash identity immutable and canonical', () => {
    expect(SYSTEM_CASH_MONEY_ACCOUNT).toEqual({
      name: 'الصندوق',
      accountType: 'cash',
      availability: 'available',
      isDefault: true,
    });
    expect(Object.isFrozen(SYSTEM_CASH_MONEY_ACCOUNT)).toBe(true);
    expect(normalizeMoneyAccountNameV1(SYSTEM_CASH_MONEY_ACCOUNT.name)).toBe('الصندوق');
  });

  it('classifies every physical field once and exposes only name as user input', () => {
    const classified = [...MONEY_ACCOUNT_USER_INPUT_FIELDS, ...MONEY_ACCOUNT_CONTROLLED_FIELDS];
    expect(new Set(classified).size).toBe(classified.length);
    expect(classified.map(camelToSnake).sort()).toEqual(
      tableConfig.columns.map((column) => column.name).sort(),
    );
    expect(MONEY_ACCOUNT_USER_INPUT_FIELDS).toEqual(['name']);
    expect(MONEY_ACCOUNT_CONTROLLED_FIELDS).not.toContain('name');
  });
});
