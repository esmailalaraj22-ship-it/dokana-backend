-- Migration 0002: establish migration ownership and the migration ledger.
--
-- This is a one-time bootstrap migration. It must be executed transactionally
-- by scripts/bootstrap-migration-foundation.ts through DATABASE_ADMIN_URL.
-- Routine migration execution must use DATABASE_MIGRATION_URL.
--
-- Preconditions:
-- - session_user and current_user are the approved local postgres administrator;
-- - the provisioned Station 3 roles have their approved attributes/memberships;
-- - the exact baseline object inventory is present and still owned by postgres;
-- - migration 0001 has already been verified live and has not been replayed.
--
-- Rollback (backend-owner approval and administrative access required):
-- transfer the explicitly listed objects and schemas back to postgres, then
-- drop platform.schema_migrations. Do not use REASSIGN OWNED. Revoke
-- shop_app_auth_owner from shop_app_migrator separately if the complete
-- Station 3 role chain is being rolled back.

DO $preconditions$
DECLARE
    unexpected_object text;
BEGIN
    IF session_user <> 'postgres' OR current_user <> 'postgres' THEN
        RAISE EXCEPTION '0002 requires the approved postgres bootstrap session';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = 'postgres' AND rolsuper
    ) THEN
        RAISE EXCEPTION '0002 requires the approved postgres bootstrap session';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = 'shop_app_migrator'
          AND NOT rolcanlogin
          AND NOT rolinherit
          AND NOT rolsuper
          AND NOT rolcreatedb
          AND NOT rolcreaterole
          AND NOT rolreplication
          AND NOT rolbypassrls
    ) THEN
        RAISE EXCEPTION 'shop_app_migrator attributes do not match the approved state';
    END IF;

    IF NOT pg_has_role('dokana_migration_login', 'shop_app_migrator', 'SET')
       OR pg_has_role('dokana_migration_login', 'shop_app_runtime', 'SET')
       OR pg_has_role('dokana_migration_login', 'shop_app_auth', 'SET')
       OR pg_has_role('shop_app_migrator', 'shop_app_runtime', 'SET')
       OR pg_has_role('shop_app_migrator', 'shop_app_auth', 'SET') THEN
        RAISE EXCEPTION 'migration role transitions do not match the approved state';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_namespace AS namespace
        WHERE namespace.nspname IN ('audit', 'ledger', 'platform', 'sync')
          AND namespace.nspowner <> (SELECT oid FROM pg_roles WHERE rolname = 'postgres')
    ) OR (
        SELECT count(*)
        FROM pg_namespace
        WHERE nspname IN ('audit', 'ledger', 'platform', 'sync')
    ) <> 4 THEN
        RAISE EXCEPTION 'application schema inventory or ownership is unexpected';
    END IF;

    SELECT format('%I.%I (%s)', namespace.nspname, relation.relname, relation.relkind)
    INTO unexpected_object
    FROM pg_class AS relation
    INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('audit', 'ledger', 'platform', 'sync')
      AND relation.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
      AND format('%I.%I', namespace.nspname, relation.relname) <> ALL (ARRAY[
          'audit.central_audit_logs',
          'audit.central_audit_logs_id_seq',
          'ledger.accounting_periods',
          'ledger.app_settings',
          'ledger.attachments',
          'ledger.audit_logs',
          'ledger.backup_metadata',
          'ledger.customer_ledger_entries',
          'ledger.customer_payment_allocations',
          'ledger.customer_payments',
          'ledger.customers',
          'ledger.devices',
          'ledger.document_sequences',
          'ledger.expense_categories',
          'ledger.expense_payments',
          'ledger.expenses',
          'ledger.goods_receipt_items',
          'ledger.goods_receipts',
          'ledger.inventory_movements',
          'ledger.money_accounts',
          'ledger.money_movements',
          'ledger.money_transfers',
          'ledger.notifications',
          'ledger.owner_ledger_entries',
          'ledger.product_units',
          'ledger.products',
          'ledger.purchase_invoices',
          'ledger.purchase_items',
          'ledger.sale_items',
          'ledger.sale_payments',
          'ledger.sale_return_items',
          'ledger.sale_return_settlements',
          'ledger.sale_returns',
          'ledger.sales',
          'ledger.stock_balances',
          'ledger.stock_count_items',
          'ledger.stock_counts',
          'ledger.stores',
          'ledger.supplier_ledger_entries',
          'ledger.supplier_payment_allocations',
          'ledger.supplier_payments',
          'ledger.supplier_return_items',
          'ledger.supplier_return_settlements',
          'ledger.supplier_returns',
          'ledger.suppliers',
          'ledger.v_customer_balances',
          'ledger.v_customer_invoice_outstanding',
          'ledger.v_expense_balances',
          'ledger.v_money_account_balances',
          'ledger.v_owner_position',
          'ledger.v_purchase_receipt_progress',
          'ledger.v_sale_profit_quality',
          'ledger.v_store_financial_position',
          'ledger.v_supplier_balances',
          'ledger.v_supplier_invoice_outstanding',
          'platform.admin_actions',
          'platform.auth_sessions',
          'platform.license_issuances',
          'platform.license_issuances_license_serial_seq',
          'platform.password_reset_tokens',
          'platform.refresh_tokens',
          'platform.server_backups',
          'platform.store_memberships',
          'platform.subscription_plans',
          'platform.subscriptions',
          'platform.users',
          'sync.bootstrap_snapshots',
          'sync.change_events',
          'sync.change_events_cursor_seq',
          'sync.conflicts',
          'sync.dead_letters',
          'sync.device_cursors',
          'sync.processed_operations',
          'sync.v_device_sync_health'
      ]::text[])
    LIMIT 1;

    IF unexpected_object IS NOT NULL THEN
        RAISE EXCEPTION 'unexpected application relation: %', unexpected_object;
    END IF;

    SELECT format('%I.%I', namespace.nspname, relation.relname)
    INTO unexpected_object
    FROM pg_class AS relation
    INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('audit', 'ledger', 'platform', 'sync')
      AND relation.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
      AND relation.relowner <> (SELECT oid FROM pg_roles WHERE rolname = 'postgres')
    LIMIT 1;

    IF unexpected_object IS NOT NULL THEN
        RAISE EXCEPTION 'application relation has unexpected owner: %', unexpected_object;
    END IF;

    IF (
        SELECT count(*)
        FROM pg_proc AS function_state
        INNER JOIN pg_namespace AS namespace ON namespace.oid = function_state.pronamespace
        WHERE namespace.nspname IN ('audit', 'ledger', 'platform', 'sync')
    ) <> 30 OR EXISTS (
        SELECT 1
        FROM pg_proc AS function_state
        INNER JOIN pg_namespace AS namespace ON namespace.oid = function_state.pronamespace
        WHERE namespace.nspname IN ('audit', 'ledger', 'platform', 'sync')
          AND (
              namespace.nspname || '.' || function_state.proname || '('
              || pg_get_function_identity_arguments(function_state.oid) || ')'
          ) <> ALL (ARRAY[
              'audit.capture_row_change()',
              'audit.prevent_central_audit_mutation()',
              'ledger.apply_inventory_movement()',
              'ledger.assert_period_open(p_store_id uuid, p_period_id uuid, p_occurred_at timestamp with time zone)',
              'ledger.enforce_period_open()',
              'ledger.ensure_parent_draft()',
              'ledger.guard_accounting_period()',
              'ledger.next_document_number(p_store_id uuid, p_device_id uuid, p_document_type text, p_year integer, p_prefix text)',
              'ledger.prevent_delete()',
              'ledger.prevent_mutation()',
              'ledger.protect_finalized_header()',
              'ledger.touch_mutable_row()',
              'ledger.validate_customer_payment_post()',
              'ledger.validate_expense_payment_post()',
              'ledger.validate_goods_receipt_item_details()',
              'ledger.validate_goods_receipt_post()',
              'ledger.validate_money_transfer_post()',
              'ledger.validate_purchase_status()',
              'ledger.validate_sale_post()',
              'ledger.validate_sale_return_post()',
              'ledger.validate_scaled_line_amount()',
              'ledger.validate_supplier_payment_post()',
              'ledger.validate_supplier_return_post()',
              'platform.current_device_id()',
              'platform.current_request_id()',
              'platform.current_store_id()',
              'platform.current_user_id()',
              'platform.setting_uuid(p_name text)',
              'sync.capture_change_event()',
              'sync.claim_operation(p_store_id uuid, p_operation_id uuid, p_device_id uuid, p_aggregate_type text, p_aggregate_id uuid, p_action text, p_request_hash text)'
          ]::text[])
    ) OR EXISTS (
        SELECT 1
        FROM pg_proc AS function_state
        INNER JOIN pg_namespace AS namespace ON namespace.oid = function_state.pronamespace
        WHERE namespace.nspname IN ('audit', 'ledger', 'platform', 'sync')
          AND function_state.proowner <> (
              SELECT oid FROM pg_roles WHERE rolname = 'postgres'
          )
    ) THEN
        RAISE EXCEPTION 'application routine inventory or ownership is unexpected';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_type AS type_state
        INNER JOIN pg_namespace AS namespace ON namespace.oid = type_state.typnamespace
        LEFT JOIN pg_class AS relation ON relation.oid = type_state.typrelid
        WHERE namespace.nspname IN ('audit', 'ledger', 'platform', 'sync')
          AND type_state.typtype IN ('c', 'd', 'e', 'm', 'r')
          AND relation.oid IS NULL
    ) THEN
        RAISE EXCEPTION 'unexpected standalone application type exists';
    END IF;

    IF to_regclass('platform.schema_migrations') IS NOT NULL THEN
        RAISE EXCEPTION 'platform.schema_migrations already exists';
    END IF;
END
$preconditions$;

CREATE TABLE platform.schema_migrations (
    filename text PRIMARY KEY
        CHECK (filename ~ '^[0-9]{4}_[a-z0-9_]+[.]sql$'),
    checksum_sha256 text NOT NULL
        CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
    applied_at timestamptz NOT NULL,
    registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    applied_by text NOT NULL CHECK (length(trim(applied_by)) > 0),
    execution_ms integer NOT NULL CHECK (execution_ms >= 0),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(metadata) = 'object')
);

COMMENT ON TABLE platform.schema_migrations IS
    'Immutable ledger for repository-owned versioned PostgreSQL migrations';

REVOKE ALL ON TABLE platform.schema_migrations FROM PUBLIC;
ALTER TABLE platform.schema_migrations OWNER TO shop_app_migrator;

DO $transfer_relations$
DECLARE
    object_name text;
    schema_name text;
    relation_name text;
BEGIN
    FOREACH object_name IN ARRAY ARRAY[
        'audit.central_audit_logs',
        'ledger.accounting_periods',
        'ledger.app_settings',
        'ledger.attachments',
        'ledger.audit_logs',
        'ledger.backup_metadata',
        'ledger.customer_ledger_entries',
        'ledger.customer_payment_allocations',
        'ledger.customer_payments',
        'ledger.customers',
        'ledger.devices',
        'ledger.document_sequences',
        'ledger.expense_categories',
        'ledger.expense_payments',
        'ledger.expenses',
        'ledger.goods_receipt_items',
        'ledger.goods_receipts',
        'ledger.inventory_movements',
        'ledger.money_accounts',
        'ledger.money_movements',
        'ledger.money_transfers',
        'ledger.notifications',
        'ledger.owner_ledger_entries',
        'ledger.product_units',
        'ledger.products',
        'ledger.purchase_invoices',
        'ledger.purchase_items',
        'ledger.sale_items',
        'ledger.sale_payments',
        'ledger.sale_return_items',
        'ledger.sale_return_settlements',
        'ledger.sale_returns',
        'ledger.sales',
        'ledger.stock_balances',
        'ledger.stock_count_items',
        'ledger.stock_counts',
        'ledger.stores',
        'ledger.supplier_ledger_entries',
        'ledger.supplier_payment_allocations',
        'ledger.supplier_payments',
        'ledger.supplier_return_items',
        'ledger.supplier_return_settlements',
        'ledger.supplier_returns',
        'ledger.suppliers',
        'platform.admin_actions',
        'platform.auth_sessions',
        'platform.license_issuances',
        'platform.password_reset_tokens',
        'platform.refresh_tokens',
        'platform.server_backups',
        'platform.store_memberships',
        'platform.subscription_plans',
        'platform.subscriptions',
        'platform.users',
        'sync.bootstrap_snapshots',
        'sync.change_events',
        'sync.conflicts',
        'sync.dead_letters',
        'sync.device_cursors',
        'sync.processed_operations'
    ] LOOP
        schema_name := split_part(object_name, '.', 1);
        relation_name := split_part(object_name, '.', 2);
        EXECUTE format('ALTER TABLE %I.%I OWNER TO shop_app_migrator', schema_name, relation_name);
    END LOOP;

    FOREACH object_name IN ARRAY ARRAY[
        'audit.central_audit_logs_id_seq',
        'platform.license_issuances_license_serial_seq',
        'sync.change_events_cursor_seq'
    ] LOOP
        schema_name := split_part(object_name, '.', 1);
        relation_name := split_part(object_name, '.', 2);
        EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO shop_app_migrator', schema_name, relation_name);
    END LOOP;

    FOREACH object_name IN ARRAY ARRAY[
        'ledger.v_customer_balances',
        'ledger.v_customer_invoice_outstanding',
        'ledger.v_expense_balances',
        'ledger.v_money_account_balances',
        'ledger.v_owner_position',
        'ledger.v_purchase_receipt_progress',
        'ledger.v_sale_profit_quality',
        'ledger.v_store_financial_position',
        'ledger.v_supplier_balances',
        'ledger.v_supplier_invoice_outstanding',
        'sync.v_device_sync_health'
    ] LOOP
        schema_name := split_part(object_name, '.', 1);
        relation_name := split_part(object_name, '.', 2);
        EXECUTE format('ALTER VIEW %I.%I OWNER TO shop_app_migrator', schema_name, relation_name);
    END LOOP;
END
$transfer_relations$;

ALTER FUNCTION audit.capture_row_change() OWNER TO shop_app_migrator;
ALTER FUNCTION audit.prevent_central_audit_mutation() OWNER TO shop_app_migrator;
ALTER FUNCTION ledger.apply_inventory_movement() OWNER TO shop_app_migrator;
ALTER FUNCTION ledger.assert_period_open(uuid, uuid, timestamptz) OWNER TO shop_app_migrator;
ALTER FUNCTION ledger.enforce_period_open() OWNER TO shop_app_migrator;
ALTER FUNCTION ledger.ensure_parent_draft() OWNER TO shop_app_migrator;
ALTER FUNCTION ledger.guard_accounting_period() OWNER TO shop_app_migrator;
ALTER FUNCTION ledger.next_document_number(uuid, uuid, text, integer, text) OWNER TO shop_app_migrator;
ALTER FUNCTION ledger.prevent_delete() OWNER TO shop_app_migrator;
ALTER FUNCTION ledger.prevent_mutation() OWNER TO shop_app_migrator;
ALTER FUNCTION ledger.protect_finalized_header() OWNER TO shop_app_migrator;
ALTER FUNCTION ledger.touch_mutable_row() OWNER TO shop_app_migrator;
ALTER FUNCTION ledger.validate_customer_payment_post() OWNER TO shop_app_migrator;
ALTER FUNCTION ledger.validate_expense_payment_post() OWNER TO shop_app_migrator;
ALTER FUNCTION ledger.validate_goods_receipt_item_details() OWNER TO shop_app_migrator;
ALTER FUNCTION ledger.validate_goods_receipt_post() OWNER TO shop_app_migrator;
ALTER FUNCTION ledger.validate_money_transfer_post() OWNER TO shop_app_migrator;
ALTER FUNCTION ledger.validate_purchase_status() OWNER TO shop_app_migrator;
ALTER FUNCTION ledger.validate_sale_post() OWNER TO shop_app_migrator;
ALTER FUNCTION ledger.validate_sale_return_post() OWNER TO shop_app_migrator;
ALTER FUNCTION ledger.validate_scaled_line_amount() OWNER TO shop_app_migrator;
ALTER FUNCTION ledger.validate_supplier_payment_post() OWNER TO shop_app_migrator;
ALTER FUNCTION ledger.validate_supplier_return_post() OWNER TO shop_app_migrator;
ALTER FUNCTION platform.current_device_id() OWNER TO shop_app_migrator;
ALTER FUNCTION platform.current_request_id() OWNER TO shop_app_migrator;
ALTER FUNCTION platform.current_store_id() OWNER TO shop_app_migrator;
ALTER FUNCTION platform.current_user_id() OWNER TO shop_app_migrator;
ALTER FUNCTION platform.setting_uuid(text) OWNER TO shop_app_migrator;
ALTER FUNCTION sync.capture_change_event() OWNER TO shop_app_migrator;
ALTER FUNCTION sync.claim_operation(uuid, uuid, uuid, text, uuid, text, text)
    OWNER TO shop_app_migrator;

ALTER SCHEMA audit OWNER TO shop_app_migrator;
ALTER SCHEMA ledger OWNER TO shop_app_migrator;
ALTER SCHEMA platform OWNER TO shop_app_migrator;
ALTER SCHEMA sync OWNER TO shop_app_migrator;

REVOKE CREATE ON SCHEMA audit, ledger, platform, sync FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA audit, ledger, platform, sync FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA audit, ledger, platform, sync FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA audit, ledger, platform, sync FROM PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE shop_app_migrator IN SCHEMA audit, ledger, platform, sync
    REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE shop_app_migrator IN SCHEMA audit, ledger, platform, sync
    REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE shop_app_migrator IN SCHEMA audit, ledger, platform, sync
    REVOKE ALL ON FUNCTIONS FROM PUBLIC;

DO $postconditions$
DECLARE
    unexpected_owner text;
BEGIN
    SELECT format('%I.%I', namespace.nspname, relation.relname)
    INTO unexpected_owner
    FROM pg_class AS relation
    INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('audit', 'ledger', 'platform', 'sync')
      AND relation.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
      AND relation.relowner <> (SELECT oid FROM pg_roles WHERE rolname = 'shop_app_migrator')
    LIMIT 1;

    IF unexpected_owner IS NOT NULL THEN
        RAISE EXCEPTION 'application relation ownership transition failed: %', unexpected_owner;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_proc AS function_state
        INNER JOIN pg_namespace AS namespace ON namespace.oid = function_state.pronamespace
        WHERE namespace.nspname IN ('audit', 'ledger', 'platform', 'sync')
          AND function_state.proowner <> (
              SELECT oid FROM pg_roles WHERE rolname = 'shop_app_migrator'
          )
    ) THEN
        RAISE EXCEPTION 'application routine ownership transition failed';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_namespace
        WHERE nspname IN ('audit', 'ledger', 'platform', 'sync')
          AND nspowner <> (SELECT oid FROM pg_roles WHERE rolname = 'shop_app_migrator')
    ) THEN
        RAISE EXCEPTION 'application schema ownership transition failed';
    END IF;
END
$postconditions$;
