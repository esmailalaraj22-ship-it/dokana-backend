import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { ledgerSchema, stores } from './ledger';
import { storeMemberships } from './platform';

export const notificationTypes = [
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
] as const;

export type NotificationType = (typeof notificationTypes)[number];
export type NotificationSeverity = 'info' | 'warning' | 'critical';
export type NotificationStorageStatus = 'unread' | 'read' | 'resolved' | 'dismissed' | 'snoozed';

export const notifications = ledgerSchema.table(
  'notifications',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    notificationKey: text('notification_key').notNull(),
    notificationType: text('notification_type').$type<NotificationType>().notNull(),
    severity: text('severity').$type<NotificationSeverity>().notNull().default('info'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    status: text('status').$type<NotificationStorageStatus>().notNull().default('unread'),
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true, mode: 'date' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'notifications_store_id_fkey',
      columns: [table.storeId],
      foreignColumns: [stores.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    unique('notifications_store_id_id_key').on(table.storeId, table.id),
    unique('notifications_store_id_notification_key_key').on(table.storeId, table.notificationKey),
    check(
      'notifications_notification_type_check',
      sql`${table.notificationType} in ('customer_debt_amount', 'customer_debt_age', 'customer_credit_limit', 'low_stock', 'negative_stock', 'supplier_due', 'expense_due', 'subscription_expiry', 'backup_failure', 'sync_failure', 'daily_report', 'review_required')`,
    ),
    check(
      'notifications_severity_check',
      sql`${table.severity} in ('info', 'warning', 'critical')`,
    ),
    check(
      'notifications_status_check',
      sql`${table.status} in ('unread', 'read', 'resolved', 'dismissed', 'snoozed')`,
    ),
    index('idx_notifications_status').on(
      table.storeId,
      table.status,
      table.severity,
      table.createdAt.desc(),
    ),
  ],
);

export const notificationUserStates = ledgerSchema.table(
  'notification_user_states',
  {
    storeId: uuid('store_id').notNull(),
    notificationId: uuid('notification_id').notNull(),
    userId: uuid('user_id').notNull(),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  },
  (table) => [
    primaryKey({
      name: 'notification_user_states_pkey',
      columns: [table.storeId, table.notificationId, table.userId],
    }),
    foreignKey({
      name: 'notification_user_states_store_id_notification_id_fkey',
      columns: [table.storeId, table.notificationId],
      foreignColumns: [notifications.storeId, notifications.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'notification_user_states_store_id_user_id_fkey',
      columns: [table.storeId, table.userId],
      foreignColumns: [storeMemberships.storeId, storeMemberships.userId],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    check('notification_user_states_version_check', sql`${table.version} >= 1`),
    index('idx_notification_user_states_user').on(
      table.storeId,
      table.userId,
      table.notificationId,
    ),
  ],
);
