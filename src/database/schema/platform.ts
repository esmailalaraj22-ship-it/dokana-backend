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
