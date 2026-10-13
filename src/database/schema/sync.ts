import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
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
import { licenseIssuances, subscriptions, users } from './platform';

export const syncSchema = pgSchema('sync');
const xid8 = customType<{ data: string }>({ dataType: () => 'xid8' });

export const offlineOperationProvenanceV1 = syncSchema.table(
  'offline_operation_provenance_v1',
  {
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    operationId: uuid('operation_id').notNull(),
    deviceId: uuid('device_id').notNull(),
    localSequence: bigint('local_sequence', { mode: 'bigint' }).notNull(),
    operationType: text('operation_type').notNull(),
    provenanceHash: text('provenance_hash').notNull(),
    canonicalRequestHash: text('canonical_request_hash'),
    licenseId: uuid('license_id')
      .notNull()
      .references(() => licenseIssuances.id, { onDelete: 'restrict' }),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'restrict' }),
    subscriptionVersion: bigint('subscription_version', { mode: 'bigint' }).notNull(),
    clientRecordedAt: timestamp('client_recorded_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    trustedServerTime: timestamp('trusted_server_time', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    observedDeviceTime: timestamp('observed_device_time', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    clockState: text('clock_state').$type<'trusted' | 'clock_rollback_suspected'>().notNull(),
    knownStoreStatus: text('known_store_status')
      .$type<'active' | 'read_only' | 'suspended'>()
      .notNull(),
    knownStoreStatusAt: timestamp('known_store_status_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    dependencyOperationIds: uuid('dependency_operation_ids').array().notNull().default([]),
    disposition: text('disposition')
      .$type<
        'processing' | 'applied' | 'rejected' | 'conflict' | 'quarantined' | 'dependency_pending'
      >()
      .notNull(),
    reasonCode: text('reason_code'),
    responseBody: jsonb('response_body').$type<Record<string, unknown>>(),
    authorizedUserId: uuid('authorized_user_id'),
    authorizationXid: xid8('authorization_xid'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    primaryKey({ columns: [table.storeId, table.operationId] }),
    unique('offline_operation_provenance__store_id_device_id_local_sequ_key').on(
      table.storeId,
      table.deviceId,
      table.localSequence,
    ),
    foreignKey({
      name: 'offline_operation_provenance_v1_store_id_device_id_fkey',
      columns: [table.storeId, table.deviceId],
      foreignColumns: [devices.storeId, devices.id],
    }).onDelete('restrict'),
    check('offline_operation_provenance_v1_local_sequence_check', sql`${table.localSequence} > 0`),
    check(
      'offline_operation_provenance_v1_subscription_version_check',
      sql`${table.subscriptionVersion} >= 1`,
    ),
    index('idx_offline_operation_provenance_v1_license').on(
      table.storeId,
      table.licenseId,
      table.clientRecordedAt,
    ),
  ],
);

export const offlineOperationRecoveryEventsV1 = syncSchema.table(
  'offline_operation_recovery_events_v1',
  {
    storeId: uuid('store_id').notNull(),
    recoveryAttemptId: uuid('recovery_attempt_id').notNull(),
    eventSequence: smallint('event_sequence').notNull(),
    operationId: uuid('operation_id').notNull(),
    provenanceHash: text('provenance_hash').notNull(),
    originalQuarantineReason: text('original_quarantine_reason'),
    eventType: text('event_type').$type<'began' | 'completed'>().notNull(),
    resultStatus: text('result_status').$type<
      'applied' | 'exact_replay' | 'rejected' | 'dependency_pending' | 'conflict' | 'quarantined'
    >(),
    reasonCode: text('reason_code'),
    responseBody: jsonb('response_body').$type<Record<string, unknown>>(),
    recoveryPolicyVersion: smallint('recovery_policy_version').notNull().default(1),
    authorizedUserId: uuid('authorized_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    authorizationXid: xid8('authorization_xid'),
    recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.storeId, table.recoveryAttemptId, table.eventSequence] }),
    foreignKey({
      name: 'offline_operation_recovery_events_v1_store_operation_fkey',
      columns: [table.storeId, table.operationId],
      foreignColumns: [
        offlineOperationProvenanceV1.storeId,
        offlineOperationProvenanceV1.operationId,
      ],
    }).onDelete('restrict'),
    check(
      'offline_operation_recovery_events_v1_event_sequence_check',
      sql`${table.eventSequence} in (1, 2)`,
    ),
    check(
      'offline_operation_recovery_events_v1_policy_version_check',
      sql`${table.recoveryPolicyVersion} = 1`,
    ),
    index('idx_offline_operation_recovery_events_v1_operation').on(
      table.storeId,
      table.operationId,
      table.recordedAt,
      table.recoveryAttemptId,
    ),
  ],
);

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
