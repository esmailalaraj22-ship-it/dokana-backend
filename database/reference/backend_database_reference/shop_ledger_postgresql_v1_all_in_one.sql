-- ==================== 01_roles.sql ====================

-- Shop Ledger PostgreSQL v1.0.0
-- Optional group roles. Create login roles separately and grant these group roles.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shop_app_runtime') THEN
        CREATE ROLE shop_app_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shop_app_migrator') THEN
        CREATE ROLE shop_app_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shop_app_readonly') THEN
        CREATE ROLE shop_app_readonly NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF;
END;
$$;



-- ==================== 02_schema.sql ====================

-- Shop Ledger PostgreSQL central database v1.0.0
-- Generated from SQLite local schema v1.1 and augmented for server operation.
-- Run as database owner. Server-only security, sync, views and triggers are in later files.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA IF NOT EXISTS ledger;
CREATE SCHEMA IF NOT EXISTS sync;
CREATE SCHEMA IF NOT EXISTS audit;

COMMENT ON SCHEMA ledger IS 'Store-scoped business data synchronized with mobile SQLite';
COMMENT ON SCHEMA platform IS 'Server-only identity, subscription, license and administration data';
COMMENT ON SCHEMA sync IS 'Idempotency, change feed, cursors, conflicts and bootstrap state';
COMMENT ON SCHEMA audit IS 'Immutable centralized audit trail';


CREATE TABLE ledger.stores (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (length(trim(name)) > 0),
    phone text,
    currency_code text NOT NULL DEFAULT 'ILS' CHECK (currency_code = 'ILS'),
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended', 'read_only', 'archived')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1)
);

CREATE TABLE ledger.devices (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    device_name text NOT NULL CHECK (length(trim(device_name)) > 0),
    platform text NOT NULL CHECK (platform IN ('android', 'ios')),
    installation_id uuid NOT NULL,
    device_prefix text NOT NULL CHECK (length(device_prefix) BETWEEN 2 AND 12),
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked', 'replaced')),
    last_seen_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (store_id, id),
    UNIQUE (store_id, installation_id),
    UNIQUE (store_id, device_prefix),
    FOREIGN KEY (store_id) REFERENCES ledger.stores(id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.document_sequences (
    store_id uuid NOT NULL,
    device_id uuid NOT NULL,
    document_type text NOT NULL CHECK (document_type IN (
        'sale', 'purchase_invoice', 'goods_receipt', 'sale_return',
        'supplier_return', 'stock_count', 'money_transfer'
    )),
    sequence_year integer NOT NULL CHECK (sequence_year >= 2020),
    next_value bigint NOT NULL DEFAULT 1 CHECK (next_value >= 1),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (store_id, device_id, document_type, sequence_year),
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.app_settings (
    store_id uuid PRIMARY KEY,
    daily_report_time_minutes integer NOT NULL DEFAULT 1200
        CHECK (daily_report_time_minutes BETWEEN 0 AND 1439),
    default_credit_policy text NOT NULL DEFAULT 'warn'
        CHECK (default_credit_policy IN ('allow', 'warn', 'block')),
    default_credit_limit_minor bigint
        CHECK (default_credit_limit_minor IS NULL OR default_credit_limit_minor >= 0),
    allow_negative_stock boolean NOT NULL DEFAULT false ,
    low_stock_alert_enabled boolean NOT NULL DEFAULT true ,
    debt_age_alert_days integer NOT NULL DEFAULT 90 CHECK (debt_age_alert_days >= 0),
    backup_enabled boolean NOT NULL DEFAULT true ,
    backup_interval_hours integer NOT NULL DEFAULT 24 CHECK (backup_interval_hours >= 1),
    export_directory_uri text,
    attachments_directory_uri text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    FOREIGN KEY (store_id) REFERENCES ledger.stores(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE ledger.attachments (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('image', 'document', 'receipt', 'other')),
    file_name text NOT NULL CHECK (length(trim(file_name)) > 0),
    mime_type text,
    local_uri text,
    remote_key text,
    file_size_bytes bigint CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
    checksum_sha256 text,
    sync_status text NOT NULL DEFAULT 'local'
        CHECK (sync_status IN ('local', 'pending', 'uploaded', 'failed', 'deleted')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (store_id, id),
    FOREIGN KEY (store_id) REFERENCES ledger.stores(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE ledger.customers (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    name text NOT NULL CHECK (length(trim(name)) > 0),
    normalized_name text NOT NULL CHECK (length(trim(normalized_name)) > 0),
    phone text NOT NULL CHECK (length(trim(phone)) > 0),
    normalized_phone text NOT NULL CHECK (length(trim(normalized_phone)) > 0),
    notes text,
    credit_limit_minor bigint CHECK (credit_limit_minor IS NULL OR credit_limit_minor >= 0),
    credit_policy text CHECK (credit_policy IS NULL OR credit_policy IN ('allow', 'warn', 'block')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    archived_at timestamptz,
    device_id uuid,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (store_id, id),
    UNIQUE (store_id, normalized_phone),
    UNIQUE (store_id, operation_id),
    CHECK ((status = 'archived' AND archived_at IS NOT NULL) OR status = 'active'),
    FOREIGN KEY (store_id) REFERENCES ledger.stores(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.suppliers (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    name text NOT NULL CHECK (length(trim(name)) > 0),
    normalized_name text NOT NULL CHECK (length(trim(normalized_name)) > 0),
    phone text,
    normalized_phone text,
    notes text,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    archived_at timestamptz,
    device_id uuid,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (store_id, id),
    UNIQUE (store_id, normalized_phone),
    UNIQUE (store_id, operation_id),
    CHECK ((status = 'archived' AND archived_at IS NOT NULL) OR status = 'active'),
    FOREIGN KEY (store_id) REFERENCES ledger.stores(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.products (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    name text NOT NULL CHECK (length(trim(name)) > 0),
    normalized_name text NOT NULL CHECK (length(trim(normalized_name)) > 0),
    sku text,
    barcode text,
    description text,
    measurement_type text NOT NULL
        CHECK (measurement_type IN ('count', 'weight', 'volume', 'length')),
    track_inventory boolean NOT NULL DEFAULT true ,
    allow_negative_stock_override boolean,
    low_stock_threshold_milli bigint
        CHECK (low_stock_threshold_milli IS NULL OR low_stock_threshold_milli >= 0),
    is_pinned boolean NOT NULL DEFAULT false ,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    archived_at timestamptz,
    device_id uuid,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (store_id, id),
    UNIQUE (store_id, id, measurement_type),
    UNIQUE (store_id, sku),
    UNIQUE (store_id, barcode),
    UNIQUE (store_id, operation_id),
    CHECK ((status = 'archived' AND archived_at IS NOT NULL) OR status = 'active'),
    FOREIGN KEY (store_id) REFERENCES ledger.stores(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.product_units (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    product_id uuid NOT NULL,
    measurement_type text NOT NULL
        CHECK (measurement_type IN ('count', 'weight', 'volume', 'length')),
    unit_name text NOT NULL CHECK (length(trim(unit_name)) > 0),
    unit_code text,
    is_base boolean NOT NULL DEFAULT false ,
    -- factor_num / factor_den = عدد الوحدات الأساسية في هذه الوحدة.
    factor_num integer NOT NULL CHECK (factor_num > 0),
    factor_den integer NOT NULL DEFAULT 1 CHECK (factor_den > 0),
    sale_price_minor bigint CHECK (sale_price_minor IS NULL OR sale_price_minor >= 0),
    purchase_price_minor bigint CHECK (purchase_price_minor IS NULL OR purchase_price_minor >= 0),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    device_id uuid,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (store_id, id),
    UNIQUE (store_id, product_id, id),
    UNIQUE (store_id, product_id, unit_name),
    UNIQUE (store_id, operation_id),
    CHECK ((is_base = true AND factor_num = 1 AND factor_den = 1) OR is_base = false),
    FOREIGN KEY (store_id, product_id, measurement_type)
        REFERENCES ledger.products(store_id, id, measurement_type)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.money_accounts (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    name text NOT NULL CHECK (length(trim(name)) > 0),
    normalized_name text NOT NULL CHECK (length(trim(normalized_name)) > 0),
    account_type text NOT NULL CHECK (account_type IN ('cash', 'transfer', 'external_party')),
    availability text NOT NULL DEFAULT 'available'
        CHECK (availability IN ('available', 'held_by_external_party')),
    is_default boolean NOT NULL DEFAULT false ,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    archived_at timestamptz,
    device_id uuid,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (store_id, id),
    UNIQUE (store_id, normalized_name),
    UNIQUE (store_id, operation_id),
    CHECK ((status = 'archived' AND archived_at IS NOT NULL) OR status = 'active'),
    FOREIGN KEY (store_id) REFERENCES ledger.stores(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.accounting_periods (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    period_year integer NOT NULL CHECK (period_year >= 2020),
    period_month integer NOT NULL CHECK (period_month BETWEEN 1 AND 12),
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closing', 'closed')),
    closed_at timestamptz,
    device_id uuid,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (store_id, id),
    UNIQUE (store_id, period_year, period_month),
    UNIQUE (store_id, operation_id),
    CHECK (ends_at > starts_at),
    CHECK ((status = 'closed' AND closed_at IS NOT NULL) OR status IN ('open', 'closing')),
    FOREIGN KEY (store_id) REFERENCES ledger.stores(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.expense_categories (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    name text NOT NULL CHECK (length(trim(name)) > 0),
    normalized_name text NOT NULL CHECK (length(trim(normalized_name)) > 0),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    device_id uuid,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (store_id, id),
    UNIQUE (store_id, normalized_name),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id) REFERENCES ledger.stores(id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.money_movements (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    account_id uuid NOT NULL,
    accounting_period_id uuid NOT NULL,
    movement_type text NOT NULL CHECK (movement_type IN (
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
        'other'
    )),
    amount_delta_minor bigint NOT NULL CHECK (amount_delta_minor <> 0),
    reference_type text NOT NULL,
    reference_id uuid NOT NULL,
    transaction_group_id uuid NOT NULL,
    transfer_group_id uuid,
    counter_account_id uuid,
    counterparty_name text,
    external_reference text,
    notes text,
    occurred_at timestamptz NOT NULL,
    reversal_of_id uuid,
    device_id uuid,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (store_id, id),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, account_id)
        REFERENCES ledger.money_accounts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES ledger.accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, counter_account_id)
        REFERENCES ledger.money_accounts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, reversal_of_id)
        REFERENCES ledger.money_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.owner_ledger_entries (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    accounting_period_id uuid NOT NULL,
    entry_type text NOT NULL CHECK (entry_type IN (
        'capital_contribution',
        'owner_loan_to_store',
        'owner_paid_expense',
        'owner_paid_supplier',
        'owner_reimbursement',
        'personal_withdrawal',
        'profit_withdrawal',
        'capital_withdrawal',
        'correction'
    )),
    owner_liability_delta_minor bigint NOT NULL DEFAULT 0,
    equity_delta_minor bigint NOT NULL DEFAULT 0,
    money_account_id uuid,
    reference_type text,
    reference_id uuid,
    transaction_group_id uuid NOT NULL,
    occurred_at timestamptz NOT NULL,
    reversal_of_id uuid,
    reason text,
    device_id uuid,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (owner_liability_delta_minor <> 0 OR equity_delta_minor <> 0),
    UNIQUE (store_id, id),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES ledger.accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, money_account_id)
        REFERENCES ledger.money_accounts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, reversal_of_id)
        REFERENCES ledger.owner_ledger_entries(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.stock_balances (
    store_id uuid NOT NULL,
    product_id uuid NOT NULL,
    quantity_milli bigint NOT NULL DEFAULT 0,
    average_unit_cost_minor bigint NOT NULL DEFAULT 0 CHECK (average_unit_cost_minor >= 0),
    inventory_value_minor bigint NOT NULL DEFAULT 0,
    has_pending_cost boolean NOT NULL DEFAULT false ,
    last_movement_id uuid,
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    PRIMARY KEY (store_id, product_id),
    FOREIGN KEY (store_id, product_id)
        REFERENCES ledger.products(store_id, id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE ledger.inventory_movements (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    product_id uuid NOT NULL,
    accounting_period_id uuid NOT NULL,
    movement_type text NOT NULL CHECK (movement_type IN (
        'opening_balance',
        'purchase_receipt',
        'sale',
        'customer_return_saleable',
        'supplier_return',
        'adjustment_in',
        'adjustment_out',
        'stock_count',
        'correction',
        'owner_use',
        'gift',
        'damage',
        'loss',
        'expiry'
    )),
    quantity_before_milli bigint NOT NULL,
    quantity_delta_milli bigint NOT NULL CHECK (quantity_delta_milli <> 0),
    quantity_after_milli bigint NOT NULL,
    inventory_value_before_minor bigint NOT NULL,
    value_delta_minor bigint NOT NULL,
    inventory_value_after_minor bigint NOT NULL,
    average_unit_cost_after_minor bigint NOT NULL CHECK (average_unit_cost_after_minor >= 0),
    cost_status text NOT NULL CHECK (cost_status IN ('known', 'estimated', 'pending')),
    has_pending_cost_after boolean NOT NULL DEFAULT false ,
    reference_type text NOT NULL,
    reference_id uuid NOT NULL,
    transaction_group_id uuid NOT NULL,
    occurred_at timestamptz NOT NULL,
    reversal_of_id uuid,
    reason text,
    device_id uuid,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (quantity_after_milli = quantity_before_milli + quantity_delta_milli),
    CHECK (inventory_value_after_minor = inventory_value_before_minor + value_delta_minor),
    CHECK (
        (quantity_after_milli = 0 AND inventory_value_after_minor = 0 AND average_unit_cost_after_minor = 0)
        OR quantity_after_milli <> 0
    ),
    UNIQUE (store_id, id),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, product_id)
        REFERENCES ledger.products(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES ledger.accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, reversal_of_id)
        REFERENCES ledger.inventory_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.sales (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    customer_id uuid,
    accounting_period_id uuid,
    display_number text NOT NULL CHECK (length(trim(display_number)) > 0),
    sale_at timestamptz NOT NULL,
    items_subtotal_minor bigint NOT NULL DEFAULT 0 CHECK (items_subtotal_minor >= 0),
    line_discount_total_minor bigint NOT NULL DEFAULT 0 CHECK (line_discount_total_minor >= 0),
    invoice_discount_minor bigint NOT NULL DEFAULT 0 CHECK (invoice_discount_minor >= 0),
    rounding_minor bigint NOT NULL DEFAULT 0 CHECK (rounding_minor BETWEEN -1 AND 1),
    total_minor bigint NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
    paid_total_minor bigint NOT NULL DEFAULT 0 CHECK (paid_total_minor >= 0),
    credit_total_minor bigint NOT NULL DEFAULT 0 CHECK (credit_total_minor >= 0),
    known_cost_total_minor bigint NOT NULL DEFAULT 0 CHECK (known_cost_total_minor >= 0),
    pending_cost_line_count integer NOT NULL DEFAULT 0 CHECK (pending_cost_line_count >= 0),
    unknown_cost_line_count integer NOT NULL DEFAULT 0 CHECK (unknown_cost_line_count >= 0),
    payment_status text NOT NULL DEFAULT 'paid'
        CHECK (payment_status IN ('paid', 'partial', 'credit')),
    status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'posted', 'cancelled', 'corrected')),
    notes text,
    correction_of_id uuid,
    reversed_by_id uuid,
    cancelled_at timestamptz,
    device_id uuid,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (
        total_minor =
        items_subtotal_minor
        - line_discount_total_minor
        - invoice_discount_minor
        + rounding_minor
    ),
    CHECK (paid_total_minor + credit_total_minor = total_minor),
    CHECK (credit_total_minor = 0 OR customer_id IS NOT NULL),
    CHECK ((status = 'cancelled' AND cancelled_at IS NOT NULL) OR status <> 'cancelled'),
    UNIQUE (store_id, id),
    UNIQUE (store_id, display_number),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id) REFERENCES ledger.stores(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, customer_id)
        REFERENCES ledger.customers(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES ledger.accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, correction_of_id)
        REFERENCES ledger.sales(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, reversed_by_id)
        REFERENCES ledger.sales(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.sale_items (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    sale_id uuid NOT NULL,
    product_id uuid,
    product_unit_id uuid,
    is_manual_line boolean NOT NULL DEFAULT false ,
    product_name_snapshot text NOT NULL CHECK (length(trim(product_name_snapshot)) > 0),
    unit_name_snapshot text,
    quantity_milli bigint NOT NULL CHECK (quantity_milli > 0),
    conversion_factor_num integer NOT NULL CHECK (conversion_factor_num > 0),
    conversion_factor_den integer NOT NULL CHECK (conversion_factor_den > 0),
    base_quantity_milli bigint,
    unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
    line_gross_minor bigint NOT NULL CHECK (line_gross_minor >= 0),
    line_discount_minor bigint NOT NULL DEFAULT 0 CHECK (line_discount_minor >= 0),
    rounding_minor bigint NOT NULL DEFAULT 0 CHECK (rounding_minor BETWEEN -1 AND 1),
    line_total_minor bigint NOT NULL CHECK (line_total_minor >= 0),
    cost_status text NOT NULL DEFAULT 'known'
        CHECK (cost_status IN ('known', 'estimated', 'pending', 'unknown')),
    unit_cost_minor bigint CHECK (unit_cost_minor IS NULL OR unit_cost_minor >= 0),
    line_cost_minor bigint CHECK (line_cost_minor IS NULL OR line_cost_minor >= 0),
    inventory_movement_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (line_total_minor = line_gross_minor - line_discount_minor + rounding_minor),
    CHECK (line_discount_minor <= line_gross_minor + rounding_minor),
    CHECK (
        (is_manual_line = true
         AND product_id IS NULL
         AND product_unit_id IS NULL
         AND base_quantity_milli IS NULL
         AND cost_status = 'unknown'
         AND unit_cost_minor IS NULL
         AND line_cost_minor IS NULL)
        OR
        (is_manual_line = false
         AND product_id IS NOT NULL
         AND product_unit_id IS NOT NULL
         AND base_quantity_milli IS NOT NULL
         AND base_quantity_milli > 0
         AND base_quantity_milli * conversion_factor_den =
             quantity_milli * conversion_factor_num)
    ),
    CHECK (
        (cost_status = 'unknown' AND unit_cost_minor IS NULL AND line_cost_minor IS NULL)
        OR
        (cost_status <> 'unknown' AND line_cost_minor IS NOT NULL)
    ),
    UNIQUE (store_id, id),
    UNIQUE (store_id, inventory_movement_id),
    FOREIGN KEY (store_id, sale_id)
        REFERENCES ledger.sales(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, product_id)
        REFERENCES ledger.products(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, product_id, product_unit_id)
        REFERENCES ledger.product_units(store_id, product_id, id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, inventory_movement_id)
        REFERENCES ledger.inventory_movements(store_id, id)
        ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.sale_payments (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    sale_id uuid NOT NULL,
    money_account_id uuid NOT NULL,
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    payment_at timestamptz NOT NULL,
    sender_account_name text,
    external_reference text,
    money_movement_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (store_id, id),
    UNIQUE (store_id, money_movement_id),
    FOREIGN KEY (store_id, sale_id)
        REFERENCES ledger.sales(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, money_account_id)
        REFERENCES ledger.money_accounts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, money_movement_id)
        REFERENCES ledger.money_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.purchase_invoices (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    invoice_number text,
    display_number text NOT NULL CHECK (length(trim(display_number)) > 0),
    invoice_date_at timestamptz NOT NULL,
    due_at timestamptz,
    items_subtotal_minor bigint NOT NULL DEFAULT 0 CHECK (items_subtotal_minor >= 0),
    line_discount_total_minor bigint NOT NULL DEFAULT 0 CHECK (line_discount_total_minor >= 0),
    invoice_discount_minor bigint NOT NULL DEFAULT 0 CHECK (invoice_discount_minor >= 0),
    rounding_minor bigint NOT NULL DEFAULT 0 CHECK (rounding_minor BETWEEN -1 AND 1),
    total_minor bigint NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
    status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'open', 'closed', 'cancelled')),
    notes text,
    correction_of_id uuid,
    cancelled_at timestamptz,
    device_id uuid,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (
        total_minor =
        items_subtotal_minor
        - line_discount_total_minor
        - invoice_discount_minor
        + rounding_minor
    ),
    CHECK ((status = 'cancelled' AND cancelled_at IS NOT NULL) OR status <> 'cancelled'),
    UNIQUE (store_id, id),
    UNIQUE (store_id, display_number),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, supplier_id)
        REFERENCES ledger.suppliers(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, correction_of_id)
        REFERENCES ledger.purchase_invoices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.purchase_items (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    purchase_invoice_id uuid NOT NULL,
    product_id uuid NOT NULL,
    product_unit_id uuid NOT NULL,
    product_name_snapshot text NOT NULL,
    unit_name_snapshot text NOT NULL,
    quantity_milli bigint NOT NULL CHECK (quantity_milli > 0),
    conversion_factor_num integer NOT NULL CHECK (conversion_factor_num > 0),
    conversion_factor_den integer NOT NULL CHECK (conversion_factor_den > 0),
    base_quantity_milli bigint NOT NULL CHECK (base_quantity_milli > 0),
    unit_cost_minor bigint NOT NULL CHECK (unit_cost_minor >= 0),
    line_gross_minor bigint NOT NULL CHECK (line_gross_minor >= 0),
    line_discount_minor bigint NOT NULL DEFAULT 0 CHECK (line_discount_minor >= 0),
    rounding_minor bigint NOT NULL DEFAULT 0 CHECK (rounding_minor BETWEEN -1 AND 1),
    line_total_minor bigint NOT NULL CHECK (line_total_minor >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (
        base_quantity_milli * conversion_factor_den =
        quantity_milli * conversion_factor_num
    ),
    CHECK (line_total_minor = line_gross_minor - line_discount_minor + rounding_minor),
    CHECK (line_discount_minor <= line_gross_minor + rounding_minor),
    UNIQUE (store_id, id),
    FOREIGN KEY (store_id, purchase_invoice_id)
        REFERENCES ledger.purchase_invoices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, product_id)
        REFERENCES ledger.products(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, product_id, product_unit_id)
        REFERENCES ledger.product_units(store_id, product_id, id)
        ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.goods_receipts (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    purchase_invoice_id uuid,
    accounting_period_id uuid,
    display_number text NOT NULL CHECK (length(trim(display_number)) > 0),
    received_at timestamptz NOT NULL,
    total_cost_minor bigint NOT NULL DEFAULT 0 CHECK (total_cost_minor >= 0),
    status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'posted', 'cancelled')),
    notes text,
    reversal_of_id uuid,
    reversed_by_id uuid,
    cancelled_at timestamptz,
    device_id uuid,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK ((status = 'cancelled' AND cancelled_at IS NOT NULL) OR status <> 'cancelled'),
    UNIQUE (store_id, id),
    UNIQUE (store_id, display_number),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, supplier_id)
        REFERENCES ledger.suppliers(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, purchase_invoice_id)
        REFERENCES ledger.purchase_invoices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES ledger.accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, reversal_of_id)
        REFERENCES ledger.goods_receipts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, reversed_by_id)
        REFERENCES ledger.goods_receipts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.goods_receipt_items (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    goods_receipt_id uuid NOT NULL,
    purchase_item_id uuid,
    product_id uuid NOT NULL,
    product_unit_id uuid NOT NULL,
    product_name_snapshot text NOT NULL,
    unit_name_snapshot text NOT NULL,
    quantity_milli bigint NOT NULL CHECK (quantity_milli > 0),
    conversion_factor_num integer NOT NULL CHECK (conversion_factor_num > 0),
    conversion_factor_den integer NOT NULL CHECK (conversion_factor_den > 0),
    base_quantity_milli bigint NOT NULL CHECK (base_quantity_milli > 0),
    unit_cost_minor bigint NOT NULL CHECK (unit_cost_minor >= 0),
    line_total_minor bigint NOT NULL CHECK (line_total_minor >= 0),
    inventory_movement_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (
        base_quantity_milli * conversion_factor_den =
        quantity_milli * conversion_factor_num
    ),
    UNIQUE (store_id, id),
    UNIQUE (store_id, inventory_movement_id),
    FOREIGN KEY (store_id, goods_receipt_id)
        REFERENCES ledger.goods_receipts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, purchase_item_id)
        REFERENCES ledger.purchase_items(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, product_id)
        REFERENCES ledger.products(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, product_id, product_unit_id)
        REFERENCES ledger.product_units(store_id, product_id, id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, inventory_movement_id)
        REFERENCES ledger.inventory_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.customer_payments (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    accounting_period_id uuid,
    money_account_id uuid NOT NULL,
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    allocated_total_minor bigint NOT NULL DEFAULT 0 CHECK (allocated_total_minor >= 0),
    credit_created_minor bigint NOT NULL DEFAULT 0 CHECK (credit_created_minor >= 0),
    payment_at timestamptz NOT NULL,
    sender_account_name text,
    external_reference text,
    notes text,
    status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'posted', 'cancelled')),
    money_movement_id uuid,
    cancelled_at timestamptz,
    device_id uuid,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (
        status <> 'posted'
        OR allocated_total_minor + credit_created_minor = amount_minor
    ),
    CHECK ((status = 'cancelled' AND cancelled_at IS NOT NULL) OR status <> 'cancelled'),
    UNIQUE (store_id, id),
    UNIQUE (store_id, money_movement_id),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, customer_id)
        REFERENCES ledger.customers(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES ledger.accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, money_account_id)
        REFERENCES ledger.money_accounts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, money_movement_id)
        REFERENCES ledger.money_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.supplier_payments (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    accounting_period_id uuid,
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    allocated_total_minor bigint NOT NULL DEFAULT 0 CHECK (allocated_total_minor >= 0),
    credit_created_minor bigint NOT NULL DEFAULT 0 CHECK (credit_created_minor >= 0),
    payment_source text NOT NULL CHECK (payment_source IN ('money_account', 'owner_pocket')),
    money_account_id uuid,
    money_movement_id uuid,
    owner_ledger_entry_id uuid,
    payment_at timestamptz NOT NULL,
    external_reference text,
    notes text,
    status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'posted', 'cancelled')),
    cancelled_at timestamptz,
    device_id uuid,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (
        status <> 'posted'
        OR allocated_total_minor + credit_created_minor = amount_minor
    ),
    CHECK (
        status <> 'posted'
        OR
        (payment_source = 'money_account'
         AND money_account_id IS NOT NULL
         AND money_movement_id IS NOT NULL
         AND owner_ledger_entry_id IS NULL)
        OR
        (payment_source = 'owner_pocket'
         AND money_account_id IS NULL
         AND money_movement_id IS NULL
         AND owner_ledger_entry_id IS NOT NULL)
    ),
    CHECK ((status = 'cancelled' AND cancelled_at IS NOT NULL) OR status <> 'cancelled'),
    UNIQUE (store_id, id),
    UNIQUE (store_id, money_movement_id),
    UNIQUE (store_id, owner_ledger_entry_id),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, supplier_id)
        REFERENCES ledger.suppliers(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES ledger.accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, money_account_id)
        REFERENCES ledger.money_accounts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, money_movement_id)
        REFERENCES ledger.money_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, owner_ledger_entry_id)
        REFERENCES ledger.owner_ledger_entries(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.expenses (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    category_id uuid,
    accounting_period_id uuid,
    description text NOT NULL CHECK (length(trim(description)) > 0),
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    paid_total_minor bigint NOT NULL DEFAULT 0 CHECK (paid_total_minor >= 0),
    expense_at timestamptz NOT NULL,
    due_at timestamptz,
    payment_timing text NOT NULL CHECK (payment_timing IN ('paid_now', 'due_later')),
    status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'posted', 'cancelled')),
    notes text,
    cancelled_at timestamptz,
    device_id uuid,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (paid_total_minor <= amount_minor),
    CHECK (
        status <> 'posted'
        OR (payment_timing = 'paid_now' AND paid_total_minor = amount_minor)
        OR payment_timing = 'due_later'
    ),
    CHECK ((status = 'cancelled' AND cancelled_at IS NOT NULL) OR status <> 'cancelled'),
    UNIQUE (store_id, id),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, category_id)
        REFERENCES ledger.expense_categories(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES ledger.accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.expense_payments (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    expense_id uuid NOT NULL,
    accounting_period_id uuid,
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    payment_source text NOT NULL CHECK (payment_source IN ('money_account', 'owner_pocket')),
    money_account_id uuid,
    money_movement_id uuid,
    owner_ledger_entry_id uuid,
    payment_at timestamptz NOT NULL,
    notes text,
    status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'posted', 'cancelled')),
    cancelled_at timestamptz,
    device_id uuid,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (
        status <> 'posted'
        OR
        (payment_source = 'money_account'
         AND money_account_id IS NOT NULL
         AND money_movement_id IS NOT NULL
         AND owner_ledger_entry_id IS NULL)
        OR
        (payment_source = 'owner_pocket'
         AND money_account_id IS NULL
         AND money_movement_id IS NULL
         AND owner_ledger_entry_id IS NOT NULL)
    ),
    CHECK ((status = 'cancelled' AND cancelled_at IS NOT NULL) OR status <> 'cancelled'),
    UNIQUE (store_id, id),
    UNIQUE (store_id, money_movement_id),
    UNIQUE (store_id, owner_ledger_entry_id),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, expense_id)
        REFERENCES ledger.expenses(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES ledger.accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, money_account_id)
        REFERENCES ledger.money_accounts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, money_movement_id)
        REFERENCES ledger.money_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, owner_ledger_entry_id)
        REFERENCES ledger.owner_ledger_entries(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.money_transfers (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    accounting_period_id uuid,
    display_number text NOT NULL,
    source_account_id uuid NOT NULL,
    destination_account_id uuid NOT NULL,
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    transfer_at timestamptz NOT NULL,
    source_movement_id uuid,
    destination_movement_id uuid,
    status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'posted', 'cancelled')),
    notes text,
    cancelled_at timestamptz,
    device_id uuid,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (source_account_id <> destination_account_id),
    CHECK ((status = 'cancelled' AND cancelled_at IS NOT NULL) OR status <> 'cancelled'),
    UNIQUE (store_id, id),
    UNIQUE (store_id, display_number),
    UNIQUE (store_id, source_movement_id),
    UNIQUE (store_id, destination_movement_id),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES ledger.accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, source_account_id)
        REFERENCES ledger.money_accounts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, destination_account_id)
        REFERENCES ledger.money_accounts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, source_movement_id)
        REFERENCES ledger.money_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, destination_movement_id)
        REFERENCES ledger.money_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.sale_returns (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    sale_id uuid NOT NULL,
    customer_id uuid,
    accounting_period_id uuid,
    display_number text NOT NULL,
    return_at timestamptz NOT NULL,
    total_minor bigint NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
    status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'posted', 'cancelled')),
    notes text,
    cancelled_at timestamptz,
    device_id uuid,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK ((status = 'cancelled' AND cancelled_at IS NOT NULL) OR status <> 'cancelled'),
    UNIQUE (store_id, id),
    UNIQUE (store_id, display_number),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, sale_id)
        REFERENCES ledger.sales(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, customer_id)
        REFERENCES ledger.customers(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES ledger.accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.sale_return_items (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    sale_return_id uuid NOT NULL,
    sale_item_id uuid NOT NULL,
    quantity_milli bigint NOT NULL CHECK (quantity_milli > 0),
    base_quantity_milli bigint,
    line_refund_minor bigint NOT NULL CHECK (line_refund_minor >= 0),
    item_condition text NOT NULL CHECK (item_condition IN ('saleable', 'damaged')),
    inventory_movement_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (store_id, id),
    UNIQUE (store_id, inventory_movement_id),
    FOREIGN KEY (store_id, sale_return_id)
        REFERENCES ledger.sale_returns(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, sale_item_id)
        REFERENCES ledger.sale_items(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, inventory_movement_id)
        REFERENCES ledger.inventory_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.supplier_returns (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    purchase_invoice_id uuid,
    accounting_period_id uuid,
    display_number text NOT NULL,
    return_at timestamptz NOT NULL,
    total_minor bigint NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
    status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'posted', 'cancelled')),
    notes text,
    cancelled_at timestamptz,
    device_id uuid,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK ((status = 'cancelled' AND cancelled_at IS NOT NULL) OR status <> 'cancelled'),
    UNIQUE (store_id, id),
    UNIQUE (store_id, display_number),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, supplier_id)
        REFERENCES ledger.suppliers(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, purchase_invoice_id)
        REFERENCES ledger.purchase_invoices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES ledger.accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.supplier_return_items (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    supplier_return_id uuid NOT NULL,
    product_id uuid NOT NULL,
    product_unit_id uuid NOT NULL,
    quantity_milli bigint NOT NULL CHECK (quantity_milli > 0),
    conversion_factor_num integer NOT NULL CHECK (conversion_factor_num > 0),
    conversion_factor_den integer NOT NULL CHECK (conversion_factor_den > 0),
    base_quantity_milli bigint NOT NULL CHECK (base_quantity_milli > 0),
    unit_cost_minor bigint NOT NULL CHECK (unit_cost_minor >= 0),
    line_total_minor bigint NOT NULL CHECK (line_total_minor >= 0),
    inventory_movement_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (
        base_quantity_milli * conversion_factor_den =
        quantity_milli * conversion_factor_num
    ),
    UNIQUE (store_id, id),
    UNIQUE (store_id, inventory_movement_id),
    FOREIGN KEY (store_id, supplier_return_id)
        REFERENCES ledger.supplier_returns(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, product_id)
        REFERENCES ledger.products(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, product_id, product_unit_id)
        REFERENCES ledger.product_units(store_id, product_id, id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, inventory_movement_id)
        REFERENCES ledger.inventory_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.stock_counts (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    accounting_period_id uuid,
    display_number text NOT NULL,
    count_type text NOT NULL CHECK (count_type IN ('full', 'partial')),
    started_at timestamptz NOT NULL,
    completed_at timestamptz,
    status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'counting', 'posted', 'cancelled')),
    notes text,
    cancelled_at timestamptz,
    device_id uuid,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK ((status = 'posted' AND completed_at IS NOT NULL) OR status <> 'posted'),
    CHECK ((status = 'cancelled' AND cancelled_at IS NOT NULL) OR status <> 'cancelled'),
    UNIQUE (store_id, id),
    UNIQUE (store_id, display_number),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES ledger.accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.stock_count_items (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    stock_count_id uuid NOT NULL,
    product_id uuid NOT NULL,
    system_quantity_milli bigint NOT NULL,
    actual_quantity_milli bigint NOT NULL,
    difference_milli bigint NOT NULL,
    adjustment_movement_id uuid,
    reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (difference_milli = actual_quantity_milli - system_quantity_milli),
    UNIQUE (store_id, id),
    UNIQUE (stock_count_id, product_id),
    UNIQUE (store_id, adjustment_movement_id),
    FOREIGN KEY (store_id, stock_count_id)
        REFERENCES ledger.stock_counts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, product_id)
        REFERENCES ledger.products(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, adjustment_movement_id)
        REFERENCES ledger.inventory_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.notifications (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    notification_key text NOT NULL,
    notification_type text NOT NULL CHECK (notification_type IN (
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
        'review_required'
    )),
    severity text NOT NULL DEFAULT 'info'
        CHECK (severity IN ('info', 'warning', 'critical')),
    title text NOT NULL,
    body text NOT NULL,
    entity_type text,
    entity_id uuid,
    status text NOT NULL DEFAULT 'unread'
        CHECK (status IN ('unread', 'read', 'resolved', 'dismissed', 'snoozed')),
    snoozed_until timestamptz,
    resolved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (store_id, id),
    UNIQUE (store_id, notification_key),
    FOREIGN KEY (store_id) REFERENCES ledger.stores(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE ledger.audit_logs (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    device_id uuid,
    actor_type text NOT NULL CHECK (actor_type IN ('owner', 'system', 'admin', 'sync')),
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    old_values_json jsonb ,
    new_values_json jsonb ,
    reason text,
    operation_id uuid,
    occurred_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (store_id, id),
    FOREIGN KEY (store_id) REFERENCES ledger.stores(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.backup_metadata (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    device_id uuid,
    backup_type text NOT NULL CHECK (backup_type IN ('local_file', 'cloud_file', 'server_snapshot')),
    local_uri text,
    remote_key text,
    schema_version integer NOT NULL CHECK (schema_version >= 1),
    file_size_bytes bigint CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
    checksum_sha256 text NOT NULL,
    encryption_version text,
    status text NOT NULL CHECK (status IN ('creating', 'ready', 'uploaded', 'failed', 'deleted')),
    created_at timestamptz NOT NULL DEFAULT now(),
    uploaded_at timestamptz,
    last_verified_at timestamptz,
    error_message text,
    UNIQUE (store_id, id),
    FOREIGN KEY (store_id) REFERENCES ledger.stores(id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.customer_ledger_entries (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    accounting_period_id uuid NOT NULL,
    entry_type text NOT NULL CHECK (entry_type IN (
        'sale_credit',
        'payment',
        'return',
        'settlement',
        'opening_balance',
        'credit_created',
        'credit_used',
        'refund',
        'correction'
    )),
    receivable_delta_minor bigint NOT NULL DEFAULT 0,
    credit_delta_minor bigint NOT NULL DEFAULT 0,
    source_sale_id uuid,
    reference_type text NOT NULL,
    reference_id uuid NOT NULL,
    transaction_group_id uuid NOT NULL,
    occurred_at timestamptz NOT NULL,
    reversal_of_id uuid,
    reason text,
    device_id uuid,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (receivable_delta_minor <> 0 OR credit_delta_minor <> 0),
    UNIQUE (store_id, id),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, customer_id)
        REFERENCES ledger.customers(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES ledger.accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, source_sale_id)
        REFERENCES ledger.sales(store_id, id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (store_id, reversal_of_id)
        REFERENCES ledger.customer_ledger_entries(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.supplier_ledger_entries (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    accounting_period_id uuid NOT NULL,
    entry_type text NOT NULL CHECK (entry_type IN (
        'goods_receipt',
        'payment',
        'return',
        'opening_balance',
        'credit_created',
        'credit_used',
        'refund',
        'correction'
    )),
    payable_delta_minor bigint NOT NULL DEFAULT 0,
    credit_delta_minor bigint NOT NULL DEFAULT 0,
    source_purchase_invoice_id uuid,
    reference_type text NOT NULL,
    reference_id uuid NOT NULL,
    transaction_group_id uuid NOT NULL,
    occurred_at timestamptz NOT NULL,
    reversal_of_id uuid,
    reason text,
    device_id uuid,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (payable_delta_minor <> 0 OR credit_delta_minor <> 0),
    UNIQUE (store_id, id),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, supplier_id)
        REFERENCES ledger.suppliers(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES ledger.accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, source_purchase_invoice_id)
        REFERENCES ledger.purchase_invoices(store_id, id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (store_id, reversal_of_id)
        REFERENCES ledger.supplier_ledger_entries(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.customer_payment_allocations (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    customer_payment_id uuid NOT NULL,
    sale_id uuid NOT NULL,
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    customer_ledger_entry_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (store_id, id),
    UNIQUE (store_id, customer_ledger_entry_id),
    UNIQUE (customer_payment_id, sale_id),
    FOREIGN KEY (store_id, customer_payment_id)
        REFERENCES ledger.customer_payments(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, sale_id)
        REFERENCES ledger.sales(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, customer_ledger_entry_id)
        REFERENCES ledger.customer_ledger_entries(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.supplier_payment_allocations (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    supplier_payment_id uuid NOT NULL,
    purchase_invoice_id uuid NOT NULL,
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    supplier_ledger_entry_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (store_id, id),
    UNIQUE (store_id, supplier_ledger_entry_id),
    UNIQUE (supplier_payment_id, purchase_invoice_id),
    FOREIGN KEY (store_id, supplier_payment_id)
        REFERENCES ledger.supplier_payments(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, purchase_invoice_id)
        REFERENCES ledger.purchase_invoices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, supplier_ledger_entry_id)
        REFERENCES ledger.supplier_ledger_entries(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.sale_return_settlements (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    sale_return_id uuid NOT NULL,
    settlement_type text NOT NULL
        CHECK (settlement_type IN ('reduce_receivable', 'customer_credit', 'money_refund')),
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    money_account_id uuid,
    money_movement_id uuid,
    customer_ledger_entry_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (settlement_type = 'money_refund'
         AND money_account_id IS NOT NULL
         AND money_movement_id IS NOT NULL
         AND customer_ledger_entry_id IS NULL)
        OR
        (settlement_type IN ('reduce_receivable', 'customer_credit')
         AND money_account_id IS NULL
         AND money_movement_id IS NULL
         AND customer_ledger_entry_id IS NOT NULL)
    ),
    UNIQUE (store_id, id),
    UNIQUE (store_id, money_movement_id),
    UNIQUE (store_id, customer_ledger_entry_id),
    FOREIGN KEY (store_id, sale_return_id)
        REFERENCES ledger.sale_returns(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, money_account_id)
        REFERENCES ledger.money_accounts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, money_movement_id)
        REFERENCES ledger.money_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, customer_ledger_entry_id)
        REFERENCES ledger.customer_ledger_entries(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE ledger.supplier_return_settlements (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    supplier_return_id uuid NOT NULL,
    settlement_type text NOT NULL
        CHECK (settlement_type IN ('reduce_payable', 'supplier_credit', 'money_refund_received')),
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    money_account_id uuid,
    money_movement_id uuid,
    supplier_ledger_entry_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (settlement_type = 'money_refund_received'
         AND money_account_id IS NOT NULL
         AND money_movement_id IS NOT NULL
         AND supplier_ledger_entry_id IS NULL)
        OR
        (settlement_type IN ('reduce_payable', 'supplier_credit')
         AND money_account_id IS NULL
         AND money_movement_id IS NULL
         AND supplier_ledger_entry_id IS NOT NULL)
    ),
    UNIQUE (store_id, id),
    UNIQUE (store_id, money_movement_id),
    UNIQUE (store_id, supplier_ledger_entry_id),
    FOREIGN KEY (store_id, supplier_return_id)
        REFERENCES ledger.supplier_returns(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, money_account_id)
        REFERENCES ledger.money_accounts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, money_movement_id)
        REFERENCES ledger.money_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, supplier_ledger_entry_id)
        REFERENCES ledger.supplier_ledger_entries(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);


-- Settings required by the PRD for business-day boundaries and reports.
-- The companion SQLite migration adds the same columns locally.
ALTER TABLE ledger.app_settings
    ADD COLUMN timezone_name text NOT NULL DEFAULT 'Asia/Hebron',
    ADD COLUMN business_day_start_minutes integer NOT NULL DEFAULT 720
        CHECK (business_day_start_minutes BETWEEN 0 AND 1439),
    ADD COLUMN business_day_end_minutes integer NOT NULL DEFAULT 720
        CHECK (business_day_end_minutes BETWEEN 0 AND 1439),
    ADD COLUMN business_day_mode text NOT NULL DEFAULT 'fixed_24h'
        CHECK (business_day_mode IN ('fixed_24h','custom'));

-- =========================================================
-- Server-only identity, subscriptions and device security
-- =========================================================

CREATE TABLE platform.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL,
    normalized_email text NOT NULL,
    password_hash text NOT NULL,
    full_name text NOT NULL CHECK (length(trim(full_name)) > 0),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','locked','deleted')),
    email_verified_at timestamptz,
    last_login_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (normalized_email)
);

CREATE TABLE platform.store_memberships (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES platform.users(id) ON DELETE RESTRICT,
    role text NOT NULL CHECK (role IN ('owner','manager','viewer','support')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','disabled','removed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (store_id, user_id),
    FOREIGN KEY (store_id) REFERENCES ledger.stores(id) ON DELETE RESTRICT
);

CREATE TABLE platform.auth_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
    store_id uuid REFERENCES ledger.stores(id) ON DELETE CASCADE,
    device_id uuid,
    access_token_jti uuid NOT NULL,
    ip_hash text,
    user_agent_hash text,
    issued_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    revoke_reason text,
    CHECK (expires_at > issued_at),
    UNIQUE (access_token_jti),
    FOREIGN KEY (store_id, device_id) REFERENCES ledger.devices(store_id, id) ON DELETE CASCADE
);

CREATE TABLE platform.refresh_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL REFERENCES platform.auth_sessions(id) ON DELETE CASCADE,
    token_hash text NOT NULL,
    family_id uuid NOT NULL,
    parent_token_id uuid REFERENCES platform.refresh_tokens(id) ON DELETE SET NULL,
    issued_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    revoked_at timestamptz,
    replaced_by_id uuid REFERENCES platform.refresh_tokens(id) ON DELETE SET NULL,
    CHECK (expires_at > issued_at),
    UNIQUE (token_hash)
);

CREATE TABLE platform.password_reset_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
    token_hash text NOT NULL,
    issued_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    CHECK (expires_at > issued_at),
    UNIQUE (token_hash)
);

CREATE TABLE platform.subscription_plans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code text NOT NULL UNIQUE,
    name text NOT NULL,
    duration_days integer NOT NULL CHECK (duration_days > 0),
    price_minor bigint NOT NULL CHECK (price_minor >= 0),
    currency_code text NOT NULL DEFAULT 'ILS' CHECK (currency_code = 'ILS'),
    max_devices integer NOT NULL DEFAULT 1 CHECK (max_devices > 0),
    offline_grace_days integer NOT NULL DEFAULT 0 CHECK (offline_grace_days >= 0),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    features jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1)
);

CREATE TABLE platform.subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id uuid NOT NULL REFERENCES ledger.stores(id) ON DELETE RESTRICT,
    plan_id uuid NOT NULL REFERENCES platform.subscription_plans(id) ON DELETE RESTRICT,
    status text NOT NULL CHECK (status IN ('trial','active','past_due','expired','suspended','cancelled')),
    starts_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    suspended_at timestamptz,
    cancelled_at timestamptz,
    external_reference text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (expires_at > starts_at)
);

CREATE UNIQUE INDEX uq_platform_one_current_subscription
ON platform.subscriptions(store_id)
WHERE status IN ('trial','active','past_due','suspended');

CREATE TABLE platform.license_issuances (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id uuid NOT NULL,
    device_id uuid NOT NULL,
    subscription_id uuid NOT NULL REFERENCES platform.subscriptions(id) ON DELETE RESTRICT,
    license_serial bigint GENERATED ALWAYS AS IDENTITY,
    signed_payload jsonb NOT NULL,
    signature text NOT NULL,
    key_id text NOT NULL,
    issued_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    revoke_reason text,
    CHECK (expires_at > issued_at),
    UNIQUE (license_serial),
    FOREIGN KEY (store_id, device_id) REFERENCES ledger.devices(store_id, id) ON DELETE RESTRICT
);

CREATE TABLE platform.server_backups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id uuid NOT NULL REFERENCES ledger.stores(id) ON DELETE CASCADE,
    device_id uuid,
    backup_type text NOT NULL CHECK (backup_type IN ('database_snapshot','encrypted_sqlite','export_archive')),
    object_key text NOT NULL,
    checksum_sha256 text NOT NULL,
    encryption_key_id text,
    schema_version integer NOT NULL CHECK (schema_version >= 1),
    size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
    status text NOT NULL CHECK (status IN ('creating','ready','failed','deleted')),
    created_at timestamptz NOT NULL DEFAULT now(),
    verified_at timestamptz,
    error_message text,
    FOREIGN KEY (store_id, device_id) REFERENCES ledger.devices(store_id, id) ON DELETE RESTRICT
);

CREATE TABLE platform.admin_actions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id uuid NOT NULL REFERENCES platform.users(id) ON DELETE RESTRICT,
    store_id uuid REFERENCES ledger.stores(id) ON DELETE RESTRICT,
    action text NOT NULL,
    reason text NOT NULL,
    request_id uuid,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now()
);

-- =========================================================
-- Central synchronization tables
-- =========================================================

CREATE TABLE sync.processed_operations (
    store_id uuid NOT NULL REFERENCES ledger.stores(id) ON DELETE CASCADE,
    operation_id uuid NOT NULL,
    device_id uuid NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id uuid NOT NULL,
    action text NOT NULL,
    request_hash text NOT NULL,
    status text NOT NULL CHECK (status IN ('processing','applied','rejected')),
    response_code integer,
    response_body jsonb,
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    PRIMARY KEY (store_id, operation_id),
    FOREIGN KEY (store_id, device_id) REFERENCES ledger.devices(store_id, id) ON DELETE RESTRICT
);

CREATE TABLE sync.change_events (
    cursor bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    store_id uuid NOT NULL REFERENCES ledger.stores(id) ON DELETE CASCADE,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    action text NOT NULL CHECK (action IN ('create','update','archive','restore','post','cancel','reverse','delete')),
    entity_version bigint NOT NULL CHECK (entity_version >= 1),
    operation_id uuid,
    device_id uuid,
    payload jsonb NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (store_id, device_id) REFERENCES ledger.devices(store_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_sync_change_events_store_cursor ON sync.change_events(store_id, cursor);
CREATE INDEX idx_sync_change_events_entity ON sync.change_events(store_id, entity_type, entity_id, cursor DESC);

CREATE TABLE sync.device_cursors (
    store_id uuid NOT NULL,
    device_id uuid NOT NULL,
    last_pulled_cursor bigint NOT NULL DEFAULT 0 CHECK (last_pulled_cursor >= 0),
    last_pushed_at timestamptz,
    last_pulled_at timestamptz,
    last_success_at timestamptz,
    last_error text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (store_id, device_id),
    FOREIGN KEY (store_id, device_id) REFERENCES ledger.devices(store_id, id) ON DELETE CASCADE
);

CREATE TABLE sync.conflicts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id uuid NOT NULL REFERENCES ledger.stores(id) ON DELETE CASCADE,
    operation_id uuid,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    client_version bigint,
    server_version bigint,
    conflict_type text NOT NULL CHECK (conflict_type IN ('version_mismatch','deleted_entity','business_rule','duplicate_identity')),
    client_payload jsonb,
    server_payload jsonb,
    resolution text CHECK (resolution IS NULL OR resolution IN ('server_wins','client_wins','merged','manual')),
    resolved_by uuid REFERENCES platform.users(id) ON DELETE SET NULL,
    resolved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sync.dead_letters (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id uuid NOT NULL REFERENCES ledger.stores(id) ON DELETE CASCADE,
    device_id uuid,
    operation_id uuid,
    payload jsonb NOT NULL,
    error_code text NOT NULL,
    error_message text NOT NULL,
    retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    first_failed_at timestamptz NOT NULL DEFAULT now(),
    last_failed_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    FOREIGN KEY (store_id, device_id) REFERENCES ledger.devices(store_id, id) ON DELETE RESTRICT
);

CREATE TABLE sync.bootstrap_snapshots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id uuid NOT NULL REFERENCES ledger.stores(id) ON DELETE CASCADE,
    base_cursor bigint NOT NULL CHECK (base_cursor >= 0),
    object_key text NOT NULL,
    checksum_sha256 text NOT NULL,
    schema_version integer NOT NULL CHECK (schema_version >= 1),
    status text NOT NULL CHECK (status IN ('creating','ready','expired','failed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    UNIQUE (store_id, base_cursor)
);

-- Immutable centralized audit table. It intentionally differs from local audit_logs.
CREATE TABLE audit.central_audit_logs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    store_id uuid REFERENCES ledger.stores(id) ON DELETE RESTRICT,
    user_id uuid REFERENCES platform.users(id) ON DELETE SET NULL,
    device_id uuid,
    request_id uuid,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid,
    old_values jsonb,
    new_values jsonb,
    reason text,
    ip_hash text,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (store_id, device_id) REFERENCES ledger.devices(store_id, id) ON DELETE RESTRICT
);

COMMIT;



-- ==================== 03_logic.sql ====================

-- Shop Ledger PostgreSQL v1.0.0
-- Business invariants, concurrency protection and sync/audit hooks.

BEGIN;

-- =========================================================
-- Session context used by NestJS and RLS
-- =========================================================

CREATE OR REPLACE FUNCTION platform.setting_uuid(p_name text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v text;
BEGIN
    v := current_setting(p_name, true);
    IF v IS NULL OR v = '' THEN
        RETURN NULL;
    END IF;
    RETURN v::uuid;
EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Invalid UUID in setting %', p_name USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION platform.current_store_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT platform.setting_uuid('app.store_id') $$;

CREATE OR REPLACE FUNCTION platform.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT platform.setting_uuid('app.user_id') $$;

CREATE OR REPLACE FUNCTION platform.current_device_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT platform.setting_uuid('app.device_id') $$;

CREATE OR REPLACE FUNCTION platform.current_request_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT platform.setting_uuid('app.request_id') $$;

-- =========================================================
-- Generic row protection
-- =========================================================

CREATE OR REPLACE FUNCTION ledger.touch_mutable_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := clock_timestamp();
    NEW.version := OLD.version + 1;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION ledger.prevent_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'DELETE is not allowed on %.%. Use archive/cancel/reversal.', TG_TABLE_SCHEMA, TG_TABLE_NAME
        USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION ledger.prevent_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '%.% is append-only. Create a reversal entry instead.', TG_TABLE_SCHEMA, TG_TABLE_NAME
        USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION ledger.protect_finalized_header()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    old_status text := to_jsonb(OLD)->>'status';
    allowed text[] := ARRAY['status','cancelled_at','reversed_by_id','updated_at','version'];
BEGIN
    IF old_status IN ('posted','open','closed','completed')
       AND (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
        RAISE EXCEPTION 'Finalized %.% business fields are immutable', TG_TABLE_SCHEMA, TG_TABLE_NAME
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

-- =========================================================
-- Accounting periods
-- =========================================================

ALTER TABLE ledger.accounting_periods
    ADD CONSTRAINT accounting_periods_no_overlap
    EXCLUDE USING gist (
        store_id WITH =,
        tstzrange(starts_at, ends_at, '[)') WITH &&
    );

CREATE OR REPLACE FUNCTION ledger.guard_accounting_period()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.status = 'closed' AND NEW.status <> 'closed' THEN
            RAISE EXCEPTION 'Closed accounting periods cannot be reopened' USING ERRCODE = '55000';
        END IF;
        IF OLD.status = 'closed'
           AND (NEW.starts_at, NEW.ends_at, NEW.period_year, NEW.period_month)
               IS DISTINCT FROM
               (OLD.starts_at, OLD.ends_at, OLD.period_year, OLD.period_month) THEN
            RAISE EXCEPTION 'Closed accounting period boundaries are immutable' USING ERRCODE = '55000';
        END IF;
        IF NEW.status = 'closed' AND OLD.status <> 'closed' THEN
            IF EXISTS (
                SELECT 1 FROM ledger.sales
                WHERE store_id = NEW.store_id AND accounting_period_id = NEW.id AND status = 'draft'
                UNION ALL
                SELECT 1 FROM ledger.goods_receipts
                WHERE store_id = NEW.store_id AND accounting_period_id = NEW.id AND status = 'draft'
                UNION ALL
                SELECT 1 FROM ledger.customer_payments
                WHERE store_id = NEW.store_id AND accounting_period_id = NEW.id AND status = 'draft'
                UNION ALL
                SELECT 1 FROM ledger.supplier_payments
                WHERE store_id = NEW.store_id AND accounting_period_id = NEW.id AND status = 'draft'
                UNION ALL
                SELECT 1 FROM ledger.expenses
                WHERE store_id = NEW.store_id AND accounting_period_id = NEW.id AND status = 'draft'
                LIMIT 1
            ) THEN
                RAISE EXCEPTION 'Cannot close period while draft transactions exist' USING ERRCODE = '23514';
            END IF;
            NEW.closed_at := COALESCE(NEW.closed_at, clock_timestamp());
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_accounting_period_guard
BEFORE UPDATE ON ledger.accounting_periods
FOR EACH ROW EXECUTE FUNCTION ledger.guard_accounting_period();

CREATE OR REPLACE FUNCTION ledger.assert_period_open(
    p_store_id uuid,
    p_period_id uuid,
    p_occurred_at timestamptz
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    r ledger.accounting_periods%ROWTYPE;
BEGIN
    SELECT * INTO r
    FROM ledger.accounting_periods
    WHERE store_id = p_store_id AND id = p_period_id
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Accounting period does not exist' USING ERRCODE = '23503';
    END IF;
    IF r.status <> 'open' THEN
        RAISE EXCEPTION 'Accounting period is not open' USING ERRCODE = '55000';
    END IF;
    IF p_occurred_at < r.starts_at OR p_occurred_at >= r.ends_at THEN
        RAISE EXCEPTION 'Transaction timestamp is outside accounting period' USING ERRCODE = '23514';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION ledger.enforce_period_open()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    j jsonb := to_jsonb(NEW);
    p_period uuid;
    p_time timestamptz;
BEGIN
    p_period := NULLIF(j->>'accounting_period_id','')::uuid;
    IF p_period IS NULL THEN
        RETURN NEW;
    END IF;
    p_time := NULLIF(j->>TG_ARGV[0],'')::timestamptz;
    IF p_time IS NULL THEN
        p_time := clock_timestamp();
    END IF;
    PERFORM ledger.assert_period_open(NEW.store_id, p_period, p_time);
    RETURN NEW;
END;
$$;

-- =========================================================
-- Inventory concurrency and cache
-- =========================================================

CREATE OR REPLACE FUNCTION ledger.apply_inventory_movement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    b ledger.stock_balances%ROWTYPE;
    allow_negative boolean;
BEGIN
    PERFORM ledger.assert_period_open(NEW.store_id, NEW.accounting_period_id, NEW.occurred_at);

    SELECT * INTO b
    FROM ledger.stock_balances
    WHERE store_id = NEW.store_id AND product_id = NEW.product_id
    FOR UPDATE;

    IF NOT FOUND THEN
        IF NEW.quantity_before_milli <> 0 OR NEW.inventory_value_before_minor <> 0 THEN
            RAISE EXCEPTION 'First inventory movement must start from zero balance' USING ERRCODE = '40001';
        END IF;
        INSERT INTO ledger.stock_balances(
            store_id, product_id, quantity_milli, average_unit_cost_minor,
            inventory_value_minor, has_pending_cost, last_movement_id, updated_at, version
        ) VALUES (
            NEW.store_id, NEW.product_id, 0, 0, 0, false, NULL, clock_timestamp(), 1
        );
        SELECT * INTO b
        FROM ledger.stock_balances
        WHERE store_id = NEW.store_id AND product_id = NEW.product_id
        FOR UPDATE;
    END IF;

    IF NEW.quantity_before_milli <> b.quantity_milli
       OR NEW.inventory_value_before_minor <> b.inventory_value_minor THEN
        RAISE EXCEPTION 'Stale inventory snapshot for product %', NEW.product_id
            USING ERRCODE = '40001';
    END IF;

    IF NEW.quantity_after_milli <> NEW.quantity_before_milli + NEW.quantity_delta_milli
       OR NEW.inventory_value_after_minor <> NEW.inventory_value_before_minor + NEW.value_delta_minor THEN
        RAISE EXCEPTION 'Inventory movement arithmetic is inconsistent' USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(p.allow_negative_stock_override, s.allow_negative_stock)
    INTO allow_negative
    FROM ledger.products p
    JOIN ledger.app_settings s ON s.store_id = p.store_id
    WHERE p.store_id = NEW.store_id AND p.id = NEW.product_id;

    IF NEW.quantity_after_milli < 0 AND NOT COALESCE(allow_negative, false) THEN
        RAISE EXCEPTION 'Negative stock is disabled for product %', NEW.product_id
            USING ERRCODE = '23514';
    END IF;

    UPDATE ledger.stock_balances
    SET quantity_milli = NEW.quantity_after_milli,
        average_unit_cost_minor = NEW.average_unit_cost_after_minor,
        inventory_value_minor = NEW.inventory_value_after_minor,
        has_pending_cost = NEW.has_pending_cost_after,
        last_movement_id = NEW.id,
        updated_at = clock_timestamp(),
        version = version + 1
    WHERE store_id = NEW.store_id AND product_id = NEW.product_id;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_inventory_apply_balance
BEFORE INSERT ON ledger.inventory_movements
FOR EACH ROW EXECUTE FUNCTION ledger.apply_inventory_movement();

-- =========================================================
-- Draft-child protection and line arithmetic
-- =========================================================

CREATE OR REPLACE FUNCTION ledger.ensure_parent_draft()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    j jsonb := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
    p_store uuid := (j->>'store_id')::uuid;
    p_id uuid := (j->>TG_ARGV[1])::uuid;
    p_status text;
BEGIN
    EXECUTE format('SELECT status FROM ledger.%I WHERE store_id = $1 AND id = $2 FOR SHARE', TG_ARGV[0])
    INTO p_status USING p_store, p_id;

    IF p_status IS NULL THEN
        RAISE EXCEPTION 'Parent %.% does not exist', TG_ARGV[0], p_id USING ERRCODE = '23503';
    END IF;
    IF p_status <> 'draft' THEN
        RAISE EXCEPTION 'Child rows of finalized % cannot be changed', TG_ARGV[0] USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION ledger.validate_scaled_line_amount()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    j jsonb := to_jsonb(NEW);
    quantity bigint := (j->>'quantity_milli')::bigint;
    unit_amount bigint := (j->>TG_ARGV[0])::bigint;
    line_amount bigint := (j->>TG_ARGV[1])::bigint;
BEGIN
    IF abs(line_amount * 1000 - quantity * unit_amount) > 500 THEN
        RAISE EXCEPTION 'Scaled line amount is inconsistent on %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION ledger.validate_goods_receipt_item_details()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.purchase_item_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM ledger.purchase_items pi
        WHERE pi.store_id = NEW.store_id
          AND pi.id = NEW.purchase_item_id
          AND pi.product_id = NEW.product_id
          AND pi.product_unit_id = NEW.product_unit_id
          AND pi.conversion_factor_num = NEW.conversion_factor_num
          AND pi.conversion_factor_den = NEW.conversion_factor_den
          AND pi.unit_cost_minor = NEW.unit_cost_minor
    ) THEN
        RAISE EXCEPTION 'Goods receipt item does not match purchase item' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

-- =========================================================
-- Sales, purchases and payment validation
-- =========================================================

CREATE OR REPLACE FUNCTION ledger.validate_sale_post()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    item_count bigint;
    subtotal bigint;
    discounts bigint;
    total bigint;
    payments bigint;
    tracked_without_movement bigint;
    current_due bigint;
    existing_sale_receivable bigint;
    sale_receivable bigint;
    invalid_payment_links bigint;
    limit_minor bigint;
    policy text;
BEGIN
    IF NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted' THEN
        PERFORM ledger.assert_period_open(NEW.store_id, NEW.accounting_period_id, NEW.sale_at);

        SELECT count(*), COALESCE(sum(line_gross_minor),0),
               COALESCE(sum(line_discount_minor),0), COALESCE(sum(line_total_minor),0),
               count(*) FILTER (WHERE is_manual_line = false AND inventory_movement_id IS NULL)
        INTO item_count, subtotal, discounts, total, tracked_without_movement
        FROM ledger.sale_items
        WHERE store_id = NEW.store_id AND sale_id = NEW.id;

        IF item_count = 0 THEN
            RAISE EXCEPTION 'Posted sale must have at least one item' USING ERRCODE = '23514';
        END IF;
        IF subtotal <> NEW.items_subtotal_minor OR discounts <> NEW.line_discount_total_minor
           OR total - NEW.invoice_discount_minor <> NEW.total_minor - NEW.rounding_minor THEN
            RAISE EXCEPTION 'Sale header totals do not match sale items' USING ERRCODE = '23514';
        END IF;
        IF tracked_without_movement > 0 THEN
            RAISE EXCEPTION 'Tracked sale items require inventory movements' USING ERRCODE = '23514';
        END IF;

        SELECT COALESCE(sum(sp.amount_minor),0),
               count(*) FILTER (WHERE mm.id IS NULL OR mm.account_id <> sp.money_account_id OR mm.amount_delta_minor <> sp.amount_minor)
        INTO payments, invalid_payment_links
        FROM ledger.sale_payments sp
        LEFT JOIN ledger.money_movements mm
          ON mm.store_id = sp.store_id AND mm.id = sp.money_movement_id
        WHERE sp.store_id = NEW.store_id AND sp.sale_id = NEW.id;
        IF payments <> NEW.paid_total_minor OR invalid_payment_links > 0 THEN
            RAISE EXCEPTION 'Sale payments or money movements do not match header' USING ERRCODE = '23514';
        END IF;

        SELECT COALESCE(sum(receivable_delta_minor),0) INTO sale_receivable
        FROM ledger.customer_ledger_entries
        WHERE store_id = NEW.store_id AND source_sale_id = NEW.id AND entry_type = 'sale_credit';
        IF sale_receivable <> NEW.credit_total_minor THEN
            RAISE EXCEPTION 'Sale customer receivable does not match credit total' USING ERRCODE = '23514';
        END IF;

        IF NEW.credit_total_minor > 0 THEN
            SELECT COALESCE(c.credit_policy, s.default_credit_policy),
                   COALESCE(c.credit_limit_minor, s.default_credit_limit_minor)
            INTO policy, limit_minor
            FROM ledger.customers c
            JOIN ledger.app_settings s ON s.store_id = c.store_id
            WHERE c.store_id = NEW.store_id AND c.id = NEW.customer_id;

            IF policy = 'block' AND limit_minor IS NOT NULL THEN
                SELECT COALESCE(sum(receivable_delta_minor - credit_delta_minor),0),
                       COALESCE(sum(receivable_delta_minor) FILTER (WHERE source_sale_id = NEW.id),0)
                INTO current_due, existing_sale_receivable
                FROM ledger.customer_ledger_entries
                WHERE store_id = NEW.store_id AND customer_id = NEW.customer_id;

                IF current_due + GREATEST(NEW.credit_total_minor - existing_sale_receivable, 0) > limit_minor THEN
                    RAISE EXCEPTION 'Customer credit limit would be exceeded' USING ERRCODE = '23514';
                END IF;
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sales_post_validate
BEFORE UPDATE OF status ON ledger.sales
FOR EACH ROW EXECUTE FUNCTION ledger.validate_sale_post();

CREATE OR REPLACE FUNCTION ledger.validate_purchase_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    item_count bigint;
    subtotal bigint;
    discounts bigint;
    total bigint;
    incomplete bigint;
BEGIN
    IF NEW.status IN ('open','closed') AND OLD.status IS DISTINCT FROM NEW.status THEN
        SELECT count(*), COALESCE(sum(line_gross_minor),0),
               COALESCE(sum(line_discount_minor),0), COALESCE(sum(line_total_minor),0)
        INTO item_count, subtotal, discounts, total
        FROM ledger.purchase_items
        WHERE store_id = NEW.store_id AND purchase_invoice_id = NEW.id;

        IF item_count = 0 THEN
            RAISE EXCEPTION 'Purchase invoice must have at least one item' USING ERRCODE = '23514';
        END IF;
        IF subtotal <> NEW.items_subtotal_minor OR discounts <> NEW.line_discount_total_minor
           OR total - NEW.invoice_discount_minor <> NEW.total_minor - NEW.rounding_minor THEN
            RAISE EXCEPTION 'Purchase header totals do not match items' USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
        SELECT count(*) INTO incomplete
        FROM ledger.purchase_items pi
        WHERE pi.store_id = NEW.store_id AND pi.purchase_invoice_id = NEW.id
          AND COALESCE((
              SELECT sum(gri.base_quantity_milli)
              FROM ledger.goods_receipt_items gri
              JOIN ledger.goods_receipts gr
                ON gr.store_id = gri.store_id AND gr.id = gri.goods_receipt_id
              WHERE gri.store_id = pi.store_id
                AND gri.purchase_item_id = pi.id
                AND gr.status = 'posted'
          ),0) < pi.base_quantity_milli;
        IF incomplete > 0 THEN
            RAISE EXCEPTION 'Purchase invoice cannot close before full receipt' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_purchase_status_validate
BEFORE UPDATE OF status ON ledger.purchase_invoices
FOR EACH ROW EXECUTE FUNCTION ledger.validate_purchase_status();

CREATE OR REPLACE FUNCTION ledger.validate_goods_receipt_post()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    item_count bigint;
    calc_total bigint;
    r record;
    already_received bigint;
    supplier_payable bigint;
BEGIN
    IF NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted' THEN
        PERFORM ledger.assert_period_open(NEW.store_id, NEW.accounting_period_id, NEW.received_at);
        SELECT count(*), COALESCE(sum(line_total_minor),0)
        INTO item_count, calc_total
        FROM ledger.goods_receipt_items
        WHERE store_id = NEW.store_id AND goods_receipt_id = NEW.id;

        IF item_count = 0 OR calc_total <> NEW.total_cost_minor THEN
            RAISE EXCEPTION 'Goods receipt items/total are invalid' USING ERRCODE = '23514';
        END IF;

        SELECT COALESCE(sum(payable_delta_minor),0) INTO supplier_payable
        FROM ledger.supplier_ledger_entries
        WHERE store_id = NEW.store_id
          AND reference_type = 'goods_receipt'
          AND reference_id = NEW.id
          AND entry_type = 'goods_receipt';
        IF supplier_payable <> NEW.total_cost_minor THEN
            RAISE EXCEPTION 'Supplier payable entry does not match receipt total' USING ERRCODE = '23514';
        END IF;

        FOR r IN
            SELECT gri.purchase_item_id, sum(gri.base_quantity_milli) current_qty
            FROM ledger.goods_receipt_items gri
            WHERE gri.store_id = NEW.store_id AND gri.goods_receipt_id = NEW.id
            GROUP BY gri.purchase_item_id
        LOOP
            IF r.purchase_item_id IS NOT NULL THEN
                SELECT COALESCE(sum(other_i.base_quantity_milli),0)
                INTO already_received
                FROM ledger.goods_receipt_items other_i
                JOIN ledger.goods_receipts other_r
                  ON other_r.store_id = other_i.store_id AND other_r.id = other_i.goods_receipt_id
                WHERE other_i.store_id = NEW.store_id
                  AND other_i.purchase_item_id = r.purchase_item_id
                  AND other_r.status = 'posted'
                  AND other_r.id <> NEW.id;

                IF already_received + r.current_qty > (
                    SELECT base_quantity_milli FROM ledger.purchase_items
                    WHERE store_id = NEW.store_id AND id = r.purchase_item_id
                ) THEN
                    RAISE EXCEPTION 'Received quantity exceeds ordered quantity' USING ERRCODE = '23514';
                END IF;
            END IF;
        END LOOP;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_goods_receipt_post_validate
BEFORE UPDATE OF status ON ledger.goods_receipts
FOR EACH ROW EXECUTE FUNCTION ledger.validate_goods_receipt_post();

CREATE OR REPLACE FUNCTION ledger.validate_customer_payment_post()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    alloc bigint;
    movement_amount bigint;
    receivable_reduction bigint;
    credit_created bigint;
BEGIN
    IF NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted' THEN
        PERFORM ledger.assert_period_open(NEW.store_id, NEW.accounting_period_id, NEW.payment_at);
        SELECT COALESCE(sum(amount_minor),0) INTO alloc
        FROM ledger.customer_payment_allocations
        WHERE store_id = NEW.store_id AND customer_payment_id = NEW.id;
        IF alloc <> NEW.allocated_total_minor
           OR NEW.allocated_total_minor + NEW.credit_created_minor <> NEW.amount_minor THEN
            RAISE EXCEPTION 'Customer payment allocation is inconsistent' USING ERRCODE = '23514';
        END IF;
        SELECT amount_delta_minor INTO movement_amount
        FROM ledger.money_movements
        WHERE store_id = NEW.store_id AND id = NEW.money_movement_id;
        IF movement_amount IS DISTINCT FROM NEW.amount_minor THEN
            RAISE EXCEPTION 'Customer payment money movement is missing or inconsistent' USING ERRCODE = '23514';
        END IF;
        SELECT COALESCE(-sum(receivable_delta_minor) FILTER (WHERE entry_type = 'payment'),0),
               COALESCE(sum(credit_delta_minor) FILTER (WHERE entry_type = 'credit_created'),0)
        INTO receivable_reduction, credit_created
        FROM ledger.customer_ledger_entries
        WHERE store_id = NEW.store_id AND reference_type = 'customer_payment' AND reference_id = NEW.id;
        IF receivable_reduction <> NEW.allocated_total_minor OR credit_created <> NEW.credit_created_minor THEN
            RAISE EXCEPTION 'Customer ledger entries do not match payment allocation' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_customer_payment_post_validate
BEFORE UPDATE OF status ON ledger.customer_payments
FOR EACH ROW EXECUTE FUNCTION ledger.validate_customer_payment_post();

CREATE OR REPLACE FUNCTION ledger.validate_supplier_payment_post()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    alloc bigint;
    movement_amount bigint;
    payable_reduction bigint;
    credit_created bigint;
BEGIN
    IF NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted' THEN
        PERFORM ledger.assert_period_open(NEW.store_id, NEW.accounting_period_id, NEW.payment_at);
        SELECT COALESCE(sum(amount_minor),0) INTO alloc
        FROM ledger.supplier_payment_allocations
        WHERE store_id = NEW.store_id AND supplier_payment_id = NEW.id;
        IF alloc <> NEW.allocated_total_minor
           OR NEW.allocated_total_minor + NEW.credit_created_minor <> NEW.amount_minor THEN
            RAISE EXCEPTION 'Supplier payment allocation is inconsistent' USING ERRCODE = '23514';
        END IF;
        IF NEW.payment_source = 'money_account' THEN
            SELECT amount_delta_minor INTO movement_amount
            FROM ledger.money_movements
            WHERE store_id = NEW.store_id AND id = NEW.money_movement_id;
            IF movement_amount IS DISTINCT FROM -NEW.amount_minor THEN
                RAISE EXCEPTION 'Supplier payment money movement is missing or inconsistent' USING ERRCODE = '23514';
            END IF;
        END IF;
        SELECT COALESCE(-sum(payable_delta_minor) FILTER (WHERE entry_type = 'payment'),0),
               COALESCE(sum(credit_delta_minor) FILTER (WHERE entry_type = 'credit_created'),0)
        INTO payable_reduction, credit_created
        FROM ledger.supplier_ledger_entries
        WHERE store_id = NEW.store_id AND reference_type = 'supplier_payment' AND reference_id = NEW.id;
        IF payable_reduction <> NEW.allocated_total_minor OR credit_created <> NEW.credit_created_minor THEN
            RAISE EXCEPTION 'Supplier ledger entries do not match payment allocation' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_supplier_payment_post_validate
BEFORE UPDATE OF status ON ledger.supplier_payments
FOR EACH ROW EXECUTE FUNCTION ledger.validate_supplier_payment_post();

CREATE OR REPLACE FUNCTION ledger.validate_expense_payment_post()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    movement_amount bigint;
BEGIN
    IF NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted' THEN
        PERFORM ledger.assert_period_open(NEW.store_id, NEW.accounting_period_id, NEW.payment_at);
        IF NEW.payment_source = 'money_account' THEN
            SELECT amount_delta_minor INTO movement_amount
            FROM ledger.money_movements
            WHERE store_id = NEW.store_id AND id = NEW.money_movement_id;
            IF movement_amount IS DISTINCT FROM -NEW.amount_minor THEN
                RAISE EXCEPTION 'Expense payment money movement is missing or inconsistent' USING ERRCODE = '23514';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_expense_payment_post_validate
BEFORE UPDATE OF status ON ledger.expense_payments
FOR EACH ROW EXECUTE FUNCTION ledger.validate_expense_payment_post();

CREATE OR REPLACE FUNCTION ledger.validate_money_transfer_post()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    source_delta bigint;
    destination_delta bigint;
BEGIN
    IF NEW.source_account_id = NEW.destination_account_id THEN
        RAISE EXCEPTION 'Transfer source and destination must differ' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'posted' AND (TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM 'posted')) THEN
        PERFORM ledger.assert_period_open(NEW.store_id, NEW.accounting_period_id, NEW.transfer_at);
        SELECT amount_delta_minor INTO source_delta
        FROM ledger.money_movements WHERE store_id = NEW.store_id AND id = NEW.source_movement_id;
        SELECT amount_delta_minor INTO destination_delta
        FROM ledger.money_movements WHERE store_id = NEW.store_id AND id = NEW.destination_movement_id;
        IF source_delta IS DISTINCT FROM -NEW.amount_minor OR destination_delta IS DISTINCT FROM NEW.amount_minor THEN
            RAISE EXCEPTION 'Transfer movements must be equal and opposite' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_money_transfer_post_validate
BEFORE INSERT OR UPDATE OF status, source_account_id, destination_account_id ON ledger.money_transfers
FOR EACH ROW EXECUTE FUNCTION ledger.validate_money_transfer_post();

-- =========================================================
-- Returns
-- =========================================================

CREATE OR REPLACE FUNCTION ledger.validate_sale_return_post()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    item_total bigint;
    settlement_total bigint;
    r record;
    prior_qty bigint;
BEGIN
    IF NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted' THEN
        PERFORM ledger.assert_period_open(NEW.store_id, NEW.accounting_period_id, NEW.return_at);
        SELECT COALESCE(sum(line_refund_minor),0) INTO item_total
        FROM ledger.sale_return_items WHERE store_id = NEW.store_id AND sale_return_id = NEW.id;
        SELECT COALESCE(sum(amount_minor),0) INTO settlement_total
        FROM ledger.sale_return_settlements WHERE store_id = NEW.store_id AND sale_return_id = NEW.id;
        IF item_total <> NEW.total_minor OR settlement_total <> NEW.total_minor THEN
            RAISE EXCEPTION 'Sale return items/settlements must equal return total' USING ERRCODE = '23514';
        END IF;
        FOR r IN
            SELECT sale_item_id, sum(quantity_milli) qty
            FROM ledger.sale_return_items
            WHERE store_id = NEW.store_id AND sale_return_id = NEW.id
            GROUP BY sale_item_id
        LOOP
            SELECT COALESCE(sum(sri.quantity_milli),0) INTO prior_qty
            FROM ledger.sale_return_items sri
            JOIN ledger.sale_returns sr ON sr.store_id = sri.store_id AND sr.id = sri.sale_return_id
            WHERE sri.store_id = NEW.store_id AND sri.sale_item_id = r.sale_item_id
              AND sr.status = 'posted' AND sr.id <> NEW.id;
            IF prior_qty + r.qty > (
                SELECT quantity_milli FROM ledger.sale_items
                WHERE store_id = NEW.store_id AND id = r.sale_item_id
            ) THEN
                RAISE EXCEPTION 'Returned sale quantity exceeds original quantity' USING ERRCODE = '23514';
            END IF;
        END LOOP;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sale_return_post_validate
BEFORE UPDATE OF status ON ledger.sale_returns
FOR EACH ROW EXECUTE FUNCTION ledger.validate_sale_return_post();

CREATE OR REPLACE FUNCTION ledger.validate_supplier_return_post()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    item_total bigint;
    settlement_total bigint;
BEGIN
    IF NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted' THEN
        PERFORM ledger.assert_period_open(NEW.store_id, NEW.accounting_period_id, NEW.return_at);
        SELECT COALESCE(sum(line_total_minor),0) INTO item_total
        FROM ledger.supplier_return_items WHERE store_id = NEW.store_id AND supplier_return_id = NEW.id;
        SELECT COALESCE(sum(amount_minor),0) INTO settlement_total
        FROM ledger.supplier_return_settlements WHERE store_id = NEW.store_id AND supplier_return_id = NEW.id;
        IF item_total <> NEW.total_minor OR settlement_total <> NEW.total_minor THEN
            RAISE EXCEPTION 'Supplier return items/settlements must equal return total' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_supplier_return_post_validate
BEFORE UPDATE OF status ON ledger.supplier_returns
FOR EACH ROW EXECUTE FUNCTION ledger.validate_supplier_return_post();

-- =========================================================
-- Readable document numbers with transaction-scoped lock
-- =========================================================

CREATE OR REPLACE FUNCTION ledger.next_document_number(
    p_store_id uuid,
    p_device_id uuid,
    p_document_type text,
    p_year integer,
    p_prefix text
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
    n bigint;
BEGIN
    IF p_document_type NOT IN ('sale','purchase_invoice','goods_receipt','sale_return','supplier_return','stock_count','money_transfer') THEN
        RAISE EXCEPTION 'Unsupported document type' USING ERRCODE = '22023';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_store_id::text || ':' || p_device_id::text || ':' || p_document_type || ':' || p_year::text, 0));

    INSERT INTO ledger.document_sequences(store_id, device_id, document_type, sequence_year, next_value, updated_at)
    VALUES (p_store_id, p_device_id, p_document_type, p_year, 2, clock_timestamp())
    ON CONFLICT (store_id, device_id, document_type, sequence_year)
    DO UPDATE SET next_value = ledger.document_sequences.next_value + 1,
                  updated_at = clock_timestamp()
    RETURNING next_value - 1 INTO n;

    RETURN concat(p_prefix, '-', p_year, '-', lpad(n::text, 6, '0'));
END;
$$;

-- =========================================================
-- Idempotency and change feed
-- =========================================================

CREATE OR REPLACE FUNCTION sync.claim_operation(
    p_store_id uuid,
    p_operation_id uuid,
    p_device_id uuid,
    p_aggregate_type text,
    p_aggregate_id uuid,
    p_action text,
    p_request_hash text
) RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO sync.processed_operations(
        store_id, operation_id, device_id, aggregate_type, aggregate_id,
        action, request_hash, status
    ) VALUES (
        p_store_id, p_operation_id, p_device_id, p_aggregate_type,
        p_aggregate_id, p_action, p_request_hash, 'processing'
    );
    RETURN true;
EXCEPTION WHEN unique_violation THEN
    IF EXISTS (
        SELECT 1 FROM sync.processed_operations
        WHERE store_id = p_store_id AND operation_id = p_operation_id
          AND request_hash <> p_request_hash
    ) THEN
        RAISE EXCEPTION 'Operation ID was reused with a different payload' USING ERRCODE = '23505';
    END IF;
    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION sync.capture_change_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, sync, ledger, platform
AS $$
DECLARE
    j jsonb := to_jsonb(NEW);
    action_name text;
BEGIN
    IF current_setting('app.suppress_change_events', true) = 'on' THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        action_name := 'create';
    ELSIF (to_jsonb(OLD)->>'status') IS DISTINCT FROM (j->>'status') THEN
        action_name := CASE j->>'status'
            WHEN 'archived' THEN 'archive'
            WHEN 'posted' THEN 'post'
            WHEN 'cancelled' THEN 'cancel'
            ELSE 'update'
        END;
    ELSE
        action_name := 'update';
    END IF;

    INSERT INTO sync.change_events(
        store_id, entity_type, entity_id, action, entity_version,
        operation_id, device_id, payload, occurred_at
    ) VALUES (
        COALESCE(NULLIF(j->>'store_id','')::uuid, NULLIF(j->>'id','')::uuid),
        TG_TABLE_NAME,
        COALESCE(NULLIF(j->>'id','')::uuid, NULLIF(j->>'store_id','')::uuid),
        action_name,
        COALESCE((j->>'version')::bigint, 1),
        NULLIF(j->>'operation_id','')::uuid,
        NULLIF(j->>'device_id','')::uuid,
        j,
        clock_timestamp()
    );
    RETURN NEW;
END;
$$;

-- =========================================================
-- Central audit capture
-- =========================================================

CREATE OR REPLACE FUNCTION audit.capture_row_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, audit, platform
AS $$
DECLARE
    j_new jsonb := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
    j_old jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
    store_uuid uuid := COALESCE(NULLIF(j_new->>'store_id','')::uuid, NULLIF(j_old->>'store_id','')::uuid);
    entity_uuid uuid := COALESCE(NULLIF(j_new->>'id','')::uuid, NULLIF(j_old->>'id','')::uuid);
BEGIN
    INSERT INTO audit.central_audit_logs(
        store_id, user_id, device_id, request_id, action,
        entity_type, entity_id, old_values, new_values, reason
    ) VALUES (
        store_uuid,
        platform.current_user_id(),
        platform.current_device_id(),
        platform.current_request_id(),
        lower(TG_OP),
        TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
        entity_uuid,
        j_old,
        j_new,
        current_setting('app.audit_reason', true)
    );
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION audit.prevent_central_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Central audit logs are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_central_audit_immutable
BEFORE UPDATE OR DELETE ON audit.central_audit_logs
FOR EACH ROW EXECUTE FUNCTION audit.prevent_central_audit_mutation();

-- =========================================================
-- Trigger attachment
-- =========================================================

-- Child tables can only change while their aggregate root is draft.
CREATE TRIGGER trg_sale_items_parent_draft BEFORE INSERT OR UPDATE OR DELETE ON ledger.sale_items
FOR EACH ROW EXECUTE FUNCTION ledger.ensure_parent_draft('sales','sale_id');
CREATE TRIGGER trg_sale_payments_parent_draft BEFORE INSERT OR UPDATE OR DELETE ON ledger.sale_payments
FOR EACH ROW EXECUTE FUNCTION ledger.ensure_parent_draft('sales','sale_id');
CREATE TRIGGER trg_purchase_items_parent_draft BEFORE INSERT OR UPDATE OR DELETE ON ledger.purchase_items
FOR EACH ROW EXECUTE FUNCTION ledger.ensure_parent_draft('purchase_invoices','purchase_invoice_id');
CREATE TRIGGER trg_goods_receipt_items_parent_draft BEFORE INSERT OR UPDATE OR DELETE ON ledger.goods_receipt_items
FOR EACH ROW EXECUTE FUNCTION ledger.ensure_parent_draft('goods_receipts','goods_receipt_id');
CREATE TRIGGER trg_customer_allocations_parent_draft BEFORE INSERT OR UPDATE OR DELETE ON ledger.customer_payment_allocations
FOR EACH ROW EXECUTE FUNCTION ledger.ensure_parent_draft('customer_payments','customer_payment_id');
CREATE TRIGGER trg_supplier_allocations_parent_draft BEFORE INSERT OR UPDATE OR DELETE ON ledger.supplier_payment_allocations
FOR EACH ROW EXECUTE FUNCTION ledger.ensure_parent_draft('supplier_payments','supplier_payment_id');
CREATE TRIGGER trg_sale_return_items_parent_draft BEFORE INSERT OR UPDATE OR DELETE ON ledger.sale_return_items
FOR EACH ROW EXECUTE FUNCTION ledger.ensure_parent_draft('sale_returns','sale_return_id');
CREATE TRIGGER trg_sale_return_settlements_parent_draft BEFORE INSERT OR UPDATE OR DELETE ON ledger.sale_return_settlements
FOR EACH ROW EXECUTE FUNCTION ledger.ensure_parent_draft('sale_returns','sale_return_id');
CREATE TRIGGER trg_supplier_return_items_parent_draft BEFORE INSERT OR UPDATE OR DELETE ON ledger.supplier_return_items
FOR EACH ROW EXECUTE FUNCTION ledger.ensure_parent_draft('supplier_returns','supplier_return_id');
CREATE TRIGGER trg_supplier_return_settlements_parent_draft BEFORE INSERT OR UPDATE OR DELETE ON ledger.supplier_return_settlements
FOR EACH ROW EXECUTE FUNCTION ledger.ensure_parent_draft('supplier_returns','supplier_return_id');
CREATE TRIGGER trg_stock_count_items_parent_draft BEFORE INSERT OR UPDATE OR DELETE ON ledger.stock_count_items
FOR EACH ROW EXECUTE FUNCTION ledger.ensure_parent_draft('stock_counts','stock_count_id');

-- Integer-scaled quantity × unit-price consistency (tolerance: half a minor unit).
CREATE TRIGGER trg_sale_item_amount BEFORE INSERT OR UPDATE ON ledger.sale_items
FOR EACH ROW EXECUTE FUNCTION ledger.validate_scaled_line_amount('unit_price_minor','line_gross_minor');
CREATE TRIGGER trg_purchase_item_amount BEFORE INSERT OR UPDATE ON ledger.purchase_items
FOR EACH ROW EXECUTE FUNCTION ledger.validate_scaled_line_amount('unit_cost_minor','line_gross_minor');
CREATE TRIGGER trg_goods_receipt_item_amount BEFORE INSERT OR UPDATE ON ledger.goods_receipt_items
FOR EACH ROW EXECUTE FUNCTION ledger.validate_scaled_line_amount('unit_cost_minor','line_total_minor');
CREATE TRIGGER trg_supplier_return_item_amount BEFORE INSERT OR UPDATE ON ledger.supplier_return_items
FOR EACH ROW EXECUTE FUNCTION ledger.validate_scaled_line_amount('unit_cost_minor','line_total_minor');
CREATE TRIGGER trg_goods_receipt_item_details BEFORE INSERT OR UPDATE ON ledger.goods_receipt_items
FOR EACH ROW EXECUTE FUNCTION ledger.validate_goods_receipt_item_details();

-- Append-only ledgers and movements.
CREATE TRIGGER trg_money_movements_no_mutation BEFORE UPDATE OR DELETE ON ledger.money_movements
FOR EACH ROW EXECUTE FUNCTION ledger.prevent_mutation();
CREATE TRIGGER trg_inventory_movements_no_mutation BEFORE UPDATE OR DELETE ON ledger.inventory_movements
FOR EACH ROW EXECUTE FUNCTION ledger.prevent_mutation();
CREATE TRIGGER trg_customer_ledger_no_mutation BEFORE UPDATE OR DELETE ON ledger.customer_ledger_entries
FOR EACH ROW EXECUTE FUNCTION ledger.prevent_mutation();
CREATE TRIGGER trg_supplier_ledger_no_mutation BEFORE UPDATE OR DELETE ON ledger.supplier_ledger_entries
FOR EACH ROW EXECUTE FUNCTION ledger.prevent_mutation();
CREATE TRIGGER trg_owner_ledger_no_mutation BEFORE UPDATE OR DELETE ON ledger.owner_ledger_entries
FOR EACH ROW EXECUTE FUNCTION ledger.prevent_mutation();
CREATE TRIGGER trg_local_audit_no_mutation BEFORE UPDATE OR DELETE ON ledger.audit_logs
FOR EACH ROW EXECUTE FUNCTION ledger.prevent_mutation();
CREATE TRIGGER trg_change_events_no_mutation BEFORE UPDATE OR DELETE ON sync.change_events
FOR EACH ROW EXECUTE FUNCTION ledger.prevent_mutation();
CREATE TRIGGER trg_processed_operations_no_delete BEFORE DELETE ON sync.processed_operations
FOR EACH ROW EXECUTE FUNCTION ledger.prevent_delete();

-- Period-open checks for append-only rows.
CREATE TRIGGER trg_money_movements_period BEFORE INSERT ON ledger.money_movements
FOR EACH ROW EXECUTE FUNCTION ledger.enforce_period_open('occurred_at');
CREATE TRIGGER trg_customer_ledger_period BEFORE INSERT ON ledger.customer_ledger_entries
FOR EACH ROW EXECUTE FUNCTION ledger.enforce_period_open('occurred_at');
CREATE TRIGGER trg_supplier_ledger_period BEFORE INSERT ON ledger.supplier_ledger_entries
FOR EACH ROW EXECUTE FUNCTION ledger.enforce_period_open('occurred_at');
CREATE TRIGGER trg_owner_ledger_period BEFORE INSERT ON ledger.owner_ledger_entries
FOR EACH ROW EXECUTE FUNCTION ledger.enforce_period_open('occurred_at');

-- No hard deletion of business records.
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'devices','customers','suppliers','products','product_units','money_accounts','accounting_periods',
        'sales','purchase_invoices','goods_receipts','customer_payments','supplier_payments',
        'expenses','expense_payments','money_transfers','sale_returns','supplier_returns',
        'stock_counts'
    ] LOOP
        EXECUTE format('CREATE TRIGGER trg_%I_no_delete BEFORE DELETE ON ledger.%I FOR EACH ROW EXECUTE FUNCTION ledger.prevent_delete()', t, t);
    END LOOP;
END;
$$;

-- Protect finalized headers.
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'sales','purchase_invoices','goods_receipts','customer_payments','supplier_payments',
        'expenses','expense_payments','money_transfers','sale_returns','supplier_returns','stock_counts'
    ] LOOP
        EXECUTE format('CREATE TRIGGER trg_%I_finalized_guard BEFORE UPDATE ON ledger.%I FOR EACH ROW EXECUTE FUNCTION ledger.protect_finalized_header()', t, t);
    END LOOP;
END;
$$;

-- Version/updated_at for mutable aggregate roots and master data.
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'stores','devices','app_settings','customers','suppliers','products','product_units',
        'money_accounts','accounting_periods','expense_categories','sales','purchase_invoices',
        'goods_receipts','customer_payments','supplier_payments','expenses','expense_payments',
        'money_transfers','sale_returns','supplier_returns','stock_counts','notifications'
    ] LOOP
        EXECUTE format('CREATE TRIGGER trg_%I_touch BEFORE UPDATE ON ledger.%I FOR EACH ROW EXECUTE FUNCTION ledger.touch_mutable_row()', t, t);
    END LOOP;
END;
$$;

-- Change feed on synchronized aggregate roots.
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'stores','devices','app_settings','customers','suppliers','products','product_units',
        'money_accounts','accounting_periods','expense_categories','sales','purchase_invoices',
        'goods_receipts','customer_payments','supplier_payments','expenses','expense_payments',
        'money_transfers','sale_returns','supplier_returns','stock_counts','notifications'
    ] LOOP
        EXECUTE format('CREATE TRIGGER trg_%I_change_event AFTER INSERT OR UPDATE ON ledger.%I FOR EACH ROW EXECUTE FUNCTION sync.capture_change_event()', t, t);
    END LOOP;
END;
$$;

-- Audit high-value mutable records.
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'customers','suppliers','products','product_units','money_accounts','accounting_periods',
        'sales','purchase_invoices','goods_receipts','customer_payments','supplier_payments',
        'expenses','money_transfers','sale_returns','supplier_returns','stock_counts'
    ] LOOP
        EXECUTE format('CREATE TRIGGER trg_%I_central_audit AFTER INSERT OR UPDATE OR DELETE ON ledger.%I FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change()', t, t);
    END LOOP;
END;
$$;

COMMIT;



-- ==================== 04_indexes_views.sql ====================

-- Shop Ledger PostgreSQL v1.0.0
-- Performance indexes and reporting views.

BEGIN;

-- =========================================================
-- Domain indexes migrated from SQLite
-- =========================================================

CREATE INDEX idx_attachments_entity ON ledger.attachments(store_id, entity_type, entity_id);
CREATE INDEX idx_audit_entity ON ledger.audit_logs(store_id, entity_type, entity_id, occurred_at DESC);
CREATE INDEX idx_customer_ledger_customer_time ON ledger.customer_ledger_entries(store_id, customer_id, occurred_at DESC);
CREATE INDEX idx_customer_ledger_sale ON ledger.customer_ledger_entries(store_id, source_sale_id, occurred_at DESC);
CREATE INDEX idx_customer_allocations_sale ON ledger.customer_payment_allocations(store_id, sale_id);
CREATE INDEX idx_customers_search ON ledger.customers(store_id, status, normalized_name, normalized_phone);
CREATE INDEX idx_goods_receipt_items_purchase_item ON ledger.goods_receipt_items(store_id, purchase_item_id);
CREATE INDEX idx_goods_receipt_items_receipt ON ledger.goods_receipt_items(store_id, goods_receipt_id);
CREATE INDEX idx_inventory_movements_product_time ON ledger.inventory_movements(store_id, product_id, occurred_at DESC);
CREATE UNIQUE INDEX uq_store_single_cash_account ON ledger.money_accounts(store_id)
    WHERE account_type = 'cash' AND status = 'active';
CREATE INDEX idx_money_movements_account_time ON ledger.money_movements(store_id, account_id, occurred_at DESC);
CREATE INDEX idx_money_movements_reference ON ledger.money_movements(store_id, reference_type, reference_id);
CREATE INDEX idx_notifications_status ON ledger.notifications(store_id, status, severity, created_at DESC);
CREATE INDEX idx_owner_ledger_time ON ledger.owner_ledger_entries(store_id, occurred_at DESC);
CREATE UNIQUE INDEX uq_product_one_base_unit ON ledger.product_units(store_id, product_id)
    WHERE is_base = true AND status = 'active';
CREATE INDEX idx_products_search ON ledger.products(store_id, status, normalized_name, barcode, sku, is_pinned);
CREATE INDEX idx_purchase_invoices_supplier ON ledger.purchase_invoices(store_id, supplier_id, invoice_date_at DESC, status);
CREATE INDEX idx_purchase_items_invoice ON ledger.purchase_items(store_id, purchase_invoice_id);
CREATE INDEX idx_sale_items_sale ON ledger.sale_items(store_id, sale_id);
CREATE INDEX idx_sales_customer_time ON ledger.sales(store_id, customer_id, sale_at DESC, status);
CREATE INDEX idx_sales_time ON ledger.sales(store_id, sale_at DESC, status);
CREATE INDEX idx_supplier_ledger_purchase ON ledger.supplier_ledger_entries(store_id, source_purchase_invoice_id, occurred_at DESC);
CREATE INDEX idx_supplier_ledger_supplier_time ON ledger.supplier_ledger_entries(store_id, supplier_id, occurred_at DESC);
CREATE INDEX idx_supplier_allocations_invoice ON ledger.supplier_payment_allocations(store_id, purchase_invoice_id);
CREATE INDEX idx_suppliers_search ON ledger.suppliers(store_id, status, normalized_name, normalized_phone);

-- Additional foreign-key and operational indexes.
CREATE INDEX idx_sale_payments_sale ON ledger.sale_payments(store_id, sale_id);
CREATE INDEX idx_customer_payments_customer_time ON ledger.customer_payments(store_id, customer_id, payment_at DESC, status);
CREATE INDEX idx_supplier_payments_supplier_time ON ledger.supplier_payments(store_id, supplier_id, payment_at DESC, status);
CREATE INDEX idx_expenses_due ON ledger.expenses(store_id, status, due_at) WHERE status IN ('posted','partially_paid');
CREATE INDEX idx_expense_payments_expense ON ledger.expense_payments(store_id, expense_id, payment_at DESC);
CREATE INDEX idx_sale_returns_sale ON ledger.sale_returns(store_id, sale_id, return_at DESC, status);
CREATE INDEX idx_supplier_returns_supplier ON ledger.supplier_returns(store_id, supplier_id, return_at DESC, status);
CREATE INDEX idx_stock_counts_time ON ledger.stock_counts(store_id, started_at DESC, status);
CREATE INDEX idx_accounting_period_status ON ledger.accounting_periods(store_id, status, starts_at, ends_at);
CREATE INDEX idx_devices_status ON ledger.devices(store_id, status, last_seen_at DESC);

-- BRIN indexes for append-only time-series tables. Useful after tables become large.
CREATE INDEX idx_money_movements_time_brin ON ledger.money_movements USING brin(occurred_at);
CREATE INDEX idx_inventory_movements_time_brin ON ledger.inventory_movements USING brin(occurred_at);
CREATE INDEX idx_customer_ledger_time_brin ON ledger.customer_ledger_entries USING brin(occurred_at);
CREATE INDEX idx_supplier_ledger_time_brin ON ledger.supplier_ledger_entries USING brin(occurred_at);
CREATE INDEX idx_change_events_cursor_brin ON sync.change_events USING brin(cursor);
CREATE INDEX idx_central_audit_time_brin ON audit.central_audit_logs USING brin(occurred_at);

-- Server-only indexes.
CREATE INDEX idx_memberships_user ON platform.store_memberships(user_id, status);
CREATE INDEX idx_auth_sessions_user ON platform.auth_sessions(user_id, expires_at DESC);
CREATE INDEX idx_refresh_tokens_session ON platform.refresh_tokens(session_id, expires_at DESC);
CREATE INDEX idx_subscriptions_store_time ON platform.subscriptions(store_id, expires_at DESC, status);
CREATE INDEX idx_license_store_device ON platform.license_issuances(store_id, device_id, expires_at DESC);
CREATE INDEX idx_backups_store_time ON platform.server_backups(store_id, created_at DESC, status);
CREATE INDEX idx_processed_operations_status ON sync.processed_operations(store_id, status, created_at);
CREATE INDEX idx_conflicts_open ON sync.conflicts(store_id, created_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX idx_dead_letters_open ON sync.dead_letters(store_id, last_failed_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX idx_audit_store_entity ON audit.central_audit_logs(store_id, entity_type, entity_id, occurred_at DESC);
CREATE INDEX idx_change_payload_gin ON sync.change_events USING gin(payload jsonb_path_ops);

-- =========================================================
-- Ledger balance views (source of truth is append-only entries)
-- =========================================================

CREATE OR REPLACE VIEW ledger.v_customer_balances WITH (security_invoker = true) AS
SELECT
    c.store_id,
    c.id AS customer_id,
    c.name,
    COALESCE(sum(l.receivable_delta_minor), 0)::bigint AS receivable_minor,
    COALESCE(sum(l.credit_delta_minor), 0)::bigint AS credit_minor,
    (COALESCE(sum(l.receivable_delta_minor), 0)
      - COALESCE(sum(l.credit_delta_minor), 0))::bigint AS net_due_minor
FROM ledger.customers c
LEFT JOIN ledger.customer_ledger_entries l
  ON l.store_id = c.store_id AND l.customer_id = c.id
GROUP BY c.store_id, c.id, c.name;

CREATE OR REPLACE VIEW ledger.v_customer_invoice_outstanding WITH (security_invoker = true) AS
SELECT
    s.store_id,
    s.id AS sale_id,
    s.customer_id,
    s.display_number,
    s.sale_at,
    s.credit_total_minor AS original_credit_minor,
    COALESCE(sum(l.receivable_delta_minor), 0)::bigint AS outstanding_minor
FROM ledger.sales s
LEFT JOIN ledger.customer_ledger_entries l
  ON l.store_id = s.store_id AND l.source_sale_id = s.id
WHERE s.customer_id IS NOT NULL
GROUP BY s.store_id, s.id, s.customer_id, s.display_number, s.sale_at, s.credit_total_minor;

CREATE OR REPLACE VIEW ledger.v_supplier_balances WITH (security_invoker = true) AS
SELECT
    s.store_id,
    s.id AS supplier_id,
    s.name,
    COALESCE(sum(l.payable_delta_minor), 0)::bigint AS payable_minor,
    COALESCE(sum(l.credit_delta_minor), 0)::bigint AS credit_minor,
    (COALESCE(sum(l.payable_delta_minor), 0)
      - COALESCE(sum(l.credit_delta_minor), 0))::bigint AS net_payable_minor
FROM ledger.suppliers s
LEFT JOIN ledger.supplier_ledger_entries l
  ON l.store_id = s.store_id AND l.supplier_id = s.id
GROUP BY s.store_id, s.id, s.name;

CREATE OR REPLACE VIEW ledger.v_supplier_invoice_outstanding WITH (security_invoker = true) AS
SELECT
    p.store_id,
    p.id AS purchase_invoice_id,
    p.supplier_id,
    p.display_number,
    p.invoice_date_at,
    COALESCE(sum(l.payable_delta_minor), 0)::bigint AS outstanding_minor
FROM ledger.purchase_invoices p
LEFT JOIN ledger.supplier_ledger_entries l
  ON l.store_id = p.store_id AND l.source_purchase_invoice_id = p.id
GROUP BY p.store_id, p.id, p.supplier_id, p.display_number, p.invoice_date_at;

CREATE OR REPLACE VIEW ledger.v_money_account_balances WITH (security_invoker = true) AS
SELECT
    a.store_id,
    a.id AS account_id,
    a.name,
    a.account_type,
    a.availability,
    COALESCE(sum(m.amount_delta_minor), 0)::bigint AS balance_minor
FROM ledger.money_accounts a
LEFT JOIN ledger.money_movements m
  ON m.store_id = a.store_id AND m.account_id = a.id
GROUP BY a.store_id, a.id, a.name, a.account_type, a.availability;

CREATE OR REPLACE VIEW ledger.v_expense_balances WITH (security_invoker = true) AS
SELECT
    e.store_id,
    e.id AS expense_id,
    e.description,
    e.amount_minor,
    COALESCE(sum(ep.amount_minor) FILTER (WHERE ep.status = 'posted'), 0)::bigint AS paid_minor,
    (e.amount_minor - COALESCE(sum(ep.amount_minor) FILTER (WHERE ep.status = 'posted'), 0))::bigint AS due_minor
FROM ledger.expenses e
LEFT JOIN ledger.expense_payments ep
  ON ep.store_id = e.store_id AND ep.expense_id = e.id
WHERE e.status = 'posted'
GROUP BY e.store_id, e.id, e.description, e.amount_minor;

CREATE OR REPLACE VIEW ledger.v_owner_position WITH (security_invoker = true) AS
SELECT
    store_id,
    COALESCE(sum(owner_liability_delta_minor), 0)::bigint AS store_owes_owner_minor,
    COALESCE(sum(equity_delta_minor), 0)::bigint AS owner_equity_movement_minor
FROM ledger.owner_ledger_entries
GROUP BY store_id;

CREATE OR REPLACE VIEW ledger.v_purchase_receipt_progress WITH (security_invoker = true) AS
SELECT
    pi.store_id,
    pi.id AS purchase_invoice_id,
    pi.display_number,
    pi.supplier_id,
    COALESCE(sum(pit.base_quantity_milli), 0)::bigint AS ordered_base_quantity_milli,
    COALESCE((
        SELECT sum(gri.base_quantity_milli)
        FROM ledger.goods_receipt_items gri
        JOIN ledger.goods_receipts gr
          ON gr.store_id = gri.store_id AND gr.id = gri.goods_receipt_id
        WHERE gr.store_id = pi.store_id
          AND gr.purchase_invoice_id = pi.id
          AND gr.status = 'posted'
    ), 0)::bigint AS received_base_quantity_milli
FROM ledger.purchase_invoices pi
LEFT JOIN ledger.purchase_items pit
  ON pit.store_id = pi.store_id AND pit.purchase_invoice_id = pi.id
GROUP BY pi.store_id, pi.id, pi.display_number, pi.supplier_id;

-- =========================================================
-- Product/reporting views
-- =========================================================

CREATE OR REPLACE VIEW ledger.v_sale_profit_quality WITH (security_invoker = true) AS
SELECT
    s.store_id,
    s.id AS sale_id,
    s.display_number,
    s.sale_at,
    s.total_minor,
    s.known_cost_total_minor,
    (s.total_minor - s.known_cost_total_minor)::bigint AS known_gross_profit_minor,
    s.pending_cost_line_count,
    s.unknown_cost_line_count,
    CASE
      WHEN s.pending_cost_line_count = 0 AND s.unknown_cost_line_count = 0 THEN 'complete'
      WHEN s.unknown_cost_line_count > 0 THEN 'unknown_cost'
      ELSE 'pending_cost'
    END AS cost_quality
FROM ledger.sales s
WHERE s.status = 'posted';

CREATE OR REPLACE VIEW ledger.v_store_financial_position WITH (security_invoker = true) AS
SELECT
    st.id AS store_id,
    COALESCE((SELECT sum(balance_minor) FROM ledger.v_money_account_balances b WHERE b.store_id = st.id),0)::bigint AS liquid_and_held_money_minor,
    COALESCE((SELECT sum(net_due_minor) FROM ledger.v_customer_balances c WHERE c.store_id = st.id),0)::bigint AS customer_net_due_minor,
    COALESCE((SELECT sum(net_payable_minor) FROM ledger.v_supplier_balances s WHERE s.store_id = st.id),0)::bigint AS supplier_net_payable_minor,
    COALESCE((SELECT sum(inventory_value_minor) FROM ledger.stock_balances i WHERE i.store_id = st.id),0)::bigint AS inventory_value_minor,
    COALESCE((SELECT store_owes_owner_minor FROM ledger.v_owner_position o WHERE o.store_id = st.id),0)::bigint AS store_owes_owner_minor
FROM ledger.stores st;

CREATE OR REPLACE VIEW sync.v_device_sync_health WITH (security_invoker = true) AS
SELECT
    d.store_id,
    d.id AS device_id,
    d.device_name,
    d.status AS device_status,
    d.last_seen_at,
    COALESCE(c.last_pulled_cursor,0) AS last_pulled_cursor,
    c.last_success_at,
    c.last_error,
    (SELECT max(cursor) FROM sync.change_events e WHERE e.store_id = d.store_id) AS store_latest_cursor,
    COALESCE((SELECT max(cursor) FROM sync.change_events e WHERE e.store_id = d.store_id),0)
      - COALESCE(c.last_pulled_cursor,0) AS events_behind
FROM ledger.devices d
LEFT JOIN sync.device_cursors c
  ON c.store_id = d.store_id AND c.device_id = d.id;

COMMIT;



-- ==================== 05_security.sql ====================

-- Shop Ledger PostgreSQL v1.0.0
-- Privileges and Row-Level Security for multi-tenant store isolation.

BEGIN;

REVOKE ALL ON SCHEMA platform, ledger, sync, audit FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA platform, ledger, sync, audit FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA platform, ledger, sync, audit FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA platform, ledger, sync, audit FROM PUBLIC;

GRANT USAGE ON SCHEMA ledger, sync TO shop_app_runtime;
GRANT USAGE ON SCHEMA ledger, sync TO shop_app_readonly;
GRANT USAGE ON SCHEMA platform, ledger, sync, audit TO shop_app_migrator;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ledger TO shop_app_runtime;
GRANT SELECT, INSERT, UPDATE ON sync.processed_operations, sync.device_cursors, sync.conflicts, sync.dead_letters TO shop_app_runtime;
GRANT SELECT ON sync.change_events, sync.bootstrap_snapshots TO shop_app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA sync TO shop_app_runtime;
GRANT EXECUTE ON FUNCTION sync.claim_operation(uuid,uuid,uuid,text,uuid,text,text) TO shop_app_runtime;
GRANT EXECUTE ON FUNCTION ledger.next_document_number(uuid,uuid,text,integer,text) TO shop_app_runtime;
GRANT EXECUTE ON FUNCTION ledger.assert_period_open(uuid, uuid, timestamptz) TO shop_app_runtime;
GRANT EXECUTE ON FUNCTION platform.current_store_id() TO shop_app_runtime, shop_app_readonly;
GRANT EXECUTE ON FUNCTION platform.current_user_id() TO shop_app_runtime;
GRANT EXECUTE ON FUNCTION platform.current_device_id() TO shop_app_runtime;
GRANT EXECUTE ON FUNCTION platform.current_request_id() TO shop_app_runtime;

GRANT SELECT ON ALL TABLES IN SCHEMA ledger TO shop_app_readonly;
GRANT SELECT ON sync.change_events, sync.device_cursors, sync.v_device_sync_health TO shop_app_readonly;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA platform, ledger, sync, audit TO shop_app_migrator;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA platform, ledger, sync, audit TO shop_app_migrator;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA platform, ledger, sync, audit TO shop_app_migrator;

-- Server auth tables are intentionally not granted to runtime directly.
-- NestJS should access them through a narrowly privileged auth connection or SECURITY DEFINER functions.

-- Store table uses id as tenant key.
ALTER TABLE ledger.stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.stores FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_stores ON ledger.stores
    USING (id = platform.current_store_id())
    WITH CHECK (id = platform.current_store_id());

-- All other synchronized ledger tables use store_id.
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'devices','document_sequences','app_settings','attachments','customers','suppliers','products',
        'product_units','money_accounts','accounting_periods','expense_categories','money_movements',
        'customer_ledger_entries','supplier_ledger_entries','owner_ledger_entries','stock_balances',
        'inventory_movements','sales','sale_items','sale_payments','purchase_invoices','purchase_items',
        'goods_receipts','goods_receipt_items','customer_payments','customer_payment_allocations',
        'supplier_payments','supplier_payment_allocations','expenses','expense_payments','money_transfers',
        'sale_returns','sale_return_items','sale_return_settlements','supplier_returns','supplier_return_items',
        'supplier_return_settlements','stock_counts','stock_count_items','notifications','audit_logs','backup_metadata'
    ] LOOP
        EXECUTE format('ALTER TABLE ledger.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE ledger.%I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation_%I ON ledger.%I USING (store_id = platform.current_store_id()) WITH CHECK (store_id = platform.current_store_id())',
            t, t
        );
    END LOOP;
END;
$$;

-- Server-only store-scoped tables.
DO $$
DECLARE rec record;
BEGIN
    FOR rec IN SELECT * FROM (VALUES
        ('platform','store_memberships'),
        ('platform','subscriptions'),
        ('platform','license_issuances'),
        ('platform','server_backups'),
        ('sync','processed_operations'),
        ('sync','change_events'),
        ('sync','device_cursors'),
        ('sync','conflicts'),
        ('sync','dead_letters'),
        ('sync','bootstrap_snapshots'),
        ('audit','central_audit_logs')
    ) AS x(schema_name, table_name)
    LOOP
        EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', rec.schema_name, rec.table_name);
        EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', rec.schema_name, rec.table_name);
        EXECUTE format(
            'CREATE POLICY tenant_isolation_%I ON %I.%I USING (store_id = platform.current_store_id()) WITH CHECK (store_id = platform.current_store_id())',
            rec.table_name, rec.schema_name, rec.table_name
        );
    END LOOP;
END;
$$;

-- Ensure future objects default to private.
ALTER DEFAULT PRIVILEGES IN SCHEMA platform, ledger, sync, audit REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform, ledger, sync, audit REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform, ledger, sync, audit REVOKE ALL ON SEQUENCES FROM PUBLIC;

COMMIT;


