import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { devices, stores } from './ledger';

export const platformSchema = pgSchema('platform');

export const users = platformSchema.table(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    normalizedEmail: text('normalized_email').notNull(),
    passwordHash: text('password_hash').notNull(),
    fullName: text('full_name').notNull(),
    status: text('status')
      .$type<'active' | 'disabled' | 'locked' | 'deleted'>()
      .notNull()
      .default('active'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true, mode: 'date' }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  },
  (table) => [
    unique('users_normalized_email_key').on(table.normalizedEmail),
    check('users_full_name_check', sql`length(trim(${table.fullName})) > 0`),
    check(
      'users_status_check',
      sql`${table.status} in ('active', 'disabled', 'locked', 'deleted')`,
    ),
    check('users_version_check', sql`${table.version} >= 1`),
  ],
);

export const storeMemberships = platformSchema.table(
  'store_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: text('role').$type<'owner' | 'manager' | 'viewer' | 'support'>().notNull(),
    status: text('status')
      .$type<'active' | 'invited' | 'disabled' | 'removed'>()
      .notNull()
      .default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  },
  (table) => [
    foreignKey({
      name: 'store_memberships_store_id_fkey',
      columns: [table.storeId],
      foreignColumns: [stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'store_memberships_user_id_fkey',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    unique('store_memberships_store_id_user_id_key').on(table.storeId, table.userId),
    check(
      'store_memberships_role_check',
      sql`${table.role} in ('owner', 'manager', 'viewer', 'support')`,
    ),
    check(
      'store_memberships_status_check',
      sql`${table.status} in ('active', 'invited', 'disabled', 'removed')`,
    ),
    check('store_memberships_version_check', sql`${table.version} >= 1`),
    index('idx_memberships_user').on(table.userId, table.status),
  ],
);

export const platformAdminAssignments = platformSchema.table(
  'platform_admin_assignments',
  {
    userId: uuid('user_id').primaryKey(),
    status: text('status').$type<'active' | 'revoked'>().notNull().default('active'),
    assignedAt: timestamp('assigned_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    assignedByUserId: uuid('assigned_by_user_id'),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedByUserId: uuid('revoked_by_user_id'),
    revokeReason: text('revoke_reason'),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  },
  (table) => [
    foreignKey({
      name: 'platform_admin_assignments_user_id_fkey',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'platform_admin_assignments_assigned_by_user_id_fkey',
      columns: [table.assignedByUserId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'platform_admin_assignments_revoked_by_user_id_fkey',
      columns: [table.revokedByUserId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    check('platform_admin_assignments_status_check', sql`${table.status} in ('active', 'revoked')`),
    check('platform_admin_assignments_version_check', sql`${table.version} >= 1`),
    check(
      'platform_admin_assignments_state_check',
      sql`(
        ${table.status} = 'active'
        and ${table.revokedAt} is null
        and ${table.revokedByUserId} is null
        and ${table.revokeReason} is null
      ) or (
        ${table.status} = 'revoked'
        and ${table.revokedAt} is not null
        and ${table.revokedByUserId} is not null
        and length(trim(${table.revokeReason})) > 0
      )`,
    ),
  ],
);

export const subscriptionPlans = platformSchema.table(
  'subscription_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    durationDays: integer('duration_days').notNull(),
    priceMinor: bigint('price_minor', { mode: 'bigint' }).notNull(),
    currencyCode: text('currency_code').notNull().default('ILS'),
    maxDevices: integer('max_devices').notNull().default(1),
    offlineGraceDays: integer('offline_grace_days').notNull().default(0),
    status: text('status').$type<'active' | 'archived'>().notNull().default('active'),
    features: jsonb('features').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  },
  (table) => [
    unique('subscription_plans_code_key').on(table.code),
    check('subscription_plans_duration_days_check', sql`${table.durationDays} > 0`),
    check('subscription_plans_price_minor_check', sql`${table.priceMinor} >= 0`),
    check('subscription_plans_currency_code_check', sql`${table.currencyCode} = 'ILS'`),
    check('subscription_plans_max_devices_check', sql`${table.maxDevices} > 0`),
    check('subscription_plans_offline_grace_days_check', sql`${table.offlineGraceDays} >= 0`),
    check('subscription_plans_status_check', sql`${table.status} in ('active', 'archived')`),
    check('subscription_plans_version_check', sql`${table.version} >= 1`),
  ],
);

export const subscriptions = platformSchema.table(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id').notNull(),
    planId: uuid('plan_id').notNull(),
    status: text('status')
      .$type<'trial' | 'active' | 'past_due' | 'expired' | 'suspended' | 'cancelled'>()
      .notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    suspendedAt: timestamp('suspended_at', { withTimezone: true, mode: 'date' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    externalReference: text('external_reference'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  },
  (table) => [
    foreignKey({
      name: 'subscriptions_store_id_fkey',
      columns: [table.storeId],
      foreignColumns: [stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'subscriptions_plan_id_fkey',
      columns: [table.planId],
      foreignColumns: [subscriptionPlans.id],
    }).onDelete('restrict'),
    check(
      'subscriptions_status_check',
      sql`${table.status} in ('trial', 'active', 'past_due', 'expired', 'suspended', 'cancelled')`,
    ),
    check('subscriptions_check', sql`${table.expiresAt} > ${table.startsAt}`),
    check('subscriptions_version_check', sql`${table.version} >= 1`),
    uniqueIndex('uq_platform_one_current_subscription')
      .on(table.storeId)
      .where(sql`${table.status} in ('trial', 'active', 'past_due', 'suspended')`),
    index('idx_subscriptions_store_time').on(table.storeId, table.expiresAt.desc(), table.status),
  ],
);

export const licenseIssuances = platformSchema.table(
  'license_issuances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id').notNull(),
    deviceId: uuid('device_id').notNull(),
    subscriptionId: uuid('subscription_id').notNull(),
    licenseSerial: bigint('license_serial', { mode: 'bigint' })
      .notNull()
      .generatedAlwaysAsIdentity(),
    signedPayload: jsonb('signed_payload').$type<Record<string, unknown>>().notNull(),
    signature: text('signature').notNull(),
    keyId: text('key_id').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokeReason: text('revoke_reason'),
  },
  (table) => [
    foreignKey({
      name: 'license_issuances_subscription_id_fkey',
      columns: [table.subscriptionId],
      foreignColumns: [subscriptions.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'license_issuances_store_id_device_id_fkey',
      columns: [table.storeId, table.deviceId],
      foreignColumns: [devices.storeId, devices.id],
    }).onDelete('restrict'),
    unique('license_issuances_license_serial_key').on(table.licenseSerial),
    check('license_issuances_check', sql`${table.expiresAt} > ${table.issuedAt}`),
    index('idx_license_store_device').on(table.storeId, table.deviceId, table.expiresAt.desc()),
  ],
);

export const adminActions = platformSchema.table(
  'admin_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adminUserId: uuid('admin_user_id').notNull(),
    storeId: uuid('store_id'),
    action: text('action').notNull(),
    reason: text('reason').notNull(),
    requestId: uuid('request_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'admin_actions_admin_user_id_fkey',
      columns: [table.adminUserId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'admin_actions_store_id_fkey',
      columns: [table.storeId],
      foreignColumns: [stores.id],
    }).onDelete('restrict'),
    check('admin_actions_action_nonempty_check', sql`length(trim(${table.action})) > 0`),
    check('admin_actions_reason_nonempty_check', sql`length(trim(${table.reason})) > 0`),
    check('admin_actions_metadata_object_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
  ],
);

export const authSessions = platformSchema.table(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    storeId: uuid('store_id'),
    deviceId: uuid('device_id'),
    accessTokenJti: uuid('access_token_jti').notNull(),
    ipHash: text('ip_hash'),
    userAgentHash: text('user_agent_hash'),
    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokeReason: text('revoke_reason'),
  },
  (table) => [
    foreignKey({
      name: 'auth_sessions_user_id_fkey',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'auth_sessions_store_id_fkey',
      columns: [table.storeId],
      foreignColumns: [stores.id],
    }).onDelete('cascade'),
    unique('auth_sessions_access_token_jti_key').on(table.accessTokenJti),
    foreignKey({
      name: 'auth_sessions_store_id_device_id_fkey',
      columns: [table.storeId, table.deviceId],
      foreignColumns: [devices.storeId, devices.id],
    }).onDelete('cascade'),
    check('auth_sessions_check', sql`${table.expiresAt} > ${table.issuedAt}`),
    index('idx_auth_sessions_user').on(table.userId, table.expiresAt.desc()),
  ],
);

export const refreshTokens = platformSchema.table(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    familyId: uuid('family_id').notNull(),
    parentTokenId: uuid('parent_token_id'),
    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    replacedById: uuid('replaced_by_id'),
  },
  (table) => [
    foreignKey({
      name: 'refresh_tokens_session_id_fkey',
      columns: [table.sessionId],
      foreignColumns: [authSessions.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'refresh_tokens_parent_token_id_fkey',
      columns: [table.parentTokenId],
      foreignColumns: [table.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'refresh_tokens_replaced_by_id_fkey',
      columns: [table.replacedById],
      foreignColumns: [table.id],
    }).onDelete('set null'),
    unique('refresh_tokens_token_hash_key').on(table.tokenHash),
    check('refresh_tokens_check', sql`${table.expiresAt} > ${table.issuedAt}`),
    index('idx_refresh_tokens_session').on(table.sessionId, table.expiresAt.desc()),
  ],
);

export const schemaMigrations = platformSchema.table(
  'schema_migrations',
  {
    filename: text('filename').primaryKey(),
    checksumSha256: text('checksum_sha256').notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'date' }).notNull(),
    registeredAt: timestamp('registered_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    appliedBy: text('applied_by').notNull(),
    executionMs: integer('execution_ms').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [
    check(
      'schema_migrations_filename_check',
      sql`${table.filename} ~ '^[0-9]{4}_[a-z0-9_]+[.]sql$'`,
    ),
    check(
      'schema_migrations_checksum_sha256_check',
      sql`${table.checksumSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check('schema_migrations_applied_by_check', sql`length(trim(${table.appliedBy})) > 0`),
    check('schema_migrations_execution_ms_check', sql`${table.executionMs} >= 0`),
    check('schema_migrations_metadata_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
  ],
);
