// Station 7 / Task 7.2 — Store settings physical foundation type boundary.
//
// This module defines the type separation used by Task 7.3 reads and required by
// the future Task 7.4 write workflow. It intentionally contains no workflow,
// HTTP endpoint, repository implementation, or persistence access. Its purpose
// is to keep the physical storage model from silently becoming the public read
// model or the mutation surface, and to keep PostgreSQL physical defaults from
// silently becoming approved Product policy.
//
// Distinct concepts:
//   AppSettingsRow                 full physical row (all mapped columns)
//   AppSettingsReadModel           public GET projection (Task 7.3 assembles it)
//   AppSettingsUpdateCommand       normalized mutable values for a PATCH
//   AppSettingsUpdateInput         explicit allowlist a repository may write
//   PreparedAppSettingsUpdate      values + operation/idempotency metadata (7.4)
//   AppSettingsInitializationValues explicit provisioning values (no DB default)

import type { TenantTransactionContext } from '../database/database.types';

/**
 * A persisted default credit policy may still contain the legacy physical value
 * `allow`, which the current Product policy no longer accepts as new input.
 */
export type PersistedCreditPolicy = 'allow' | 'warn' | 'block';

/**
 * New settings writes accept only the approved Product policy (PRD FR-CUS-05:
 * warning or blocking). `allow` is deliberately absent from writable input; it
 * is never rewritten or silently translated.
 */
export type WritableCreditPolicy = 'warn' | 'block';

export type BusinessDayMode = 'fixed_24h' | 'custom';

/**
 * The MVP public operational timezone is the fixed IANA literal `Asia/Hebron`.
 * Physical storage remains `text`; the public/product contract is narrower than
 * physical capability by design.
 */
export type MvpTimezone = 'Asia/Hebron';

export const MVP_TIMEZONE_NAME: MvpTimezone = 'Asia/Hebron';

/** The fixed MVP business-day mode. Physical storage remains `text`. */
export type MvpBusinessDayMode = 'fixed_24h';

/**
 * Full physical `ledger.app_settings` row. Used only by the persistence layer.
 * `bigint` values are represented losslessly and never as JavaScript numbers.
 * A compile-time parity assertion in the schema spec proves this stays
 * structurally equivalent to the Drizzle mapping (`app-settings.schema.spec.ts`).
 */
export interface AppSettingsRow {
  storeId: string;
  dailyReportTimeMinutes: number;
  defaultCreditPolicy: PersistedCreditPolicy;
  defaultCreditLimitMinor: bigint | null;
  allowNegativeStock: boolean;
  lowStockAlertEnabled: boolean;
  debtAgeAlertDays: number;
  backupEnabled: boolean;
  backupIntervalHours: number;
  exportDirectoryUri: string | null;
  attachmentsDirectoryUri: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: bigint;
  timezoneName: string;
  businessDayStartMinutes: number;
  businessDayEndMinutes: number;
  businessDayMode: BusinessDayMode;
}

/**
 * Public read projection returned by the GET workflow. It excludes the
 * server-derived tenant key, the device-local directory URIs, and the
 * preparatory business-day cutoff fields. `bigint` values become lossless
 * decimal strings; timestamps become RFC 3339 UTC strings. Timezone is exposed
 * read-only as the fixed MVP literal. GET tolerates a persisted `allow` value
 * without rewriting it.
 */
export interface AppSettingsReadModel {
  dailyReportTimeMinutes: number;
  defaultCreditPolicy: PersistedCreditPolicy;
  defaultCreditLimitMinor: string | null;
  allowNegativeStock: boolean;
  lowStockAlertEnabled: boolean;
  debtAgeAlertDays: number;
  backupEnabled: boolean;
  backupIntervalHours: number;
  timezoneName: MvpTimezone;
  version: string;
  createdAt: string;
  updatedAt: string;
}

/** Public PATCH response. The operation identity is included for offline retry correlation. */
export interface AppSettingsMutationResponse extends AppSettingsReadModel {
  operationId: string;
}

/**
 * Narrow physical projection used by the settings read repository. It contains
 * only columns required to assemble the public read model.
 */
export interface AppSettingsReadRow {
  dailyReportTimeMinutes: number;
  defaultCreditPolicy: PersistedCreditPolicy;
  defaultCreditLimitMinor: bigint | null;
  allowNegativeStock: boolean;
  lowStockAlertEnabled: boolean;
  debtAgeAlertDays: number;
  backupEnabled: boolean;
  backupIntervalHours: number;
  timezoneName: string;
  version: bigint;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Normalized PATCH values. Every field is optional; an omitted field leaves the
 * persisted value unchanged. `defaultCreditLimitMinor: null` explicitly clears
 * the Store-wide limit. No other field accepts null.
 *
 * Empty-command semantics (frozen S7 contract Section 8.2, matching the
 * established Customer/Product/Supplier pattern): a PATCH must contain at least
 * one mutable field. An empty command is structurally disallowed and rejected by
 * the future write service; it is NOT an implicit success. A canonical no-op is
 * distinct: it is a request that supplies fields whose values already equal the
 * persisted state, which succeeds without a physical `UPDATE`.
 */
export interface AppSettingsUpdateCommand {
  dailyReportTimeMinutes?: number;
  defaultCreditPolicy?: WritableCreditPolicy;
  defaultCreditLimitMinor?: bigint | null;
  allowNegativeStock?: boolean;
  lowStockAlertEnabled?: boolean;
  debtAgeAlertDays?: number;
  backupEnabled?: boolean;
  backupIntervalHours?: number;
}

/**
 * Explicit allowlist a future settings repository may translate into an explicit
 * Drizzle `.set({...})`. Structurally identical to the command by design: the
 * repository must never receive server-only, device-local, timezone, or
 * business-day fields, and must never accept a raw request body.
 */
export type AppSettingsUpdateInput = AppSettingsUpdateCommand;

/**
 * Complete prepared settings mutation for the future write repository (Task 7.4),
 * mirroring the established Customer/Product/Supplier prepared-mutation pattern.
 * It separates the settings values to change from the operation/idempotency
 * metadata so a settings write can never be confused with a plain value object.
 * The future write service builds `requestHash` from a canonical request that
 * includes the contract version, action, `expectedVersion`, and the supplied
 * values. `operationId` is claim identity and is not part of the hashed payload.
 */
export interface PreparedAppSettingsUpdate {
  operationId: string;
  expectedVersion: bigint;
  values: AppSettingsUpdateCommand;
  requestHash: string;
}

export type AppSettingsMutationFailureCode =
  | 'SETTINGS_NOT_INITIALIZED'
  | 'SETTINGS_VERSION_CONFLICT'
  | 'OPERATION_ID_CONFLICT'
  | 'OPERATION_IN_PROGRESS';

export interface AppSettingsMutationFailure {
  code: AppSettingsMutationFailureCode;
  message: string;
  statusCode: 404 | 409;
}

export type AppSettingsMutationResult =
  | { ok: true; response: AppSettingsMutationResponse }
  | { ok: false; error: AppSettingsMutationFailure };

/**
 * Explicit, application-owned initial settings values that controlled Store
 * provisioning MUST supply. PostgreSQL physical defaults are not Product policy,
 * so the future initializer requires these values rather than relying on
 * `ON CONFLICT DO NOTHING` to adopt database defaults.
 *
 * Excluded on purpose:
 *   - DB-managed values (`version`, `createdAt`, `updatedAt`) remain DB-managed.
 *   - Device-local URI columns are not initialization input; they start NULL.
 *   - `businessDayStartMinutes`/`businessDayEndMinutes` are inert preparatory
 *     storage under the fixed MVP `fixed_24h` mode and carry no Product meaning,
 *     so their preparatory physical value is acceptable and they are not required
 *     policy input here.
 *
 * `timezoneName` and `businessDayMode` are fixed server-owned MVP constants
 * (not client input), typed as literals so provisioning cannot drift from the
 * approved MVP contract.
 */
export interface AppSettingsInitializationValues {
  dailyReportTimeMinutes: number;
  defaultCreditPolicy: WritableCreditPolicy;
  defaultCreditLimitMinor: bigint | null;
  allowNegativeStock: boolean;
  lowStockAlertEnabled: boolean;
  debtAgeAlertDays: number;
  backupEnabled: boolean;
  backupIntervalHours: number;
  timezoneName: MvpTimezone;
  businessDayMode: MvpBusinessDayMode;
}

/**
 * The only `app_settings` values that Station 7 MVP may mutate. A future write
 * repository MUST build its update object from exactly these keys and MUST NOT
 * use generic request-body passthrough.
 */
export const APP_SETTINGS_MUTABLE_FIELDS = [
  'dailyReportTimeMinutes',
  'defaultCreditPolicy',
  'defaultCreditLimitMinor',
  'allowNegativeStock',
  'lowStockAlertEnabled',
  'debtAgeAlertDays',
  'backupEnabled',
  'backupIntervalHours',
] as const;

/**
 * Server-managed / non-MVP-mutable physical fields. They are never accepted from
 * a client and never written through the settings update path.
 */
export const APP_SETTINGS_SERVER_ONLY_FIELDS = [
  'storeId',
  'createdAt',
  'updatedAt',
  'version',
  'timezoneName',
  'businessDayStartMinutes',
  'businessDayEndMinutes',
  'businessDayMode',
] as const;

/**
 * Device-local fields. They are excluded from public read models and mutation
 * commands. The central PostgreSQL row must keep them NULL: central application
 * code must never write a non-NULL value. The existing full-row change-event
 * trigger still serializes these keys, but with NULL values no device path is
 * present (see the Task 7.2 foundation doc and S7-DT-03).
 */
export const APP_SETTINGS_DEVICE_LOCAL_FIELDS = [
  'exportDirectoryUri',
  'attachmentsDirectoryUri',
] as const;

export type AppSettingsMutableField = (typeof APP_SETTINGS_MUTABLE_FIELDS)[number];
export type AppSettingsServerOnlyField = (typeof APP_SETTINGS_SERVER_ONLY_FIELDS)[number];
export type AppSettingsDeviceLocalField = (typeof APP_SETTINGS_DEVICE_LOCAL_FIELDS)[number];

/**
 * J1 singleton-initialization primitive contract (implemented in a later Task).
 * It requires trusted tenant context and explicit application-owned initial
 * values; it must normalize/validate them before the physical
 * `INSERT INTO ledger.app_settings (...) VALUES (...) ON CONFLICT (store_id) DO
 * NOTHING` inside the trusted tenant transaction. It never adopts PostgreSQL
 * physical policy defaults, is idempotent, is never invoked by GET or by a
 * read_only Store, and initializes the device-local URI columns as NULL. GET
 * does not create; PATCH does not silently upsert.
 */
export type EnsureSettingsForStore = (
  context: TenantTransactionContext,
  values: AppSettingsInitializationValues,
) => Promise<void>;
