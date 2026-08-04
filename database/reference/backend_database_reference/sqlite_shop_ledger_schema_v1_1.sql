
-- نظام دفتر الدكان - SQLite Local Schema v1.1
-- قاعدة تشغيل محلية Offline-first متوافقة منطقيًا مع PostgreSQL.
--
-- مبادئ إلزامية:
-- 1) UUID يخزن TEXT في SQLite ويقابله uuid في PostgreSQL.
-- 2) الأموال تخزن بأصغر وحدة نقدية في INTEGER/ BIGINT وتنتهي بـ _minor.
-- 3) الكميات تخزن بأجزاء الألف من الوحدة في INTEGER/ BIGINT وتنتهي بـ _milli.
-- 4) الزمن يخزن UTC كـ Unix epoch milliseconds وينتهي بـ _at.
-- 5) الحركات المالية والمخزنية والدفاتر Append-only؛ التصحيح يتم بحركة عكسية.
-- 6) كل عملية قابلة للمزامنة تحمل operation_id فريدًا داخل الدكان.
-- 7) كل علاقة بين جداول الدكان تستخدم store_id لمنع الربط بين دكانين.
-- 8) stock_balances جدول Cache؛ المصدر الحقيقي هو inventory_movements.
-- 9) أرصدة العملاء والموردين والحسابات مشتقة من دفاتر الحركات.
-- 10) يجب تشغيل كل عملية مركبة داخل Transaction واحدة من التطبيق.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA recursive_triggers = ON;
PRAGMA user_version = 10100;

-- =========================================================
-- 0. البنية المحلية، المستخدم، الجهاز، الاشتراك، المزامنة
-- =========================================================

CREATE TABLE IF NOT EXISTS local_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;

INSERT OR IGNORE INTO local_meta(key, value) VALUES
('schema_name', 'shop_ledger_sqlite'),
('schema_version', '1.1.0'),
('money_scale', 'minor_unit'),
('quantity_scale', '1000'),
('time_format', 'unix_epoch_milliseconds_utc');

CREATE TABLE IF NOT EXISTS stores (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    phone TEXT,
    currency_code TEXT NOT NULL DEFAULT 'ILS' CHECK (currency_code = 'ILS'),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended', 'read_only', 'archived')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;

CREATE TABLE IF NOT EXISTS local_users (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    full_name TEXT NOT NULL CHECK (length(trim(full_name)) > 0),
    email TEXT,
    normalized_email TEXT,
    role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (store_id, id),
    UNIQUE (store_id, normalized_email),
    FOREIGN KEY (store_id) REFERENCES stores(id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    device_name TEXT NOT NULL CHECK (length(trim(device_name)) > 0),
    platform TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
    installation_id TEXT NOT NULL,
    device_prefix TEXT NOT NULL CHECK (length(device_prefix) BETWEEN 2 AND 12),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked', 'replaced')),
    last_seen_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (store_id, id),
    UNIQUE (store_id, installation_id),
    UNIQUE (store_id, device_prefix),
    FOREIGN KEY (store_id) REFERENCES stores(id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS local_license (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    signed_payload TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_trusted_server_at INTEGER,
    last_seen_device_time INTEGER,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'expired', 'revoked')),
    CHECK (expires_at > issued_at),
    UNIQUE (store_id, id),
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS sync_state (
    store_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    pull_cursor TEXT,
    last_push_at INTEGER,
    last_pull_at INTEGER,
    last_success_at INTEGER,
    last_error TEXT,
    pending_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS sync_outbox (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    aggregate_type TEXT NOT NULL CHECK (length(trim(aggregate_type)) > 0),
    aggregate_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN (
        'create', 'update', 'archive', 'restore', 'post', 'cancel', 'reverse'
    )),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    occurred_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sending', 'synced', 'failed', 'blocked')),
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    next_retry_at INTEGER,
    last_attempt_at INTEGER,
    last_error TEXT,
    server_ack_json TEXT CHECK (server_ack_json IS NULL OR json_valid(server_ack_json)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (store_id, id),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending
ON sync_outbox (store_id, status, next_retry_at, created_at);

CREATE TABLE IF NOT EXISTS sync_inbox_receipts (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    server_event_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    server_version INTEGER CHECK (server_version IS NULL OR server_version >= 1),
    applied_at INTEGER NOT NULL,
    UNIQUE (store_id, id),
    UNIQUE (store_id, server_event_id),
    FOREIGN KEY (store_id) REFERENCES stores(id) ON UPDATE CASCADE ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS document_sequences (
    store_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    document_type TEXT NOT NULL CHECK (document_type IN (
        'sale', 'purchase_invoice', 'goods_receipt', 'sale_return',
        'supplier_return', 'stock_count', 'money_transfer'
    )),
    sequence_year INTEGER NOT NULL CHECK (sequence_year >= 2020),
    next_value INTEGER NOT NULL DEFAULT 1 CHECK (next_value >= 1),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (store_id, device_id, document_type, sequence_year),
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;


-- =========================================================
-- 1. الإعدادات والمرفقات
-- =========================================================

CREATE TABLE IF NOT EXISTS app_settings (
    store_id TEXT PRIMARY KEY,
    daily_report_time_minutes INTEGER NOT NULL DEFAULT 1200
        CHECK (daily_report_time_minutes BETWEEN 0 AND 1439),
    default_credit_policy TEXT NOT NULL DEFAULT 'warn'
        CHECK (default_credit_policy IN ('allow', 'warn', 'block')),
    default_credit_limit_minor INTEGER
        CHECK (default_credit_limit_minor IS NULL OR default_credit_limit_minor >= 0),
    allow_negative_stock INTEGER NOT NULL DEFAULT 0 CHECK (allow_negative_stock IN (0, 1)),
    low_stock_alert_enabled INTEGER NOT NULL DEFAULT 1 CHECK (low_stock_alert_enabled IN (0, 1)),
    debt_age_alert_days INTEGER NOT NULL DEFAULT 90 CHECK (debt_age_alert_days >= 0),
    backup_enabled INTEGER NOT NULL DEFAULT 1 CHECK (backup_enabled IN (0, 1)),
    backup_interval_hours INTEGER NOT NULL DEFAULT 24 CHECK (backup_interval_hours >= 1),
    export_directory_uri TEXT,
    attachments_directory_uri TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    FOREIGN KEY (store_id) REFERENCES stores(id) ON UPDATE CASCADE ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'document', 'receipt', 'other')),
    file_name TEXT NOT NULL CHECK (length(trim(file_name)) > 0),
    mime_type TEXT,
    local_uri TEXT,
    remote_key TEXT,
    file_size_bytes INTEGER CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
    checksum_sha256 TEXT,
    sync_status TEXT NOT NULL DEFAULT 'local'
        CHECK (sync_status IN ('local', 'pending', 'uploaded', 'failed', 'deleted')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (store_id, id),
    FOREIGN KEY (store_id) REFERENCES stores(id) ON UPDATE CASCADE ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_attachments_entity
ON attachments (store_id, entity_type, entity_id);

-- =========================================================
-- 2. الأطراف: العملاء والموردون
-- =========================================================

CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    normalized_name TEXT NOT NULL CHECK (length(trim(normalized_name)) > 0),
    phone TEXT NOT NULL CHECK (length(trim(phone)) > 0),
    normalized_phone TEXT NOT NULL CHECK (length(trim(normalized_phone)) > 0),
    notes TEXT,
    credit_limit_minor INTEGER CHECK (credit_limit_minor IS NULL OR credit_limit_minor >= 0),
    credit_policy TEXT CHECK (credit_policy IS NULL OR credit_policy IN ('allow', 'warn', 'block')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    archived_at INTEGER,
    device_id TEXT,
    operation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (store_id, id),
    UNIQUE (store_id, normalized_phone),
    UNIQUE (store_id, operation_id),
    CHECK ((status = 'archived' AND archived_at IS NOT NULL) OR status = 'active'),
    FOREIGN KEY (store_id) REFERENCES stores(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_customers_search
ON customers (store_id, status, normalized_name, normalized_phone);

CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    normalized_name TEXT NOT NULL CHECK (length(trim(normalized_name)) > 0),
    phone TEXT,
    normalized_phone TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    archived_at INTEGER,
    device_id TEXT,
    operation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (store_id, id),
    UNIQUE (store_id, normalized_phone),
    UNIQUE (store_id, operation_id),
    CHECK ((status = 'archived' AND archived_at IS NOT NULL) OR status = 'active'),
    FOREIGN KEY (store_id) REFERENCES stores(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_suppliers_search
ON suppliers (store_id, status, normalized_name, normalized_phone);


-- =========================================================
-- 3. المنتجات والوحدات
-- =========================================================

CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    normalized_name TEXT NOT NULL CHECK (length(trim(normalized_name)) > 0),
    sku TEXT,
    barcode TEXT,
    description TEXT,
    measurement_type TEXT NOT NULL
        CHECK (measurement_type IN ('count', 'weight', 'volume', 'length')),
    track_inventory INTEGER NOT NULL DEFAULT 1 CHECK (track_inventory IN (0, 1)),
    allow_negative_stock_override INTEGER
        CHECK (allow_negative_stock_override IS NULL OR allow_negative_stock_override IN (0, 1)),
    low_stock_threshold_milli INTEGER
        CHECK (low_stock_threshold_milli IS NULL OR low_stock_threshold_milli >= 0),
    is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    archived_at INTEGER,
    device_id TEXT,
    operation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (store_id, id),
    UNIQUE (store_id, id, measurement_type),
    UNIQUE (store_id, sku),
    UNIQUE (store_id, barcode),
    UNIQUE (store_id, operation_id),
    CHECK ((status = 'archived' AND archived_at IS NOT NULL) OR status = 'active'),
    FOREIGN KEY (store_id) REFERENCES stores(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_products_search
ON products (store_id, status, normalized_name, barcode, sku, is_pinned);

CREATE TABLE IF NOT EXISTS product_units (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    measurement_type TEXT NOT NULL
        CHECK (measurement_type IN ('count', 'weight', 'volume', 'length')),
    unit_name TEXT NOT NULL CHECK (length(trim(unit_name)) > 0),
    unit_code TEXT,
    is_base INTEGER NOT NULL DEFAULT 0 CHECK (is_base IN (0, 1)),
    -- factor_num / factor_den = عدد الوحدات الأساسية في هذه الوحدة.
    factor_num INTEGER NOT NULL CHECK (factor_num > 0),
    factor_den INTEGER NOT NULL DEFAULT 1 CHECK (factor_den > 0),
    sale_price_minor INTEGER CHECK (sale_price_minor IS NULL OR sale_price_minor >= 0),
    purchase_price_minor INTEGER CHECK (purchase_price_minor IS NULL OR purchase_price_minor >= 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    device_id TEXT,
    operation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (store_id, id),
    UNIQUE (store_id, product_id, id),
    UNIQUE (store_id, product_id, unit_name),
    UNIQUE (store_id, operation_id),
    CHECK ((is_base = 1 AND factor_num = 1 AND factor_den = 1) OR is_base = 0),
    FOREIGN KEY (store_id, product_id, measurement_type)
        REFERENCES products(store_id, id, measurement_type)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_one_base_unit
ON product_units (store_id, product_id)
WHERE is_base = 1 AND status = 'active';

-- =========================================================
-- 4. الحسابات والفترات والفئات
-- =========================================================

CREATE TABLE IF NOT EXISTS money_accounts (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    normalized_name TEXT NOT NULL CHECK (length(trim(normalized_name)) > 0),
    account_type TEXT NOT NULL CHECK (account_type IN ('cash', 'transfer', 'external_party')),
    availability TEXT NOT NULL DEFAULT 'available'
        CHECK (availability IN ('available', 'held_by_external_party')),
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    archived_at INTEGER,
    device_id TEXT,
    operation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (store_id, id),
    UNIQUE (store_id, normalized_name),
    UNIQUE (store_id, operation_id),
    CHECK ((status = 'archived' AND archived_at IS NOT NULL) OR status = 'active'),
    FOREIGN KEY (store_id) REFERENCES stores(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_store_single_cash_account
ON money_accounts (store_id)
WHERE account_type = 'cash' AND status = 'active';

CREATE TABLE IF NOT EXISTS accounting_periods (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    period_year INTEGER NOT NULL CHECK (period_year >= 2020),
    period_month INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
    starts_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closing', 'closed')),
    closed_at INTEGER,
    device_id TEXT,
    operation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (store_id, id),
    UNIQUE (store_id, period_year, period_month),
    UNIQUE (store_id, operation_id),
    CHECK (ends_at > starts_at),
    CHECK ((status = 'closed' AND closed_at IS NOT NULL) OR status IN ('open', 'closing')),
    FOREIGN KEY (store_id) REFERENCES stores(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS expense_categories (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    normalized_name TEXT NOT NULL CHECK (length(trim(normalized_name)) > 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    device_id TEXT,
    operation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (store_id, id),
    UNIQUE (store_id, normalized_name),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id) REFERENCES stores(id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;


-- =========================================================
-- 5. دفاتر الحركات الأساسية (مصدر الحقيقة)
-- =========================================================

CREATE TABLE IF NOT EXISTS money_movements (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    accounting_period_id TEXT NOT NULL,
    movement_type TEXT NOT NULL CHECK (movement_type IN (
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
    amount_delta_minor INTEGER NOT NULL CHECK (amount_delta_minor <> 0),
    reference_type TEXT NOT NULL,
    reference_id TEXT NOT NULL,
    transaction_group_id TEXT NOT NULL,
    transfer_group_id TEXT,
    counter_account_id TEXT,
    counterparty_name TEXT,
    external_reference TEXT,
    notes TEXT,
    occurred_at INTEGER NOT NULL,
    reversal_of_id TEXT,
    device_id TEXT,
    operation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (store_id, id),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, account_id)
        REFERENCES money_accounts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, counter_account_id)
        REFERENCES money_accounts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, reversal_of_id)
        REFERENCES money_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_money_movements_account_time
ON money_movements (store_id, account_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_money_movements_reference
ON money_movements (store_id, reference_type, reference_id);

CREATE TABLE IF NOT EXISTS customer_ledger_entries (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    accounting_period_id TEXT NOT NULL,
    entry_type TEXT NOT NULL CHECK (entry_type IN (
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
    receivable_delta_minor INTEGER NOT NULL DEFAULT 0,
    credit_delta_minor INTEGER NOT NULL DEFAULT 0,
    source_sale_id TEXT,
    reference_type TEXT NOT NULL,
    reference_id TEXT NOT NULL,
    transaction_group_id TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    reversal_of_id TEXT,
    reason TEXT,
    device_id TEXT,
    operation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    CHECK (receivable_delta_minor <> 0 OR credit_delta_minor <> 0),
    UNIQUE (store_id, id),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, customer_id)
        REFERENCES customers(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, source_sale_id)
        REFERENCES sales(store_id, id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (store_id, reversal_of_id)
        REFERENCES customer_ledger_entries(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_customer_ledger_customer_time
ON customer_ledger_entries (store_id, customer_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_customer_ledger_sale
ON customer_ledger_entries (store_id, source_sale_id, occurred_at);

CREATE TABLE IF NOT EXISTS supplier_ledger_entries (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    supplier_id TEXT NOT NULL,
    accounting_period_id TEXT NOT NULL,
    entry_type TEXT NOT NULL CHECK (entry_type IN (
        'goods_receipt',
        'payment',
        'return',
        'opening_balance',
        'credit_created',
        'credit_used',
        'refund',
        'correction'
    )),
    payable_delta_minor INTEGER NOT NULL DEFAULT 0,
    credit_delta_minor INTEGER NOT NULL DEFAULT 0,
    source_purchase_invoice_id TEXT,
    reference_type TEXT NOT NULL,
    reference_id TEXT NOT NULL,
    transaction_group_id TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    reversal_of_id TEXT,
    reason TEXT,
    device_id TEXT,
    operation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    CHECK (payable_delta_minor <> 0 OR credit_delta_minor <> 0),
    UNIQUE (store_id, id),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, supplier_id)
        REFERENCES suppliers(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, source_purchase_invoice_id)
        REFERENCES purchase_invoices(store_id, id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (store_id, reversal_of_id)
        REFERENCES supplier_ledger_entries(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_supplier_ledger_supplier_time
ON supplier_ledger_entries (store_id, supplier_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_supplier_ledger_purchase
ON supplier_ledger_entries (store_id, source_purchase_invoice_id, occurred_at);

CREATE TABLE IF NOT EXISTS owner_ledger_entries (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    accounting_period_id TEXT NOT NULL,
    entry_type TEXT NOT NULL CHECK (entry_type IN (
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
    owner_liability_delta_minor INTEGER NOT NULL DEFAULT 0,
    equity_delta_minor INTEGER NOT NULL DEFAULT 0,
    money_account_id TEXT,
    reference_type TEXT,
    reference_id TEXT,
    transaction_group_id TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    reversal_of_id TEXT,
    reason TEXT,
    device_id TEXT,
    operation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    CHECK (owner_liability_delta_minor <> 0 OR equity_delta_minor <> 0),
    UNIQUE (store_id, id),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, money_account_id)
        REFERENCES money_accounts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, reversal_of_id)
        REFERENCES owner_ledger_entries(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_owner_ledger_time
ON owner_ledger_entries (store_id, occurred_at);

CREATE TABLE IF NOT EXISTS stock_balances (
    store_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    quantity_milli INTEGER NOT NULL DEFAULT 0,
    average_unit_cost_minor INTEGER NOT NULL DEFAULT 0 CHECK (average_unit_cost_minor >= 0),
    inventory_value_minor INTEGER NOT NULL DEFAULT 0,
    has_pending_cost INTEGER NOT NULL DEFAULT 0 CHECK (has_pending_cost IN (0, 1)),
    last_movement_id TEXT,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    PRIMARY KEY (store_id, product_id),
    FOREIGN KEY (store_id, product_id)
        REFERENCES products(store_id, id) ON UPDATE CASCADE ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS inventory_movements (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    accounting_period_id TEXT NOT NULL,
    movement_type TEXT NOT NULL CHECK (movement_type IN (
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
    quantity_before_milli INTEGER NOT NULL,
    quantity_delta_milli INTEGER NOT NULL CHECK (quantity_delta_milli <> 0),
    quantity_after_milli INTEGER NOT NULL,
    inventory_value_before_minor INTEGER NOT NULL,
    value_delta_minor INTEGER NOT NULL,
    inventory_value_after_minor INTEGER NOT NULL,
    average_unit_cost_after_minor INTEGER NOT NULL CHECK (average_unit_cost_after_minor >= 0),
    cost_status TEXT NOT NULL CHECK (cost_status IN ('known', 'estimated', 'pending')),
    has_pending_cost_after INTEGER NOT NULL DEFAULT 0 CHECK (has_pending_cost_after IN (0, 1)),
    reference_type TEXT NOT NULL,
    reference_id TEXT NOT NULL,
    transaction_group_id TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    reversal_of_id TEXT,
    reason TEXT,
    device_id TEXT,
    operation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    CHECK (quantity_after_milli = quantity_before_milli + quantity_delta_milli),
    CHECK (inventory_value_after_minor = inventory_value_before_minor + value_delta_minor),
    CHECK (
        (quantity_after_milli = 0 AND inventory_value_after_minor = 0 AND average_unit_cost_after_minor = 0)
        OR quantity_after_milli <> 0
    ),
    UNIQUE (store_id, id),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, product_id)
        REFERENCES products(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, reversal_of_id)
        REFERENCES inventory_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_inventory_movements_product_time
ON inventory_movements (store_id, product_id, occurred_at);


-- =========================================================
-- 6. المبيعات والمدفوعات الأولية
-- =========================================================

CREATE TABLE IF NOT EXISTS sales (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    customer_id TEXT,
    accounting_period_id TEXT,
    display_number TEXT NOT NULL CHECK (length(trim(display_number)) > 0),
    sale_at INTEGER NOT NULL,
    items_subtotal_minor INTEGER NOT NULL DEFAULT 0 CHECK (items_subtotal_minor >= 0),
    line_discount_total_minor INTEGER NOT NULL DEFAULT 0 CHECK (line_discount_total_minor >= 0),
    invoice_discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (invoice_discount_minor >= 0),
    rounding_minor INTEGER NOT NULL DEFAULT 0 CHECK (rounding_minor BETWEEN -1 AND 1),
    total_minor INTEGER NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
    paid_total_minor INTEGER NOT NULL DEFAULT 0 CHECK (paid_total_minor >= 0),
    credit_total_minor INTEGER NOT NULL DEFAULT 0 CHECK (credit_total_minor >= 0),
    known_cost_total_minor INTEGER NOT NULL DEFAULT 0 CHECK (known_cost_total_minor >= 0),
    pending_cost_line_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_cost_line_count >= 0),
    unknown_cost_line_count INTEGER NOT NULL DEFAULT 0 CHECK (unknown_cost_line_count >= 0),
    payment_status TEXT NOT NULL DEFAULT 'paid'
        CHECK (payment_status IN ('paid', 'partial', 'credit')),
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'posted', 'cancelled', 'corrected')),
    notes TEXT,
    correction_of_id TEXT,
    reversed_by_id TEXT,
    cancelled_at INTEGER,
    device_id TEXT,
    operation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
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
    FOREIGN KEY (store_id) REFERENCES stores(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, customer_id)
        REFERENCES customers(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, correction_of_id)
        REFERENCES sales(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, reversed_by_id)
        REFERENCES sales(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_sales_customer_time
ON sales (store_id, customer_id, sale_at, status);

CREATE INDEX IF NOT EXISTS idx_sales_time
ON sales (store_id, sale_at, status);

CREATE TABLE IF NOT EXISTS sale_items (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    sale_id TEXT NOT NULL,
    product_id TEXT,
    product_unit_id TEXT,
    is_manual_line INTEGER NOT NULL DEFAULT 0 CHECK (is_manual_line IN (0, 1)),
    product_name_snapshot TEXT NOT NULL CHECK (length(trim(product_name_snapshot)) > 0),
    unit_name_snapshot TEXT,
    quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
    conversion_factor_num INTEGER NOT NULL CHECK (conversion_factor_num > 0),
    conversion_factor_den INTEGER NOT NULL CHECK (conversion_factor_den > 0),
    base_quantity_milli INTEGER,
    unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
    line_gross_minor INTEGER NOT NULL CHECK (line_gross_minor >= 0),
    line_discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (line_discount_minor >= 0),
    rounding_minor INTEGER NOT NULL DEFAULT 0 CHECK (rounding_minor BETWEEN -1 AND 1),
    line_total_minor INTEGER NOT NULL CHECK (line_total_minor >= 0),
    cost_status TEXT NOT NULL DEFAULT 'known'
        CHECK (cost_status IN ('known', 'estimated', 'pending', 'unknown')),
    unit_cost_minor INTEGER CHECK (unit_cost_minor IS NULL OR unit_cost_minor >= 0),
    line_cost_minor INTEGER CHECK (line_cost_minor IS NULL OR line_cost_minor >= 0),
    inventory_movement_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (line_total_minor = line_gross_minor - line_discount_minor + rounding_minor),
    CHECK (line_discount_minor <= line_gross_minor + rounding_minor),
    CHECK (
        (is_manual_line = 1
         AND product_id IS NULL
         AND product_unit_id IS NULL
         AND base_quantity_milli IS NULL
         AND cost_status = 'unknown'
         AND unit_cost_minor IS NULL
         AND line_cost_minor IS NULL)
        OR
        (is_manual_line = 0
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
        REFERENCES sales(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, product_id)
        REFERENCES products(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, product_id, product_unit_id)
        REFERENCES product_units(store_id, product_id, id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, inventory_movement_id)
        REFERENCES inventory_movements(store_id, id)
        ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_sale_items_sale
ON sale_items (store_id, sale_id);

CREATE TABLE IF NOT EXISTS sale_payments (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    sale_id TEXT NOT NULL,
    money_account_id TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    payment_at INTEGER NOT NULL,
    sender_account_name TEXT,
    external_reference TEXT,
    money_movement_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (store_id, id),
    UNIQUE (store_id, money_movement_id),
    FOREIGN KEY (store_id, sale_id)
        REFERENCES sales(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, money_account_id)
        REFERENCES money_accounts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, money_movement_id)
        REFERENCES money_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

-- =========================================================
-- 7. مشتريات المورد والاستلام
-- =========================================================

CREATE TABLE IF NOT EXISTS purchase_invoices (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    supplier_id TEXT NOT NULL,
    invoice_number TEXT,
    display_number TEXT NOT NULL CHECK (length(trim(display_number)) > 0),
    invoice_date_at INTEGER NOT NULL,
    due_at INTEGER,
    items_subtotal_minor INTEGER NOT NULL DEFAULT 0 CHECK (items_subtotal_minor >= 0),
    line_discount_total_minor INTEGER NOT NULL DEFAULT 0 CHECK (line_discount_total_minor >= 0),
    invoice_discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (invoice_discount_minor >= 0),
    rounding_minor INTEGER NOT NULL DEFAULT 0 CHECK (rounding_minor BETWEEN -1 AND 1),
    total_minor INTEGER NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'open', 'closed', 'cancelled')),
    notes TEXT,
    correction_of_id TEXT,
    cancelled_at INTEGER,
    device_id TEXT,
    operation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
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
        REFERENCES suppliers(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, correction_of_id)
        REFERENCES purchase_invoices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_purchase_invoices_supplier
ON purchase_invoices (store_id, supplier_id, invoice_date_at, status);

CREATE TABLE IF NOT EXISTS purchase_items (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    purchase_invoice_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    product_unit_id TEXT NOT NULL,
    product_name_snapshot TEXT NOT NULL,
    unit_name_snapshot TEXT NOT NULL,
    quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
    conversion_factor_num INTEGER NOT NULL CHECK (conversion_factor_num > 0),
    conversion_factor_den INTEGER NOT NULL CHECK (conversion_factor_den > 0),
    base_quantity_milli INTEGER NOT NULL CHECK (base_quantity_milli > 0),
    unit_cost_minor INTEGER NOT NULL CHECK (unit_cost_minor >= 0),
    line_gross_minor INTEGER NOT NULL CHECK (line_gross_minor >= 0),
    line_discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (line_discount_minor >= 0),
    rounding_minor INTEGER NOT NULL DEFAULT 0 CHECK (rounding_minor BETWEEN -1 AND 1),
    line_total_minor INTEGER NOT NULL CHECK (line_total_minor >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (
        base_quantity_milli * conversion_factor_den =
        quantity_milli * conversion_factor_num
    ),
    CHECK (line_total_minor = line_gross_minor - line_discount_minor + rounding_minor),
    CHECK (line_discount_minor <= line_gross_minor + rounding_minor),
    UNIQUE (store_id, id),
    FOREIGN KEY (store_id, purchase_invoice_id)
        REFERENCES purchase_invoices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, product_id)
        REFERENCES products(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, product_id, product_unit_id)
        REFERENCES product_units(store_id, product_id, id)
        ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_purchase_items_invoice
ON purchase_items (store_id, purchase_invoice_id);

CREATE TABLE IF NOT EXISTS goods_receipts (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    supplier_id TEXT NOT NULL,
    purchase_invoice_id TEXT,
    accounting_period_id TEXT,
    display_number TEXT NOT NULL CHECK (length(trim(display_number)) > 0),
    received_at INTEGER NOT NULL,
    total_cost_minor INTEGER NOT NULL DEFAULT 0 CHECK (total_cost_minor >= 0),
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'posted', 'cancelled')),
    notes TEXT,
    reversal_of_id TEXT,
    reversed_by_id TEXT,
    cancelled_at INTEGER,
    device_id TEXT,
    operation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK ((status = 'cancelled' AND cancelled_at IS NOT NULL) OR status <> 'cancelled'),
    UNIQUE (store_id, id),
    UNIQUE (store_id, display_number),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, supplier_id)
        REFERENCES suppliers(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, purchase_invoice_id)
        REFERENCES purchase_invoices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, reversal_of_id)
        REFERENCES goods_receipts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, reversed_by_id)
        REFERENCES goods_receipts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS goods_receipt_items (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    goods_receipt_id TEXT NOT NULL,
    purchase_item_id TEXT,
    product_id TEXT NOT NULL,
    product_unit_id TEXT NOT NULL,
    product_name_snapshot TEXT NOT NULL,
    unit_name_snapshot TEXT NOT NULL,
    quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
    conversion_factor_num INTEGER NOT NULL CHECK (conversion_factor_num > 0),
    conversion_factor_den INTEGER NOT NULL CHECK (conversion_factor_den > 0),
    base_quantity_milli INTEGER NOT NULL CHECK (base_quantity_milli > 0),
    unit_cost_minor INTEGER NOT NULL CHECK (unit_cost_minor >= 0),
    line_total_minor INTEGER NOT NULL CHECK (line_total_minor >= 0),
    inventory_movement_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (
        base_quantity_milli * conversion_factor_den =
        quantity_milli * conversion_factor_num
    ),
    UNIQUE (store_id, id),
    UNIQUE (store_id, inventory_movement_id),
    FOREIGN KEY (store_id, goods_receipt_id)
        REFERENCES goods_receipts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, purchase_item_id)
        REFERENCES purchase_items(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, product_id)
        REFERENCES products(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, product_id, product_unit_id)
        REFERENCES product_units(store_id, product_id, id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, inventory_movement_id)
        REFERENCES inventory_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_goods_receipt_items_receipt
ON goods_receipt_items (store_id, goods_receipt_id);


-- =========================================================
-- 8. تحصيل العملاء وسداد الموردين
-- =========================================================

CREATE TABLE IF NOT EXISTS customer_payments (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    accounting_period_id TEXT,
    money_account_id TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    allocated_total_minor INTEGER NOT NULL DEFAULT 0 CHECK (allocated_total_minor >= 0),
    credit_created_minor INTEGER NOT NULL DEFAULT 0 CHECK (credit_created_minor >= 0),
    payment_at INTEGER NOT NULL,
    sender_account_name TEXT,
    external_reference TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'posted', 'cancelled')),
    money_movement_id TEXT,
    cancelled_at INTEGER,
    device_id TEXT,
    operation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (
        status <> 'posted'
        OR allocated_total_minor + credit_created_minor = amount_minor
    ),
    CHECK ((status = 'cancelled' AND cancelled_at IS NOT NULL) OR status <> 'cancelled'),
    UNIQUE (store_id, id),
    UNIQUE (store_id, money_movement_id),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, customer_id)
        REFERENCES customers(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, money_account_id)
        REFERENCES money_accounts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, money_movement_id)
        REFERENCES money_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS customer_payment_allocations (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    customer_payment_id TEXT NOT NULL,
    sale_id TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    customer_ledger_entry_id TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (store_id, id),
    UNIQUE (store_id, customer_ledger_entry_id),
    UNIQUE (customer_payment_id, sale_id),
    FOREIGN KEY (store_id, customer_payment_id)
        REFERENCES customer_payments(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, sale_id)
        REFERENCES sales(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, customer_ledger_entry_id)
        REFERENCES customer_ledger_entries(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS supplier_payments (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    supplier_id TEXT NOT NULL,
    accounting_period_id TEXT,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    allocated_total_minor INTEGER NOT NULL DEFAULT 0 CHECK (allocated_total_minor >= 0),
    credit_created_minor INTEGER NOT NULL DEFAULT 0 CHECK (credit_created_minor >= 0),
    payment_source TEXT NOT NULL CHECK (payment_source IN ('money_account', 'owner_pocket')),
    money_account_id TEXT,
    money_movement_id TEXT,
    owner_ledger_entry_id TEXT,
    payment_at INTEGER NOT NULL,
    external_reference TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'posted', 'cancelled')),
    cancelled_at INTEGER,
    device_id TEXT,
    operation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
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
        REFERENCES suppliers(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, money_account_id)
        REFERENCES money_accounts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, money_movement_id)
        REFERENCES money_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, owner_ledger_entry_id)
        REFERENCES owner_ledger_entries(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS supplier_payment_allocations (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    supplier_payment_id TEXT NOT NULL,
    purchase_invoice_id TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    supplier_ledger_entry_id TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (store_id, id),
    UNIQUE (store_id, supplier_ledger_entry_id),
    UNIQUE (supplier_payment_id, purchase_invoice_id),
    FOREIGN KEY (store_id, supplier_payment_id)
        REFERENCES supplier_payments(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, purchase_invoice_id)
        REFERENCES purchase_invoices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, supplier_ledger_entry_id)
        REFERENCES supplier_ledger_entries(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

-- =========================================================
-- 9. المصاريف والمدفوعات
-- =========================================================

CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    category_id TEXT,
    accounting_period_id TEXT,
    description TEXT NOT NULL CHECK (length(trim(description)) > 0),
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    paid_total_minor INTEGER NOT NULL DEFAULT 0 CHECK (paid_total_minor >= 0),
    expense_at INTEGER NOT NULL,
    due_at INTEGER,
    payment_timing TEXT NOT NULL CHECK (payment_timing IN ('paid_now', 'due_later')),
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'posted', 'cancelled')),
    notes TEXT,
    cancelled_at INTEGER,
    device_id TEXT,
    operation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
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
        REFERENCES expense_categories(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS expense_payments (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    expense_id TEXT NOT NULL,
    accounting_period_id TEXT,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    payment_source TEXT NOT NULL CHECK (payment_source IN ('money_account', 'owner_pocket')),
    money_account_id TEXT,
    money_movement_id TEXT,
    owner_ledger_entry_id TEXT,
    payment_at INTEGER NOT NULL,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'posted', 'cancelled')),
    cancelled_at INTEGER,
    device_id TEXT,
    operation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
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
        REFERENCES expenses(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, money_account_id)
        REFERENCES money_accounts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, money_movement_id)
        REFERENCES money_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, owner_ledger_entry_id)
        REFERENCES owner_ledger_entries(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

-- =========================================================
-- 10. التحويل بين الحسابات
-- =========================================================

CREATE TABLE IF NOT EXISTS money_transfers (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    accounting_period_id TEXT,
    display_number TEXT NOT NULL,
    source_account_id TEXT NOT NULL,
    destination_account_id TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    transfer_at INTEGER NOT NULL,
    source_movement_id TEXT,
    destination_movement_id TEXT,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'posted', 'cancelled')),
    notes TEXT,
    cancelled_at INTEGER,
    device_id TEXT,
    operation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (source_account_id <> destination_account_id),
    CHECK ((status = 'cancelled' AND cancelled_at IS NOT NULL) OR status <> 'cancelled'),
    UNIQUE (store_id, id),
    UNIQUE (store_id, display_number),
    UNIQUE (store_id, source_movement_id),
    UNIQUE (store_id, destination_movement_id),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, source_account_id)
        REFERENCES money_accounts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, destination_account_id)
        REFERENCES money_accounts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, source_movement_id)
        REFERENCES money_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, destination_movement_id)
        REFERENCES money_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;


-- =========================================================
-- 11. مرتجعات العملاء
-- =========================================================

CREATE TABLE IF NOT EXISTS sale_returns (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    sale_id TEXT NOT NULL,
    customer_id TEXT,
    accounting_period_id TEXT,
    display_number TEXT NOT NULL,
    return_at INTEGER NOT NULL,
    total_minor INTEGER NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'posted', 'cancelled')),
    notes TEXT,
    cancelled_at INTEGER,
    device_id TEXT,
    operation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK ((status = 'cancelled' AND cancelled_at IS NOT NULL) OR status <> 'cancelled'),
    UNIQUE (store_id, id),
    UNIQUE (store_id, display_number),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, sale_id)
        REFERENCES sales(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, customer_id)
        REFERENCES customers(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS sale_return_items (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    sale_return_id TEXT NOT NULL,
    sale_item_id TEXT NOT NULL,
    quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
    base_quantity_milli INTEGER,
    line_refund_minor INTEGER NOT NULL CHECK (line_refund_minor >= 0),
    item_condition TEXT NOT NULL CHECK (item_condition IN ('saleable', 'damaged')),
    inventory_movement_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (store_id, id),
    UNIQUE (store_id, inventory_movement_id),
    FOREIGN KEY (store_id, sale_return_id)
        REFERENCES sale_returns(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, sale_item_id)
        REFERENCES sale_items(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, inventory_movement_id)
        REFERENCES inventory_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS sale_return_settlements (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    sale_return_id TEXT NOT NULL,
    settlement_type TEXT NOT NULL
        CHECK (settlement_type IN ('reduce_receivable', 'customer_credit', 'money_refund')),
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    money_account_id TEXT,
    money_movement_id TEXT,
    customer_ledger_entry_id TEXT,
    created_at INTEGER NOT NULL,
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
        REFERENCES sale_returns(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, money_account_id)
        REFERENCES money_accounts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, money_movement_id)
        REFERENCES money_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, customer_ledger_entry_id)
        REFERENCES customer_ledger_entries(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

-- =========================================================
-- 12. مرتجعات الموردين
-- =========================================================

CREATE TABLE IF NOT EXISTS supplier_returns (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    supplier_id TEXT NOT NULL,
    purchase_invoice_id TEXT,
    accounting_period_id TEXT,
    display_number TEXT NOT NULL,
    return_at INTEGER NOT NULL,
    total_minor INTEGER NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'posted', 'cancelled')),
    notes TEXT,
    cancelled_at INTEGER,
    device_id TEXT,
    operation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK ((status = 'cancelled' AND cancelled_at IS NOT NULL) OR status <> 'cancelled'),
    UNIQUE (store_id, id),
    UNIQUE (store_id, display_number),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, supplier_id)
        REFERENCES suppliers(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, purchase_invoice_id)
        REFERENCES purchase_invoices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS supplier_return_items (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    supplier_return_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    product_unit_id TEXT NOT NULL,
    quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
    conversion_factor_num INTEGER NOT NULL CHECK (conversion_factor_num > 0),
    conversion_factor_den INTEGER NOT NULL CHECK (conversion_factor_den > 0),
    base_quantity_milli INTEGER NOT NULL CHECK (base_quantity_milli > 0),
    unit_cost_minor INTEGER NOT NULL CHECK (unit_cost_minor >= 0),
    line_total_minor INTEGER NOT NULL CHECK (line_total_minor >= 0),
    inventory_movement_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (
        base_quantity_milli * conversion_factor_den =
        quantity_milli * conversion_factor_num
    ),
    UNIQUE (store_id, id),
    UNIQUE (store_id, inventory_movement_id),
    FOREIGN KEY (store_id, supplier_return_id)
        REFERENCES supplier_returns(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, product_id)
        REFERENCES products(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, product_id, product_unit_id)
        REFERENCES product_units(store_id, product_id, id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, inventory_movement_id)
        REFERENCES inventory_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS supplier_return_settlements (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    supplier_return_id TEXT NOT NULL,
    settlement_type TEXT NOT NULL
        CHECK (settlement_type IN ('reduce_payable', 'supplier_credit', 'money_refund_received')),
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    money_account_id TEXT,
    money_movement_id TEXT,
    supplier_ledger_entry_id TEXT,
    created_at INTEGER NOT NULL,
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
        REFERENCES supplier_returns(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, money_account_id)
        REFERENCES money_accounts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, money_movement_id)
        REFERENCES money_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, supplier_ledger_entry_id)
        REFERENCES supplier_ledger_entries(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

-- =========================================================
-- 13. الجرد
-- =========================================================

CREATE TABLE IF NOT EXISTS stock_counts (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    accounting_period_id TEXT,
    display_number TEXT NOT NULL,
    count_type TEXT NOT NULL CHECK (count_type IN ('full', 'partial')),
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'counting', 'posted', 'cancelled')),
    notes TEXT,
    cancelled_at INTEGER,
    device_id TEXT,
    operation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK ((status = 'posted' AND completed_at IS NOT NULL) OR status <> 'posted'),
    CHECK ((status = 'cancelled' AND cancelled_at IS NOT NULL) OR status <> 'cancelled'),
    UNIQUE (store_id, id),
    UNIQUE (store_id, display_number),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS stock_count_items (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    stock_count_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    system_quantity_milli INTEGER NOT NULL,
    actual_quantity_milli INTEGER NOT NULL,
    difference_milli INTEGER NOT NULL,
    adjustment_movement_id TEXT,
    reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (difference_milli = actual_quantity_milli - system_quantity_milli),
    UNIQUE (store_id, id),
    UNIQUE (stock_count_id, product_id),
    UNIQUE (store_id, adjustment_movement_id),
    FOREIGN KEY (store_id, stock_count_id)
        REFERENCES stock_counts(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, product_id)
        REFERENCES products(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, adjustment_movement_id)
        REFERENCES inventory_movements(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;


-- =========================================================
-- 14. التنبيهات والتدقيق والنسخ
-- =========================================================

CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    notification_key TEXT NOT NULL,
    notification_type TEXT NOT NULL CHECK (notification_type IN (
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
    severity TEXT NOT NULL DEFAULT 'info'
        CHECK (severity IN ('info', 'warning', 'critical')),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    status TEXT NOT NULL DEFAULT 'unread'
        CHECK (status IN ('unread', 'read', 'resolved', 'dismissed', 'snoozed')),
    snoozed_until INTEGER,
    resolved_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (store_id, id),
    UNIQUE (store_id, notification_key),
    FOREIGN KEY (store_id) REFERENCES stores(id) ON UPDATE CASCADE ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_notifications_status
ON notifications (store_id, status, severity, created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    device_id TEXT,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('owner', 'system', 'admin', 'sync')),
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    old_values_json TEXT CHECK (old_values_json IS NULL OR json_valid(old_values_json)),
    new_values_json TEXT CHECK (new_values_json IS NULL OR json_valid(new_values_json)),
    reason TEXT,
    operation_id TEXT,
    occurred_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (store_id, id),
    FOREIGN KEY (store_id) REFERENCES stores(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_audit_entity
ON audit_logs (store_id, entity_type, entity_id, occurred_at);

CREATE TABLE IF NOT EXISTS backup_metadata (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    device_id TEXT,
    backup_type TEXT NOT NULL CHECK (backup_type IN ('local_file', 'cloud_file', 'server_snapshot')),
    local_uri TEXT,
    remote_key TEXT,
    schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
    file_size_bytes INTEGER CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
    checksum_sha256 TEXT NOT NULL,
    encryption_version TEXT,
    status TEXT NOT NULL CHECK (status IN ('creating', 'ready', 'uploaded', 'failed', 'deleted')),
    created_at INTEGER NOT NULL,
    uploaded_at INTEGER,
    last_verified_at INTEGER,
    error_message TEXT,
    UNIQUE (store_id, id),
    FOREIGN KEY (store_id) REFERENCES stores(id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

-- =========================================================
-- 15. Views: الأرصدة والحالة المشتقة
-- =========================================================

CREATE VIEW IF NOT EXISTS v_money_account_balances AS
SELECT
    a.store_id,
    a.id AS account_id,
    a.name,
    a.account_type,
    a.availability,
    COALESCE(SUM(m.amount_delta_minor), 0) AS balance_minor
FROM money_accounts a
LEFT JOIN money_movements m
    ON m.store_id = a.store_id
   AND m.account_id = a.id
GROUP BY a.store_id, a.id, a.name, a.account_type, a.availability;

CREATE VIEW IF NOT EXISTS v_customer_balances AS
SELECT
    c.store_id,
    c.id AS customer_id,
    c.name,
    COALESCE(SUM(l.receivable_delta_minor), 0) AS receivable_minor,
    COALESCE(SUM(l.credit_delta_minor), 0) AS credit_minor,
    COALESCE(SUM(l.receivable_delta_minor), 0)
      - COALESCE(SUM(l.credit_delta_minor), 0) AS net_due_minor
FROM customers c
LEFT JOIN customer_ledger_entries l
    ON l.store_id = c.store_id
   AND l.customer_id = c.id
GROUP BY c.store_id, c.id, c.name;

CREATE VIEW IF NOT EXISTS v_customer_invoice_outstanding AS
SELECT
    s.store_id,
    s.id AS sale_id,
    s.customer_id,
    s.display_number,
    s.sale_at,
    s.credit_total_minor AS original_credit_minor,
    COALESCE(SUM(l.receivable_delta_minor), 0) AS outstanding_minor
FROM sales s
LEFT JOIN customer_ledger_entries l
    ON l.store_id = s.store_id
   AND l.source_sale_id = s.id
WHERE s.customer_id IS NOT NULL
GROUP BY s.store_id, s.id, s.customer_id, s.display_number, s.sale_at, s.credit_total_minor;

CREATE VIEW IF NOT EXISTS v_supplier_balances AS
SELECT
    s.store_id,
    s.id AS supplier_id,
    s.name,
    COALESCE(SUM(l.payable_delta_minor), 0) AS payable_minor,
    COALESCE(SUM(l.credit_delta_minor), 0) AS credit_minor,
    COALESCE(SUM(l.payable_delta_minor), 0)
      - COALESCE(SUM(l.credit_delta_minor), 0) AS net_payable_minor
FROM suppliers s
LEFT JOIN supplier_ledger_entries l
    ON l.store_id = s.store_id
   AND l.supplier_id = s.id
GROUP BY s.store_id, s.id, s.name;

CREATE VIEW IF NOT EXISTS v_supplier_invoice_outstanding AS
SELECT
    p.store_id,
    p.id AS purchase_invoice_id,
    p.supplier_id,
    p.display_number,
    p.invoice_date_at,
    COALESCE(SUM(l.payable_delta_minor), 0) AS outstanding_minor
FROM purchase_invoices p
LEFT JOIN supplier_ledger_entries l
    ON l.store_id = p.store_id
   AND l.source_purchase_invoice_id = p.id
GROUP BY p.store_id, p.id, p.supplier_id, p.display_number, p.invoice_date_at;

CREATE VIEW IF NOT EXISTS v_expense_balances AS
SELECT
    e.store_id,
    e.id AS expense_id,
    e.description,
    e.amount_minor,
    COALESCE(SUM(CASE WHEN ep.status = 'posted' THEN ep.amount_minor ELSE 0 END), 0) AS paid_minor,
    e.amount_minor
      - COALESCE(SUM(CASE WHEN ep.status = 'posted' THEN ep.amount_minor ELSE 0 END), 0)
      AS due_minor
FROM expenses e
LEFT JOIN expense_payments ep
    ON ep.store_id = e.store_id
   AND ep.expense_id = e.id
WHERE e.status = 'posted'
GROUP BY e.store_id, e.id, e.description, e.amount_minor;

CREATE VIEW IF NOT EXISTS v_owner_position AS
SELECT
    store_id,
    COALESCE(SUM(owner_liability_delta_minor), 0) AS store_owes_owner_minor,
    COALESCE(SUM(equity_delta_minor), 0) AS owner_equity_movement_minor
FROM owner_ledger_entries
GROUP BY store_id;

CREATE VIEW IF NOT EXISTS v_purchase_receipt_progress AS
SELECT
    pi.store_id,
    pi.id AS purchase_invoice_id,
    pi.display_number,
    pi.supplier_id,
    COALESCE(SUM(pit.base_quantity_milli), 0) AS ordered_base_quantity_milli,
    COALESCE((
        SELECT SUM(gri.base_quantity_milli)
        FROM goods_receipt_items gri
        JOIN goods_receipts gr
          ON gr.store_id = gri.store_id
         AND gr.id = gri.goods_receipt_id
        WHERE gr.store_id = pi.store_id
          AND gr.purchase_invoice_id = pi.id
          AND gr.status = 'posted'
    ), 0) AS received_base_quantity_milli
FROM purchase_invoices pi
LEFT JOIN purchase_items pit
  ON pit.store_id = pi.store_id
 AND pit.purchase_invoice_id = pi.id
GROUP BY pi.store_id, pi.id, pi.display_number, pi.supplier_id;


-- =========================================================
-- 16. Triggers: حماية الفترات والحركات غير القابلة للتعديل
-- =========================================================

-- كل حركة محاسبية/مالية/مخزنية يجب أن تقع داخل فترة مفتوحة مطابقة لتاريخها.
CREATE TRIGGER IF NOT EXISTS trg_money_movement_period_open
BEFORE INSERT ON money_movements
BEGIN
    SELECT RAISE(ABORT, 'MONEY_MOVEMENT_PERIOD_NOT_OPEN')
    WHERE NOT EXISTS (
        SELECT 1
        FROM accounting_periods p
        WHERE p.store_id = NEW.store_id
          AND p.id = NEW.accounting_period_id
          AND p.status = 'open'
          AND NEW.occurred_at >= p.starts_at
          AND NEW.occurred_at < p.ends_at
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_customer_ledger_period_open
BEFORE INSERT ON customer_ledger_entries
BEGIN
    SELECT RAISE(ABORT, 'CUSTOMER_LEDGER_PERIOD_NOT_OPEN')
    WHERE NOT EXISTS (
        SELECT 1
        FROM accounting_periods p
        WHERE p.store_id = NEW.store_id
          AND p.id = NEW.accounting_period_id
          AND p.status = 'open'
          AND NEW.occurred_at >= p.starts_at
          AND NEW.occurred_at < p.ends_at
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_ledger_period_open
BEFORE INSERT ON supplier_ledger_entries
BEGIN
    SELECT RAISE(ABORT, 'SUPPLIER_LEDGER_PERIOD_NOT_OPEN')
    WHERE NOT EXISTS (
        SELECT 1
        FROM accounting_periods p
        WHERE p.store_id = NEW.store_id
          AND p.id = NEW.accounting_period_id
          AND p.status = 'open'
          AND NEW.occurred_at >= p.starts_at
          AND NEW.occurred_at < p.ends_at
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_owner_ledger_period_open
BEFORE INSERT ON owner_ledger_entries
BEGIN
    SELECT RAISE(ABORT, 'OWNER_LEDGER_PERIOD_NOT_OPEN')
    WHERE NOT EXISTS (
        SELECT 1
        FROM accounting_periods p
        WHERE p.store_id = NEW.store_id
          AND p.id = NEW.accounting_period_id
          AND p.status = 'open'
          AND NEW.occurred_at >= p.starts_at
          AND NEW.occurred_at < p.ends_at
    );
END;

-- الحركات الأساسية Append-only.
CREATE TRIGGER IF NOT EXISTS trg_money_movements_no_update
BEFORE UPDATE ON money_movements
BEGIN
    SELECT RAISE(ABORT, 'MONEY_MOVEMENTS_ARE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_money_movements_no_delete
BEFORE DELETE ON money_movements
BEGIN
    SELECT RAISE(ABORT, 'MONEY_MOVEMENTS_CANNOT_BE_DELETED');
END;

CREATE TRIGGER IF NOT EXISTS trg_customer_ledger_no_update
BEFORE UPDATE ON customer_ledger_entries
BEGIN
    SELECT RAISE(ABORT, 'CUSTOMER_LEDGER_IS_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_customer_ledger_no_delete
BEFORE DELETE ON customer_ledger_entries
BEGIN
    SELECT RAISE(ABORT, 'CUSTOMER_LEDGER_CANNOT_BE_DELETED');
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_ledger_no_update
BEFORE UPDATE ON supplier_ledger_entries
BEGIN
    SELECT RAISE(ABORT, 'SUPPLIER_LEDGER_IS_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_ledger_no_delete
BEFORE DELETE ON supplier_ledger_entries
BEGIN
    SELECT RAISE(ABORT, 'SUPPLIER_LEDGER_CANNOT_BE_DELETED');
END;

CREATE TRIGGER IF NOT EXISTS trg_owner_ledger_no_update
BEFORE UPDATE ON owner_ledger_entries
BEGIN
    SELECT RAISE(ABORT, 'OWNER_LEDGER_IS_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_owner_ledger_no_delete
BEFORE DELETE ON owner_ledger_entries
BEGIN
    SELECT RAISE(ABORT, 'OWNER_LEDGER_CANNOT_BE_DELETED');
END;

CREATE TRIGGER IF NOT EXISTS trg_inventory_movements_no_update
BEFORE UPDATE ON inventory_movements
BEGIN
    SELECT RAISE(ABORT, 'INVENTORY_MOVEMENTS_ARE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_inventory_movements_no_delete
BEFORE DELETE ON inventory_movements
BEGIN
    SELECT RAISE(ABORT, 'INVENTORY_MOVEMENTS_CANNOT_BE_DELETED');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_update
BEFORE UPDATE ON audit_logs
BEGIN
    SELECT RAISE(ABORT, 'AUDIT_LOGS_ARE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_delete
BEFORE DELETE ON audit_logs
BEGIN
    SELECT RAISE(ABORT, 'AUDIT_LOGS_CANNOT_BE_DELETED');
END;


-- =========================================================
-- 17. Triggers: المخزون وتحديث الرصيد المخبأ
-- =========================================================

CREATE TRIGGER IF NOT EXISTS trg_inventory_movement_validate
BEFORE INSERT ON inventory_movements
BEGIN
    SELECT RAISE(ABORT, 'INVENTORY_PERIOD_NOT_OPEN')
    WHERE NOT EXISTS (
        SELECT 1
        FROM accounting_periods p
        WHERE p.store_id = NEW.store_id
          AND p.id = NEW.accounting_period_id
          AND p.status = 'open'
          AND NEW.occurred_at >= p.starts_at
          AND NEW.occurred_at < p.ends_at
    );

    SELECT RAISE(ABORT, 'PRODUCT_NOT_TRACKED_IN_INVENTORY')
    WHERE NOT EXISTS (
        SELECT 1
        FROM products pr
        WHERE pr.store_id = NEW.store_id
          AND pr.id = NEW.product_id
          AND pr.track_inventory = 1
          AND pr.status = 'active'
    );

    SELECT RAISE(ABORT, 'INVENTORY_QUANTITY_BEFORE_MISMATCH')
    WHERE NEW.quantity_before_milli <>
        COALESCE((
            SELECT sb.quantity_milli
            FROM stock_balances sb
            WHERE sb.store_id = NEW.store_id
              AND sb.product_id = NEW.product_id
        ), 0);

    SELECT RAISE(ABORT, 'INVENTORY_VALUE_BEFORE_MISMATCH')
    WHERE NEW.inventory_value_before_minor <>
        COALESCE((
            SELECT sb.inventory_value_minor
            FROM stock_balances sb
            WHERE sb.store_id = NEW.store_id
              AND sb.product_id = NEW.product_id
        ), 0);

    SELECT RAISE(ABORT, 'NEGATIVE_STOCK_NOT_ALLOWED')
    WHERE NEW.quantity_after_milli < 0
      AND COALESCE(
          (
            SELECT pr.allow_negative_stock_override
            FROM products pr
            WHERE pr.store_id = NEW.store_id
              AND pr.id = NEW.product_id
          ),
          (
            SELECT st.allow_negative_stock
            FROM app_settings st
            WHERE st.store_id = NEW.store_id
          ),
          0
      ) = 0;

    SELECT RAISE(ABORT, 'INVENTORY_AVERAGE_COST_INCONSISTENT')
    WHERE NEW.quantity_after_milli > 0
      AND NEW.has_pending_cost_after = 0
      AND ABS(
          NEW.inventory_value_after_minor * 1000
          - NEW.average_unit_cost_after_minor * NEW.quantity_after_milli
      ) > MAX(1000, ABS(NEW.quantity_after_milli));
END;

CREATE TRIGGER IF NOT EXISTS trg_inventory_movement_apply_balance
AFTER INSERT ON inventory_movements
BEGIN
    INSERT INTO stock_balances (
        store_id,
        product_id,
        quantity_milli,
        average_unit_cost_minor,
        inventory_value_minor,
        has_pending_cost,
        last_movement_id,
        updated_at,
        version
    )
    VALUES (
        NEW.store_id,
        NEW.product_id,
        NEW.quantity_after_milli,
        NEW.average_unit_cost_after_minor,
        NEW.inventory_value_after_minor,
        NEW.has_pending_cost_after,
        NEW.id,
        NEW.occurred_at,
        1
    )
    ON CONFLICT(store_id, product_id) DO UPDATE SET
        quantity_milli = excluded.quantity_milli,
        average_unit_cost_minor = excluded.average_unit_cost_minor,
        inventory_value_minor = excluded.inventory_value_minor,
        has_pending_cost = excluded.has_pending_cost,
        last_movement_id = excluded.last_movement_id,
        updated_at = excluded.updated_at,
        version = stock_balances.version + 1;
END;


-- =========================================================
-- 18. Triggers: حماية المستندات وبنودها بعد الاعتماد
-- =========================================================

CREATE TRIGGER IF NOT EXISTS trg_sale_items_insert_draft_only
BEFORE INSERT ON sale_items
BEGIN
    SELECT RAISE(ABORT, 'SALE_ITEMS_REQUIRE_DRAFT_SALE')
    WHERE NOT EXISTS (
        SELECT 1 FROM sales s
        WHERE s.store_id = NEW.store_id
          AND s.id = NEW.sale_id
          AND s.status = 'draft'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_items_update_draft_only
BEFORE UPDATE ON sale_items
BEGIN
    SELECT RAISE(ABORT, 'POSTED_SALE_ITEMS_ARE_IMMUTABLE')
    WHERE NOT EXISTS (
        SELECT 1 FROM sales s
        WHERE s.store_id = OLD.store_id
          AND s.id = OLD.sale_id
          AND s.status = 'draft'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_items_delete_draft_only
BEFORE DELETE ON sale_items
BEGIN
    SELECT RAISE(ABORT, 'POSTED_SALE_ITEMS_CANNOT_BE_DELETED')
    WHERE NOT EXISTS (
        SELECT 1 FROM sales s
        WHERE s.store_id = OLD.store_id
          AND s.id = OLD.sale_id
          AND s.status = 'draft'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_payments_insert_draft_only
BEFORE INSERT ON sale_payments
BEGIN
    SELECT RAISE(ABORT, 'SALE_PAYMENTS_REQUIRE_DRAFT_SALE')
    WHERE NOT EXISTS (
        SELECT 1 FROM sales s
        WHERE s.store_id = NEW.store_id
          AND s.id = NEW.sale_id
          AND s.status = 'draft'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_payments_update_draft_only
BEFORE UPDATE ON sale_payments
BEGIN
    SELECT RAISE(ABORT, 'POSTED_SALE_PAYMENTS_ARE_IMMUTABLE')
    WHERE NOT EXISTS (
        SELECT 1 FROM sales s
        WHERE s.store_id = OLD.store_id
          AND s.id = OLD.sale_id
          AND s.status = 'draft'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_payments_delete_draft_only
BEFORE DELETE ON sale_payments
BEGIN
    SELECT RAISE(ABORT, 'POSTED_SALE_PAYMENTS_CANNOT_BE_DELETED')
    WHERE NOT EXISTS (
        SELECT 1 FROM sales s
        WHERE s.store_id = OLD.store_id
          AND s.id = OLD.sale_id
          AND s.status = 'draft'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_purchase_items_insert_draft_only
BEFORE INSERT ON purchase_items
BEGIN
    SELECT RAISE(ABORT, 'PURCHASE_ITEMS_REQUIRE_DRAFT_INVOICE')
    WHERE NOT EXISTS (
        SELECT 1 FROM purchase_invoices p
        WHERE p.store_id = NEW.store_id
          AND p.id = NEW.purchase_invoice_id
          AND p.status = 'draft'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_purchase_items_update_draft_only
BEFORE UPDATE ON purchase_items
BEGIN
    SELECT RAISE(ABORT, 'FINAL_PURCHASE_ITEMS_ARE_IMMUTABLE')
    WHERE NOT EXISTS (
        SELECT 1 FROM purchase_invoices p
        WHERE p.store_id = OLD.store_id
          AND p.id = OLD.purchase_invoice_id
          AND p.status = 'draft'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_purchase_items_delete_draft_only
BEFORE DELETE ON purchase_items
BEGIN
    SELECT RAISE(ABORT, 'FINAL_PURCHASE_ITEMS_CANNOT_BE_DELETED')
    WHERE NOT EXISTS (
        SELECT 1 FROM purchase_invoices p
        WHERE p.store_id = OLD.store_id
          AND p.id = OLD.purchase_invoice_id
          AND p.status = 'draft'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_goods_receipt_items_insert_draft_only
BEFORE INSERT ON goods_receipt_items
BEGIN
    SELECT RAISE(ABORT, 'RECEIPT_ITEMS_REQUIRE_DRAFT_RECEIPT')
    WHERE NOT EXISTS (
        SELECT 1 FROM goods_receipts g
        WHERE g.store_id = NEW.store_id
          AND g.id = NEW.goods_receipt_id
          AND g.status = 'draft'
    );

    SELECT RAISE(ABORT, 'RECEIPT_PURCHASE_ITEM_PRODUCT_MISMATCH')
    WHERE NEW.purchase_item_id IS NOT NULL
      AND NOT EXISTS (
          SELECT 1
          FROM purchase_items pi
          WHERE pi.store_id = NEW.store_id
            AND pi.id = NEW.purchase_item_id
            AND pi.product_id = NEW.product_id
            AND pi.product_unit_id = NEW.product_unit_id
      );
END;

CREATE TRIGGER IF NOT EXISTS trg_goods_receipt_items_update_draft_only
BEFORE UPDATE ON goods_receipt_items
BEGIN
    SELECT RAISE(ABORT, 'POSTED_RECEIPT_ITEMS_ARE_IMMUTABLE')
    WHERE NOT EXISTS (
        SELECT 1 FROM goods_receipts g
        WHERE g.store_id = OLD.store_id
          AND g.id = OLD.goods_receipt_id
          AND g.status = 'draft'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_goods_receipt_items_delete_draft_only
BEFORE DELETE ON goods_receipt_items
BEGIN
    SELECT RAISE(ABORT, 'POSTED_RECEIPT_ITEMS_CANNOT_BE_DELETED')
    WHERE NOT EXISTS (
        SELECT 1 FROM goods_receipts g
        WHERE g.store_id = OLD.store_id
          AND g.id = OLD.goods_receipt_id
          AND g.status = 'draft'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_customer_allocations_draft_only_insert
BEFORE INSERT ON customer_payment_allocations
BEGIN
    SELECT RAISE(ABORT, 'CUSTOMER_ALLOCATION_REQUIRES_DRAFT_PAYMENT')
    WHERE NOT EXISTS (
        SELECT 1 FROM customer_payments p
        WHERE p.store_id = NEW.store_id
          AND p.id = NEW.customer_payment_id
          AND p.status = 'draft'
    );

    SELECT RAISE(ABORT, 'CUSTOMER_ALLOCATION_CUSTOMER_MISMATCH')
    WHERE NOT EXISTS (
        SELECT 1
        FROM customer_payments p
        JOIN sales s
          ON s.store_id = p.store_id
         AND s.id = NEW.sale_id
        WHERE p.store_id = NEW.store_id
          AND p.id = NEW.customer_payment_id
          AND s.customer_id = p.customer_id
          AND s.status = 'posted'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_customer_allocations_draft_only_update
BEFORE UPDATE ON customer_payment_allocations
BEGIN
    SELECT RAISE(ABORT, 'POSTED_CUSTOMER_ALLOCATION_IMMUTABLE')
    WHERE NOT EXISTS (
        SELECT 1 FROM customer_payments p
        WHERE p.store_id = OLD.store_id
          AND p.id = OLD.customer_payment_id
          AND p.status = 'draft'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_customer_allocations_draft_only_delete
BEFORE DELETE ON customer_payment_allocations
BEGIN
    SELECT RAISE(ABORT, 'POSTED_CUSTOMER_ALLOCATION_CANNOT_BE_DELETED')
    WHERE NOT EXISTS (
        SELECT 1 FROM customer_payments p
        WHERE p.store_id = OLD.store_id
          AND p.id = OLD.customer_payment_id
          AND p.status = 'draft'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_allocations_draft_only_insert
BEFORE INSERT ON supplier_payment_allocations
BEGIN
    SELECT RAISE(ABORT, 'SUPPLIER_ALLOCATION_REQUIRES_DRAFT_PAYMENT')
    WHERE NOT EXISTS (
        SELECT 1 FROM supplier_payments p
        WHERE p.store_id = NEW.store_id
          AND p.id = NEW.supplier_payment_id
          AND p.status = 'draft'
    );

    SELECT RAISE(ABORT, 'SUPPLIER_ALLOCATION_SUPPLIER_MISMATCH')
    WHERE NOT EXISTS (
        SELECT 1
        FROM supplier_payments p
        JOIN purchase_invoices pi
          ON pi.store_id = p.store_id
         AND pi.id = NEW.purchase_invoice_id
        WHERE p.store_id = NEW.store_id
          AND p.id = NEW.supplier_payment_id
          AND pi.supplier_id = p.supplier_id
          AND pi.status IN ('open', 'closed')
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_allocations_draft_only_update
BEFORE UPDATE ON supplier_payment_allocations
BEGIN
    SELECT RAISE(ABORT, 'POSTED_SUPPLIER_ALLOCATION_IMMUTABLE')
    WHERE NOT EXISTS (
        SELECT 1 FROM supplier_payments p
        WHERE p.store_id = OLD.store_id
          AND p.id = OLD.supplier_payment_id
          AND p.status = 'draft'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_allocations_draft_only_delete
BEFORE DELETE ON supplier_payment_allocations
BEGIN
    SELECT RAISE(ABORT, 'POSTED_SUPPLIER_ALLOCATION_CANNOT_BE_DELETED')
    WHERE NOT EXISTS (
        SELECT 1 FROM supplier_payments p
        WHERE p.store_id = OLD.store_id
          AND p.id = OLD.supplier_payment_id
          AND p.status = 'draft'
    );
END;


CREATE TRIGGER IF NOT EXISTS trg_sale_return_items_draft_only_insert
BEFORE INSERT ON sale_return_items
BEGIN
    SELECT RAISE(ABORT, 'SALE_RETURN_ITEM_REQUIRES_DRAFT_RETURN')
    WHERE NOT EXISTS (
        SELECT 1 FROM sale_returns r
        WHERE r.store_id = NEW.store_id
          AND r.id = NEW.sale_return_id
          AND r.status = 'draft'
    );

    SELECT RAISE(ABORT, 'SALE_RETURN_ITEM_NOT_FROM_ORIGINAL_SALE')
    WHERE NOT EXISTS (
        SELECT 1
        FROM sale_returns r
        JOIN sale_items si
          ON si.store_id = r.store_id
         AND si.id = NEW.sale_item_id
        WHERE r.store_id = NEW.store_id
          AND r.id = NEW.sale_return_id
          AND si.sale_id = r.sale_id
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_return_items_draft_only_update
BEFORE UPDATE ON sale_return_items
BEGIN
    SELECT RAISE(ABORT, 'POSTED_SALE_RETURN_ITEMS_IMMUTABLE')
    WHERE NOT EXISTS (
        SELECT 1 FROM sale_returns r
        WHERE r.store_id = OLD.store_id
          AND r.id = OLD.sale_return_id
          AND r.status = 'draft'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_return_items_draft_only_delete
BEFORE DELETE ON sale_return_items
BEGIN
    SELECT RAISE(ABORT, 'POSTED_SALE_RETURN_ITEMS_CANNOT_BE_DELETED')
    WHERE NOT EXISTS (
        SELECT 1 FROM sale_returns r
        WHERE r.store_id = OLD.store_id
          AND r.id = OLD.sale_return_id
          AND r.status = 'draft'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_return_settlements_draft_only_insert
BEFORE INSERT ON sale_return_settlements
BEGIN
    SELECT RAISE(ABORT, 'SALE_RETURN_SETTLEMENT_REQUIRES_DRAFT_RETURN')
    WHERE NOT EXISTS (
        SELECT 1 FROM sale_returns r
        WHERE r.store_id = NEW.store_id
          AND r.id = NEW.sale_return_id
          AND r.status = 'draft'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_return_settlements_draft_only_update
BEFORE UPDATE ON sale_return_settlements
BEGIN
    SELECT RAISE(ABORT, 'POSTED_SALE_RETURN_SETTLEMENT_IMMUTABLE')
    WHERE NOT EXISTS (
        SELECT 1 FROM sale_returns r
        WHERE r.store_id = OLD.store_id
          AND r.id = OLD.sale_return_id
          AND r.status = 'draft'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_return_settlements_draft_only_delete
BEFORE DELETE ON sale_return_settlements
BEGIN
    SELECT RAISE(ABORT, 'POSTED_SALE_RETURN_SETTLEMENT_CANNOT_BE_DELETED')
    WHERE NOT EXISTS (
        SELECT 1 FROM sale_returns r
        WHERE r.store_id = OLD.store_id
          AND r.id = OLD.sale_return_id
          AND r.status = 'draft'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_return_items_draft_only_insert
BEFORE INSERT ON supplier_return_items
BEGIN
    SELECT RAISE(ABORT, 'SUPPLIER_RETURN_ITEM_REQUIRES_DRAFT_RETURN')
    WHERE NOT EXISTS (
        SELECT 1 FROM supplier_returns r
        WHERE r.store_id = NEW.store_id
          AND r.id = NEW.supplier_return_id
          AND r.status = 'draft'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_return_items_draft_only_update
BEFORE UPDATE ON supplier_return_items
BEGIN
    SELECT RAISE(ABORT, 'POSTED_SUPPLIER_RETURN_ITEMS_IMMUTABLE')
    WHERE NOT EXISTS (
        SELECT 1 FROM supplier_returns r
        WHERE r.store_id = OLD.store_id
          AND r.id = OLD.supplier_return_id
          AND r.status = 'draft'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_return_items_draft_only_delete
BEFORE DELETE ON supplier_return_items
BEGIN
    SELECT RAISE(ABORT, 'POSTED_SUPPLIER_RETURN_ITEMS_CANNOT_BE_DELETED')
    WHERE NOT EXISTS (
        SELECT 1 FROM supplier_returns r
        WHERE r.store_id = OLD.store_id
          AND r.id = OLD.supplier_return_id
          AND r.status = 'draft'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_return_settlements_draft_only_insert
BEFORE INSERT ON supplier_return_settlements
BEGIN
    SELECT RAISE(ABORT, 'SUPPLIER_RETURN_SETTLEMENT_REQUIRES_DRAFT_RETURN')
    WHERE NOT EXISTS (
        SELECT 1 FROM supplier_returns r
        WHERE r.store_id = NEW.store_id
          AND r.id = NEW.supplier_return_id
          AND r.status = 'draft'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_return_settlements_draft_only_update
BEFORE UPDATE ON supplier_return_settlements
BEGIN
    SELECT RAISE(ABORT, 'POSTED_SUPPLIER_RETURN_SETTLEMENT_IMMUTABLE')
    WHERE NOT EXISTS (
        SELECT 1 FROM supplier_returns r
        WHERE r.store_id = OLD.store_id
          AND r.id = OLD.supplier_return_id
          AND r.status = 'draft'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_return_settlements_draft_only_delete
BEFORE DELETE ON supplier_return_settlements
BEGIN
    SELECT RAISE(ABORT, 'POSTED_SUPPLIER_RETURN_SETTLEMENT_CANNOT_BE_DELETED')
    WHERE NOT EXISTS (
        SELECT 1 FROM supplier_returns r
        WHERE r.store_id = OLD.store_id
          AND r.id = OLD.supplier_return_id
          AND r.status = 'draft'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_stock_count_items_not_final_insert
BEFORE INSERT ON stock_count_items
BEGIN
    SELECT RAISE(ABORT, 'STOCK_COUNT_IS_FINAL')
    WHERE NOT EXISTS (
        SELECT 1 FROM stock_counts c
        WHERE c.store_id = NEW.store_id
          AND c.id = NEW.stock_count_id
          AND c.status IN ('draft', 'counting')
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_stock_count_items_not_final_update
BEFORE UPDATE ON stock_count_items
BEGIN
    SELECT RAISE(ABORT, 'FINAL_STOCK_COUNT_ITEM_IMMUTABLE')
    WHERE NOT EXISTS (
        SELECT 1 FROM stock_counts c
        WHERE c.store_id = OLD.store_id
          AND c.id = OLD.stock_count_id
          AND c.status IN ('draft', 'counting')
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_stock_count_items_not_final_delete
BEFORE DELETE ON stock_count_items
BEGIN
    SELECT RAISE(ABORT, 'FINAL_STOCK_COUNT_ITEM_CANNOT_BE_DELETED')
    WHERE NOT EXISTS (
        SELECT 1 FROM stock_counts c
        WHERE c.store_id = OLD.store_id
          AND c.id = OLD.stock_count_id
          AND c.status IN ('draft', 'counting')
    );
END;


-- =========================================================
-- 19. Triggers: تحديث إجماليات المستندات تلقائيًا
-- =========================================================

CREATE TRIGGER IF NOT EXISTS trg_sale_items_totals_ai
AFTER INSERT ON sale_items
BEGIN
    UPDATE sales
    SET
        items_subtotal_minor = COALESCE((
            SELECT SUM(line_gross_minor) FROM sale_items
            WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id
        ), 0),
        line_discount_total_minor = COALESCE((
            SELECT SUM(line_discount_minor) FROM sale_items
            WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id
        ), 0),
        known_cost_total_minor = COALESCE((
            SELECT SUM(CASE WHEN cost_status IN ('known', 'estimated') THEN COALESCE(line_cost_minor, 0) ELSE 0 END)
            FROM sale_items
            WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id
        ), 0),
        pending_cost_line_count = COALESCE((
            SELECT SUM(CASE WHEN cost_status = 'pending' THEN 1 ELSE 0 END)
            FROM sale_items
            WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id
        ), 0),
        unknown_cost_line_count = COALESCE((
            SELECT SUM(CASE WHEN cost_status = 'unknown' THEN 1 ELSE 0 END)
            FROM sale_items
            WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id
        ), 0),
        total_minor =
            COALESCE((SELECT SUM(line_gross_minor) FROM sale_items WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id), 0)
            - COALESCE((SELECT SUM(line_discount_minor) FROM sale_items WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id), 0)
            - invoice_discount_minor
            + rounding_minor,
        credit_total_minor =
            COALESCE((SELECT SUM(line_gross_minor) FROM sale_items WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id), 0)
            - COALESCE((SELECT SUM(line_discount_minor) FROM sale_items WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id), 0)
            - invoice_discount_minor
            + rounding_minor
            - paid_total_minor,
        payment_status =
            CASE
                WHEN paid_total_minor =
                    COALESCE((SELECT SUM(line_gross_minor) FROM sale_items WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id), 0)
                    - COALESCE((SELECT SUM(line_discount_minor) FROM sale_items WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id), 0)
                    - invoice_discount_minor + rounding_minor
                THEN 'paid'
                WHEN paid_total_minor = 0 THEN 'credit'
                ELSE 'partial'
            END
    WHERE store_id = NEW.store_id AND id = NEW.sale_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_items_totals_au
AFTER UPDATE ON sale_items
BEGIN
    UPDATE sales
    SET
        items_subtotal_minor = COALESCE((SELECT SUM(line_gross_minor) FROM sale_items WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id), 0),
        line_discount_total_minor = COALESCE((SELECT SUM(line_discount_minor) FROM sale_items WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id), 0),
        known_cost_total_minor = COALESCE((SELECT SUM(CASE WHEN cost_status IN ('known', 'estimated') THEN COALESCE(line_cost_minor, 0) ELSE 0 END) FROM sale_items WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id), 0),
        pending_cost_line_count = COALESCE((SELECT SUM(CASE WHEN cost_status = 'pending' THEN 1 ELSE 0 END) FROM sale_items WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id), 0),
        unknown_cost_line_count = COALESCE((SELECT SUM(CASE WHEN cost_status = 'unknown' THEN 1 ELSE 0 END) FROM sale_items WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id), 0),
        total_minor = COALESCE((SELECT SUM(line_gross_minor) FROM sale_items WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id), 0)
            - COALESCE((SELECT SUM(line_discount_minor) FROM sale_items WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id), 0)
            - invoice_discount_minor + rounding_minor,
        credit_total_minor = COALESCE((SELECT SUM(line_gross_minor) FROM sale_items WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id), 0)
            - COALESCE((SELECT SUM(line_discount_minor) FROM sale_items WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id), 0)
            - invoice_discount_minor + rounding_minor - paid_total_minor,
        payment_status = CASE
            WHEN paid_total_minor = COALESCE((SELECT SUM(line_gross_minor) FROM sale_items WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id), 0)
                - COALESCE((SELECT SUM(line_discount_minor) FROM sale_items WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id), 0)
                - invoice_discount_minor + rounding_minor THEN 'paid'
            WHEN paid_total_minor = 0 THEN 'credit'
            ELSE 'partial'
        END
    WHERE store_id = NEW.store_id AND id = NEW.sale_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_items_totals_ad
AFTER DELETE ON sale_items
BEGIN
    UPDATE sales
    SET
        items_subtotal_minor = COALESCE((SELECT SUM(line_gross_minor) FROM sale_items WHERE store_id = OLD.store_id AND sale_id = OLD.sale_id), 0),
        line_discount_total_minor = COALESCE((SELECT SUM(line_discount_minor) FROM sale_items WHERE store_id = OLD.store_id AND sale_id = OLD.sale_id), 0),
        known_cost_total_minor = COALESCE((SELECT SUM(CASE WHEN cost_status IN ('known', 'estimated') THEN COALESCE(line_cost_minor, 0) ELSE 0 END) FROM sale_items WHERE store_id = OLD.store_id AND sale_id = OLD.sale_id), 0),
        pending_cost_line_count = COALESCE((SELECT SUM(CASE WHEN cost_status = 'pending' THEN 1 ELSE 0 END) FROM sale_items WHERE store_id = OLD.store_id AND sale_id = OLD.sale_id), 0),
        unknown_cost_line_count = COALESCE((SELECT SUM(CASE WHEN cost_status = 'unknown' THEN 1 ELSE 0 END) FROM sale_items WHERE store_id = OLD.store_id AND sale_id = OLD.sale_id), 0),
        total_minor = COALESCE((SELECT SUM(line_gross_minor) FROM sale_items WHERE store_id = OLD.store_id AND sale_id = OLD.sale_id), 0)
            - COALESCE((SELECT SUM(line_discount_minor) FROM sale_items WHERE store_id = OLD.store_id AND sale_id = OLD.sale_id), 0)
            - invoice_discount_minor + rounding_minor,
        credit_total_minor = COALESCE((SELECT SUM(line_gross_minor) FROM sale_items WHERE store_id = OLD.store_id AND sale_id = OLD.sale_id), 0)
            - COALESCE((SELECT SUM(line_discount_minor) FROM sale_items WHERE store_id = OLD.store_id AND sale_id = OLD.sale_id), 0)
            - invoice_discount_minor + rounding_minor - paid_total_minor,
        payment_status = CASE
            WHEN paid_total_minor = COALESCE((SELECT SUM(line_gross_minor) FROM sale_items WHERE store_id = OLD.store_id AND sale_id = OLD.sale_id), 0)
                - COALESCE((SELECT SUM(line_discount_minor) FROM sale_items WHERE store_id = OLD.store_id AND sale_id = OLD.sale_id), 0)
                - invoice_discount_minor + rounding_minor THEN 'paid'
            WHEN paid_total_minor = 0 THEN 'credit'
            ELSE 'partial'
        END
    WHERE store_id = OLD.store_id AND id = OLD.sale_id;
END;


CREATE TRIGGER IF NOT EXISTS trg_sale_payments_totals_ai
AFTER INSERT ON sale_payments
BEGIN
    UPDATE sales
    SET
        paid_total_minor = COALESCE((
            SELECT SUM(amount_minor) FROM sale_payments
            WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id
        ), 0),
        credit_total_minor = total_minor - COALESCE((
            SELECT SUM(amount_minor) FROM sale_payments
            WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id
        ), 0),
        payment_status = CASE
            WHEN COALESCE((SELECT SUM(amount_minor) FROM sale_payments WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id), 0) = total_minor THEN 'paid'
            WHEN COALESCE((SELECT SUM(amount_minor) FROM sale_payments WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id), 0) = 0 THEN 'credit'
            ELSE 'partial'
        END
    WHERE store_id = NEW.store_id AND id = NEW.sale_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_payments_totals_au
AFTER UPDATE ON sale_payments
BEGIN
    UPDATE sales
    SET
        paid_total_minor = COALESCE((SELECT SUM(amount_minor) FROM sale_payments WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id), 0),
        credit_total_minor = total_minor - COALESCE((SELECT SUM(amount_minor) FROM sale_payments WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id), 0),
        payment_status = CASE
            WHEN COALESCE((SELECT SUM(amount_minor) FROM sale_payments WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id), 0) = total_minor THEN 'paid'
            WHEN COALESCE((SELECT SUM(amount_minor) FROM sale_payments WHERE store_id = NEW.store_id AND sale_id = NEW.sale_id), 0) = 0 THEN 'credit'
            ELSE 'partial'
        END
    WHERE store_id = NEW.store_id AND id = NEW.sale_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_payments_totals_ad
AFTER DELETE ON sale_payments
BEGIN
    UPDATE sales
    SET
        paid_total_minor = COALESCE((SELECT SUM(amount_minor) FROM sale_payments WHERE store_id = OLD.store_id AND sale_id = OLD.sale_id), 0),
        credit_total_minor = total_minor - COALESCE((SELECT SUM(amount_minor) FROM sale_payments WHERE store_id = OLD.store_id AND sale_id = OLD.sale_id), 0),
        payment_status = CASE
            WHEN COALESCE((SELECT SUM(amount_minor) FROM sale_payments WHERE store_id = OLD.store_id AND sale_id = OLD.sale_id), 0) = total_minor THEN 'paid'
            WHEN COALESCE((SELECT SUM(amount_minor) FROM sale_payments WHERE store_id = OLD.store_id AND sale_id = OLD.sale_id), 0) = 0 THEN 'credit'
            ELSE 'partial'
        END
    WHERE store_id = OLD.store_id AND id = OLD.sale_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_header_discount_recalc
AFTER UPDATE OF invoice_discount_minor, rounding_minor ON sales
WHEN OLD.status = 'draft' AND NEW.status = 'draft'
BEGIN
    UPDATE sales
    SET
        total_minor = items_subtotal_minor - line_discount_total_minor - invoice_discount_minor + rounding_minor,
        credit_total_minor = items_subtotal_minor - line_discount_total_minor - invoice_discount_minor + rounding_minor - paid_total_minor,
        payment_status = CASE
            WHEN paid_total_minor = items_subtotal_minor - line_discount_total_minor - invoice_discount_minor + rounding_minor THEN 'paid'
            WHEN paid_total_minor = 0 THEN 'credit'
            ELSE 'partial'
        END
    WHERE store_id = NEW.store_id AND id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_purchase_items_totals_ai
AFTER INSERT ON purchase_items
BEGIN
    UPDATE purchase_invoices
    SET
        items_subtotal_minor = COALESCE((SELECT SUM(line_gross_minor) FROM purchase_items WHERE store_id = NEW.store_id AND purchase_invoice_id = NEW.purchase_invoice_id), 0),
        line_discount_total_minor = COALESCE((SELECT SUM(line_discount_minor) FROM purchase_items WHERE store_id = NEW.store_id AND purchase_invoice_id = NEW.purchase_invoice_id), 0),
        total_minor = COALESCE((SELECT SUM(line_gross_minor) FROM purchase_items WHERE store_id = NEW.store_id AND purchase_invoice_id = NEW.purchase_invoice_id), 0)
            - COALESCE((SELECT SUM(line_discount_minor) FROM purchase_items WHERE store_id = NEW.store_id AND purchase_invoice_id = NEW.purchase_invoice_id), 0)
            - invoice_discount_minor + rounding_minor
    WHERE store_id = NEW.store_id AND id = NEW.purchase_invoice_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_purchase_items_totals_au
AFTER UPDATE ON purchase_items
BEGIN
    UPDATE purchase_invoices
    SET
        items_subtotal_minor = COALESCE((SELECT SUM(line_gross_minor) FROM purchase_items WHERE store_id = NEW.store_id AND purchase_invoice_id = NEW.purchase_invoice_id), 0),
        line_discount_total_minor = COALESCE((SELECT SUM(line_discount_minor) FROM purchase_items WHERE store_id = NEW.store_id AND purchase_invoice_id = NEW.purchase_invoice_id), 0),
        total_minor = COALESCE((SELECT SUM(line_gross_minor) FROM purchase_items WHERE store_id = NEW.store_id AND purchase_invoice_id = NEW.purchase_invoice_id), 0)
            - COALESCE((SELECT SUM(line_discount_minor) FROM purchase_items WHERE store_id = NEW.store_id AND purchase_invoice_id = NEW.purchase_invoice_id), 0)
            - invoice_discount_minor + rounding_minor
    WHERE store_id = NEW.store_id AND id = NEW.purchase_invoice_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_purchase_items_totals_ad
AFTER DELETE ON purchase_items
BEGIN
    UPDATE purchase_invoices
    SET
        items_subtotal_minor = COALESCE((SELECT SUM(line_gross_minor) FROM purchase_items WHERE store_id = OLD.store_id AND purchase_invoice_id = OLD.purchase_invoice_id), 0),
        line_discount_total_minor = COALESCE((SELECT SUM(line_discount_minor) FROM purchase_items WHERE store_id = OLD.store_id AND purchase_invoice_id = OLD.purchase_invoice_id), 0),
        total_minor = COALESCE((SELECT SUM(line_gross_minor) FROM purchase_items WHERE store_id = OLD.store_id AND purchase_invoice_id = OLD.purchase_invoice_id), 0)
            - COALESCE((SELECT SUM(line_discount_minor) FROM purchase_items WHERE store_id = OLD.store_id AND purchase_invoice_id = OLD.purchase_invoice_id), 0)
            - invoice_discount_minor + rounding_minor
    WHERE store_id = OLD.store_id AND id = OLD.purchase_invoice_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_purchase_header_discount_recalc
AFTER UPDATE OF invoice_discount_minor, rounding_minor ON purchase_invoices
WHEN OLD.status = 'draft' AND NEW.status = 'draft'
BEGIN
    UPDATE purchase_invoices
    SET total_minor = items_subtotal_minor - line_discount_total_minor - invoice_discount_minor + rounding_minor
    WHERE store_id = NEW.store_id AND id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_goods_receipt_totals_ai
AFTER INSERT ON goods_receipt_items
BEGIN
    UPDATE goods_receipts
    SET total_cost_minor = COALESCE((
        SELECT SUM(line_total_minor)
        FROM goods_receipt_items
        WHERE store_id = NEW.store_id AND goods_receipt_id = NEW.goods_receipt_id
    ), 0)
    WHERE store_id = NEW.store_id AND id = NEW.goods_receipt_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_goods_receipt_totals_au
AFTER UPDATE ON goods_receipt_items
BEGIN
    UPDATE goods_receipts
    SET total_cost_minor = COALESCE((
        SELECT SUM(line_total_minor)
        FROM goods_receipt_items
        WHERE store_id = NEW.store_id AND goods_receipt_id = NEW.goods_receipt_id
    ), 0)
    WHERE store_id = NEW.store_id AND id = NEW.goods_receipt_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_goods_receipt_totals_ad
AFTER DELETE ON goods_receipt_items
BEGIN
    UPDATE goods_receipts
    SET total_cost_minor = COALESCE((
        SELECT SUM(line_total_minor)
        FROM goods_receipt_items
        WHERE store_id = OLD.store_id AND goods_receipt_id = OLD.goods_receipt_id
    ), 0)
    WHERE store_id = OLD.store_id AND id = OLD.goods_receipt_id;
END;


CREATE TRIGGER IF NOT EXISTS trg_customer_allocations_totals_ai
AFTER INSERT ON customer_payment_allocations
BEGIN
    UPDATE customer_payments
    SET
        allocated_total_minor = COALESCE((
            SELECT SUM(amount_minor)
            FROM customer_payment_allocations
            WHERE store_id = NEW.store_id AND customer_payment_id = NEW.customer_payment_id
        ), 0),
        credit_created_minor = amount_minor - COALESCE((
            SELECT SUM(amount_minor)
            FROM customer_payment_allocations
            WHERE store_id = NEW.store_id AND customer_payment_id = NEW.customer_payment_id
        ), 0)
    WHERE store_id = NEW.store_id AND id = NEW.customer_payment_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_customer_allocations_totals_au
AFTER UPDATE ON customer_payment_allocations
BEGIN
    UPDATE customer_payments
    SET
        allocated_total_minor = COALESCE((
            SELECT SUM(amount_minor)
            FROM customer_payment_allocations
            WHERE store_id = NEW.store_id AND customer_payment_id = NEW.customer_payment_id
        ), 0),
        credit_created_minor = amount_minor - COALESCE((
            SELECT SUM(amount_minor)
            FROM customer_payment_allocations
            WHERE store_id = NEW.store_id AND customer_payment_id = NEW.customer_payment_id
        ), 0)
    WHERE store_id = NEW.store_id AND id = NEW.customer_payment_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_customer_allocations_totals_ad
AFTER DELETE ON customer_payment_allocations
BEGIN
    UPDATE customer_payments
    SET
        allocated_total_minor = COALESCE((
            SELECT SUM(amount_minor)
            FROM customer_payment_allocations
            WHERE store_id = OLD.store_id AND customer_payment_id = OLD.customer_payment_id
        ), 0),
        credit_created_minor = amount_minor - COALESCE((
            SELECT SUM(amount_minor)
            FROM customer_payment_allocations
            WHERE store_id = OLD.store_id AND customer_payment_id = OLD.customer_payment_id
        ), 0)
    WHERE store_id = OLD.store_id AND id = OLD.customer_payment_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_allocations_totals_ai
AFTER INSERT ON supplier_payment_allocations
BEGIN
    UPDATE supplier_payments
    SET
        allocated_total_minor = COALESCE((
            SELECT SUM(amount_minor)
            FROM supplier_payment_allocations
            WHERE store_id = NEW.store_id AND supplier_payment_id = NEW.supplier_payment_id
        ), 0),
        credit_created_minor = amount_minor - COALESCE((
            SELECT SUM(amount_minor)
            FROM supplier_payment_allocations
            WHERE store_id = NEW.store_id AND supplier_payment_id = NEW.supplier_payment_id
        ), 0)
    WHERE store_id = NEW.store_id AND id = NEW.supplier_payment_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_allocations_totals_au
AFTER UPDATE ON supplier_payment_allocations
BEGIN
    UPDATE supplier_payments
    SET
        allocated_total_minor = COALESCE((
            SELECT SUM(amount_minor)
            FROM supplier_payment_allocations
            WHERE store_id = NEW.store_id AND supplier_payment_id = NEW.supplier_payment_id
        ), 0),
        credit_created_minor = amount_minor - COALESCE((
            SELECT SUM(amount_minor)
            FROM supplier_payment_allocations
            WHERE store_id = NEW.store_id AND supplier_payment_id = NEW.supplier_payment_id
        ), 0)
    WHERE store_id = NEW.store_id AND id = NEW.supplier_payment_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_allocations_totals_ad
AFTER DELETE ON supplier_payment_allocations
BEGIN
    UPDATE supplier_payments
    SET
        allocated_total_minor = COALESCE((
            SELECT SUM(amount_minor)
            FROM supplier_payment_allocations
            WHERE store_id = OLD.store_id AND supplier_payment_id = OLD.supplier_payment_id
        ), 0),
        credit_created_minor = amount_minor - COALESCE((
            SELECT SUM(amount_minor)
            FROM supplier_payment_allocations
            WHERE store_id = OLD.store_id AND supplier_payment_id = OLD.supplier_payment_id
        ), 0)
    WHERE store_id = OLD.store_id AND id = OLD.supplier_payment_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_expense_payments_totals_ai
AFTER INSERT ON expense_payments
BEGIN
    UPDATE expenses
    SET paid_total_minor = COALESCE((
        SELECT SUM(amount_minor)
        FROM expense_payments
        WHERE store_id = NEW.store_id
          AND expense_id = NEW.expense_id
          AND status = 'posted'
    ), 0)
    WHERE store_id = NEW.store_id AND id = NEW.expense_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_expense_payments_totals_au
AFTER UPDATE ON expense_payments
BEGIN
    UPDATE expenses
    SET paid_total_minor = COALESCE((
        SELECT SUM(amount_minor)
        FROM expense_payments
        WHERE store_id = NEW.store_id
          AND expense_id = NEW.expense_id
          AND status = 'posted'
    ), 0)
    WHERE store_id = NEW.store_id AND id = NEW.expense_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_expense_payments_totals_ad
AFTER DELETE ON expense_payments
BEGIN
    UPDATE expenses
    SET paid_total_minor = COALESCE((
        SELECT SUM(amount_minor)
        FROM expense_payments
        WHERE store_id = OLD.store_id
          AND expense_id = OLD.expense_id
          AND status = 'posted'
    ), 0)
    WHERE store_id = OLD.store_id AND id = OLD.expense_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_return_totals_ai
AFTER INSERT ON sale_return_items
BEGIN
    UPDATE sale_returns
    SET total_minor = COALESCE((
        SELECT SUM(line_refund_minor)
        FROM sale_return_items
        WHERE store_id = NEW.store_id AND sale_return_id = NEW.sale_return_id
    ), 0)
    WHERE store_id = NEW.store_id AND id = NEW.sale_return_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_return_totals_au
AFTER UPDATE ON sale_return_items
BEGIN
    UPDATE sale_returns
    SET total_minor = COALESCE((
        SELECT SUM(line_refund_minor)
        FROM sale_return_items
        WHERE store_id = NEW.store_id AND sale_return_id = NEW.sale_return_id
    ), 0)
    WHERE store_id = NEW.store_id AND id = NEW.sale_return_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_return_totals_ad
AFTER DELETE ON sale_return_items
BEGIN
    UPDATE sale_returns
    SET total_minor = COALESCE((
        SELECT SUM(line_refund_minor)
        FROM sale_return_items
        WHERE store_id = OLD.store_id AND sale_return_id = OLD.sale_return_id
    ), 0)
    WHERE store_id = OLD.store_id AND id = OLD.sale_return_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_return_totals_ai
AFTER INSERT ON supplier_return_items
BEGIN
    UPDATE supplier_returns
    SET total_minor = COALESCE((
        SELECT SUM(line_total_minor)
        FROM supplier_return_items
        WHERE store_id = NEW.store_id AND supplier_return_id = NEW.supplier_return_id
    ), 0)
    WHERE store_id = NEW.store_id AND id = NEW.supplier_return_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_return_totals_au
AFTER UPDATE ON supplier_return_items
BEGIN
    UPDATE supplier_returns
    SET total_minor = COALESCE((
        SELECT SUM(line_total_minor)
        FROM supplier_return_items
        WHERE store_id = NEW.store_id AND supplier_return_id = NEW.supplier_return_id
    ), 0)
    WHERE store_id = NEW.store_id AND id = NEW.supplier_return_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_return_totals_ad
AFTER DELETE ON supplier_return_items
BEGIN
    UPDATE supplier_returns
    SET total_minor = COALESCE((
        SELECT SUM(line_total_minor)
        FROM supplier_return_items
        WHERE store_id = OLD.store_id AND supplier_return_id = OLD.supplier_return_id
    ), 0)
    WHERE store_id = OLD.store_id AND id = OLD.supplier_return_id;
END;


-- =========================================================
-- 20. Triggers: اعتماد المبيعات
-- =========================================================

CREATE TRIGGER IF NOT EXISTS trg_sale_post_validate
BEFORE UPDATE OF status ON sales
WHEN OLD.status = 'draft' AND NEW.status = 'posted'
BEGIN
    SELECT RAISE(ABORT, 'SALE_PERIOD_NOT_OPEN')
    WHERE NEW.accounting_period_id IS NULL
       OR NOT EXISTS (
            SELECT 1
            FROM accounting_periods p
            WHERE p.store_id = NEW.store_id
              AND p.id = NEW.accounting_period_id
              AND p.status = 'open'
              AND NEW.sale_at >= p.starts_at
              AND NEW.sale_at < p.ends_at
       );

    SELECT RAISE(ABORT, 'SALE_REQUIRES_ITEMS')
    WHERE NOT EXISTS (
        SELECT 1 FROM sale_items i
        WHERE i.store_id = NEW.store_id AND i.sale_id = NEW.id
    );

    SELECT RAISE(ABORT, 'SALE_TOTAL_MUST_BE_POSITIVE')
    WHERE NEW.total_minor <= 0;

    SELECT RAISE(ABORT, 'ANONYMOUS_SALE_CANNOT_HAVE_CREDIT')
    WHERE NEW.credit_total_minor > 0 AND NEW.customer_id IS NULL;

    SELECT RAISE(ABORT, 'SALE_PAYMENT_MOVEMENT_MISMATCH')
    WHERE EXISTS (
        SELECT 1
        FROM sale_payments sp
        LEFT JOIN money_movements mm
          ON mm.store_id = sp.store_id
         AND mm.id = sp.money_movement_id
        WHERE sp.store_id = NEW.store_id
          AND sp.sale_id = NEW.id
          AND (
              mm.id IS NULL
              OR mm.account_id <> sp.money_account_id
              OR mm.amount_delta_minor <> sp.amount_minor
              OR mm.movement_type <> 'sale_payment'
              OR mm.reference_type <> 'sale'
              OR mm.reference_id <> NEW.id
              OR mm.accounting_period_id <> NEW.accounting_period_id
          )
    );

    SELECT RAISE(ABORT, 'SALE_MONEY_TOTAL_MISMATCH')
    WHERE COALESCE((
        SELECT SUM(mm.amount_delta_minor)
        FROM sale_payments sp
        JOIN money_movements mm
          ON mm.store_id = sp.store_id
         AND mm.id = sp.money_movement_id
        WHERE sp.store_id = NEW.store_id
          AND sp.sale_id = NEW.id
    ), 0) <> NEW.paid_total_minor;

    SELECT RAISE(ABORT, 'SALE_CUSTOMER_LEDGER_MISMATCH')
    WHERE COALESCE((
        SELECT SUM(l.receivable_delta_minor)
        FROM customer_ledger_entries l
        WHERE l.store_id = NEW.store_id
          AND l.customer_id = NEW.customer_id
          AND l.source_sale_id = NEW.id
          AND l.reference_type = 'sale'
          AND l.reference_id = NEW.id
          AND l.entry_type = 'sale_credit'
    ), 0) <> NEW.credit_total_minor;

    SELECT RAISE(ABORT, 'SALE_INVENTORY_MOVEMENT_MISMATCH')
    WHERE EXISTS (
        SELECT 1
        FROM sale_items si
        JOIN products pr
          ON pr.store_id = si.store_id
         AND pr.id = si.product_id
        LEFT JOIN inventory_movements im
          ON im.store_id = si.store_id
         AND im.id = si.inventory_movement_id
        WHERE si.store_id = NEW.store_id
          AND si.sale_id = NEW.id
          AND si.is_manual_line = 0
          AND pr.track_inventory = 1
          AND (
              im.id IS NULL
              OR im.product_id <> si.product_id
              OR im.movement_type <> 'sale'
              OR im.quantity_delta_milli <> -si.base_quantity_milli
              OR im.reference_type <> 'sale'
              OR im.reference_id <> NEW.id
              OR im.accounting_period_id <> NEW.accounting_period_id
              OR (si.line_cost_minor IS NOT NULL AND im.value_delta_minor <> -si.line_cost_minor)
          )
    );

    SELECT RAISE(ABORT, 'UNTRACKED_OR_MANUAL_SALE_LINE_HAS_INVENTORY_MOVEMENT')
    WHERE EXISTS (
        SELECT 1
        FROM sale_items si
        LEFT JOIN products pr
          ON pr.store_id = si.store_id
         AND pr.id = si.product_id
        WHERE si.store_id = NEW.store_id
          AND si.sale_id = NEW.id
          AND si.inventory_movement_id IS NOT NULL
          AND (si.is_manual_line = 1 OR COALESCE(pr.track_inventory, 0) = 0)
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_final_fields_immutable
BEFORE UPDATE ON sales
WHEN OLD.status <> 'draft'
 AND (
    NEW.customer_id IS NOT OLD.customer_id
    OR NEW.accounting_period_id IS NOT OLD.accounting_period_id
    OR NEW.display_number <> OLD.display_number
    OR NEW.sale_at <> OLD.sale_at
    OR NEW.items_subtotal_minor <> OLD.items_subtotal_minor
    OR NEW.line_discount_total_minor <> OLD.line_discount_total_minor
    OR NEW.invoice_discount_minor <> OLD.invoice_discount_minor
    OR NEW.rounding_minor <> OLD.rounding_minor
    OR NEW.total_minor <> OLD.total_minor
    OR NEW.paid_total_minor <> OLD.paid_total_minor
    OR NEW.credit_total_minor <> OLD.credit_total_minor
 )
BEGIN
    SELECT RAISE(ABORT, 'POSTED_SALE_FINANCIAL_FIELDS_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_sales_no_delete
BEFORE DELETE ON sales
BEGIN
    SELECT RAISE(ABORT, 'SALES_CANNOT_BE_DELETED_USE_REVERSAL');
END;

-- =========================================================
-- 21. Triggers: اعتماد فواتير الشراء والاستلام
-- =========================================================

CREATE TRIGGER IF NOT EXISTS trg_purchase_invoice_open_validate
BEFORE UPDATE OF status ON purchase_invoices
WHEN OLD.status = 'draft' AND NEW.status = 'open'
BEGIN
    SELECT RAISE(ABORT, 'PURCHASE_INVOICE_REQUIRES_ITEMS')
    WHERE NOT EXISTS (
        SELECT 1 FROM purchase_items i
        WHERE i.store_id = NEW.store_id
          AND i.purchase_invoice_id = NEW.id
    );

    SELECT RAISE(ABORT, 'PURCHASE_INVOICE_TOTAL_MUST_BE_POSITIVE')
    WHERE NEW.total_minor <= 0;
END;

CREATE TRIGGER IF NOT EXISTS trg_purchase_invoice_final_fields_immutable
BEFORE UPDATE ON purchase_invoices
WHEN OLD.status <> 'draft'
 AND (
    NEW.supplier_id <> OLD.supplier_id
    OR NEW.invoice_number IS NOT OLD.invoice_number
    OR NEW.display_number <> OLD.display_number
    OR NEW.invoice_date_at <> OLD.invoice_date_at
    OR NEW.due_at IS NOT OLD.due_at
    OR NEW.items_subtotal_minor <> OLD.items_subtotal_minor
    OR NEW.line_discount_total_minor <> OLD.line_discount_total_minor
    OR NEW.invoice_discount_minor <> OLD.invoice_discount_minor
    OR NEW.rounding_minor <> OLD.rounding_minor
    OR NEW.total_minor <> OLD.total_minor
 )
BEGIN
    SELECT RAISE(ABORT, 'FINAL_PURCHASE_INVOICE_FIELDS_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_purchase_invoices_no_delete
BEFORE DELETE ON purchase_invoices
BEGIN
    SELECT RAISE(ABORT, 'PURCHASE_INVOICES_CANNOT_BE_DELETED');
END;

CREATE TRIGGER IF NOT EXISTS trg_goods_receipt_post_validate
BEFORE UPDATE OF status ON goods_receipts
WHEN OLD.status = 'draft' AND NEW.status = 'posted'
BEGIN
    SELECT RAISE(ABORT, 'GOODS_RECEIPT_PERIOD_NOT_OPEN')
    WHERE NEW.accounting_period_id IS NULL
       OR NOT EXISTS (
            SELECT 1 FROM accounting_periods p
            WHERE p.store_id = NEW.store_id
              AND p.id = NEW.accounting_period_id
              AND p.status = 'open'
              AND NEW.received_at >= p.starts_at
              AND NEW.received_at < p.ends_at
       );

    SELECT RAISE(ABORT, 'GOODS_RECEIPT_REQUIRES_ITEMS')
    WHERE NOT EXISTS (
        SELECT 1 FROM goods_receipt_items i
        WHERE i.store_id = NEW.store_id AND i.goods_receipt_id = NEW.id
    );

    SELECT RAISE(ABORT, 'GOODS_RECEIPT_TOTAL_MUST_BE_POSITIVE')
    WHERE NEW.total_cost_minor <= 0;

    SELECT RAISE(ABORT, 'GOODS_RECEIPT_SUPPLIER_INVOICE_MISMATCH')
    WHERE NEW.purchase_invoice_id IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM purchase_invoices pi
          WHERE pi.store_id = NEW.store_id
            AND pi.id = NEW.purchase_invoice_id
            AND pi.supplier_id = NEW.supplier_id
            AND pi.status IN ('open', 'closed')
      );

    SELECT RAISE(ABORT, 'GOODS_RECEIPT_ITEM_INVOICE_MISMATCH')
    WHERE EXISTS (
        SELECT 1
        FROM goods_receipt_items gri
        JOIN purchase_items pi
          ON pi.store_id = gri.store_id
         AND pi.id = gri.purchase_item_id
        WHERE gri.store_id = NEW.store_id
          AND gri.goods_receipt_id = NEW.id
          AND NEW.purchase_invoice_id IS NOT NULL
          AND pi.purchase_invoice_id <> NEW.purchase_invoice_id
    );

    SELECT RAISE(ABORT, 'GOODS_RECEIPT_EXCEEDS_ORDERED_QUANTITY')
    WHERE EXISTS (
        SELECT 1
        FROM goods_receipt_items current_item
        JOIN purchase_items pi
          ON pi.store_id = current_item.store_id
         AND pi.id = current_item.purchase_item_id
        WHERE current_item.store_id = NEW.store_id
          AND current_item.goods_receipt_id = NEW.id
          AND current_item.purchase_item_id IS NOT NULL
          AND (
              COALESCE((
                  SELECT SUM(other_item.base_quantity_milli)
                  FROM goods_receipt_items other_item
                  JOIN goods_receipts other_receipt
                    ON other_receipt.store_id = other_item.store_id
                   AND other_receipt.id = other_item.goods_receipt_id
                  WHERE other_item.store_id = current_item.store_id
                    AND other_item.purchase_item_id = current_item.purchase_item_id
                    AND other_receipt.status = 'posted'
                    AND other_receipt.id <> NEW.id
              ), 0)
              + current_item.base_quantity_milli
          ) > pi.base_quantity_milli
    );

    SELECT RAISE(ABORT, 'GOODS_RECEIPT_INVENTORY_MISMATCH')
    WHERE EXISTS (
        SELECT 1
        FROM goods_receipt_items gri
        LEFT JOIN inventory_movements im
          ON im.store_id = gri.store_id
         AND im.id = gri.inventory_movement_id
        WHERE gri.store_id = NEW.store_id
          AND gri.goods_receipt_id = NEW.id
          AND (
              im.id IS NULL
              OR im.product_id <> gri.product_id
              OR im.movement_type <> 'purchase_receipt'
              OR im.quantity_delta_milli <> gri.base_quantity_milli
              OR im.value_delta_minor <> gri.line_total_minor
              OR im.reference_type <> 'goods_receipt'
              OR im.reference_id <> NEW.id
              OR im.accounting_period_id <> NEW.accounting_period_id
          )
    );

    SELECT RAISE(ABORT, 'GOODS_RECEIPT_SUPPLIER_LEDGER_MISMATCH')
    WHERE COALESCE((
        SELECT SUM(l.payable_delta_minor)
        FROM supplier_ledger_entries l
        WHERE l.store_id = NEW.store_id
          AND l.supplier_id = NEW.supplier_id
          AND l.reference_type = 'goods_receipt'
          AND l.reference_id = NEW.id
          AND l.entry_type = 'goods_receipt'
          AND (
              (NEW.purchase_invoice_id IS NULL AND l.source_purchase_invoice_id IS NULL)
              OR l.source_purchase_invoice_id = NEW.purchase_invoice_id
          )
    ), 0) <> NEW.total_cost_minor;
END;

CREATE TRIGGER IF NOT EXISTS trg_goods_receipts_no_delete
BEFORE DELETE ON goods_receipts
BEGIN
    SELECT RAISE(ABORT, 'GOODS_RECEIPTS_CANNOT_BE_DELETED_USE_REVERSAL');
END;


-- =========================================================
-- 22. Triggers: اعتماد تحصيل العملاء وسداد الموردين
-- =========================================================

CREATE TRIGGER IF NOT EXISTS trg_customer_payment_post_validate
BEFORE UPDATE OF status ON customer_payments
WHEN OLD.status = 'draft' AND NEW.status = 'posted'
BEGIN
    SELECT RAISE(ABORT, 'CUSTOMER_PAYMENT_PERIOD_NOT_OPEN')
    WHERE NEW.accounting_period_id IS NULL
       OR NOT EXISTS (
            SELECT 1 FROM accounting_periods p
            WHERE p.store_id = NEW.store_id
              AND p.id = NEW.accounting_period_id
              AND p.status = 'open'
              AND NEW.payment_at >= p.starts_at
              AND NEW.payment_at < p.ends_at
       );

    SELECT RAISE(ABORT, 'CUSTOMER_PAYMENT_ALLOCATION_EXCEEDS_AMOUNT')
    WHERE NEW.allocated_total_minor > NEW.amount_minor;

    SELECT RAISE(ABORT, 'CUSTOMER_PAYMENT_MONEY_MOVEMENT_MISMATCH')
    WHERE NOT EXISTS (
        SELECT 1
        FROM money_movements m
        WHERE m.store_id = NEW.store_id
          AND m.id = NEW.money_movement_id
          AND m.account_id = NEW.money_account_id
          AND m.amount_delta_minor = NEW.amount_minor
          AND m.movement_type = 'customer_payment'
          AND m.reference_type = 'customer_payment'
          AND m.reference_id = NEW.id
          AND m.accounting_period_id = NEW.accounting_period_id
    );

    SELECT RAISE(ABORT, 'CUSTOMER_PAYMENT_ALLOCATION_LEDGER_MISMATCH')
    WHERE EXISTS (
        SELECT 1
        FROM customer_payment_allocations a
        LEFT JOIN customer_ledger_entries l
          ON l.store_id = a.store_id
         AND l.id = a.customer_ledger_entry_id
        WHERE a.store_id = NEW.store_id
          AND a.customer_payment_id = NEW.id
          AND (
              l.id IS NULL
              OR l.customer_id <> NEW.customer_id
              OR l.entry_type <> 'payment'
              OR l.receivable_delta_minor <> -a.amount_minor
              OR l.credit_delta_minor <> 0
              OR l.source_sale_id <> a.sale_id
              OR l.reference_type <> 'customer_payment'
              OR l.reference_id <> NEW.id
              OR l.accounting_period_id <> NEW.accounting_period_id
          )
    );

    SELECT RAISE(ABORT, 'CUSTOMER_PAYMENT_CREDIT_LEDGER_MISMATCH')
    WHERE COALESCE((
        SELECT SUM(l.credit_delta_minor)
        FROM customer_ledger_entries l
        WHERE l.store_id = NEW.store_id
          AND l.customer_id = NEW.customer_id
          AND l.reference_type = 'customer_payment'
          AND l.reference_id = NEW.id
          AND l.entry_type = 'credit_created'
    ), 0) <> NEW.credit_created_minor;
END;

CREATE TRIGGER IF NOT EXISTS trg_customer_payments_no_delete
BEFORE DELETE ON customer_payments
BEGIN
    SELECT RAISE(ABORT, 'CUSTOMER_PAYMENTS_CANNOT_BE_DELETED');
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_payment_post_validate
BEFORE UPDATE OF status ON supplier_payments
WHEN OLD.status = 'draft' AND NEW.status = 'posted'
BEGIN
    SELECT RAISE(ABORT, 'SUPPLIER_PAYMENT_PERIOD_NOT_OPEN')
    WHERE NEW.accounting_period_id IS NULL
       OR NOT EXISTS (
            SELECT 1 FROM accounting_periods p
            WHERE p.store_id = NEW.store_id
              AND p.id = NEW.accounting_period_id
              AND p.status = 'open'
              AND NEW.payment_at >= p.starts_at
              AND NEW.payment_at < p.ends_at
       );

    SELECT RAISE(ABORT, 'SUPPLIER_PAYMENT_ALLOCATION_EXCEEDS_AMOUNT')
    WHERE NEW.allocated_total_minor > NEW.amount_minor;

    SELECT RAISE(ABORT, 'SUPPLIER_PAYMENT_SOURCE_MISMATCH')
    WHERE (
        NEW.payment_source = 'money_account'
        AND NOT EXISTS (
            SELECT 1 FROM money_movements m
            WHERE m.store_id = NEW.store_id
              AND m.id = NEW.money_movement_id
              AND m.account_id = NEW.money_account_id
              AND m.amount_delta_minor = -NEW.amount_minor
              AND m.movement_type = 'supplier_payment'
              AND m.reference_type = 'supplier_payment'
              AND m.reference_id = NEW.id
              AND m.accounting_period_id = NEW.accounting_period_id
        )
    )
    OR (
        NEW.payment_source = 'owner_pocket'
        AND NOT EXISTS (
            SELECT 1 FROM owner_ledger_entries o
            WHERE o.store_id = NEW.store_id
              AND o.id = NEW.owner_ledger_entry_id
              AND o.entry_type = 'owner_paid_supplier'
              AND o.owner_liability_delta_minor = NEW.amount_minor
              AND o.equity_delta_minor = 0
              AND o.reference_type = 'supplier_payment'
              AND o.reference_id = NEW.id
              AND o.accounting_period_id = NEW.accounting_period_id
        )
    );

    SELECT RAISE(ABORT, 'SUPPLIER_PAYMENT_ALLOCATION_LEDGER_MISMATCH')
    WHERE EXISTS (
        SELECT 1
        FROM supplier_payment_allocations a
        LEFT JOIN supplier_ledger_entries l
          ON l.store_id = a.store_id
         AND l.id = a.supplier_ledger_entry_id
        WHERE a.store_id = NEW.store_id
          AND a.supplier_payment_id = NEW.id
          AND (
              l.id IS NULL
              OR l.supplier_id <> NEW.supplier_id
              OR l.entry_type <> 'payment'
              OR l.payable_delta_minor <> -a.amount_minor
              OR l.credit_delta_minor <> 0
              OR l.source_purchase_invoice_id <> a.purchase_invoice_id
              OR l.reference_type <> 'supplier_payment'
              OR l.reference_id <> NEW.id
              OR l.accounting_period_id <> NEW.accounting_period_id
          )
    );

    SELECT RAISE(ABORT, 'SUPPLIER_PAYMENT_CREDIT_LEDGER_MISMATCH')
    WHERE COALESCE((
        SELECT SUM(l.credit_delta_minor)
        FROM supplier_ledger_entries l
        WHERE l.store_id = NEW.store_id
          AND l.supplier_id = NEW.supplier_id
          AND l.reference_type = 'supplier_payment'
          AND l.reference_id = NEW.id
          AND l.entry_type = 'credit_created'
    ), 0) <> NEW.credit_created_minor;
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_payments_no_delete
BEFORE DELETE ON supplier_payments
BEGIN
    SELECT RAISE(ABORT, 'SUPPLIER_PAYMENTS_CANNOT_BE_DELETED');
END;

-- =========================================================
-- 23. Triggers: المصاريف والتحويلات
-- =========================================================

CREATE TRIGGER IF NOT EXISTS trg_expense_payment_post_validate
BEFORE UPDATE OF status ON expense_payments
WHEN OLD.status = 'draft' AND NEW.status = 'posted'
BEGIN
    SELECT RAISE(ABORT, 'EXPENSE_PAYMENT_PERIOD_NOT_OPEN')
    WHERE NEW.accounting_period_id IS NULL
       OR NOT EXISTS (
            SELECT 1 FROM accounting_periods p
            WHERE p.store_id = NEW.store_id
              AND p.id = NEW.accounting_period_id
              AND p.status = 'open'
              AND NEW.payment_at >= p.starts_at
              AND NEW.payment_at < p.ends_at
       );

    SELECT RAISE(ABORT, 'EXPENSE_PAYMENT_SOURCE_MISMATCH')
    WHERE (
        NEW.payment_source = 'money_account'
        AND NOT EXISTS (
            SELECT 1 FROM money_movements m
            WHERE m.store_id = NEW.store_id
              AND m.id = NEW.money_movement_id
              AND m.account_id = NEW.money_account_id
              AND m.amount_delta_minor = -NEW.amount_minor
              AND m.movement_type = 'expense_payment'
              AND m.reference_type = 'expense_payment'
              AND m.reference_id = NEW.id
              AND m.accounting_period_id = NEW.accounting_period_id
        )
    )
    OR (
        NEW.payment_source = 'owner_pocket'
        AND NOT EXISTS (
            SELECT 1 FROM owner_ledger_entries o
            WHERE o.store_id = NEW.store_id
              AND o.id = NEW.owner_ledger_entry_id
              AND o.entry_type = 'owner_paid_expense'
              AND o.owner_liability_delta_minor = NEW.amount_minor
              AND o.equity_delta_minor = 0
              AND o.reference_type = 'expense_payment'
              AND o.reference_id = NEW.id
              AND o.accounting_period_id = NEW.accounting_period_id
        )
    );

    SELECT RAISE(ABORT, 'EXPENSE_OVERPAYMENT')
    WHERE COALESCE((
        SELECT SUM(ep.amount_minor)
        FROM expense_payments ep
        WHERE ep.store_id = NEW.store_id
          AND ep.expense_id = NEW.expense_id
          AND ep.status = 'posted'
          AND ep.id <> NEW.id
    ), 0) + NEW.amount_minor >
    (
        SELECT e.amount_minor
        FROM expenses e
        WHERE e.store_id = NEW.store_id
          AND e.id = NEW.expense_id
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_expense_post_validate
BEFORE UPDATE OF status ON expenses
WHEN OLD.status = 'draft' AND NEW.status = 'posted'
BEGIN
    SELECT RAISE(ABORT, 'EXPENSE_PERIOD_NOT_OPEN')
    WHERE NEW.accounting_period_id IS NULL
       OR NOT EXISTS (
            SELECT 1 FROM accounting_periods p
            WHERE p.store_id = NEW.store_id
              AND p.id = NEW.accounting_period_id
              AND p.status = 'open'
              AND NEW.expense_at >= p.starts_at
              AND NEW.expense_at < p.ends_at
       );

    SELECT RAISE(ABORT, 'PAID_NOW_EXPENSE_REQUIRES_FULL_PAYMENT')
    WHERE NEW.payment_timing = 'paid_now'
      AND NEW.paid_total_minor <> NEW.amount_minor;
END;

CREATE TRIGGER IF NOT EXISTS trg_expenses_no_delete
BEFORE DELETE ON expenses
BEGIN
    SELECT RAISE(ABORT, 'EXPENSES_CANNOT_BE_DELETED');
END;

CREATE TRIGGER IF NOT EXISTS trg_expense_payments_no_delete
BEFORE DELETE ON expense_payments
BEGIN
    SELECT RAISE(ABORT, 'EXPENSE_PAYMENTS_CANNOT_BE_DELETED');
END;

CREATE TRIGGER IF NOT EXISTS trg_money_transfer_post_validate
BEFORE UPDATE OF status ON money_transfers
WHEN OLD.status = 'draft' AND NEW.status = 'posted'
BEGIN
    SELECT RAISE(ABORT, 'MONEY_TRANSFER_PERIOD_NOT_OPEN')
    WHERE NEW.accounting_period_id IS NULL
       OR NOT EXISTS (
            SELECT 1 FROM accounting_periods p
            WHERE p.store_id = NEW.store_id
              AND p.id = NEW.accounting_period_id
              AND p.status = 'open'
              AND NEW.transfer_at >= p.starts_at
              AND NEW.transfer_at < p.ends_at
       );

    SELECT RAISE(ABORT, 'MONEY_TRANSFER_SOURCE_MOVEMENT_MISMATCH')
    WHERE NOT EXISTS (
        SELECT 1 FROM money_movements m
        WHERE m.store_id = NEW.store_id
          AND m.id = NEW.source_movement_id
          AND m.account_id = NEW.source_account_id
          AND m.counter_account_id = NEW.destination_account_id
          AND m.amount_delta_minor = -NEW.amount_minor
          AND m.movement_type = 'internal_transfer'
          AND m.reference_type = 'money_transfer'
          AND m.reference_id = NEW.id
          AND m.accounting_period_id = NEW.accounting_period_id
    );

    SELECT RAISE(ABORT, 'MONEY_TRANSFER_DESTINATION_MOVEMENT_MISMATCH')
    WHERE NOT EXISTS (
        SELECT 1 FROM money_movements m
        WHERE m.store_id = NEW.store_id
          AND m.id = NEW.destination_movement_id
          AND m.account_id = NEW.destination_account_id
          AND m.counter_account_id = NEW.source_account_id
          AND m.amount_delta_minor = NEW.amount_minor
          AND m.movement_type = 'internal_transfer'
          AND m.reference_type = 'money_transfer'
          AND m.reference_id = NEW.id
          AND m.accounting_period_id = NEW.accounting_period_id
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_money_transfers_no_delete
BEFORE DELETE ON money_transfers
BEGIN
    SELECT RAISE(ABORT, 'MONEY_TRANSFERS_CANNOT_BE_DELETED');
END;


-- =========================================================
-- 24. Triggers: مرتجعات العملاء
-- =========================================================

CREATE TRIGGER IF NOT EXISTS trg_sale_return_post_validate
BEFORE UPDATE OF status ON sale_returns
WHEN OLD.status = 'draft' AND NEW.status = 'posted'
BEGIN
    SELECT RAISE(ABORT, 'SALE_RETURN_PERIOD_NOT_OPEN')
    WHERE NEW.accounting_period_id IS NULL
       OR NOT EXISTS (
            SELECT 1 FROM accounting_periods p
            WHERE p.store_id = NEW.store_id
              AND p.id = NEW.accounting_period_id
              AND p.status = 'open'
              AND NEW.return_at >= p.starts_at
              AND NEW.return_at < p.ends_at
       );

    SELECT RAISE(ABORT, 'SALE_RETURN_REQUIRES_POSTED_SALE')
    WHERE NOT EXISTS (
        SELECT 1 FROM sales s
        WHERE s.store_id = NEW.store_id
          AND s.id = NEW.sale_id
          AND s.status IN ('posted', 'corrected')
          AND (
              (s.customer_id IS NULL AND NEW.customer_id IS NULL)
              OR s.customer_id = NEW.customer_id
          )
    );

    SELECT RAISE(ABORT, 'SALE_RETURN_REQUIRES_ITEMS')
    WHERE NOT EXISTS (
        SELECT 1 FROM sale_return_items i
        WHERE i.store_id = NEW.store_id
          AND i.sale_return_id = NEW.id
    );

    SELECT RAISE(ABORT, 'SALE_RETURN_TOTAL_MUST_BE_POSITIVE')
    WHERE NEW.total_minor <= 0;

    SELECT RAISE(ABORT, 'SALE_RETURN_SETTLEMENT_TOTAL_MISMATCH')
    WHERE COALESCE((
        SELECT SUM(s.amount_minor)
        FROM sale_return_settlements s
        WHERE s.store_id = NEW.store_id
          AND s.sale_return_id = NEW.id
    ), 0) <> NEW.total_minor;

    SELECT RAISE(ABORT, 'SALE_RETURN_QUANTITY_EXCEEDS_SOLD')
    WHERE EXISTS (
        SELECT 1
        FROM sale_return_items current_item
        JOIN sale_items original_item
          ON original_item.store_id = current_item.store_id
         AND original_item.id = current_item.sale_item_id
        WHERE current_item.store_id = NEW.store_id
          AND current_item.sale_return_id = NEW.id
          AND (
              COALESCE((
                  SELECT SUM(previous_item.quantity_milli)
                  FROM sale_return_items previous_item
                  JOIN sale_returns previous_return
                    ON previous_return.store_id = previous_item.store_id
                   AND previous_return.id = previous_item.sale_return_id
                  WHERE previous_item.store_id = current_item.store_id
                    AND previous_item.sale_item_id = current_item.sale_item_id
                    AND previous_return.status = 'posted'
                    AND previous_return.id <> NEW.id
              ), 0)
              + current_item.quantity_milli
          ) > original_item.quantity_milli
    );

    SELECT RAISE(ABORT, 'SALEABLE_RETURN_INVENTORY_MISMATCH')
    WHERE EXISTS (
        SELECT 1
        FROM sale_return_items ri
        JOIN sale_items si
          ON si.store_id = ri.store_id
         AND si.id = ri.sale_item_id
        JOIN products pr
          ON pr.store_id = si.store_id
         AND pr.id = si.product_id
        LEFT JOIN inventory_movements im
          ON im.store_id = ri.store_id
         AND im.id = ri.inventory_movement_id
        WHERE ri.store_id = NEW.store_id
          AND ri.sale_return_id = NEW.id
          AND ri.item_condition = 'saleable'
          AND si.is_manual_line = 0
          AND pr.track_inventory = 1
          AND (
              im.id IS NULL
              OR im.product_id <> si.product_id
              OR im.movement_type <> 'customer_return_saleable'
              OR im.quantity_delta_milli <> ri.base_quantity_milli
              OR im.reference_type <> 'sale_return'
              OR im.reference_id <> NEW.id
              OR im.accounting_period_id <> NEW.accounting_period_id
          )
    );

    SELECT RAISE(ABORT, 'DAMAGED_OR_UNTRACKED_RETURN_MUST_NOT_RESTORE_STOCK')
    WHERE EXISTS (
        SELECT 1
        FROM sale_return_items ri
        JOIN sale_items si
          ON si.store_id = ri.store_id
         AND si.id = ri.sale_item_id
        LEFT JOIN products pr
          ON pr.store_id = si.store_id
         AND pr.id = si.product_id
        WHERE ri.store_id = NEW.store_id
          AND ri.sale_return_id = NEW.id
          AND ri.inventory_movement_id IS NOT NULL
          AND (
              ri.item_condition = 'damaged'
              OR si.is_manual_line = 1
              OR COALESCE(pr.track_inventory, 0) = 0
          )
    );

    SELECT RAISE(ABORT, 'ANONYMOUS_RETURN_CANNOT_CREATE_LEDGER_SETTLEMENT')
    WHERE NEW.customer_id IS NULL
      AND EXISTS (
          SELECT 1 FROM sale_return_settlements s
          WHERE s.store_id = NEW.store_id
            AND s.sale_return_id = NEW.id
            AND s.settlement_type <> 'money_refund'
      );

    SELECT RAISE(ABORT, 'SALE_RETURN_SETTLEMENT_LINK_MISMATCH')
    WHERE EXISTS (
        SELECT 1
        FROM sale_return_settlements rs
        LEFT JOIN money_movements mm
          ON mm.store_id = rs.store_id
         AND mm.id = rs.money_movement_id
        LEFT JOIN customer_ledger_entries cl
          ON cl.store_id = rs.store_id
         AND cl.id = rs.customer_ledger_entry_id
        WHERE rs.store_id = NEW.store_id
          AND rs.sale_return_id = NEW.id
          AND (
              (
                  rs.settlement_type = 'money_refund'
                  AND (
                      mm.id IS NULL
                      OR mm.account_id <> rs.money_account_id
                      OR mm.amount_delta_minor <> -rs.amount_minor
                      OR mm.movement_type <> 'customer_refund'
                      OR mm.reference_type <> 'sale_return'
                      OR mm.reference_id <> NEW.id
                      OR mm.accounting_period_id <> NEW.accounting_period_id
                  )
              )
              OR
              (
                  rs.settlement_type = 'reduce_receivable'
                  AND (
                      cl.id IS NULL
                      OR cl.customer_id <> NEW.customer_id
                      OR cl.entry_type <> 'return'
                      OR cl.receivable_delta_minor <> -rs.amount_minor
                      OR cl.credit_delta_minor <> 0
                      OR cl.source_sale_id <> NEW.sale_id
                      OR cl.reference_type <> 'sale_return'
                      OR cl.reference_id <> NEW.id
                      OR cl.accounting_period_id <> NEW.accounting_period_id
                  )
              )
              OR
              (
                  rs.settlement_type = 'customer_credit'
                  AND (
                      cl.id IS NULL
                      OR cl.customer_id <> NEW.customer_id
                      OR cl.entry_type <> 'credit_created'
                      OR cl.receivable_delta_minor <> 0
                      OR cl.credit_delta_minor <> rs.amount_minor
                      OR cl.reference_type <> 'sale_return'
                      OR cl.reference_id <> NEW.id
                      OR cl.accounting_period_id <> NEW.accounting_period_id
                  )
              )
          )
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_returns_no_delete
BEFORE DELETE ON sale_returns
BEGIN
    SELECT RAISE(ABORT, 'SALE_RETURNS_CANNOT_BE_DELETED');
END;

-- =========================================================
-- 25. Triggers: مرتجعات الموردين
-- =========================================================

CREATE TRIGGER IF NOT EXISTS trg_supplier_return_post_validate
BEFORE UPDATE OF status ON supplier_returns
WHEN OLD.status = 'draft' AND NEW.status = 'posted'
BEGIN
    SELECT RAISE(ABORT, 'SUPPLIER_RETURN_PERIOD_NOT_OPEN')
    WHERE NEW.accounting_period_id IS NULL
       OR NOT EXISTS (
            SELECT 1 FROM accounting_periods p
            WHERE p.store_id = NEW.store_id
              AND p.id = NEW.accounting_period_id
              AND p.status = 'open'
              AND NEW.return_at >= p.starts_at
              AND NEW.return_at < p.ends_at
       );

    SELECT RAISE(ABORT, 'SUPPLIER_RETURN_REQUIRES_ITEMS')
    WHERE NOT EXISTS (
        SELECT 1 FROM supplier_return_items i
        WHERE i.store_id = NEW.store_id
          AND i.supplier_return_id = NEW.id
    );

    SELECT RAISE(ABORT, 'SUPPLIER_RETURN_TOTAL_MUST_BE_POSITIVE')
    WHERE NEW.total_minor <= 0;

    SELECT RAISE(ABORT, 'SUPPLIER_RETURN_SETTLEMENT_TOTAL_MISMATCH')
    WHERE COALESCE((
        SELECT SUM(s.amount_minor)
        FROM supplier_return_settlements s
        WHERE s.store_id = NEW.store_id
          AND s.supplier_return_id = NEW.id
    ), 0) <> NEW.total_minor;

    SELECT RAISE(ABORT, 'SUPPLIER_RETURN_INVENTORY_MISMATCH')
    WHERE EXISTS (
        SELECT 1
        FROM supplier_return_items ri
        LEFT JOIN inventory_movements im
          ON im.store_id = ri.store_id
         AND im.id = ri.inventory_movement_id
        WHERE ri.store_id = NEW.store_id
          AND ri.supplier_return_id = NEW.id
          AND (
              im.id IS NULL
              OR im.product_id <> ri.product_id
              OR im.movement_type <> 'supplier_return'
              OR im.quantity_delta_milli <> -ri.base_quantity_milli
              OR im.value_delta_minor <> -ri.line_total_minor
              OR im.reference_type <> 'supplier_return'
              OR im.reference_id <> NEW.id
              OR im.accounting_period_id <> NEW.accounting_period_id
          )
    );

    SELECT RAISE(ABORT, 'SUPPLIER_RETURN_EXCEEDS_RECEIVED_QUANTITY')
    WHERE NEW.purchase_invoice_id IS NOT NULL
      AND EXISTS (
          SELECT 1
          FROM supplier_return_items current_item
          WHERE current_item.store_id = NEW.store_id
            AND current_item.supplier_return_id = NEW.id
            AND (
                COALESCE((
                    SELECT SUM(previous_item.base_quantity_milli)
                    FROM supplier_return_items previous_item
                    JOIN supplier_returns previous_return
                      ON previous_return.store_id = previous_item.store_id
                     AND previous_return.id = previous_item.supplier_return_id
                    WHERE previous_item.store_id = current_item.store_id
                      AND previous_item.product_id = current_item.product_id
                      AND previous_return.purchase_invoice_id = NEW.purchase_invoice_id
                      AND previous_return.status = 'posted'
                      AND previous_return.id <> NEW.id
                ), 0)
                + current_item.base_quantity_milli
            ) >
            COALESCE((
                SELECT SUM(gri.base_quantity_milli)
                FROM goods_receipt_items gri
                JOIN goods_receipts gr
                  ON gr.store_id = gri.store_id
                 AND gr.id = gri.goods_receipt_id
                WHERE gr.store_id = NEW.store_id
                  AND gr.purchase_invoice_id = NEW.purchase_invoice_id
                  AND gr.status = 'posted'
                  AND gri.product_id = current_item.product_id
            ), 0)
      );

    SELECT RAISE(ABORT, 'SUPPLIER_RETURN_SETTLEMENT_LINK_MISMATCH')
    WHERE EXISTS (
        SELECT 1
        FROM supplier_return_settlements rs
        LEFT JOIN money_movements mm
          ON mm.store_id = rs.store_id
         AND mm.id = rs.money_movement_id
        LEFT JOIN supplier_ledger_entries sl
          ON sl.store_id = rs.store_id
         AND sl.id = rs.supplier_ledger_entry_id
        WHERE rs.store_id = NEW.store_id
          AND rs.supplier_return_id = NEW.id
          AND (
              (
                  rs.settlement_type = 'money_refund_received'
                  AND (
                      mm.id IS NULL
                      OR mm.account_id <> rs.money_account_id
                      OR mm.amount_delta_minor <> rs.amount_minor
                      OR mm.movement_type <> 'supplier_refund'
                      OR mm.reference_type <> 'supplier_return'
                      OR mm.reference_id <> NEW.id
                      OR mm.accounting_period_id <> NEW.accounting_period_id
                  )
              )
              OR
              (
                  rs.settlement_type = 'reduce_payable'
                  AND (
                      sl.id IS NULL
                      OR sl.supplier_id <> NEW.supplier_id
                      OR sl.entry_type <> 'return'
                      OR sl.payable_delta_minor <> -rs.amount_minor
                      OR sl.credit_delta_minor <> 0
                      OR (
                          NEW.purchase_invoice_id IS NOT NULL
                          AND sl.source_purchase_invoice_id <> NEW.purchase_invoice_id
                      )
                      OR sl.reference_type <> 'supplier_return'
                      OR sl.reference_id <> NEW.id
                      OR sl.accounting_period_id <> NEW.accounting_period_id
                  )
              )
              OR
              (
                  rs.settlement_type = 'supplier_credit'
                  AND (
                      sl.id IS NULL
                      OR sl.supplier_id <> NEW.supplier_id
                      OR sl.entry_type <> 'credit_created'
                      OR sl.payable_delta_minor <> 0
                      OR sl.credit_delta_minor <> rs.amount_minor
                      OR sl.reference_type <> 'supplier_return'
                      OR sl.reference_id <> NEW.id
                      OR sl.accounting_period_id <> NEW.accounting_period_id
                  )
              )
          )
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_returns_no_delete
BEFORE DELETE ON supplier_returns
BEGIN
    SELECT RAISE(ABORT, 'SUPPLIER_RETURNS_CANNOT_BE_DELETED');
END;

-- =========================================================
-- 26. Triggers: الجرد
-- =========================================================

CREATE TRIGGER IF NOT EXISTS trg_stock_count_post_validate
BEFORE UPDATE OF status ON stock_counts
WHEN OLD.status IN ('draft', 'counting') AND NEW.status = 'posted'
BEGIN
    SELECT RAISE(ABORT, 'STOCK_COUNT_PERIOD_NOT_OPEN')
    WHERE NEW.accounting_period_id IS NULL
       OR NOT EXISTS (
            SELECT 1 FROM accounting_periods p
            WHERE p.store_id = NEW.store_id
              AND p.id = NEW.accounting_period_id
              AND p.status = 'open'
              AND NEW.completed_at >= p.starts_at
              AND NEW.completed_at < p.ends_at
       );

    SELECT RAISE(ABORT, 'STOCK_COUNT_REQUIRES_ITEMS')
    WHERE NOT EXISTS (
        SELECT 1 FROM stock_count_items i
        WHERE i.store_id = NEW.store_id
          AND i.stock_count_id = NEW.id
    );

    SELECT RAISE(ABORT, 'STOCK_COUNT_ADJUSTMENT_MISMATCH')
    WHERE EXISTS (
        SELECT 1
        FROM stock_count_items ci
        LEFT JOIN inventory_movements im
          ON im.store_id = ci.store_id
         AND im.id = ci.adjustment_movement_id
        WHERE ci.store_id = NEW.store_id
          AND ci.stock_count_id = NEW.id
          AND (
              (ci.difference_milli = 0 AND ci.adjustment_movement_id IS NOT NULL)
              OR
              (
                  ci.difference_milli <> 0
                  AND (
                      im.id IS NULL
                      OR im.product_id <> ci.product_id
                      OR im.movement_type <> 'stock_count'
                      OR im.quantity_delta_milli <> ci.difference_milli
                      OR im.reference_type <> 'stock_count'
                      OR im.reference_id <> NEW.id
                      OR im.accounting_period_id <> NEW.accounting_period_id
                  )
              )
          )
    );

    SELECT RAISE(ABORT, 'FULL_STOCK_COUNT_MISSING_ACTIVE_PRODUCT')
    WHERE NEW.count_type = 'full'
      AND EXISTS (
          SELECT 1
          FROM products p
          WHERE p.store_id = NEW.store_id
            AND p.status = 'active'
            AND p.track_inventory = 1
            AND NOT EXISTS (
                SELECT 1
                FROM stock_count_items ci
                WHERE ci.store_id = NEW.store_id
                  AND ci.stock_count_id = NEW.id
                  AND ci.product_id = p.id
            )
      );
END;

CREATE TRIGGER IF NOT EXISTS trg_stock_counts_no_delete
BEFORE DELETE ON stock_counts
BEGIN
    SELECT RAISE(ABORT, 'STOCK_COUNTS_CANNOT_BE_DELETED');
END;


-- =========================================================
-- 27. Triggers: الفترات والوحدات وقواعد عامة
-- =========================================================

CREATE TRIGGER IF NOT EXISTS trg_accounting_period_no_overlap_insert
BEFORE INSERT ON accounting_periods
BEGIN
    SELECT RAISE(ABORT, 'ACCOUNTING_PERIOD_OVERLAP')
    WHERE EXISTS (
        SELECT 1
        FROM accounting_periods p
        WHERE p.store_id = NEW.store_id
          AND NEW.starts_at < p.ends_at
          AND NEW.ends_at > p.starts_at
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_accounting_period_no_overlap_update
BEFORE UPDATE OF starts_at, ends_at ON accounting_periods
BEGIN
    SELECT RAISE(ABORT, 'CLOSED_PERIOD_DATES_IMMUTABLE')
    WHERE OLD.status = 'closed';

    SELECT RAISE(ABORT, 'ACCOUNTING_PERIOD_OVERLAP')
    WHERE EXISTS (
        SELECT 1
        FROM accounting_periods p
        WHERE p.store_id = NEW.store_id
          AND p.id <> NEW.id
          AND NEW.starts_at < p.ends_at
          AND NEW.ends_at > p.starts_at
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_accounting_period_close_validate
BEFORE UPDATE OF status ON accounting_periods
WHEN OLD.status IN ('open', 'closing') AND NEW.status = 'closed'
BEGIN
    SELECT RAISE(ABORT, 'PERIOD_HAS_PENDING_COST_SALES')
    WHERE EXISTS (
        SELECT 1
        FROM sales s
        WHERE s.store_id = NEW.store_id
          AND s.accounting_period_id = NEW.id
          AND s.status IN ('posted', 'corrected')
          AND s.pending_cost_line_count > 0
    );

    SELECT RAISE(ABORT, 'PERIOD_HAS_PENDING_INVENTORY_COST')
    WHERE EXISTS (
        SELECT 1
        FROM inventory_movements im
        WHERE im.store_id = NEW.store_id
          AND im.accounting_period_id = NEW.id
          AND im.has_pending_cost_after = 1
    );

    SELECT RAISE(ABORT, 'PERIOD_CLOSE_TIME_REQUIRED')
    WHERE NEW.closed_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_accounting_period_no_reopen
BEFORE UPDATE OF status ON accounting_periods
WHEN OLD.status = 'closed' AND NEW.status <> 'closed'
BEGIN
    SELECT RAISE(ABORT, 'CLOSED_PERIOD_CANNOT_BE_REOPENED');
END;

CREATE TRIGGER IF NOT EXISTS trg_accounting_periods_no_delete
BEFORE DELETE ON accounting_periods
BEGIN
    SELECT RAISE(ABORT, 'ACCOUNTING_PERIODS_CANNOT_BE_DELETED');
END;

CREATE TRIGGER IF NOT EXISTS trg_product_unit_nonbase_requires_base
BEFORE INSERT ON product_units
WHEN NEW.is_base = 0 AND NEW.status = 'active'
BEGIN
    SELECT RAISE(ABORT, 'BASE_UNIT_REQUIRED_BEFORE_CONVERSION_UNIT')
    WHERE NOT EXISTS (
        SELECT 1 FROM product_units u
        WHERE u.store_id = NEW.store_id
          AND u.product_id = NEW.product_id
          AND u.is_base = 1
          AND u.status = 'active'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_product_base_unit_cannot_archive_with_active_conversions
BEFORE UPDATE OF status ON product_units
WHEN OLD.is_base = 1 AND OLD.status = 'active' AND NEW.status = 'archived'
BEGIN
    SELECT RAISE(ABORT, 'BASE_UNIT_CANNOT_BE_ARCHIVED_WITH_ACTIVE_CONVERSIONS')
    WHERE EXISTS (
        SELECT 1 FROM product_units u
        WHERE u.store_id = OLD.store_id
          AND u.product_id = OLD.product_id
          AND u.id <> OLD.id
          AND u.status = 'active'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_product_units_used_cannot_delete
BEFORE DELETE ON product_units
BEGIN
    SELECT RAISE(ABORT, 'PRODUCT_UNITS_CANNOT_BE_DELETED_USE_ARCHIVE');
END;

CREATE TRIGGER IF NOT EXISTS trg_customers_no_delete
BEFORE DELETE ON customers
BEGIN
    SELECT RAISE(ABORT, 'CUSTOMERS_CANNOT_BE_DELETED_USE_ARCHIVE');
END;

CREATE TRIGGER IF NOT EXISTS trg_suppliers_no_delete
BEFORE DELETE ON suppliers
BEGIN
    SELECT RAISE(ABORT, 'SUPPLIERS_CANNOT_BE_DELETED_USE_ARCHIVE');
END;

CREATE TRIGGER IF NOT EXISTS trg_products_no_delete
BEFORE DELETE ON products
BEGIN
    SELECT RAISE(ABORT, 'PRODUCTS_CANNOT_BE_DELETED_USE_ARCHIVE');
END;

CREATE TRIGGER IF NOT EXISTS trg_money_accounts_no_delete
BEFORE DELETE ON money_accounts
BEGIN
    SELECT RAISE(ABORT, 'MONEY_ACCOUNTS_CANNOT_BE_DELETED_USE_ARCHIVE');
END;

-- فحوص تشغيلية يوصى بتنفيذها في الاختبارات والنسخ الاحتياطي:
-- PRAGMA quick_check;
-- PRAGMA integrity_check;
-- PRAGMA foreign_key_check;

-- =========================================================
-- 28. Hardening v1.1: اتساق المبالغ والتخصيصات وحالات الاعتماد
-- =========================================================

-- يسمح بفارق نصف أصغر وحدة نقدية قبل التقريب إلى INTEGER.
CREATE TRIGGER IF NOT EXISTS trg_purchase_item_amount_consistency_insert
BEFORE INSERT ON purchase_items
BEGIN
    SELECT RAISE(ABORT, 'PURCHASE_ITEM_GROSS_AMOUNT_MISMATCH')
    WHERE ABS(NEW.line_gross_minor * 1000 - NEW.quantity_milli * NEW.unit_cost_minor) > 500;
END;

CREATE TRIGGER IF NOT EXISTS trg_purchase_item_amount_consistency_update
BEFORE UPDATE OF quantity_milli, unit_cost_minor, line_gross_minor ON purchase_items
BEGIN
    SELECT RAISE(ABORT, 'PURCHASE_ITEM_GROSS_AMOUNT_MISMATCH')
    WHERE ABS(NEW.line_gross_minor * 1000 - NEW.quantity_milli * NEW.unit_cost_minor) > 500;
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_item_amount_consistency_insert
BEFORE INSERT ON sale_items
BEGIN
    SELECT RAISE(ABORT, 'SALE_ITEM_GROSS_AMOUNT_MISMATCH')
    WHERE ABS(NEW.line_gross_minor * 1000 - NEW.quantity_milli * NEW.unit_price_minor) > 500;
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_item_amount_consistency_update
BEFORE UPDATE OF quantity_milli, unit_price_minor, line_gross_minor ON sale_items
BEGIN
    SELECT RAISE(ABORT, 'SALE_ITEM_GROSS_AMOUNT_MISMATCH')
    WHERE ABS(NEW.line_gross_minor * 1000 - NEW.quantity_milli * NEW.unit_price_minor) > 500;
END;

CREATE TRIGGER IF NOT EXISTS trg_goods_receipt_item_consistency_insert
BEFORE INSERT ON goods_receipt_items
BEGIN
    SELECT RAISE(ABORT, 'GOODS_RECEIPT_ITEM_AMOUNT_MISMATCH')
    WHERE ABS(NEW.line_total_minor * 1000 - NEW.quantity_milli * NEW.unit_cost_minor) > 500;

    SELECT RAISE(ABORT, 'GOODS_RECEIPT_PURCHASE_ITEM_DETAILS_MISMATCH')
    WHERE NEW.purchase_item_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM purchase_items pi
        WHERE pi.store_id = NEW.store_id
          AND pi.id = NEW.purchase_item_id
          AND pi.product_id = NEW.product_id
          AND pi.product_unit_id = NEW.product_unit_id
          AND pi.conversion_factor_num = NEW.conversion_factor_num
          AND pi.conversion_factor_den = NEW.conversion_factor_den
          AND pi.unit_cost_minor = NEW.unit_cost_minor
      );
END;

CREATE TRIGGER IF NOT EXISTS trg_goods_receipt_item_consistency_update
BEFORE UPDATE OF purchase_item_id, product_id, product_unit_id, quantity_milli,
                 conversion_factor_num, conversion_factor_den, unit_cost_minor, line_total_minor
ON goods_receipt_items
BEGIN
    SELECT RAISE(ABORT, 'GOODS_RECEIPT_ITEM_AMOUNT_MISMATCH')
    WHERE ABS(NEW.line_total_minor * 1000 - NEW.quantity_milli * NEW.unit_cost_minor) > 500;

    SELECT RAISE(ABORT, 'GOODS_RECEIPT_PURCHASE_ITEM_DETAILS_MISMATCH')
    WHERE NEW.purchase_item_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM purchase_items pi
        WHERE pi.store_id = NEW.store_id
          AND pi.id = NEW.purchase_item_id
          AND pi.product_id = NEW.product_id
          AND pi.product_unit_id = NEW.product_unit_id
          AND pi.conversion_factor_num = NEW.conversion_factor_num
          AND pi.conversion_factor_den = NEW.conversion_factor_den
          AND pi.unit_cost_minor = NEW.unit_cost_minor
      );
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_return_item_amount_consistency_insert
BEFORE INSERT ON supplier_return_items
BEGIN
    SELECT RAISE(ABORT, 'SUPPLIER_RETURN_ITEM_AMOUNT_MISMATCH')
    WHERE ABS(NEW.line_total_minor * 1000 - NEW.quantity_milli * NEW.unit_cost_minor) > 500;
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_return_item_amount_consistency_update
BEFORE UPDATE OF quantity_milli, unit_cost_minor, line_total_minor ON supplier_return_items
BEGIN
    SELECT RAISE(ABORT, 'SUPPLIER_RETURN_ITEM_AMOUNT_MISMATCH')
    WHERE ABS(NEW.line_total_minor * 1000 - NEW.quantity_milli * NEW.unit_cost_minor) > 500;
END;

-- كمية المرتجع وقيمته يجب أن تكونا متناسبتين مع بند البيع الأصلي.
CREATE TRIGGER IF NOT EXISTS trg_sale_return_item_consistency_insert
BEFORE INSERT ON sale_return_items
BEGIN
    SELECT RAISE(ABORT, 'SALE_RETURN_ITEM_NOT_FROM_ORIGINAL_SALE')
    WHERE NOT EXISTS (
        SELECT 1
        FROM sale_returns sr
        JOIN sale_items si
          ON si.store_id = sr.store_id
         AND si.sale_id = sr.sale_id
         AND si.id = NEW.sale_item_id
        WHERE sr.store_id = NEW.store_id
          AND sr.id = NEW.sale_return_id
    );

    SELECT RAISE(ABORT, 'SALE_RETURN_REFUND_EXCEEDS_PROPORTIONAL_VALUE')
    WHERE EXISTS (
        SELECT 1
        FROM sale_items si
        WHERE si.store_id = NEW.store_id
          AND si.id = NEW.sale_item_id
          AND NEW.line_refund_minor * si.quantity_milli
              > NEW.quantity_milli * si.line_total_minor + si.quantity_milli
    );

    SELECT RAISE(ABORT, 'SALE_RETURN_BASE_QUANTITY_MISMATCH')
    WHERE EXISTS (
        SELECT 1
        FROM sale_items si
        JOIN products p
          ON p.store_id = si.store_id
         AND p.id = si.product_id
        WHERE si.store_id = NEW.store_id
          AND si.id = NEW.sale_item_id
          AND si.is_manual_line = 0
          AND p.track_inventory = 1
          AND (
              NEW.base_quantity_milli IS NULL
              OR NEW.base_quantity_milli * si.quantity_milli
                 <> NEW.quantity_milli * si.base_quantity_milli
          )
    );

    SELECT RAISE(ABORT, 'UNTRACKED_RETURN_MUST_NOT_HAVE_BASE_QUANTITY')
    WHERE EXISTS (
        SELECT 1
        FROM sale_items si
        LEFT JOIN products p
          ON p.store_id = si.store_id
         AND p.id = si.product_id
        WHERE si.store_id = NEW.store_id
          AND si.id = NEW.sale_item_id
          AND (si.is_manual_line = 1 OR COALESCE(p.track_inventory, 0) = 0)
          AND NEW.base_quantity_milli IS NOT NULL
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_return_item_consistency_update
BEFORE UPDATE OF sale_return_id, sale_item_id, quantity_milli, base_quantity_milli, line_refund_minor
ON sale_return_items
BEGIN
    SELECT RAISE(ABORT, 'SALE_RETURN_ITEM_NOT_FROM_ORIGINAL_SALE')
    WHERE NOT EXISTS (
        SELECT 1
        FROM sale_returns sr
        JOIN sale_items si
          ON si.store_id = sr.store_id
         AND si.sale_id = sr.sale_id
         AND si.id = NEW.sale_item_id
        WHERE sr.store_id = NEW.store_id
          AND sr.id = NEW.sale_return_id
    );

    SELECT RAISE(ABORT, 'SALE_RETURN_REFUND_EXCEEDS_PROPORTIONAL_VALUE')
    WHERE EXISTS (
        SELECT 1
        FROM sale_items si
        WHERE si.store_id = NEW.store_id
          AND si.id = NEW.sale_item_id
          AND NEW.line_refund_minor * si.quantity_milli
              > NEW.quantity_milli * si.line_total_minor + si.quantity_milli
    );

    SELECT RAISE(ABORT, 'SALE_RETURN_BASE_QUANTITY_MISMATCH')
    WHERE EXISTS (
        SELECT 1
        FROM sale_items si
        JOIN products p
          ON p.store_id = si.store_id
         AND p.id = si.product_id
        WHERE si.store_id = NEW.store_id
          AND si.id = NEW.sale_item_id
          AND si.is_manual_line = 0
          AND p.track_inventory = 1
          AND (
              NEW.base_quantity_milli IS NULL
              OR NEW.base_quantity_milli * si.quantity_milli
                 <> NEW.quantity_milli * si.base_quantity_milli
          )
    );
END;

-- لا يسمح بتخصيص دفعة على فاتورة بأكثر من رصيدها قبل الدفعة الحالية.
CREATE TRIGGER IF NOT EXISTS trg_customer_payment_outstanding_validate
BEFORE UPDATE OF status ON customer_payments
WHEN OLD.status = 'draft' AND NEW.status = 'posted'
BEGIN
    SELECT RAISE(ABORT, 'CUSTOMER_ALLOCATION_EXCEEDS_INVOICE_OUTSTANDING')
    WHERE EXISTS (
        SELECT 1
        FROM customer_payment_allocations a
        WHERE a.store_id = NEW.store_id
          AND a.customer_payment_id = NEW.id
          AND a.amount_minor > COALESCE((
              SELECT SUM(l.receivable_delta_minor)
              FROM customer_ledger_entries l
              WHERE l.store_id = NEW.store_id
                AND l.customer_id = NEW.customer_id
                AND l.source_sale_id = a.sale_id
                AND NOT (
                    l.reference_type = 'customer_payment'
                    AND l.reference_id = NEW.id
                )
          ), 0)
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_payment_outstanding_validate
BEFORE UPDATE OF status ON supplier_payments
WHEN OLD.status = 'draft' AND NEW.status = 'posted'
BEGIN
    SELECT RAISE(ABORT, 'SUPPLIER_ALLOCATION_EXCEEDS_INVOICE_OUTSTANDING')
    WHERE EXISTS (
        SELECT 1
        FROM supplier_payment_allocations a
        WHERE a.store_id = NEW.store_id
          AND a.supplier_payment_id = NEW.id
          AND a.amount_minor > COALESCE((
              SELECT SUM(l.payable_delta_minor)
              FROM supplier_ledger_entries l
              WHERE l.store_id = NEW.store_id
                AND l.supplier_id = NEW.supplier_id
                AND l.source_purchase_invoice_id = a.purchase_invoice_id
                AND NOT (
                    l.reference_type = 'supplier_payment'
                    AND l.reference_id = NEW.id
                )
          ), 0)
    );
END;

-- المرتجع لا يخفض دينًا أكبر من الرصيد السابق للعملية الحالية.
CREATE TRIGGER IF NOT EXISTS trg_sale_return_receivable_validate
BEFORE UPDATE OF status ON sale_returns
WHEN OLD.status = 'draft' AND NEW.status = 'posted'
BEGIN
    SELECT RAISE(ABORT, 'SALE_RETURN_REDUCES_MORE_THAN_OUTSTANDING')
    WHERE COALESCE((
        SELECT SUM(s.amount_minor)
        FROM sale_return_settlements s
        WHERE s.store_id = NEW.store_id
          AND s.sale_return_id = NEW.id
          AND s.settlement_type = 'reduce_receivable'
    ), 0) > COALESCE((
        SELECT SUM(l.receivable_delta_minor)
        FROM customer_ledger_entries l
        WHERE l.store_id = NEW.store_id
          AND l.customer_id = NEW.customer_id
          AND l.source_sale_id = NEW.sale_id
          AND NOT (
              l.reference_type = 'sale_return'
              AND l.reference_id = NEW.id
          )
    ), 0);
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_return_payable_validate
BEFORE UPDATE OF status ON supplier_returns
WHEN OLD.status = 'draft' AND NEW.status = 'posted'
BEGIN
    SELECT RAISE(ABORT, 'SUPPLIER_RETURN_REDUCES_MORE_THAN_PAYABLE')
    WHERE NEW.purchase_invoice_id IS NOT NULL
      AND COALESCE((
        SELECT SUM(s.amount_minor)
        FROM supplier_return_settlements s
        WHERE s.store_id = NEW.store_id
          AND s.supplier_return_id = NEW.id
          AND s.settlement_type = 'reduce_payable'
      ), 0) > COALESCE((
        SELECT SUM(l.payable_delta_minor)
        FROM supplier_ledger_entries l
        WHERE l.store_id = NEW.store_id
          AND l.supplier_id = NEW.supplier_id
          AND l.source_purchase_invoice_id = NEW.purchase_invoice_id
          AND NOT (
              l.reference_type = 'supplier_return'
              AND l.reference_id = NEW.id
          )
      ), 0);
END;

-- إغلاق فاتورة الشراء يعني اكتمال استلام جميع البنود.
CREATE TRIGGER IF NOT EXISTS trg_purchase_invoice_close_validate
BEFORE UPDATE OF status ON purchase_invoices
WHEN OLD.status = 'open' AND NEW.status = 'closed'
BEGIN
    SELECT RAISE(ABORT, 'PURCHASE_INVOICE_NOT_FULLY_RECEIVED')
    WHERE EXISTS (
        SELECT 1
        FROM purchase_items pi
        WHERE pi.store_id = NEW.store_id
          AND pi.purchase_invoice_id = NEW.id
          AND COALESCE((
              SELECT SUM(gri.base_quantity_milli)
              FROM goods_receipt_items gri
              JOIN goods_receipts gr
                ON gr.store_id = gri.store_id
               AND gr.id = gri.goods_receipt_id
              WHERE gri.store_id = pi.store_id
                AND gri.purchase_item_id = pi.id
                AND gr.status = 'posted'
          ), 0) < pi.base_quantity_milli
    );
END;

-- عند سياسة block يمنع تجاوز حد الدين، أما warn فيبقى قرار واجهة المستخدم.
CREATE TRIGGER IF NOT EXISTS trg_sale_credit_limit_block
BEFORE UPDATE OF status ON sales
WHEN OLD.status = 'draft' AND NEW.status = 'posted' AND NEW.credit_total_minor > 0
BEGIN
    SELECT RAISE(ABORT, 'CUSTOMER_CREDIT_LIMIT_EXCEEDED')
    WHERE COALESCE((
        SELECT c.credit_policy
        FROM customers c
        WHERE c.store_id = NEW.store_id AND c.id = NEW.customer_id
    ), (
        SELECT s.default_credit_policy
        FROM app_settings s
        WHERE s.store_id = NEW.store_id
    ), 'warn') = 'block'
    AND COALESCE((
        SELECT c.credit_limit_minor
        FROM customers c
        WHERE c.store_id = NEW.store_id AND c.id = NEW.customer_id
    ), (
        SELECT s.default_credit_limit_minor
        FROM app_settings s
        WHERE s.store_id = NEW.store_id
    )) IS NOT NULL
    AND COALESCE((
        SELECT b.net_due_minor
        FROM v_customer_balances b
        WHERE b.store_id = NEW.store_id AND b.customer_id = NEW.customer_id
    ), 0) > COALESCE((
        SELECT c.credit_limit_minor
        FROM customers c
        WHERE c.store_id = NEW.store_id AND c.id = NEW.customer_id
    ), (
        SELECT s.default_credit_limit_minor
        FROM app_settings s
        WHERE s.store_id = NEW.store_id
    ));
END;

-- انتقالات الحالات تمنع إلغاء عملية معتمدة دون حركة عكسية مستقلة.
CREATE TRIGGER IF NOT EXISTS trg_sales_status_transition
BEFORE UPDATE OF status ON sales
WHEN NEW.status <> OLD.status
BEGIN
    SELECT RAISE(ABORT, 'INVALID_SALE_STATUS_TRANSITION')
    WHERE NOT (
        (OLD.status = 'draft' AND NEW.status IN ('posted', 'cancelled'))
        OR
        (OLD.status = 'posted' AND NEW.status IN ('corrected', 'cancelled') AND NEW.reversed_by_id IS NOT NULL)
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_purchase_invoice_status_transition
BEFORE UPDATE OF status ON purchase_invoices
WHEN NEW.status <> OLD.status
BEGIN
    SELECT RAISE(ABORT, 'INVALID_PURCHASE_INVOICE_STATUS_TRANSITION')
    WHERE NOT (
        (OLD.status = 'draft' AND NEW.status IN ('open', 'cancelled'))
        OR
        (OLD.status = 'open' AND NEW.status = 'closed')
        OR
        (OLD.status = 'open' AND NEW.status = 'cancelled'
         AND NOT EXISTS (
            SELECT 1 FROM goods_receipts gr
            WHERE gr.store_id = OLD.store_id
              AND gr.purchase_invoice_id = OLD.id
              AND gr.status = 'posted'
         ))
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_goods_receipt_status_transition
BEFORE UPDATE OF status ON goods_receipts
WHEN NEW.status <> OLD.status
BEGIN
    SELECT RAISE(ABORT, 'INVALID_GOODS_RECEIPT_STATUS_TRANSITION')
    WHERE NOT (OLD.status = 'draft' AND NEW.status IN ('posted', 'cancelled'));
END;

CREATE TRIGGER IF NOT EXISTS trg_customer_payment_status_transition
BEFORE UPDATE OF status ON customer_payments
WHEN NEW.status <> OLD.status
BEGIN
    SELECT RAISE(ABORT, 'INVALID_CUSTOMER_PAYMENT_STATUS_TRANSITION')
    WHERE NOT (OLD.status = 'draft' AND NEW.status IN ('posted', 'cancelled'));
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_payment_status_transition
BEFORE UPDATE OF status ON supplier_payments
WHEN NEW.status <> OLD.status
BEGIN
    SELECT RAISE(ABORT, 'INVALID_SUPPLIER_PAYMENT_STATUS_TRANSITION')
    WHERE NOT (OLD.status = 'draft' AND NEW.status IN ('posted', 'cancelled'));
END;

CREATE TRIGGER IF NOT EXISTS trg_expense_status_transition
BEFORE UPDATE OF status ON expenses
WHEN NEW.status <> OLD.status
BEGIN
    SELECT RAISE(ABORT, 'INVALID_EXPENSE_STATUS_TRANSITION')
    WHERE NOT (OLD.status = 'draft' AND NEW.status IN ('posted', 'cancelled'));
END;

CREATE TRIGGER IF NOT EXISTS trg_expense_payment_status_transition
BEFORE UPDATE OF status ON expense_payments
WHEN NEW.status <> OLD.status
BEGIN
    SELECT RAISE(ABORT, 'INVALID_EXPENSE_PAYMENT_STATUS_TRANSITION')
    WHERE NOT (OLD.status = 'draft' AND NEW.status IN ('posted', 'cancelled'));
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_return_status_transition
BEFORE UPDATE OF status ON sale_returns
WHEN NEW.status <> OLD.status
BEGIN
    SELECT RAISE(ABORT, 'INVALID_SALE_RETURN_STATUS_TRANSITION')
    WHERE NOT (OLD.status = 'draft' AND NEW.status IN ('posted', 'cancelled'));
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_return_status_transition
BEFORE UPDATE OF status ON supplier_returns
WHEN NEW.status <> OLD.status
BEGIN
    SELECT RAISE(ABORT, 'INVALID_SUPPLIER_RETURN_STATUS_TRANSITION')
    WHERE NOT (OLD.status = 'draft' AND NEW.status IN ('posted', 'cancelled'));
END;

CREATE TRIGGER IF NOT EXISTS trg_money_transfer_status_transition
BEFORE UPDATE OF status ON money_transfers
WHEN NEW.status <> OLD.status
BEGIN
    SELECT RAISE(ABORT, 'INVALID_MONEY_TRANSFER_STATUS_TRANSITION')
    WHERE NOT (OLD.status = 'draft' AND NEW.status IN ('posted', 'cancelled'));
END;

CREATE TRIGGER IF NOT EXISTS trg_stock_count_status_transition
BEFORE UPDATE OF status ON stock_counts
WHEN NEW.status <> OLD.status
BEGIN
    SELECT RAISE(ABORT, 'INVALID_STOCK_COUNT_STATUS_TRANSITION')
    WHERE NOT (
        (OLD.status = 'draft' AND NEW.status IN ('counting', 'posted', 'cancelled'))
        OR (OLD.status = 'counting' AND NEW.status IN ('posted', 'cancelled'))
    );
END;

-- العمليات المعتمدة رؤوسها غير قابلة للتعديل؛ التصحيح يتم بمستند جديد.
CREATE TRIGGER IF NOT EXISTS trg_goods_receipt_final_immutable
BEFORE UPDATE ON goods_receipts
WHEN OLD.status <> 'draft' AND (
    NEW.store_id <> OLD.store_id OR
    NEW.supplier_id <> OLD.supplier_id OR
    NEW.purchase_invoice_id IS NOT OLD.purchase_invoice_id OR
    NEW.accounting_period_id IS NOT OLD.accounting_period_id OR
    NEW.display_number <> OLD.display_number OR
    NEW.received_at <> OLD.received_at OR
    NEW.total_cost_minor <> OLD.total_cost_minor
)
BEGIN
    SELECT RAISE(ABORT, 'POSTED_GOODS_RECEIPT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_customer_payment_final_immutable
BEFORE UPDATE ON customer_payments
WHEN OLD.status <> 'draft' AND (
    NEW.customer_id <> OLD.customer_id OR
    NEW.accounting_period_id IS NOT OLD.accounting_period_id OR
    NEW.money_account_id <> OLD.money_account_id OR
    NEW.amount_minor <> OLD.amount_minor OR
    NEW.allocated_total_minor <> OLD.allocated_total_minor OR
    NEW.credit_created_minor <> OLD.credit_created_minor OR
    NEW.payment_at <> OLD.payment_at
)
BEGIN
    SELECT RAISE(ABORT, 'POSTED_CUSTOMER_PAYMENT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_payment_final_immutable
BEFORE UPDATE ON supplier_payments
WHEN OLD.status <> 'draft' AND (
    NEW.supplier_id <> OLD.supplier_id OR
    NEW.accounting_period_id IS NOT OLD.accounting_period_id OR
    NEW.amount_minor <> OLD.amount_minor OR
    NEW.allocated_total_minor <> OLD.allocated_total_minor OR
    NEW.credit_created_minor <> OLD.credit_created_minor OR
    NEW.payment_source <> OLD.payment_source OR
    NEW.money_account_id IS NOT OLD.money_account_id OR
    NEW.payment_at <> OLD.payment_at
)
BEGIN
    SELECT RAISE(ABORT, 'POSTED_SUPPLIER_PAYMENT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_expense_final_immutable
BEFORE UPDATE ON expenses
WHEN OLD.status <> 'draft' AND (
    NEW.category_id IS NOT OLD.category_id OR
    NEW.accounting_period_id IS NOT OLD.accounting_period_id OR
    NEW.description <> OLD.description OR
    NEW.amount_minor <> OLD.amount_minor OR
    NEW.expense_at <> OLD.expense_at OR
    NEW.due_at IS NOT OLD.due_at OR
    NEW.payment_timing <> OLD.payment_timing
)
BEGIN
    SELECT RAISE(ABORT, 'POSTED_EXPENSE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_expense_payment_final_immutable
BEFORE UPDATE ON expense_payments
WHEN OLD.status <> 'draft' AND (
    NEW.expense_id <> OLD.expense_id OR
    NEW.accounting_period_id IS NOT OLD.accounting_period_id OR
    NEW.amount_minor <> OLD.amount_minor OR
    NEW.payment_source <> OLD.payment_source OR
    NEW.money_account_id IS NOT OLD.money_account_id OR
    NEW.payment_at <> OLD.payment_at
)
BEGIN
    SELECT RAISE(ABORT, 'POSTED_EXPENSE_PAYMENT_IMMUTABLE');
END;

-- فهارس للاستعلامات الأكثر تكرارًا في دفتر الفواتير والتخصيصات.
CREATE INDEX IF NOT EXISTS idx_customer_ledger_sale
ON customer_ledger_entries(store_id, source_sale_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_supplier_ledger_purchase
ON supplier_ledger_entries(store_id, source_purchase_invoice_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_customer_allocations_sale
ON customer_payment_allocations(store_id, sale_id);

CREATE INDEX IF NOT EXISTS idx_supplier_allocations_invoice
ON supplier_payment_allocations(store_id, purchase_invoice_id);

CREATE INDEX IF NOT EXISTS idx_goods_receipt_items_purchase_item
ON goods_receipt_items(store_id, purchase_item_id);

-- تقوية إلغاء/تصحيح البيع المعتمد: يجب إنشاء حركات عكسية كاملة أولًا.
DROP TRIGGER IF EXISTS trg_sales_status_transition;
CREATE TRIGGER trg_sales_status_transition
BEFORE UPDATE OF status ON sales
WHEN NEW.status <> OLD.status
BEGIN
    SELECT RAISE(ABORT, 'INVALID_SALE_STATUS_TRANSITION')
    WHERE NOT (
        (OLD.status = 'draft' AND NEW.status IN ('posted', 'cancelled'))
        OR
        (
            OLD.status = 'posted'
            AND NEW.status IN ('cancelled', 'corrected')
            AND NOT EXISTS (
                SELECT 1
                FROM sale_payments sp
                JOIN money_movements original_movement
                  ON original_movement.store_id = sp.store_id
                 AND original_movement.id = sp.money_movement_id
                WHERE sp.store_id = OLD.store_id
                  AND sp.sale_id = OLD.id
                  AND NOT EXISTS (
                      SELECT 1
                      FROM money_movements reversal_movement
                      WHERE reversal_movement.store_id = original_movement.store_id
                        AND reversal_movement.reversal_of_id = original_movement.id
                        AND reversal_movement.amount_delta_minor = -original_movement.amount_delta_minor
                  )
            )
            AND NOT EXISTS (
                SELECT 1
                FROM sale_items si
                JOIN inventory_movements original_inventory
                  ON original_inventory.store_id = si.store_id
                 AND original_inventory.id = si.inventory_movement_id
                WHERE si.store_id = OLD.store_id
                  AND si.sale_id = OLD.id
                  AND si.inventory_movement_id IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1
                      FROM inventory_movements reversal_inventory
                      WHERE reversal_inventory.store_id = original_inventory.store_id
                        AND reversal_inventory.reversal_of_id = original_inventory.id
                        AND reversal_inventory.quantity_delta_milli = -original_inventory.quantity_delta_milli
                        AND reversal_inventory.value_delta_minor = -original_inventory.value_delta_minor
                  )
            )
            AND NOT EXISTS (
                SELECT 1
                FROM customer_ledger_entries original_ledger
                WHERE original_ledger.store_id = OLD.store_id
                  AND original_ledger.reference_type = 'sale'
                  AND original_ledger.reference_id = OLD.id
                  AND NOT EXISTS (
                      SELECT 1
                      FROM customer_ledger_entries reversal_ledger
                      WHERE reversal_ledger.store_id = original_ledger.store_id
                        AND reversal_ledger.reversal_of_id = original_ledger.id
                        AND reversal_ledger.receivable_delta_minor = -original_ledger.receivable_delta_minor
                        AND reversal_ledger.credit_delta_minor = -original_ledger.credit_delta_minor
                  )
            )
            AND (
                NEW.status = 'cancelled'
                OR EXISTS (
                    SELECT 1
                    FROM sales replacement
                    WHERE replacement.store_id = OLD.store_id
                      AND replacement.id = NEW.reversed_by_id
                      AND replacement.correction_of_id = OLD.id
                      AND replacement.status = 'posted'
                )
            )
        )
    );
END;

-- Final recommended checks:
-- PRAGMA quick_check;
-- PRAGMA integrity_check;
-- PRAGMA foreign_key_check;
