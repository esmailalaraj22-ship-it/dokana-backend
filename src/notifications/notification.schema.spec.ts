import { getTableConfig } from 'drizzle-orm/pg-core';

import { notifications, notificationTypes, notificationUserStates } from '../database/schema';

describe('Notification Drizzle mappings', () => {
  const notificationConfig = getTableConfig(notifications);
  const stateConfig = getTableConfig(notificationUserStates);

  it('maps the legacy notification relation exactly without inventing version state', () => {
    expect({ schema: notificationConfig.schema, table: notificationConfig.name }).toEqual({
      schema: 'ledger',
      table: 'notifications',
    });
    expect(notificationConfig.columns.map((column) => column.name)).toEqual([
      'id',
      'store_id',
      'notification_key',
      'notification_type',
      'severity',
      'title',
      'body',
      'entity_type',
      'entity_id',
      'status',
      'snoozed_until',
      'resolved_at',
      'created_at',
      'updated_at',
    ]);
    expect(notificationConfig.columns.some((column) => column.name === 'version')).toBe(false);
    expect(
      notificationConfig.uniqueConstraints.map((constraint) => constraint.name).sort(),
    ).toEqual(['notifications_store_id_id_key', 'notifications_store_id_notification_key_key']);
    expect(notificationConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      'notifications_notification_type_check',
      'notifications_severity_check',
      'notifications_status_check',
    ]);
    expect(notificationTypes).toEqual([
      'customer_debt_amount',
      'customer_debt_age',
      'customer_credit_limit',
      'low_stock',
      'negative_stock',
      'supplier_due',
      'expense_due',
      'subscription_expiry',
      'backup_failure',
      'sync_failure',
      'daily_report',
      'review_required',
    ]);
  });

  it('maps per-user presentation identity, versioning, and both tenant-safe foreign keys', () => {
    expect({ schema: stateConfig.schema, table: stateConfig.name }).toEqual({
      schema: 'ledger',
      table: 'notification_user_states',
    });
    expect(stateConfig.columns.map((column) => column.name)).toEqual([
      'store_id',
      'notification_id',
      'user_id',
      'read_at',
      'created_at',
      'updated_at',
      'version',
    ]);
    expect(stateConfig.primaryKeys).toHaveLength(1);
    expect(stateConfig.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      'store_id',
      'notification_id',
      'user_id',
    ]);
    expect(notificationUserStates.version.dataType).toBe('bigint');
    expect(stateConfig.checks.map((constraint) => constraint.name)).toEqual([
      'notification_user_states_version_check',
    ]);

    const foreignKeys = stateConfig.foreignKeys
      .map((foreignKey) => {
        const reference = foreignKey.reference();

        return {
          name: foreignKey.getName(),
          columns: reference.columns.map((column) => column.name),
          foreignColumns: reference.foreignColumns.map((column) => column.name),
          foreignTable: getTableConfig(reference.foreignTable).name,
          onUpdate: foreignKey.onUpdate,
          onDelete: foreignKey.onDelete,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    expect(foreignKeys).toEqual([
      {
        name: 'notification_user_states_store_id_notification_id_fkey',
        columns: ['store_id', 'notification_id'],
        foreignColumns: ['store_id', 'id'],
        foreignTable: 'notifications',
        onUpdate: 'cascade',
        onDelete: 'cascade',
      },
      {
        name: 'notification_user_states_store_id_user_id_fkey',
        columns: ['store_id', 'user_id'],
        foreignColumns: ['store_id', 'user_id'],
        foreignTable: 'store_memberships',
        onUpdate: 'cascade',
        onDelete: 'restrict',
      },
    ]);
  });
});
