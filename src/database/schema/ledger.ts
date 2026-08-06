import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const ledgerSchema = pgSchema('ledger');

export const stores = ledgerSchema.table(
  'stores',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    phone: text('phone'),
    currencyCode: text('currency_code').notNull().default('ILS'),
    status: text('status')
      .$type<'active' | 'suspended' | 'read_only' | 'archived'>()
      .notNull()
      .default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  },
  (table) => [
    check('stores_name_check', sql`length(trim(${table.name})) > 0`),
    check('stores_currency_code_check', sql`${table.currencyCode} = 'ILS'`),
    check(
      'stores_status_check',
      sql`${table.status} in ('active', 'suspended', 'read_only', 'archived')`,
    ),
    check('stores_version_check', sql`${table.version} >= 1`),
  ],
);

export const devices = ledgerSchema.table(
  'devices',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    deviceName: text('device_name').notNull(),
    platform: text('platform').$type<'android' | 'ios'>().notNull(),
    installationId: uuid('installation_id').notNull(),
    devicePrefix: text('device_prefix').notNull(),
    status: text('status').$type<'active' | 'revoked' | 'replaced'>().notNull().default('active'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  },
  (table) => [
    foreignKey({
      name: 'devices_store_id_fkey',
      columns: [table.storeId],
      foreignColumns: [stores.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    unique('devices_store_id_id_key').on(table.storeId, table.id),
    unique('devices_store_id_installation_id_key').on(table.storeId, table.installationId),
    unique('devices_store_id_device_prefix_key').on(table.storeId, table.devicePrefix),
    check('devices_device_name_check', sql`length(trim(${table.deviceName})) > 0`),
    check('devices_platform_check', sql`${table.platform} in ('android', 'ios')`),
    check('devices_device_prefix_check', sql`length(${table.devicePrefix}) between 2 and 12`),
    check('devices_status_check', sql`${table.status} in ('active', 'revoked', 'replaced')`),
    check('devices_version_check', sql`${table.version} >= 1`),
    index('idx_devices_status').on(table.storeId, table.status, table.lastSeenAt.desc()),
  ],
);
