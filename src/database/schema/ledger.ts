import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
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

// Store operational settings singleton. Exactly one row per Store keyed by the
// primary key store_id. The mapping models physical truth for every column,
// including fields that are not publicly readable or client-mutable (timezone,
// business-day preparation, and the device-local directory URIs). Mapping a
// column here does not grant API exposure, client mutability, or Product policy.
export const appSettings = ledgerSchema.table(
  'app_settings',
  {
    storeId: uuid('store_id').primaryKey(),
    dailyReportTimeMinutes: integer('daily_report_time_minutes').notNull().default(1200),
    defaultCreditPolicy: text('default_credit_policy')
      .$type<'allow' | 'warn' | 'block'>()
      .notNull()
      .default('warn'),
    defaultCreditLimitMinor: bigint('default_credit_limit_minor', { mode: 'bigint' }),
    allowNegativeStock: boolean('allow_negative_stock').notNull().default(false),
    lowStockAlertEnabled: boolean('low_stock_alert_enabled').notNull().default(true),
    debtAgeAlertDays: integer('debt_age_alert_days').notNull().default(90),
    backupEnabled: boolean('backup_enabled').notNull().default(true),
    backupIntervalHours: integer('backup_interval_hours').notNull().default(24),
    exportDirectoryUri: text('export_directory_uri'),
    attachmentsDirectoryUri: text('attachments_directory_uri'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
    timezoneName: text('timezone_name').notNull().default('Asia/Hebron'),
    businessDayStartMinutes: integer('business_day_start_minutes').notNull().default(720),
    businessDayEndMinutes: integer('business_day_end_minutes').notNull().default(720),
    businessDayMode: text('business_day_mode')
      .$type<'fixed_24h' | 'custom'>()
      .notNull()
      .default('fixed_24h'),
  },
  (table) => [
    foreignKey({
      name: 'app_settings_store_id_fkey',
      columns: [table.storeId],
      foreignColumns: [stores.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check(
      'app_settings_daily_report_time_minutes_check',
      sql`${table.dailyReportTimeMinutes} >= 0 and ${table.dailyReportTimeMinutes} <= 1439`,
    ),
    check(
      'app_settings_default_credit_policy_check',
      sql`${table.defaultCreditPolicy} in ('allow', 'warn', 'block')`,
    ),
    check(
      'app_settings_default_credit_limit_minor_check',
      sql`${table.defaultCreditLimitMinor} is null or ${table.defaultCreditLimitMinor} >= 0`,
    ),
    check('app_settings_debt_age_alert_days_check', sql`${table.debtAgeAlertDays} >= 0`),
    check('app_settings_backup_interval_hours_check', sql`${table.backupIntervalHours} >= 1`),
    check('app_settings_version_check', sql`${table.version} >= 1`),
    check(
      'app_settings_business_day_start_minutes_check',
      sql`${table.businessDayStartMinutes} >= 0 and ${table.businessDayStartMinutes} <= 1439`,
    ),
    check(
      'app_settings_business_day_end_minutes_check',
      sql`${table.businessDayEndMinutes} >= 0 and ${table.businessDayEndMinutes} <= 1439`,
    ),
    check(
      'app_settings_business_day_mode_check',
      sql`${table.businessDayMode} in ('fixed_24h', 'custom')`,
    ),
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

export const customers = ledgerSchema.table(
  'customers',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    phone: text('phone').notNull(),
    normalizedPhone: text('normalized_phone').notNull(),
    notes: text('notes'),
    creditLimitMinor: bigint('credit_limit_minor', { mode: 'bigint' }),
    creditPolicy: text('credit_policy').$type<'allow' | 'warn' | 'block'>(),
    status: text('status').$type<'active' | 'archived'>().notNull().default('active'),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
    deviceId: uuid('device_id'),
    operationId: uuid('operation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  },
  (table) => [
    foreignKey({
      name: 'customers_store_id_fkey',
      columns: [table.storeId],
      foreignColumns: [stores.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'customers_store_id_device_id_fkey',
      columns: [table.storeId, table.deviceId],
      foreignColumns: [devices.storeId, devices.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    unique('customers_store_id_id_key').on(table.storeId, table.id),
    unique('customers_store_id_normalized_phone_key').on(table.storeId, table.normalizedPhone),
    unique('customers_store_id_operation_id_key').on(table.storeId, table.operationId),
    check('customers_name_check', sql`length(trim(${table.name})) > 0`),
    check('customers_normalized_name_check', sql`length(trim(${table.normalizedName})) > 0`),
    check('customers_phone_check', sql`length(trim(${table.phone})) > 0`),
    check('customers_normalized_phone_check', sql`length(trim(${table.normalizedPhone})) > 0`),
    check(
      'customers_credit_limit_minor_check',
      sql`${table.creditLimitMinor} is null or ${table.creditLimitMinor} >= 0`,
    ),
    check(
      'customers_credit_policy_check',
      sql`${table.creditPolicy} is null or ${table.creditPolicy} in ('allow', 'warn', 'block')`,
    ),
    check('customers_status_check', sql`${table.status} in ('active', 'archived')`),
    check(
      'customers_check',
      sql`(${table.status} = 'archived' and ${table.archivedAt} is not null) or ${table.status} = 'active'`,
    ),
    check('customers_version_check', sql`${table.version} >= 1`),
    index('idx_customers_search').on(
      table.storeId,
      table.status,
      table.normalizedName,
      table.normalizedPhone,
    ),
  ],
);

export const suppliers = ledgerSchema.table(
  'suppliers',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    phone: text('phone'),
    normalizedPhone: text('normalized_phone'),
    notes: text('notes'),
    status: text('status').$type<'active' | 'archived'>().notNull().default('active'),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
    deviceId: uuid('device_id'),
    operationId: uuid('operation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  },
  (table) => [
    foreignKey({
      name: 'suppliers_store_id_fkey',
      columns: [table.storeId],
      foreignColumns: [stores.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'suppliers_store_id_device_id_fkey',
      columns: [table.storeId, table.deviceId],
      foreignColumns: [devices.storeId, devices.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    unique('suppliers_store_id_id_key').on(table.storeId, table.id),
    unique('suppliers_store_id_normalized_phone_key').on(table.storeId, table.normalizedPhone),
    unique('suppliers_store_id_operation_id_key').on(table.storeId, table.operationId),
    check('suppliers_name_check', sql`length(trim(${table.name})) > 0`),
    check('suppliers_normalized_name_check', sql`length(trim(${table.normalizedName})) > 0`),
    check('suppliers_status_check', sql`${table.status} in ('active', 'archived')`),
    check(
      'suppliers_check',
      sql`(${table.status} = 'archived' and ${table.archivedAt} is not null) or ${table.status} = 'active'`,
    ),
    check('suppliers_version_check', sql`${table.version} >= 1`),
    index('idx_suppliers_search').on(
      table.storeId,
      table.status,
      table.normalizedName,
      table.normalizedPhone,
    ),
  ],
);

export const products = ledgerSchema.table(
  'products',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    sku: text('sku'),
    barcode: text('barcode'),
    description: text('description'),
    measurementType: text('measurement_type')
      .$type<'count' | 'weight' | 'volume' | 'length'>()
      .notNull(),
    trackInventory: boolean('track_inventory').notNull().default(true),
    allowNegativeStockOverride: boolean('allow_negative_stock_override'),
    lowStockThresholdMilli: bigint('low_stock_threshold_milli', { mode: 'bigint' }),
    isPinned: boolean('is_pinned').notNull().default(false),
    status: text('status').$type<'active' | 'archived'>().notNull().default('active'),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
    deviceId: uuid('device_id'),
    operationId: uuid('operation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  },
  (table) => [
    foreignKey({
      name: 'products_store_id_fkey',
      columns: [table.storeId],
      foreignColumns: [stores.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'products_store_id_device_id_fkey',
      columns: [table.storeId, table.deviceId],
      foreignColumns: [devices.storeId, devices.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    unique('products_store_id_id_key').on(table.storeId, table.id),
    unique('products_store_id_id_measurement_type_key').on(
      table.storeId,
      table.id,
      table.measurementType,
    ),
    unique('products_store_id_sku_key').on(table.storeId, table.sku),
    unique('products_store_id_barcode_key').on(table.storeId, table.barcode),
    unique('products_store_id_operation_id_key').on(table.storeId, table.operationId),
    check('products_name_check', sql`length(trim(${table.name})) > 0`),
    check('products_normalized_name_check', sql`length(trim(${table.normalizedName})) > 0`),
    check(
      'products_measurement_type_check',
      sql`${table.measurementType} in ('count', 'weight', 'volume', 'length')`,
    ),
    check(
      'products_low_stock_threshold_milli_check',
      sql`${table.lowStockThresholdMilli} is null or ${table.lowStockThresholdMilli} >= 0`,
    ),
    check('products_status_check', sql`${table.status} in ('active', 'archived')`),
    check(
      'products_check',
      sql`(${table.status} = 'archived' and ${table.archivedAt} is not null) or ${table.status} = 'active'`,
    ),
    check('products_version_check', sql`${table.version} >= 1`),
    index('idx_products_search').on(
      table.storeId,
      table.status,
      table.normalizedName,
      table.barcode,
      table.sku,
      table.isPinned,
    ),
  ],
);

export const productUnits = ledgerSchema.table(
  'product_units',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    productId: uuid('product_id').notNull(),
    measurementType: text('measurement_type')
      .$type<'count' | 'weight' | 'volume' | 'length'>()
      .notNull(),
    unitName: text('unit_name').notNull(),
    unitCode: text('unit_code'),
    isBase: boolean('is_base').notNull().default(false),
    factorNum: integer('factor_num').notNull(),
    factorDen: integer('factor_den').notNull().default(1),
    salePriceMinor: bigint('sale_price_minor', { mode: 'bigint' }),
    purchasePriceMinor: bigint('purchase_price_minor', { mode: 'bigint' }),
    status: text('status').$type<'active' | 'archived'>().notNull().default('active'),
    deviceId: uuid('device_id'),
    operationId: uuid('operation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  },
  (table) => [
    foreignKey({
      name: 'product_units_store_id_product_id_measurement_type_fkey',
      columns: [table.storeId, table.productId, table.measurementType],
      foreignColumns: [products.storeId, products.id, products.measurementType],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'product_units_store_id_device_id_fkey',
      columns: [table.storeId, table.deviceId],
      foreignColumns: [devices.storeId, devices.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    unique('product_units_store_id_id_key').on(table.storeId, table.id),
    unique('product_units_store_id_product_id_id_key').on(table.storeId, table.productId, table.id),
    unique('product_units_store_id_product_id_unit_name_key').on(
      table.storeId,
      table.productId,
      table.unitName,
    ),
    unique('product_units_store_id_operation_id_key').on(table.storeId, table.operationId),
    check(
      'product_units_measurement_type_check',
      sql`${table.measurementType} in ('count', 'weight', 'volume', 'length')`,
    ),
    check('product_units_unit_name_check', sql`length(trim(${table.unitName})) > 0`),
    check('product_units_factor_num_check', sql`${table.factorNum} > 0`),
    check('product_units_factor_den_check', sql`${table.factorDen} > 0`),
    check(
      'product_units_sale_price_minor_check',
      sql`${table.salePriceMinor} is null or ${table.salePriceMinor} >= 0`,
    ),
    check(
      'product_units_purchase_price_minor_check',
      sql`${table.purchasePriceMinor} is null or ${table.purchasePriceMinor} >= 0`,
    ),
    check('product_units_status_check', sql`${table.status} in ('active', 'archived')`),
    check(
      'product_units_check',
      sql`(${table.isBase} = true and ${table.factorNum} = 1 and ${table.factorDen} = 1) or ${table.isBase} = false`,
    ),
    check('product_units_version_check', sql`${table.version} >= 1`),
    uniqueIndex('uq_product_one_base_unit')
      .on(table.storeId, table.productId)
      .where(sql`${table.isBase} = true and ${table.status} = 'active'`),
  ],
);

export const moneyAccounts = ledgerSchema.table(
  'money_accounts',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    accountType: text('account_type').$type<'cash' | 'transfer' | 'external_party'>().notNull(),
    availability: text('availability')
      .$type<'available' | 'held_by_external_party'>()
      .notNull()
      .default('available'),
    isDefault: boolean('is_default').notNull().default(false),
    status: text('status').$type<'active' | 'archived'>().notNull().default('active'),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
    deviceId: uuid('device_id'),
    operationId: uuid('operation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  },
  (table) => [
    foreignKey({
      name: 'money_accounts_store_id_fkey',
      columns: [table.storeId],
      foreignColumns: [stores.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'money_accounts_store_id_device_id_fkey',
      columns: [table.storeId, table.deviceId],
      foreignColumns: [devices.storeId, devices.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    unique('money_accounts_store_id_id_key').on(table.storeId, table.id),
    unique('money_accounts_store_id_normalized_name_key').on(table.storeId, table.normalizedName),
    unique('money_accounts_store_id_operation_id_key').on(table.storeId, table.operationId),
    check('money_accounts_name_check', sql`length(trim(${table.name})) > 0`),
    check('money_accounts_normalized_name_check', sql`length(trim(${table.normalizedName})) > 0`),
    check(
      'money_accounts_account_type_check',
      sql`${table.accountType} in ('cash', 'transfer', 'external_party')`,
    ),
    check(
      'money_accounts_availability_check',
      sql`${table.availability} in ('available', 'held_by_external_party')`,
    ),
    check('money_accounts_status_check', sql`${table.status} in ('active', 'archived')`),
    check(
      'money_accounts_check',
      sql`(${table.status} = 'archived' and ${table.archivedAt} is not null) or ${table.status} = 'active'`,
    ),
    check('money_accounts_version_check', sql`${table.version} >= 1`),
    uniqueIndex('uq_store_single_cash_account')
      .on(table.storeId)
      .where(sql`${table.accountType} = 'cash' and ${table.status} = 'active'`),
  ],
);

export const accountingPeriods = ledgerSchema.table(
  'accounting_periods',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    periodYear: integer('period_year').notNull(),
    periodMonth: integer('period_month').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true, mode: 'date' }).notNull(),
    status: text('status').$type<'open' | 'closing' | 'closed'>().notNull().default('open'),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    deviceId: uuid('device_id'),
    operationId: uuid('operation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  },
  (table) => [
    foreignKey({
      name: 'accounting_periods_store_id_fkey',
      columns: [table.storeId],
      foreignColumns: [stores.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'accounting_periods_store_id_device_id_fkey',
      columns: [table.storeId, table.deviceId],
      foreignColumns: [devices.storeId, devices.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    unique('accounting_periods_store_id_id_key').on(table.storeId, table.id),
    unique('accounting_periods_store_id_period_year_period_month_key').on(
      table.storeId,
      table.periodYear,
      table.periodMonth,
    ),
    unique('accounting_periods_store_id_operation_id_key').on(table.storeId, table.operationId),
    check('accounting_periods_period_year_check', sql`${table.periodYear} >= 2020`),
    check('accounting_periods_period_month_check', sql`${table.periodMonth} between 1 and 12`),
    check('accounting_periods_status_check', sql`${table.status} in ('open', 'closing', 'closed')`),
    check('accounting_periods_check', sql`${table.endsAt} > ${table.startsAt}`),
    check(
      'accounting_periods_check1',
      sql`(${table.status} = 'closed' and ${table.closedAt} is not null) or ${table.status} in ('open', 'closing')`,
    ),
    check('accounting_periods_version_check', sql`${table.version} >= 1`),
  ],
);

export const moneyMovementTypes = [
  'opening_balance',
  'sale_payment',
  'customer_payment',
  'supplier_payment',
  'expense_payment',
  'owner_contribution',
  'owner_loan',
  'owner_reimbursement',
  'owner_withdrawal',
  'internal_transfer',
  'customer_refund',
  'supplier_refund',
  'correction',
  'other',
] as const;

export type MoneyMovementTypeValue = (typeof moneyMovementTypes)[number];

export const moneyMovements = ledgerSchema.table(
  'money_movements',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    accountId: uuid('account_id').notNull(),
    accountingPeriodId: uuid('accounting_period_id').notNull(),
    movementType: text('movement_type').$type<MoneyMovementTypeValue>().notNull(),
    amountDeltaMinor: bigint('amount_delta_minor', { mode: 'bigint' }).notNull(),
    referenceType: text('reference_type').notNull(),
    referenceId: uuid('reference_id').notNull(),
    transactionGroupId: uuid('transaction_group_id').notNull(),
    transferGroupId: uuid('transfer_group_id'),
    counterAccountId: uuid('counter_account_id'),
    counterpartyName: text('counterparty_name'),
    externalReference: text('external_reference'),
    notes: text('notes'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    reversalOfId: uuid('reversal_of_id'),
    deviceId: uuid('device_id'),
    operationId: uuid('operation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'money_movements_store_id_account_id_fkey',
      columns: [table.storeId, table.accountId],
      foreignColumns: [moneyAccounts.storeId, moneyAccounts.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'money_movements_store_id_accounting_period_id_fkey',
      columns: [table.storeId, table.accountingPeriodId],
      foreignColumns: [accountingPeriods.storeId, accountingPeriods.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'money_movements_store_id_counter_account_id_fkey',
      columns: [table.storeId, table.counterAccountId],
      foreignColumns: [moneyAccounts.storeId, moneyAccounts.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'money_movements_store_id_reversal_of_id_fkey',
      columns: [table.storeId, table.reversalOfId],
      foreignColumns: [table.storeId, table.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'money_movements_store_id_device_id_fkey',
      columns: [table.storeId, table.deviceId],
      foreignColumns: [devices.storeId, devices.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    unique('money_movements_store_id_id_key').on(table.storeId, table.id),
    unique('money_movements_store_id_operation_id_key').on(table.storeId, table.operationId),
    check(
      'money_movements_movement_type_check',
      sql`${table.movementType} in ('opening_balance', 'sale_payment', 'customer_payment', 'supplier_payment', 'expense_payment', 'owner_contribution', 'owner_loan', 'owner_reimbursement', 'owner_withdrawal', 'internal_transfer', 'customer_refund', 'supplier_refund', 'correction', 'other')`,
    ),
    check('money_movements_amount_delta_minor_check', sql`${table.amountDeltaMinor} <> 0`),
  ],
);

export const ownerLedgerEntryTypes = [
  'capital_contribution',
  'owner_loan_to_store',
  'owner_paid_expense',
  'owner_paid_supplier',
  'owner_reimbursement',
  'personal_withdrawal',
  'profit_withdrawal',
  'capital_withdrawal',
  'correction',
] as const;

export type OwnerLedgerEntryTypeValue = (typeof ownerLedgerEntryTypes)[number];

export const ownerLedgerEntries = ledgerSchema.table(
  'owner_ledger_entries',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    accountingPeriodId: uuid('accounting_period_id').notNull(),
    entryType: text('entry_type').$type<OwnerLedgerEntryTypeValue>().notNull(),
    ownerLiabilityDeltaMinor: bigint('owner_liability_delta_minor', { mode: 'bigint' })
      .notNull()
      .default(0n),
    equityDeltaMinor: bigint('equity_delta_minor', { mode: 'bigint' }).notNull().default(0n),
    moneyAccountId: uuid('money_account_id'),
    referenceType: text('reference_type'),
    referenceId: uuid('reference_id'),
    transactionGroupId: uuid('transaction_group_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    reversalOfId: uuid('reversal_of_id'),
    reason: text('reason'),
    deviceId: uuid('device_id'),
    operationId: uuid('operation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'owner_ledger_entries_store_id_accounting_period_id_fkey',
      columns: [table.storeId, table.accountingPeriodId],
      foreignColumns: [accountingPeriods.storeId, accountingPeriods.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'owner_ledger_entries_store_id_money_account_id_fkey',
      columns: [table.storeId, table.moneyAccountId],
      foreignColumns: [moneyAccounts.storeId, moneyAccounts.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'owner_ledger_entries_store_id_reversal_of_id_fkey',
      columns: [table.storeId, table.reversalOfId],
      foreignColumns: [table.storeId, table.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      name: 'owner_ledger_entries_store_id_device_id_fkey',
      columns: [table.storeId, table.deviceId],
      foreignColumns: [devices.storeId, devices.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    unique('owner_ledger_entries_store_id_id_key').on(table.storeId, table.id),
    unique('owner_ledger_entries_store_id_operation_id_key').on(table.storeId, table.operationId),
    index('idx_owner_ledger_time').on(table.storeId, table.occurredAt.desc()),
    check(
      'owner_ledger_entries_entry_type_check',
      sql`${table.entryType} in ('capital_contribution', 'owner_loan_to_store', 'owner_paid_expense', 'owner_paid_supplier', 'owner_reimbursement', 'personal_withdrawal', 'profit_withdrawal', 'capital_withdrawal', 'correction')`,
    ),
    check(
      'owner_ledger_entries_check',
      sql`${table.ownerLiabilityDeltaMinor} <> 0 or ${table.equityDeltaMinor} <> 0`,
    ),
  ],
);

export const ownerPosition = ledgerSchema
  .view('v_owner_position', {
    storeId: uuid('store_id').notNull(),
    storeOwesOwnerMinor: bigint('store_owes_owner_minor', { mode: 'bigint' }).notNull(),
    ownerEquityMovementMinor: bigint('owner_equity_movement_minor', {
      mode: 'bigint',
    }).notNull(),
  })
  .existing();
