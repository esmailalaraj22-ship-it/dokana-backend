-- S19.6: immutable, versioned client representations on the existing commit-ordered stream.

DO $preconditions$
DECLARE
    relation_name text;
BEGIN
    IF session_user <> 'dokana_migration_login' OR current_user <> 'shop_app_migrator' THEN
        RAISE EXCEPTION '0027 requires the approved migration login and role';
    END IF;
    IF to_regclass('sync.store_change_watermarks_v1') IS NULL
       OR to_regclass('sync.store_change_events_v1') IS NULL
       OR to_regprocedure('sync.capture_store_change_v1()') IS NULL
       OR to_regprocedure('sync.sanitize_bootstrap_record_v1(jsonb)') IS NULL THEN
        RAISE EXCEPTION '0027 requires the verified 0022 synchronization foundation';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'sync'
          AND table_name = 'store_change_events_v1'
          AND column_name IN ('representation_version', 'representation')
    ) OR EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'sync'
          AND table_name = 'store_change_watermarks_v1'
          AND column_name = 'minimum_replayable_sequence'
    ) THEN
        RAISE EXCEPTION '0027 immutable representation columns already exist';
    END IF;

    FOREACH relation_name IN ARRAY ARRAY[
        'ledger.stores', 'ledger.devices', 'ledger.document_sequences', 'ledger.app_settings',
        'ledger.customers', 'ledger.suppliers', 'ledger.products', 'ledger.product_units',
        'ledger.money_accounts', 'ledger.accounting_periods', 'ledger.expense_categories',
        'ledger.money_movements', 'ledger.customer_ledger_entries',
        'ledger.supplier_ledger_entries', 'ledger.owner_ledger_entries',
        'ledger.stock_balances', 'ledger.inventory_movements',
        'ledger.manual_inventory_entries', 'ledger.sales', 'ledger.sale_items',
        'ledger.sale_payments', 'ledger.purchase_invoices', 'ledger.purchase_items',
        'ledger.goods_receipts', 'ledger.goods_receipt_items', 'ledger.customer_payments',
        'ledger.customer_payment_allocations', 'ledger.sale_customer_credit_applications',
        'ledger.supplier_payments', 'ledger.supplier_payment_allocations', 'ledger.expenses',
        'ledger.expense_payments', 'ledger.money_transfers', 'ledger.sale_returns',
        'ledger.sale_return_items', 'ledger.sale_return_settlements', 'ledger.supplier_returns',
        'ledger.supplier_return_items', 'ledger.supplier_return_settlements',
        'ledger.stock_counts', 'ledger.stock_count_items', 'platform.store_memberships',
        'platform.subscriptions', 'platform.license_issuances'
    ] LOOP
        IF to_regclass(relation_name) IS NULL THEN
            RAISE EXCEPTION '0027 managed relation is missing: %', relation_name;
        END IF;
    END LOOP;
END
$preconditions$;

-- This lock set waits for earlier writers and blocks later writers until the cutover commits.
-- Therefore no write can be sequenced beyond the cutover with the old pointer-only capture.
LOCK TABLE
    ledger.stores, ledger.devices, ledger.document_sequences, ledger.app_settings,
    ledger.customers, ledger.suppliers, ledger.products, ledger.product_units,
    ledger.money_accounts, ledger.accounting_periods, ledger.expense_categories,
    ledger.money_movements, ledger.customer_ledger_entries,
    ledger.supplier_ledger_entries, ledger.owner_ledger_entries,
    ledger.stock_balances, ledger.inventory_movements, ledger.manual_inventory_entries,
    ledger.sales, ledger.sale_items, ledger.sale_payments, ledger.purchase_invoices,
    ledger.purchase_items, ledger.goods_receipts, ledger.goods_receipt_items,
    ledger.customer_payments, ledger.customer_payment_allocations,
    ledger.sale_customer_credit_applications, ledger.supplier_payments,
    ledger.supplier_payment_allocations, ledger.expenses, ledger.expense_payments,
    ledger.money_transfers, ledger.sale_returns, ledger.sale_return_items,
    ledger.sale_return_settlements, ledger.supplier_returns, ledger.supplier_return_items,
    ledger.supplier_return_settlements, ledger.stock_counts, ledger.stock_count_items,
    platform.store_memberships, platform.subscriptions, platform.license_issuances
IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE sync.store_change_watermarks_v1
    ADD COLUMN minimum_replayable_sequence bigint;

INSERT INTO sync.store_change_watermarks_v1(
    store_id,
    last_sequence,
    minimum_replayable_sequence
)
SELECT store_record.id, 0, 0
FROM ledger.stores AS store_record
ON CONFLICT (store_id) DO NOTHING;

UPDATE sync.store_change_watermarks_v1
SET minimum_replayable_sequence = last_sequence,
    updated_at = clock_timestamp();

ALTER TABLE sync.store_change_watermarks_v1
    ALTER COLUMN minimum_replayable_sequence SET DEFAULT 0,
    ALTER COLUMN minimum_replayable_sequence SET NOT NULL,
    ADD CONSTRAINT store_change_watermarks_v1_replayable_sequence_check
        CHECK (
            minimum_replayable_sequence >= 0
            AND minimum_replayable_sequence <= last_sequence
        );

ALTER TABLE sync.store_change_events_v1
    ADD COLUMN representation_version smallint,
    ADD COLUMN representation jsonb,
    ADD CONSTRAINT store_change_events_v1_representation_pair_check
        CHECK (
            (representation_version IS NULL AND representation IS NULL)
            OR (representation_version = 1 AND jsonb_typeof(representation) = 'object')
        );

CREATE FUNCTION sync.build_change_representation_v1(
    p_entity_type text,
    p_row jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_allowed_fields text[];
    v_representation jsonb;
BEGIN
    v_allowed_fields := CASE p_entity_type
        WHEN 'store' THEN ARRAY[
            'id','name','phone','currency_code','status','created_at','updated_at','version'
        ]
        WHEN 'device' THEN ARRAY[
            'id','store_id','device_name','platform','installation_id','device_prefix','status',
            'last_seen_at','created_at','updated_at','version'
        ]
        WHEN 'document_sequence' THEN ARRAY[
            'store_id','device_id','document_type','sequence_year','next_value','updated_at'
        ]
        WHEN 'app_settings' THEN ARRAY[
            'store_id','daily_report_time_minutes','default_credit_policy',
            'default_credit_limit_minor','allow_negative_stock','low_stock_alert_enabled',
            'debt_age_alert_days','backup_enabled','backup_interval_hours','created_at','updated_at',
            'version','timezone_name','business_day_start_minutes','business_day_end_minutes',
            'business_day_mode'
        ]
        WHEN 'customer' THEN ARRAY[
            'id','store_id','name','normalized_name','phone','normalized_phone','notes',
            'credit_limit_minor','credit_policy','status','archived_at','device_id','operation_id',
            'created_at','updated_at','version'
        ]
        WHEN 'supplier' THEN ARRAY[
            'id','store_id','name','normalized_name','phone','normalized_phone','notes','status',
            'archived_at','device_id','operation_id','created_at','updated_at','version'
        ]
        WHEN 'product' THEN ARRAY[
            'id','store_id','name','normalized_name','sku','barcode','description',
            'measurement_type','track_inventory','allow_negative_stock_override',
            'low_stock_threshold_milli','is_pinned','status','archived_at','device_id',
            'operation_id','created_at','updated_at','version'
        ]
        WHEN 'product_unit' THEN ARRAY[
            'id','store_id','product_id','measurement_type','unit_name','unit_code','is_base',
            'factor_num','factor_den','sale_price_minor','purchase_price_minor','status',
            'device_id','operation_id','created_at','updated_at','version'
        ]
        WHEN 'money_account' THEN ARRAY[
            'id','store_id','name','normalized_name','account_type','availability','is_default',
            'status','archived_at','device_id','operation_id','created_at','updated_at','version'
        ]
        WHEN 'accounting_period' THEN ARRAY[
            'id','store_id','period_year','period_month','starts_at','ends_at','status','closed_at',
            'device_id','operation_id','created_at','updated_at','version'
        ]
        WHEN 'expense_category' THEN ARRAY[
            'id','store_id','name','normalized_name','status','device_id','operation_id',
            'created_at','updated_at','version'
        ]
        WHEN 'supplier_invoice' THEN ARRAY[
            'id','store_id','supplier_id','invoice_number','display_number','invoice_date_at',
            'due_at','items_subtotal_minor','line_discount_total_minor','invoice_discount_minor',
            'rounding_minor','total_minor','status','notes','correction_of_id','cancelled_at',
            'device_id','operation_id','created_at','updated_at','version',
            'accounting_period_id','posting_date'
        ]
        WHEN 'supplier_invoice_item' THEN ARRAY[
            'id','store_id','purchase_invoice_id','product_id','product_unit_id',
            'product_name_snapshot','unit_name_snapshot','quantity_milli','conversion_factor_num',
            'conversion_factor_den','base_quantity_milli','unit_cost_minor','line_gross_minor',
            'line_discount_minor','rounding_minor','line_total_minor','created_at','updated_at','version'
        ]
        WHEN 'legacy_goods_receipt' THEN ARRAY[
            'id','store_id','supplier_id','purchase_invoice_id','accounting_period_id',
            'display_number','received_at','total_cost_minor','status','notes','reversal_of_id',
            'reversed_by_id','cancelled_at','device_id','operation_id','created_at','updated_at','version'
        ]
        WHEN 'legacy_goods_receipt_item' THEN ARRAY[
            'id','store_id','goods_receipt_id','purchase_item_id','product_id','product_unit_id',
            'product_name_snapshot','unit_name_snapshot','quantity_milli','conversion_factor_num',
            'conversion_factor_den','base_quantity_milli','unit_cost_minor','line_total_minor',
            'inventory_movement_id','created_at','updated_at','version'
        ]
        WHEN 'sale' THEN ARRAY[
            'id','store_id','customer_id','accounting_period_id','display_number','sale_at',
            'items_subtotal_minor','line_discount_total_minor','invoice_discount_minor',
            'rounding_minor','total_minor','paid_total_minor','credit_total_minor',
            'known_cost_total_minor','pending_cost_line_count','unknown_cost_line_count',
            'payment_status','status','notes','correction_of_id','reversed_by_id','cancelled_at',
            'device_id','operation_id','created_at','updated_at','version'
        ]
        WHEN 'sale_item' THEN ARRAY[
            'id','store_id','sale_id','product_id','product_unit_id','is_manual_line',
            'product_name_snapshot','unit_name_snapshot','quantity_milli','conversion_factor_num',
            'conversion_factor_den','base_quantity_milli','unit_price_minor','line_gross_minor',
            'line_discount_minor','rounding_minor','line_total_minor','cost_status','unit_cost_minor',
            'line_cost_minor','inventory_movement_id','created_at','updated_at','version'
        ]
        WHEN 'customer_payment' THEN ARRAY[
            'id','store_id','customer_id','accounting_period_id','money_account_id','amount_minor',
            'allocated_total_minor','credit_created_minor','payment_at','sender_account_name',
            'external_reference','notes','status','money_movement_id','cancelled_at','device_id',
            'operation_id','created_at','updated_at','version'
        ]
        WHEN 'supplier_payment' THEN ARRAY[
            'id','store_id','supplier_id','accounting_period_id','amount_minor',
            'allocated_total_minor','credit_created_minor','payment_source','money_account_id',
            'money_movement_id','owner_ledger_entry_id','payment_at','external_reference','notes',
            'status','cancelled_at','device_id','operation_id','created_at','updated_at','version'
        ]
        WHEN 'expense' THEN ARRAY[
            'id','store_id','category_id','accounting_period_id','description','amount_minor',
            'paid_total_minor','expense_at','due_at','payment_timing','status','notes','cancelled_at',
            'device_id','operation_id','created_at','updated_at','version'
        ]
        WHEN 'money_transfer' THEN ARRAY[
            'id','store_id','accounting_period_id','display_number','source_account_id',
            'destination_account_id','amount_minor','transfer_at','source_movement_id',
            'destination_movement_id','status','notes','cancelled_at','device_id','operation_id',
            'created_at','updated_at','version'
        ]
        WHEN 'sale_return' THEN ARRAY[
            'id','store_id','sale_id','customer_id','accounting_period_id','display_number',
            'return_at','total_minor','status','notes','cancelled_at','device_id','operation_id',
            'created_at','updated_at','version'
        ]
        WHEN 'sale_return_item' THEN ARRAY[
            'id','store_id','sale_return_id','sale_item_id','quantity_milli','base_quantity_milli',
            'line_refund_minor','item_condition','inventory_movement_id','created_at','updated_at','version'
        ]
        WHEN 'supplier_return' THEN ARRAY[
            'id','store_id','supplier_id','purchase_invoice_id','accounting_period_id',
            'display_number','return_at','total_minor','status','notes','cancelled_at','device_id',
            'operation_id','created_at','updated_at','version'
        ]
        WHEN 'supplier_return_item' THEN ARRAY[
            'id','store_id','supplier_return_id','product_id','product_unit_id','quantity_milli',
            'conversion_factor_num','conversion_factor_den','base_quantity_milli','unit_cost_minor',
            'line_total_minor','inventory_movement_id','created_at','updated_at','version'
        ]
        WHEN 'manual_inventory_entry' THEN ARRAY[
            'id','store_id','operation_id','product_id','product_unit_id','selected_quantity_milli',
            'base_quantity_milli','factor_num','factor_den','total_purchase_cost_minor','cost_status',
            'occurred_at','business_date','posting_date','accounting_period_id','movement_id',
            'transaction_group_id','reason','device_id','created_at'
        ]
        WHEN 'stock_count' THEN ARRAY[
            'id','store_id','accounting_period_id','display_number','count_type','started_at',
            'completed_at','status','notes','cancelled_at','device_id','operation_id','created_at',
            'updated_at','version','occurred_at','business_date','posting_date'
        ]
        WHEN 'stock_count_item' THEN ARRAY[
            'id','store_id','stock_count_id','product_id','system_quantity_milli',
            'actual_quantity_milli','difference_milli','adjustment_movement_id','reason','created_at',
            'updated_at','version','product_unit_id','selected_quantity_milli','factor_num',
            'factor_den','previous_projection_state'
        ]
        WHEN 'inventory_movement' THEN ARRAY[
            'id','store_id','product_id','accounting_period_id','movement_type',
            'quantity_before_milli','quantity_delta_milli','quantity_after_milli',
            'inventory_value_before_minor','value_delta_minor','inventory_value_after_minor',
            'average_unit_cost_after_minor','cost_status','has_pending_cost_after','reference_type',
            'reference_id','transaction_group_id','occurred_at','reversal_of_id','reason','device_id',
            'operation_id','created_at','product_unit_id','selected_quantity_milli','factor_num',
            'factor_den','business_date','posting_date','cost_state_before','cost_state_after',
            'quantity_fact_kind'
        ]
        WHEN 'stock_balance' THEN ARRAY[
            'store_id','product_id','quantity_milli','average_unit_cost_minor',
            'inventory_value_minor','has_pending_cost','last_movement_id','updated_at','version','cost_state'
        ]
        WHEN 'money_movement' THEN ARRAY[
            'id','store_id','account_id','accounting_period_id','movement_type','amount_delta_minor',
            'reference_type','reference_id','transaction_group_id','transfer_group_id',
            'counter_account_id','counterparty_name','external_reference','notes','occurred_at',
            'reversal_of_id','device_id','operation_id','created_at'
        ]
        WHEN 'sale_payment' THEN ARRAY[
            'id','store_id','sale_id','money_account_id','amount_minor','payment_at',
            'sender_account_name','external_reference','money_movement_id','created_at','updated_at','version'
        ]
        WHEN 'customer_payment_allocation' THEN ARRAY[
            'id','store_id','customer_payment_id','sale_id','amount_minor',
            'customer_ledger_entry_id','created_at','opening_receivable_ledger_entry_id'
        ]
        WHEN 'sale_customer_credit_application' THEN ARRAY[
            'id','store_id','sale_id','customer_id','customer_ledger_entry_id','amount_minor',
            'applied_at','created_at'
        ]
        WHEN 'supplier_payment_allocation' THEN ARRAY[
            'id','store_id','supplier_payment_id','purchase_invoice_id','amount_minor',
            'supplier_ledger_entry_id','created_at','opening_payable_ledger_entry_id'
        ]
        WHEN 'expense_payment' THEN ARRAY[
            'id','store_id','expense_id','accounting_period_id','amount_minor','payment_source',
            'money_account_id','money_movement_id','owner_ledger_entry_id','payment_at','notes',
            'status','cancelled_at','device_id','operation_id','created_at','updated_at','version'
        ]
        WHEN 'sale_return_settlement' THEN ARRAY[
            'id','store_id','sale_return_id','settlement_type','amount_minor','money_account_id',
            'money_movement_id','customer_ledger_entry_id','created_at'
        ]
        WHEN 'supplier_return_settlement' THEN ARRAY[
            'id','store_id','supplier_return_id','settlement_type','amount_minor','money_account_id',
            'money_movement_id','supplier_ledger_entry_id','created_at'
        ]
        WHEN 'customer_ledger_entry' THEN ARRAY[
            'id','store_id','customer_id','accounting_period_id','entry_type',
            'receivable_delta_minor','credit_delta_minor','source_sale_id','reference_type',
            'reference_id','transaction_group_id','occurred_at','reversal_of_id','reason',
            'device_id','operation_id','created_at'
        ]
        WHEN 'supplier_ledger_entry' THEN ARRAY[
            'id','store_id','supplier_id','accounting_period_id','entry_type',
            'payable_delta_minor','credit_delta_minor','source_purchase_invoice_id',
            'reference_type','reference_id','transaction_group_id','occurred_at','reversal_of_id',
            'reason','device_id','operation_id','created_at'
        ]
        WHEN 'owner_ledger_entry' THEN ARRAY[
            'id','store_id','accounting_period_id','entry_type','owner_liability_delta_minor',
            'equity_delta_minor','money_account_id','reference_type','reference_id',
            'transaction_group_id','occurred_at','reversal_of_id','reason','device_id',
            'operation_id','created_at'
        ]
        ELSE NULL
    END;

    IF v_allowed_fields IS NULL THEN
        RAISE EXCEPTION '0027 client representation type is not approved: %', p_entity_type
            USING ERRCODE = '55000';
    END IF;

    SELECT COALESCE(jsonb_object_agg(field.key, field.value ORDER BY field.key), '{}'::jsonb)
    INTO v_representation
    FROM jsonb_each(p_row) AS field
    WHERE field.key = ANY(v_allowed_fields);

    IF EXISTS (
        SELECT 1
        FROM unnest(v_allowed_fields) AS required_field
        WHERE NOT (p_row ? required_field)
    ) THEN
        RAISE EXCEPTION '0027 client representation shape drifted for type: %', p_entity_type
            USING ERRCODE = '55000';
    END IF;

    RETURN sync.sanitize_bootstrap_record_v1(v_representation);
END
$function$;

CREATE OR REPLACE FUNCTION sync.capture_store_change_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_new jsonb := to_jsonb(NEW);
    v_old jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
    v_store_id uuid;
    v_entity_id uuid;
    v_entity_key text;
    v_entity_type text;
    v_action text := 'update';
    v_entity_version bigint := 1;
    v_operation_id uuid;
    v_device_id uuid;
    v_occurred_at timestamptz;
    v_payload jsonb;
    v_representation jsonb;
    v_sequence bigint;
BEGIN
    IF current_setting('app.suppress_change_events', true) = 'on' THEN
        RETURN NEW;
    END IF;

    IF TG_TABLE_SCHEMA NOT IN ('ledger', 'platform') OR TG_TABLE_NAME NOT IN (
        'stores', 'devices', 'document_sequences', 'app_settings', 'customers', 'suppliers',
        'products', 'product_units', 'money_accounts', 'accounting_periods',
        'expense_categories', 'money_movements', 'customer_ledger_entries',
        'supplier_ledger_entries', 'owner_ledger_entries', 'stock_balances',
        'inventory_movements', 'manual_inventory_entries', 'sales', 'sale_items',
        'sale_payments', 'purchase_invoices', 'purchase_items', 'goods_receipts',
        'goods_receipt_items', 'customer_payments', 'customer_payment_allocations',
        'sale_customer_credit_applications', 'supplier_payments',
        'supplier_payment_allocations', 'expenses', 'expense_payments', 'money_transfers',
        'sale_returns', 'sale_return_items', 'sale_return_settlements', 'supplier_returns',
        'supplier_return_items', 'supplier_return_settlements', 'stock_counts',
        'stock_count_items', 'store_memberships', 'subscriptions', 'license_issuances'
    ) THEN
        RAISE EXCEPTION '0027 change capture was attached to an unmanaged relation'
            USING ERRCODE = '55000';
    END IF;

    -- These platform records remain server-only. Authentication and License APIs expose their
    -- approved client models; unrestricted platform rows never enter the client change stream.
    IF TG_TABLE_SCHEMA = 'platform' THEN
        RETURN NEW;
    END IF;

    v_store_id := COALESCE(
        NULLIF(v_new->>'store_id', '')::uuid,
        CASE WHEN TG_TABLE_NAME = 'stores' THEN NULLIF(v_new->>'id', '')::uuid END
    );
    IF v_store_id IS NULL THEN
        RAISE EXCEPTION '0027 synchronized row has no Store identity'
            USING ERRCODE = '55000';
    END IF;

    v_entity_id := NULLIF(v_new->>'id', '')::uuid;
    v_entity_key := COALESCE(
        v_new->>'id',
        CASE WHEN TG_TABLE_NAME = 'stock_balances' THEN v_new->>'product_id' END,
        CASE WHEN TG_TABLE_NAME = 'app_settings' THEN v_new->>'store_id' END,
        CASE WHEN TG_TABLE_NAME = 'document_sequences' THEN concat_ws(
            ':', v_new->>'device_id', v_new->>'document_type', v_new->>'sequence_year'
        ) END
    );
    IF v_entity_key IS NULL OR v_entity_key = '' THEN
        RAISE EXCEPTION '0027 synchronized row has no stable entity key'
            USING ERRCODE = '55000';
    END IF;

    v_entity_type := CASE TG_TABLE_NAME
        WHEN 'stores' THEN 'store'
        WHEN 'devices' THEN 'device'
        WHEN 'document_sequences' THEN 'document_sequence'
        WHEN 'app_settings' THEN 'app_settings'
        WHEN 'customers' THEN 'customer'
        WHEN 'suppliers' THEN 'supplier'
        WHEN 'products' THEN 'product'
        WHEN 'product_units' THEN 'product_unit'
        WHEN 'money_accounts' THEN 'money_account'
        WHEN 'accounting_periods' THEN 'accounting_period'
        WHEN 'expense_categories' THEN 'expense_category'
        WHEN 'money_movements' THEN 'money_movement'
        WHEN 'customer_ledger_entries' THEN 'customer_ledger_entry'
        WHEN 'supplier_ledger_entries' THEN 'supplier_ledger_entry'
        WHEN 'owner_ledger_entries' THEN 'owner_ledger_entry'
        WHEN 'stock_balances' THEN 'stock_balance'
        WHEN 'inventory_movements' THEN 'inventory_movement'
        WHEN 'manual_inventory_entries' THEN 'manual_inventory_entry'
        WHEN 'sales' THEN 'sale'
        WHEN 'sale_items' THEN 'sale_item'
        WHEN 'sale_payments' THEN 'sale_payment'
        WHEN 'purchase_invoices' THEN 'supplier_invoice'
        WHEN 'purchase_items' THEN 'supplier_invoice_item'
        WHEN 'goods_receipts' THEN 'legacy_goods_receipt'
        WHEN 'goods_receipt_items' THEN 'legacy_goods_receipt_item'
        WHEN 'customer_payments' THEN 'customer_payment'
        WHEN 'customer_payment_allocations' THEN 'customer_payment_allocation'
        WHEN 'sale_customer_credit_applications' THEN 'sale_customer_credit_application'
        WHEN 'supplier_payments' THEN 'supplier_payment'
        WHEN 'supplier_payment_allocations' THEN 'supplier_payment_allocation'
        WHEN 'expenses' THEN 'expense'
        WHEN 'expense_payments' THEN 'expense_payment'
        WHEN 'money_transfers' THEN 'money_transfer'
        WHEN 'sale_returns' THEN 'sale_return'
        WHEN 'sale_return_items' THEN 'sale_return_item'
        WHEN 'sale_return_settlements' THEN 'sale_return_settlement'
        WHEN 'supplier_returns' THEN 'supplier_return'
        WHEN 'supplier_return_items' THEN 'supplier_return_item'
        WHEN 'supplier_return_settlements' THEN 'supplier_return_settlement'
        WHEN 'stock_counts' THEN 'stock_count'
        WHEN 'stock_count_items' THEN 'stock_count_item'
    END;

    IF TG_OP = 'INSERT' THEN
        v_action := 'create';
    ELSIF v_old->>'status' = 'archived' AND v_new->>'status' = 'active' THEN
        v_action := 'restore';
    ELSIF v_new->>'status' = 'archived' AND v_old->>'status' IS DISTINCT FROM 'archived' THEN
        v_action := 'archive';
    ELSIF v_new->>'status' = 'posted' AND v_old->>'status' IS DISTINCT FROM 'posted' THEN
        v_action := 'post';
    ELSIF v_new->>'status' = 'cancelled' AND v_old->>'status' IS DISTINCT FROM 'cancelled' THEN
        v_action := 'cancel';
    ELSIF NULLIF(v_new->>'reversed_by_id', '') IS NOT NULL
          AND NULLIF(v_old->>'reversed_by_id', '') IS NULL THEN
        v_action := 'reverse';
    ELSIF v_new->>'status' IN ('revoked', 'replaced', 'disabled', 'removed', 'suspended', 'expired')
          AND v_old->>'status' IS DISTINCT FROM v_new->>'status' THEN
        v_action := 'deactivate';
    END IF;

    IF NULLIF(v_new->>'version', '') IS NOT NULL THEN
        v_entity_version := (v_new->>'version')::bigint;
    END IF;
    v_operation_id := NULLIF(v_new->>'operation_id', '')::uuid;
    v_device_id := NULLIF(v_new->>'device_id', '')::uuid;
    v_occurred_at := COALESCE(
        NULLIF(v_new->>'updated_at', '')::timestamptz,
        NULLIF(v_new->>'posted_at', '')::timestamptz,
        NULLIF(v_new->>'occurred_at', '')::timestamptz,
        NULLIF(v_new->>'created_at', '')::timestamptz,
        clock_timestamp()
    );
    v_payload := jsonb_strip_nulls(jsonb_build_object(
        'entityKey', v_entity_key,
        'id', v_entity_id,
        'status', NULLIF(v_new->>'status', ''),
        'version', v_entity_version::text,
        'archivedAt', NULLIF(v_new->>'archived_at', ''),
        'reversedById', NULLIF(v_new->>'reversed_by_id', ''),
        'reversalOfId', NULLIF(v_new->>'reversal_of_id', ''),
        'correctionOfId', NULLIF(v_new->>'correction_of_id', ''),
        'replacementForId', NULLIF(v_new->>'replacement_for_id', ''),
        'revokedAt', NULLIF(v_new->>'revoked_at', '')
    ));
    v_representation := sync.build_change_representation_v1(v_entity_type, v_new);

    v_sequence := sync.allocate_store_change_sequence_v1(v_store_id);
    INSERT INTO sync.store_change_events_v1(
        store_id, store_sequence, entity_type, entity_key, entity_id, action,
        entity_version, operation_id, device_id, payload, occurred_at,
        representation_version, representation
    ) VALUES (
        v_store_id, v_sequence, v_entity_type, v_entity_key, v_entity_id, v_action,
        v_entity_version, v_operation_id, v_device_id, v_payload, v_occurred_at,
        1, v_representation
    );
    RETURN NEW;
END
$function$;

CREATE FUNCTION sync.read_store_change_bounds_v1(p_store_id uuid)
RETURNS TABLE (
    stream_generation smallint,
    head_sequence bigint,
    minimum_replayable_sequence bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
    IF p_store_id IS NULL
       OR p_store_id IS DISTINCT FROM platform.current_store_id()
       OR platform.current_user_id() IS NULL
       OR platform.current_device_id() IS NULL THEN
        RAISE EXCEPTION '0027 Store change bounds context is invalid'
            USING ERRCODE = '42501';
    END IF;

    PERFORM 1
    FROM ledger.stores AS store_record
    JOIN ledger.devices AS device_record
      ON device_record.store_id = store_record.id
     AND device_record.id = platform.current_device_id()
     AND device_record.status = 'active'
    JOIN platform.store_memberships AS membership
      ON membership.store_id = store_record.id
     AND membership.user_id = platform.current_user_id()
     AND membership.status = 'active'
    WHERE store_record.id = p_store_id
      AND store_record.status IN ('active', 'read_only');
    IF NOT FOUND THEN
        RAISE EXCEPTION '0027 Store change pull is unavailable'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
        1::smallint,
        watermark.last_sequence,
        watermark.minimum_replayable_sequence
    FROM sync.store_change_watermarks_v1 AS watermark
    WHERE watermark.store_id = p_store_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION '0027 Store change watermark is unavailable'
            USING ERRCODE = '55000';
    END IF;
END
$function$;

CREATE FUNCTION sync.read_store_change_page_v2(
    p_store_id uuid,
    p_after_sequence bigint,
    p_limit integer
)
RETURNS TABLE (
    store_sequence bigint,
    event_id uuid,
    contract_version smallint,
    representation_version smallint,
    entity_type text,
    entity_key text,
    entity_id uuid,
    action text,
    entity_version bigint,
    operation_id uuid,
    device_id uuid,
    representation jsonb,
    occurred_at timestamptz,
    captured_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_head_sequence bigint;
    v_minimum_replayable_sequence bigint;
BEGIN
    IF p_store_id IS NULL
       OR p_store_id IS DISTINCT FROM platform.current_store_id()
       OR p_after_sequence IS NULL
       OR p_after_sequence < 0
       OR p_limit IS NULL
       OR p_limit < 1
       OR p_limit > 100 THEN
        RAISE EXCEPTION '0027 Store change page input or context is invalid'
            USING ERRCODE = '22023';
    END IF;

    SELECT bounds.head_sequence, bounds.minimum_replayable_sequence
    INTO v_head_sequence, v_minimum_replayable_sequence
    FROM sync.read_store_change_bounds_v1(p_store_id) AS bounds;

    IF p_after_sequence < v_minimum_replayable_sequence THEN
        RAISE EXCEPTION 'SYNC_REBOOTSTRAP_REQUIRED'
            USING ERRCODE = 'P0001';
    END IF;
    IF p_after_sequence > v_head_sequence THEN
        RAISE EXCEPTION 'SYNC_CURSOR_AHEAD'
            USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM (
            SELECT candidate.representation_version, candidate.representation
            FROM sync.store_change_events_v1 AS candidate
            WHERE candidate.store_id = p_store_id
              AND candidate.store_sequence > p_after_sequence
            ORDER BY candidate.store_sequence
            LIMIT p_limit
        ) AS event
        WHERE (
              event.representation_version IS DISTINCT FROM 1
              OR event.representation IS NULL
        )
    ) THEN
        RAISE EXCEPTION 'SYNC_REPRESENTATION_UNSUPPORTED'
            USING ERRCODE = '55000';
    END IF;

    RETURN QUERY
    SELECT
        event.store_sequence,
        event.event_id,
        event.contract_version,
        event.representation_version,
        event.entity_type,
        event.entity_key,
        event.entity_id,
        event.action,
        event.entity_version,
        event.operation_id,
        event.device_id,
        event.representation,
        event.occurred_at,
        event.captured_at
    FROM sync.store_change_events_v1 AS event
    WHERE event.store_id = p_store_id
      AND event.store_sequence > p_after_sequence
    ORDER BY event.store_sequence
    LIMIT p_limit;
END
$function$;

REVOKE EXECUTE ON FUNCTION sync.read_store_change_page_v1(uuid, bigint, integer)
FROM shop_app_runtime;

REVOKE ALL ON FUNCTION
    sync.build_change_representation_v1(text, jsonb),
    sync.read_store_change_bounds_v1(uuid),
    sync.read_store_change_page_v2(uuid, bigint, integer)
FROM PUBLIC, shop_app_auth, shop_app_auth_owner;

GRANT EXECUTE ON FUNCTION
    sync.read_store_change_bounds_v1(uuid),
    sync.read_store_change_page_v2(uuid, bigint, integer)
TO shop_app_runtime;

DO $postconditions$
DECLARE
    function_name regprocedure;
BEGIN
    IF EXISTS (
        SELECT 1
        FROM sync.store_change_watermarks_v1
        WHERE minimum_replayable_sequence < 0
           OR minimum_replayable_sequence > last_sequence
    ) THEN
        RAISE EXCEPTION '0027 Store replay boundary is invalid';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM sync.store_change_events_v1 AS event
        JOIN sync.store_change_watermarks_v1 AS watermark USING (store_id)
        WHERE event.store_sequence > watermark.minimum_replayable_sequence
          AND (event.representation_version IS DISTINCT FROM 1 OR event.representation IS NULL)
    ) THEN
        RAISE EXCEPTION '0027 post-cutover event lacks an immutable representation';
    END IF;

    FOREACH function_name IN ARRAY ARRAY[
        'sync.capture_store_change_v1()'::regprocedure,
        'sync.build_change_representation_v1(text,jsonb)'::regprocedure,
        'sync.read_store_change_bounds_v1(uuid)'::regprocedure,
        'sync.read_store_change_page_v2(uuid,bigint,integer)'::regprocedure
    ] LOOP
        IF (
            SELECT owner_role.rolname <> 'shop_app_migrator'
                   OR function_state.prosecdef IS DISTINCT FROM
                      (function_name <> 'sync.build_change_representation_v1(text,jsonb)'::regprocedure)
                   OR function_state.proconfig IS NULL
                   OR NOT ('search_path=pg_catalog, pg_temp' = ANY(function_state.proconfig))
            FROM pg_proc AS function_state
            JOIN pg_roles AS owner_role ON owner_role.oid = function_state.proowner
            WHERE function_state.oid = function_name
        ) THEN
            RAISE EXCEPTION '0027 managed function security configuration is invalid: %', function_name;
        END IF;
    END LOOP;

    IF has_function_privilege('public', 'sync.read_store_change_page_v2(uuid,bigint,integer)', 'EXECUTE')
       OR has_function_privilege('shop_app_auth', 'sync.read_store_change_page_v2(uuid,bigint,integer)', 'EXECUTE')
       OR NOT has_function_privilege('shop_app_runtime', 'sync.read_store_change_page_v2(uuid,bigint,integer)', 'EXECUTE')
       OR NOT has_function_privilege('shop_app_runtime', 'sync.read_store_change_bounds_v1(uuid)', 'EXECUTE')
       OR has_function_privilege('shop_app_runtime', 'sync.read_store_change_page_v1(uuid,bigint,integer)', 'EXECUTE')
       OR has_function_privilege('shop_app_runtime', 'sync.build_change_representation_v1(text,jsonb)', 'EXECUTE') THEN
        RAISE EXCEPTION '0027 function grants are not least privileged';
    END IF;

    IF has_table_privilege('shop_app_runtime', 'sync.store_change_events_v1', 'SELECT')
       OR has_table_privilege('shop_app_runtime', 'sync.store_change_events_v1', 'INSERT')
       OR has_table_privilege('shop_app_runtime', 'sync.store_change_watermarks_v1', 'SELECT')
       OR has_table_privilege('shop_app_runtime', 'sync.store_change_watermarks_v1', 'UPDATE') THEN
        RAISE EXCEPTION '0027 runtime received direct synchronization table privileges';
    END IF;
END
$postconditions$;
