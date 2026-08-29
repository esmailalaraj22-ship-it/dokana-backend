// Station 7 / Task 7.2 — Store settings physical foundation type boundary.
//
// This module defines the type separation that later Station 7 Tasks (7.3 read,
// 7.4 write) must build upon. It intentionally contains no workflow, no HTTP
// endpoint, no repository implementation, and no persistence access. Its purpose
// is to keep the physical storage model from silently becoming the public read
// model or the mutation surface.
//
// Four distinct concepts:
//   AppSettingsRow           full physical row (all mapped columns)
//   AppSettingsReadModel     public GET projection (Task 7.3 assembles it)
//   AppSettingsUpdateCommand normalized domain intent for a PATCH (Task 7.4)
//   AppSettingsUpdateInput   explicit allowlist a repository may write (Task 7.4)

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
 * Full physical `ledger.app_settings` row. Used only by the persistence layer.
 * `bigint` values are represented losslessly and never as JavaScript numbers.
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
 * Public read projection returned by the future GET workflow. It excludes the
 * server-derived tenant key, the device-local directory URIs, and the
 * preparatory business-day cutoff fields. `bigint` values become lossless
 * decimal strings; timestamps become RFC 3339 UTC strings. Timezone is exposed
 * read-only. GET tolerates a persisted `allow` value without rewriting it.
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
  timezoneName: string;
  version: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Normalized PATCH intent. Every field is optional; an omitted field leaves the
 * persisted value unchanged. `defaultCreditLimitMinor: null` explicitly clears
 * the Store-wide limit. No other field accepts null.
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
 * commands, and the central PostgreSQL row must keep them NULL so the existing
 * full-row change-event trigger cannot leak a device path.
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
 * Semantics: `INSERT INTO ledger.app_settings (store_id) VALUES (:storeId)
 * ON CONFLICT (store_id) DO NOTHING` inside a trusted tenant transaction. It is
 * idempotent, never invoked by GET or by a read_only Store, and it initializes
 * the device-local URI columns as NULL. GET does not create; PATCH does not
 * silently upsert.
 */
export type EnsureSettingsForStore = (storeId: string) => Promise<void>;
