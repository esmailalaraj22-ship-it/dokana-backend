import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { devices, stores } from './ledger';

export const syncSchema = pgSchema('sync');

export const storeChangeWatermarksV1 = syncSchema.table(
  'store_change_watermarks_v1',
  {
    storeId: uuid('store_id')
      .primaryKey()
      .references(() => stores.id, { onDelete: 'cascade' }),
    lastSequence: bigint('last_sequence', { mode: 'bigint' }).notNull().default(0n),
    minimumReplayableSequence: bigint('minimum_replayable_sequence', { mode: 'bigint' })
      .notNull()
      .default(0n),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    check('store_change_watermarks_v1_last_sequence_check', sql`${table.lastSequence} >= 0`),
    check(
      'store_change_watermarks_v1_replayable_sequence_check',
      sql`${table.minimumReplayableSequence} >= 0 and ${table.minimumReplayableSequence} <= ${table.lastSequence}`,
    ),
  ],
);

export const storeChangeEventsV1 = syncSchema.table(
  'store_change_events_v1',
  {
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    storeSequence: bigint('store_sequence', { mode: 'bigint' }).notNull(),
    eventId: uuid('event_id').notNull().defaultRandom(),
    contractVersion: smallint('contract_version').notNull().default(1),
    entityType: text('entity_type').notNull(),
    entityKey: text('entity_key').notNull(),
    entityId: uuid('entity_id'),
    action: text('action')
      .$type<
        'create' | 'update' | 'archive' | 'restore' | 'post' | 'cancel' | 'reverse' | 'deactivate'
      >()
      .notNull(),
    entityVersion: bigint('entity_version', { mode: 'bigint' }).notNull(),
    operationId: uuid('operation_id'),
    deviceId: uuid('device_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    representationVersion: smallint('representation_version'),
    representation: jsonb('representation').$type<Record<string, unknown>>(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.storeId, table.storeSequence] }),
    unique('store_change_events_v1_event_id_key').on(table.eventId),
    foreignKey({
      name: 'store_change_events_v1_store_id_device_id_fkey',
      columns: [table.storeId, table.deviceId],
      foreignColumns: [devices.storeId, devices.id],
    }).onDelete('restrict'),
    check('store_change_events_v1_store_sequence_check', sql`${table.storeSequence} > 0`),
    check('store_change_events_v1_contract_version_check', sql`${table.contractVersion} = 1`),
    check('store_change_events_v1_entity_version_check', sql`${table.entityVersion} >= 1`),
    check(
      'store_change_events_v1_representation_pair_check',
      sql`(${table.representationVersion} is null and ${table.representation} is null)
          or (${table.representationVersion} = 1 and jsonb_typeof(${table.representation}) = 'object')`,
    ),
    index('idx_store_change_events_v1_entity').on(
      table.storeId,
      table.entityType,
      table.entityKey,
      table.storeSequence,
    ),
  ],
);
