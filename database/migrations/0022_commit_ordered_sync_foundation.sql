-- Migration 0022: add the commit-ordered synchronization foundation required by S19.4.
--
-- The legacy sync.change_events identity cursor remains unchanged for compatibility and is
-- not an authoritative synchronization boundary. The v1 Store stream below captures only
-- sanitized entity pointers. Deferred constraint triggers run at transaction completion and
-- serialize sequence allocation through one transactional watermark row per Store. Therefore
-- a transaction that commits first receives the earlier Store sequence even when another
-- transaction changed data earlier but remains open.
--
-- Approved rollback: revoke runtime EXECUTE on the three public v1 functions, remove the v1
-- constraint triggers, then drop the managed functions and v1 tables. The legacy change feed
-- is unaffected. Retain emitted v1 events if any client has activated a v1 bootstrap cursor.

DO $preconditions$
DECLARE
    required_relation text;
BEGIN
    IF session_user <> 'dokana_migration_login'
       OR current_user <> 'shop_app_migrator' THEN
        RAISE EXCEPTION '0022 requires the approved migration login and effective role';
    END IF;

    IF to_regclass('sync.change_events') IS NULL
       OR to_regclass('sync.bootstrap_snapshots') IS NULL
       OR to_regprocedure('platform.current_store_id()') IS NULL
       OR to_regprocedure('platform.current_user_id()') IS NULL
       OR to_regprocedure('platform.current_device_id()') IS NULL THEN
        RAISE EXCEPTION '0022 requires the verified tenant and synchronization foundations';
    END IF;

    IF to_regclass('sync.store_change_watermarks_v1') IS NOT NULL
       OR to_regclass('sync.store_change_events_v1') IS NOT NULL
       OR to_regprocedure('sync.allocate_store_change_sequence_v1(uuid)') IS NOT NULL
       OR to_regprocedure('sync.capture_store_change_v1()') IS NOT NULL
       OR to_regprocedure('sync.sanitize_bootstrap_record_v1(jsonb)') IS NOT NULL
       OR to_regprocedure('sync.read_bootstrap_boundary_v1(uuid,uuid)') IS NOT NULL
       OR to_regprocedure('sync.read_store_change_page_v1(uuid,bigint,integer)') IS NOT NULL THEN
        RAISE EXCEPTION '0022 managed objects already exist';
    END IF;

    FOREACH required_relation IN ARRAY ARRAY[
        'ledger.stores',
        'ledger.devices',
        'ledger.document_sequences',
        'ledger.app_settings',
        'ledger.customers',
        'ledger.suppliers',
        'ledger.products',
        'ledger.product_units',
        'ledger.money_accounts',
        'ledger.accounting_periods',
        'ledger.expense_categories',
        'ledger.money_movements',
        'ledger.customer_ledger_entries',
        'ledger.supplier_ledger_entries',
        'ledger.owner_ledger_entries',
        'ledger.stock_balances',
        'ledger.inventory_movements',
        'ledger.manual_inventory_entries',
        'ledger.sales',
        'ledger.sale_items',
        'ledger.sale_payments',
        'ledger.purchase_invoices',
        'ledger.purchase_items',
        'ledger.goods_receipts',
        'ledger.goods_receipt_items',
        'ledger.customer_payments',
        'ledger.customer_payment_allocations',
        'ledger.sale_customer_credit_applications',
        'ledger.supplier_payments',
        'ledger.supplier_payment_allocations',
        'ledger.expenses',
        'ledger.expense_payments',
        'ledger.money_transfers',
        'ledger.sale_returns',
        'ledger.sale_return_items',
        'ledger.sale_return_settlements',
        'ledger.supplier_returns',
        'ledger.supplier_return_items',
        'ledger.supplier_return_settlements',
        'ledger.stock_counts',
        'ledger.stock_count_items',
        'platform.store_memberships',
        'platform.subscriptions',
        'platform.license_issuances'
    ] LOOP
        IF to_regclass(required_relation) IS NULL THEN
            RAISE EXCEPTION '0022 required synchronized relation is missing: %', required_relation;
        END IF;
    END LOOP;

    IF has_schema_privilege('shop_app_runtime', 'platform', 'USAGE') THEN
        RAISE EXCEPTION '0022 requires the verified runtime platform firewall';
    END IF;
END
$preconditions$;

CREATE TABLE sync.store_change_watermarks_v1 (
    store_id uuid PRIMARY KEY REFERENCES ledger.stores(id) ON DELETE CASCADE,
    last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sync.store_change_events_v1 (
    store_id uuid NOT NULL REFERENCES ledger.stores(id) ON DELETE CASCADE,
    store_sequence bigint NOT NULL CHECK (store_sequence > 0),
    event_id uuid NOT NULL DEFAULT gen_random_uuid(),
    contract_version smallint NOT NULL DEFAULT 1 CHECK (contract_version = 1),
    entity_type text NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_]{0,62}$'),
    entity_key text NOT NULL CHECK (length(entity_key) BETWEEN 1 AND 512),
    entity_id uuid,
    action text NOT NULL CHECK (action IN (
        'create', 'update', 'archive', 'restore', 'post', 'cancel', 'reverse', 'deactivate'
    )),
    entity_version bigint NOT NULL CHECK (entity_version >= 1),
    operation_id uuid,
    device_id uuid,
    payload jsonb NOT NULL,
    occurred_at timestamptz NOT NULL,
    captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (store_id, store_sequence),
    UNIQUE (event_id),
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON DELETE RESTRICT,
    CHECK (jsonb_typeof(payload) = 'object'),
    CHECK ((payload - ARRAY[
        'entityKey', 'id', 'status', 'version', 'archivedAt', 'reversedById',
        'reversalOfId', 'correctionOfId', 'replacementForId', 'revokedAt'
    ]::text[]) = '{}'::jsonb)
);

CREATE INDEX idx_store_change_events_v1_entity
ON sync.store_change_events_v1(store_id, entity_type, entity_key, store_sequence DESC);

ALTER TABLE sync.store_change_watermarks_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync.store_change_watermarks_v1 FORCE ROW LEVEL SECURITY;
CREATE POLICY store_change_watermarks_v1_store_isolation
ON sync.store_change_watermarks_v1
USING (store_id = platform.current_store_id() OR current_user = 'shop_app_migrator')
WITH CHECK (store_id = platform.current_store_id() OR current_user = 'shop_app_migrator');

ALTER TABLE sync.store_change_events_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync.store_change_events_v1 FORCE ROW LEVEL SECURITY;
CREATE POLICY store_change_events_v1_store_isolation
ON sync.store_change_events_v1
USING (store_id = platform.current_store_id() OR current_user = 'shop_app_migrator')
WITH CHECK (store_id = platform.current_store_id() OR current_user = 'shop_app_migrator');

REVOKE ALL ON TABLE
    sync.store_change_watermarks_v1,
    sync.store_change_events_v1
FROM PUBLIC, shop_app_runtime, shop_app_auth, shop_app_auth_owner;

CREATE FUNCTION sync.allocate_store_change_sequence_v1(p_store_id uuid)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_sequence bigint;
BEGIN
    IF p_store_id IS NULL THEN
        RAISE EXCEPTION '0022 Store sequence allocation requires a Store'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO sync.store_change_watermarks_v1(store_id, last_sequence)
    VALUES (p_store_id, 0)
    ON CONFLICT (store_id) DO NOTHING;

    UPDATE sync.store_change_watermarks_v1 AS watermark
    SET last_sequence = watermark.last_sequence + 1,
        updated_at = clock_timestamp()
    WHERE watermark.store_id = p_store_id
    RETURNING watermark.last_sequence INTO v_sequence;

    IF v_sequence IS NULL THEN
        RAISE EXCEPTION '0022 Store sequence allocation failed'
            USING ERRCODE = '55000';
    END IF;
    RETURN v_sequence;
END
$function$;

CREATE FUNCTION sync.capture_store_change_v1()
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
        RAISE EXCEPTION '0022 change capture was attached to an unmanaged relation'
            USING ERRCODE = '55000';
    END IF;

    v_store_id := COALESCE(
        NULLIF(v_new->>'store_id', '')::uuid,
        CASE WHEN TG_TABLE_SCHEMA = 'ledger' AND TG_TABLE_NAME = 'stores'
            THEN NULLIF(v_new->>'id', '')::uuid END
    );
    IF v_store_id IS NULL THEN
        RAISE EXCEPTION '0022 synchronized row has no Store identity'
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
        RAISE EXCEPTION '0022 synchronized row has no stable entity key'
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
        WHEN 'store_memberships' THEN 'store_membership'
        WHEN 'subscriptions' THEN 'subscription'
        WHEN 'license_issuances' THEN 'offline_license'
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

    v_sequence := sync.allocate_store_change_sequence_v1(v_store_id);
    INSERT INTO sync.store_change_events_v1(
        store_id, store_sequence, entity_type, entity_key, entity_id, action,
        entity_version, operation_id, device_id, payload, occurred_at
    ) VALUES (
        v_store_id, v_sequence, v_entity_type, v_entity_key, v_entity_id, v_action,
        v_entity_version, v_operation_id, v_device_id, v_payload, v_occurred_at
    );
    RETURN NEW;
END
$function$;

CREATE FUNCTION sync.sanitize_bootstrap_record_v1(p_value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_type text := jsonb_typeof(p_value);
    v_result jsonb;
BEGIN
    IF v_type = 'number' THEN
        RETURN to_jsonb(p_value::text);
    ELSIF v_type = 'array' THEN
        SELECT COALESCE(jsonb_agg(sync.sanitize_bootstrap_record_v1(element)), '[]'::jsonb)
        INTO v_result
        FROM jsonb_array_elements(p_value) AS item(element);
        RETURN v_result;
    ELSIF v_type = 'object' THEN
        SELECT COALESCE(
            jsonb_object_agg(key, sync.sanitize_bootstrap_record_v1(value) ORDER BY key),
            '{}'::jsonb
        )
        INTO v_result
        FROM jsonb_each(p_value)
        WHERE key NOT IN ('request_hash', 'password_hash', 'token_hash');
        RETURN v_result;
    END IF;
    RETURN p_value;
END
$function$;

CREATE FUNCTION sync.read_bootstrap_boundary_v1(p_store_id uuid, p_device_id uuid)
RETURNS TABLE (
    contract_version smallint,
    base_watermark bigint,
    snapshot_id text,
    server_time timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_snapshot pg_snapshot;
BEGIN
    IF current_setting('transaction_isolation') <> 'repeatable read'
       OR current_setting('transaction_read_only') <> 'on' THEN
        RAISE EXCEPTION '0022 bootstrap boundary requires a read-only REPEATABLE READ transaction'
            USING ERRCODE = '25001';
    END IF;
    IF p_store_id IS NULL
       OR p_store_id IS DISTINCT FROM platform.current_store_id()
       OR p_device_id IS NULL
       OR p_device_id IS DISTINCT FROM platform.current_device_id()
       OR platform.current_user_id() IS NULL THEN
        RAISE EXCEPTION '0022 bootstrap context is invalid'
            USING ERRCODE = '42501';
    END IF;

    PERFORM 1
    FROM ledger.stores AS store_record
    JOIN ledger.devices AS device_record
      ON device_record.store_id = store_record.id
     AND device_record.id = p_device_id
    JOIN platform.store_memberships AS membership
      ON membership.store_id = store_record.id
     AND membership.user_id = platform.current_user_id()
     AND membership.status = 'active'
    WHERE store_record.id = p_store_id
      AND store_record.status IN ('active', 'read_only')
      AND device_record.status = 'active';
    IF NOT FOUND THEN
        RAISE EXCEPTION '0022 bootstrap is unavailable'
            USING ERRCODE = '42501';
    END IF;

    v_snapshot := pg_current_snapshot();
    RETURN QUERY SELECT
        1::smallint,
        COALESCE(watermark.last_sequence, 0),
        encode(digest(v_snapshot::text, 'sha256'), 'hex'),
        transaction_timestamp()
    FROM (SELECT 1) AS singleton
    LEFT JOIN sync.store_change_watermarks_v1 AS watermark
      ON watermark.store_id = p_store_id;
END
$function$;

CREATE FUNCTION sync.read_store_change_page_v1(
    p_store_id uuid,
    p_after_sequence bigint,
    p_limit integer
)
RETURNS TABLE (
    store_sequence bigint,
    event_id uuid,
    contract_version smallint,
    entity_type text,
    entity_key text,
    entity_id uuid,
    action text,
    entity_version bigint,
    operation_id uuid,
    device_id uuid,
    payload jsonb,
    occurred_at timestamptz,
    captured_at timestamptz
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
       OR platform.current_device_id() IS NULL
       OR p_after_sequence IS NULL
       OR p_after_sequence < 0
       OR p_limit IS NULL
       OR p_limit < 1
       OR p_limit > 100 THEN
        RAISE EXCEPTION '0022 Store change page input or context is invalid'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    SELECT
        event.store_sequence,
        event.event_id,
        event.contract_version,
        event.entity_type,
        event.entity_key,
        event.entity_id,
        event.action,
        event.entity_version,
        event.operation_id,
        event.device_id,
        event.payload,
        event.occurred_at,
        event.captured_at
    FROM sync.store_change_events_v1 AS event
    WHERE event.store_id = p_store_id
      AND event.store_sequence > p_after_sequence
    ORDER BY event.store_sequence
    LIMIT p_limit;
END
$function$;

DO $triggers$
DECLARE
    relation_name text;
BEGIN
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
        EXECUTE format(
            'CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE ON %s '
            || 'DEFERRABLE INITIALLY DEFERRED FOR EACH ROW '
            || 'EXECUTE FUNCTION sync.capture_store_change_v1()',
            'trg_' || split_part(relation_name, '.', 2) || '_store_change_v1',
            relation_name
        );
    END LOOP;
END
$triggers$;

REVOKE ALL ON FUNCTION
    sync.allocate_store_change_sequence_v1(uuid),
    sync.capture_store_change_v1(),
    sync.sanitize_bootstrap_record_v1(jsonb),
    sync.read_bootstrap_boundary_v1(uuid, uuid),
    sync.read_store_change_page_v1(uuid, bigint, integer)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
    sync.sanitize_bootstrap_record_v1(jsonb),
    sync.read_bootstrap_boundary_v1(uuid, uuid),
    sync.read_store_change_page_v1(uuid, bigint, integer)
TO shop_app_runtime;

DO $postconditions$
DECLARE
    managed_function regprocedure;
    trigger_count integer;
BEGIN
    FOREACH managed_function IN ARRAY ARRAY[
        'sync.allocate_store_change_sequence_v1(uuid)'::regprocedure,
        'sync.capture_store_change_v1()'::regprocedure,
        'sync.sanitize_bootstrap_record_v1(jsonb)'::regprocedure,
        'sync.read_bootstrap_boundary_v1(uuid,uuid)'::regprocedure,
        'sync.read_store_change_page_v1(uuid,bigint,integer)'::regprocedure
    ] LOOP
        IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = managed_function) <> 'shop_app_migrator'
           OR EXISTS (
                SELECT 1
                FROM aclexplode(COALESCE(
                    (SELECT proacl FROM pg_proc WHERE oid = managed_function),
                    acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = managed_function))
                )) AS privilege
                WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
           ) THEN
            RAISE EXCEPTION '0022 managed function ownership or PUBLIC privilege is unsafe';
        END IF;
    END LOOP;

    IF NOT has_function_privilege(
            'shop_app_runtime',
            'sync.sanitize_bootstrap_record_v1(jsonb)',
            'EXECUTE'
       )
       OR NOT has_function_privilege(
            'shop_app_runtime',
            'sync.read_bootstrap_boundary_v1(uuid,uuid)',
            'EXECUTE'
       )
       OR NOT has_function_privilege(
            'shop_app_runtime',
            'sync.read_store_change_page_v1(uuid,bigint,integer)',
            'EXECUTE'
       )
       OR has_function_privilege(
            'shop_app_runtime',
            'sync.allocate_store_change_sequence_v1(uuid)',
            'EXECUTE'
       )
       OR has_function_privilege('shop_app_runtime', 'sync.capture_store_change_v1()', 'EXECUTE')
       OR has_function_privilege(
            'shop_app_auth',
            'sync.read_bootstrap_boundary_v1(uuid,uuid)',
            'EXECUTE'
       )
       OR has_function_privilege(
            'shop_app_auth_owner',
            'sync.read_bootstrap_boundary_v1(uuid,uuid)',
            'EXECUTE'
       ) THEN
        RAISE EXCEPTION '0022 managed function grants are unsafe';
    END IF;

    IF has_table_privilege('shop_app_runtime', 'sync.store_change_watermarks_v1', 'SELECT')
       OR has_table_privilege('shop_app_runtime', 'sync.store_change_events_v1', 'SELECT')
       OR has_table_privilege('shop_app_runtime', 'sync.store_change_events_v1', 'INSERT')
       OR has_schema_privilege('shop_app_runtime', 'platform', 'USAGE') THEN
        RAISE EXCEPTION '0022 broadened runtime table or platform access';
    END IF;

    IF NOT (
        SELECT relrowsecurity AND relforcerowsecurity
        FROM pg_class WHERE oid = 'sync.store_change_watermarks_v1'::regclass
    ) OR NOT (
        SELECT relrowsecurity AND relforcerowsecurity
        FROM pg_class WHERE oid = 'sync.store_change_events_v1'::regclass
    ) THEN
        RAISE EXCEPTION '0022 requires forced RLS on managed Store-scoped tables';
    END IF;

    SELECT count(*)
    INTO trigger_count
    FROM pg_trigger
    WHERE tgfoid = 'sync.capture_store_change_v1()'::regprocedure
      AND NOT tgisinternal
      AND tgdeferrable
      AND tginitdeferred
      AND tgenabled = 'O';
    IF trigger_count <> 44 THEN
        RAISE EXCEPTION '0022 expected 44 enabled deferred synchronized relation triggers, found %',
            trigger_count;
    END IF;
END
$postconditions$;
