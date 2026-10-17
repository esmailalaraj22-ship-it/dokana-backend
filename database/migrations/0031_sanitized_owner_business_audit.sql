-- S21.3: expose a least-privileged Owner business-audit boundary and add the
-- two missing transactional capture points. Raw central audit data remains
-- private to database-owned code.

DO $preconditions$
BEGIN
    IF session_user <> 'dokana_migration_login'
       OR current_user <> 'shop_app_migrator' THEN
        RAISE EXCEPTION '0031 requires the approved migration login and effective role';
    END IF;

    IF to_regclass('audit.central_audit_logs') IS NULL
       OR to_regclass('ledger.app_settings') IS NULL
       OR to_regclass('ledger.owner_ledger_entries') IS NULL
       OR to_regclass('platform.store_memberships') IS NULL
       OR to_regclass('platform.users') IS NULL
       OR to_regprocedure('audit.capture_row_change()') IS NULL
       OR to_regprocedure('platform.current_store_id()') IS NULL
       OR to_regprocedure('platform.current_user_id()') IS NULL
       OR to_regprocedure(
            'ledger.sanitize_app_settings_audit_v1(jsonb,jsonb)'
          ) IS NOT NULL
       OR to_regprocedure(
            'ledger.read_owner_business_audit_v1(integer,timestamp with time zone,uuid,timestamp with time zone,timestamp with time zone,uuid,text,text,uuid)'
          ) IS NOT NULL
       OR EXISTS (
            SELECT 1
            FROM pg_trigger AS trigger_state
            WHERE trigger_state.tgname IN (
                'trg_app_settings_central_audit',
                'trg_owner_ledger_entries_central_audit'
            )
              AND NOT trigger_state.tgisinternal
       )
       OR has_table_privilege(
            'shop_app_runtime', 'audit.central_audit_logs', 'SELECT'
       )
       OR has_schema_privilege('shop_app_runtime', 'audit', 'USAGE') THEN
        RAISE EXCEPTION '0031 found an unexpected audit foundation state';
    END IF;

    IF NOT (SELECT relrowsecurity AND relforcerowsecurity
            FROM pg_class
            WHERE oid = 'audit.central_audit_logs'::regclass)
       OR NOT (SELECT prosecdef
               FROM pg_proc
               WHERE oid = 'audit.capture_row_change()'::regprocedure)
       OR (SELECT proconfig
           FROM pg_proc
           WHERE oid = 'audit.capture_row_change()'::regprocedure)
            IS DISTINCT FROM ARRAY[
                'search_path=pg_catalog, audit, platform'
            ]::text[] THEN
        RAISE EXCEPTION '0031 requires the approved immutable central-audit boundary';
    END IF;
END
$preconditions$;

CREATE FUNCTION ledger.sanitize_app_settings_audit_v1(
    p_old jsonb,
    p_new jsonb
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
    SELECT pg_catalog.jsonb_build_object(
        'changes',
        (CASE WHEN p_old -> 'daily_report_time_minutes'
                       IS DISTINCT FROM p_new -> 'daily_report_time_minutes'
              THEN pg_catalog.jsonb_build_object(
                  'dailyReportTimeMinutes', pg_catalog.jsonb_build_object(
                      'previous', p_old -> 'daily_report_time_minutes',
                      'current', p_new -> 'daily_report_time_minutes'
                  )
              ) ELSE '{}'::jsonb END)
        || (CASE WHEN p_old -> 'default_credit_policy'
                          IS DISTINCT FROM p_new -> 'default_credit_policy'
              THEN pg_catalog.jsonb_build_object(
                  'defaultCreditPolicy', pg_catalog.jsonb_build_object(
                      'previous', p_old -> 'default_credit_policy',
                      'current', p_new -> 'default_credit_policy'
                  )
              ) ELSE '{}'::jsonb END)
        || (CASE WHEN p_old -> 'default_credit_limit_minor'
                          IS DISTINCT FROM p_new -> 'default_credit_limit_minor'
              THEN pg_catalog.jsonb_build_object(
                  'defaultCreditLimitMinor', pg_catalog.jsonb_build_object(
                      'previous', CASE
                          WHEN p_old ->> 'default_credit_limit_minor' IS NULL
                              THEN 'null'::jsonb
                          ELSE pg_catalog.to_jsonb(
                              p_old ->> 'default_credit_limit_minor'
                          )
                      END,
                      'current', CASE
                          WHEN p_new ->> 'default_credit_limit_minor' IS NULL
                              THEN 'null'::jsonb
                          ELSE pg_catalog.to_jsonb(
                              p_new ->> 'default_credit_limit_minor'
                          )
                      END
                  )
              ) ELSE '{}'::jsonb END)
        || (CASE WHEN p_old -> 'allow_negative_stock'
                          IS DISTINCT FROM p_new -> 'allow_negative_stock'
              THEN pg_catalog.jsonb_build_object(
                  'allowNegativeStock', pg_catalog.jsonb_build_object(
                      'previous', p_old -> 'allow_negative_stock',
                      'current', p_new -> 'allow_negative_stock'
                  )
              ) ELSE '{}'::jsonb END)
        || (CASE WHEN p_old -> 'low_stock_alert_enabled'
                          IS DISTINCT FROM p_new -> 'low_stock_alert_enabled'
              THEN pg_catalog.jsonb_build_object(
                  'lowStockAlertEnabled', pg_catalog.jsonb_build_object(
                      'previous', p_old -> 'low_stock_alert_enabled',
                      'current', p_new -> 'low_stock_alert_enabled'
                  )
              ) ELSE '{}'::jsonb END)
        || (CASE WHEN p_old -> 'debt_age_alert_days'
                          IS DISTINCT FROM p_new -> 'debt_age_alert_days'
              THEN pg_catalog.jsonb_build_object(
                  'debtAgeAlertDays', pg_catalog.jsonb_build_object(
                      'previous', p_old -> 'debt_age_alert_days',
                      'current', p_new -> 'debt_age_alert_days'
                  )
              ) ELSE '{}'::jsonb END)
        || (CASE WHEN p_old -> 'customer_debt_amount_alert_minor'
                          IS DISTINCT FROM p_new -> 'customer_debt_amount_alert_minor'
              THEN pg_catalog.jsonb_build_object(
                  'customerDebtAmountAlertMinor', pg_catalog.jsonb_build_object(
                      'previous', pg_catalog.to_jsonb(
                          p_old ->> 'customer_debt_amount_alert_minor'
                      ),
                      'current', pg_catalog.to_jsonb(
                          p_new ->> 'customer_debt_amount_alert_minor'
                      )
                  )
              ) ELSE '{}'::jsonb END)
        || (CASE WHEN p_old -> 'backup_enabled'
                          IS DISTINCT FROM p_new -> 'backup_enabled'
              THEN pg_catalog.jsonb_build_object(
                  'backupEnabled', pg_catalog.jsonb_build_object(
                      'previous', p_old -> 'backup_enabled',
                      'current', p_new -> 'backup_enabled'
                  )
              ) ELSE '{}'::jsonb END)
        || (CASE WHEN p_old -> 'backup_interval_hours'
                          IS DISTINCT FROM p_new -> 'backup_interval_hours'
              THEN pg_catalog.jsonb_build_object(
                  'backupIntervalHours', pg_catalog.jsonb_build_object(
                      'previous', p_old -> 'backup_interval_hours',
                      'current', p_new -> 'backup_interval_hours'
                  )
              ) ELSE '{}'::jsonb END)
    )
$function$;

REVOKE ALL ON FUNCTION ledger.sanitize_app_settings_audit_v1(jsonb, jsonb)
FROM PUBLIC, shop_app_runtime, shop_app_auth, shop_app_auth_owner;

CREATE FUNCTION ledger.read_owner_business_audit_v1(
    p_limit integer,
    p_cursor_occurred_at timestamptz,
    p_cursor_event_id uuid,
    p_occurred_from timestamptz,
    p_occurred_to timestamptz,
    p_actor_user_id uuid,
    p_action text,
    p_entity_type text,
    p_entity_id uuid
)
RETURNS TABLE (
    audit_event_id uuid,
    business_action text,
    business_entity_type text,
    business_entity_id uuid,
    entity_reference text,
    actor_type text,
    actor_user_id uuid,
    actor_display_name text,
    occurred_at timestamptz,
    business_date date,
    safe_context jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
ROWS 101
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_store_id uuid := platform.current_store_id();
    v_user_id uuid := platform.current_user_id();
BEGIN
    IF v_store_id IS NULL
       OR v_user_id IS NULL
       OR p_limit IS NULL
       OR p_limit < 1
       OR p_limit > 101
       OR (p_cursor_occurred_at IS NULL) <> (p_cursor_event_id IS NULL)
       OR (p_occurred_from IS NOT NULL
           AND p_occurred_to IS NOT NULL
           AND p_occurred_from > p_occurred_to) THEN
        RAISE EXCEPTION 'AUDIT_QUERY_INVALID' USING ERRCODE = '22023';
    END IF;

    IF p_action IS NOT NULL AND p_action <> ALL (ARRAY[
        'CUSTOMER_CREATED','CUSTOMER_UPDATED','CUSTOMER_ARCHIVED','CUSTOMER_RESTORED',
        'SUPPLIER_CREATED','SUPPLIER_UPDATED','SUPPLIER_ARCHIVED','SUPPLIER_RESTORED',
        'PRODUCT_CREATED','PRODUCT_UPDATED','PRODUCT_ARCHIVED','PRODUCT_RESTORED',
        'PRODUCT_UNIT_CREATED','PRODUCT_UNIT_UPDATED','PRODUCT_UNIT_ARCHIVED','PRODUCT_UNIT_RESTORED',
        'MONEY_ACCOUNT_CREATED','MONEY_ACCOUNT_UPDATED','MONEY_ACCOUNT_ARCHIVED','MONEY_ACCOUNT_RESTORED',
        'ACCOUNTING_PERIOD_CREATED','ACCOUNTING_PERIOD_UPDATED','ACCOUNTING_PERIOD_CLOSING','ACCOUNTING_PERIOD_CLOSED','ACCOUNTING_PERIOD_REOPENED',
        'SALE_CREATED','SALE_CORRECTED','SALE_CANCELLED',
        'SUPPLIER_INVOICE_CREATED','SUPPLIER_INVOICE_CORRECTED','SUPPLIER_INVOICE_CANCELLED',
        'CUSTOMER_COLLECTION_CREATED','CUSTOMER_COLLECTION_CORRECTED','CUSTOMER_COLLECTION_CANCELLED',
        'SUPPLIER_PAYMENT_CREATED','SUPPLIER_PAYMENT_CORRECTED','SUPPLIER_PAYMENT_CANCELLED',
        'EXPENSE_CREATED','EXPENSE_CORRECTED','EXPENSE_PAYMENT_CREATED','EXPENSE_PAYMENT_CORRECTED',
        'MONEY_TRANSFER_CREATED','MONEY_TRANSFER_CORRECTED','MONEY_TRANSFER_CANCELLED',
        'SALE_RETURN_CREATED','SALE_RETURN_CORRECTED','SALE_RETURN_CANCELLED',
        'SUPPLIER_RETURN_CREATED','SUPPLIER_RETURN_CORRECTED','SUPPLIER_RETURN_CANCELLED',
        'STOCK_COUNT_CREATED','STOCK_COUNT_CORRECTED','STOCK_COUNT_CANCELLED',
        'MANUAL_INVENTORY_CREATED',
        'OWNER_LEDGER_ENTRY_CREATED','OWNER_LEDGER_CORRECTION_CREATED',
        'STORE_SETTINGS_UPDATED'
    ]::text[]) THEN
        RAISE EXCEPTION 'AUDIT_FILTER_NOT_ALLOWED' USING ERRCODE = '22023';
    END IF;

    IF p_entity_type IS NOT NULL AND p_entity_type <> ALL (ARRAY[
        'customer','supplier','product','product_unit','money_account',
        'accounting_period','sale','supplier_invoice','customer_collection',
        'supplier_payment','expense','money_transfer','sale_return',
        'supplier_return','stock_count','manual_inventory','owner_ledger',
        'store_settings'
    ]::text[]) THEN
        RAISE EXCEPTION 'AUDIT_FILTER_NOT_ALLOWED' USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM ledger.stores AS store_record
        WHERE store_record.id = v_store_id
          AND store_record.status IN ('active', 'read_only')
    )
       OR NOT EXISTS (
        SELECT 1
        FROM platform.store_memberships AS membership
        WHERE membership.store_id = v_store_id
          AND membership.user_id = v_user_id
          AND membership.role = 'owner'
          AND membership.status = 'active'
    ) THEN
        RAISE EXCEPTION 'AUDIT_ACCESS_NOT_ALLOWED' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    WITH raw_evidence AS (
        SELECT
            evidence.event_id,
            evidence.user_id,
            evidence.action AS raw_action,
            evidence.entity_type AS raw_entity_type,
            evidence.entity_id,
            evidence.old_values,
            evidence.new_values,
            evidence.occurred_at,
            actor.full_name AS actor_name,
            EXISTS (
                SELECT 1
                FROM audit.central_audit_logs AS sibling
                WHERE sibling.store_id = evidence.store_id
                  AND sibling.request_id = evidence.request_id
                  AND sibling.request_id IS NOT NULL
                  AND sibling.entity_type = evidence.entity_type
                  AND sibling.entity_id IS DISTINCT FROM evidence.entity_id
                  AND sibling.action = 'update'
                  AND sibling.new_values ->> 'status' = 'cancelled'
            ) AS has_cancelled_sibling,
            EXISTS (
                SELECT 1
                FROM audit.central_audit_logs AS sibling
                WHERE sibling.store_id = evidence.store_id
                  AND sibling.request_id = evidence.request_id
                  AND sibling.request_id IS NOT NULL
                  AND sibling.entity_type = evidence.entity_type
                  AND sibling.entity_id IS DISTINCT FROM evidence.entity_id
                  AND sibling.new_values ->> 'correction_of_id' = evidence.entity_id::text
            ) AS has_linked_replacement,
            EXISTS (
                SELECT 1
                FROM audit.central_audit_logs AS sibling
                WHERE sibling.store_id = evidence.store_id
                  AND sibling.request_id = evidence.request_id
                  AND sibling.request_id IS NOT NULL
                  AND sibling.entity_type = evidence.entity_type
                  AND sibling.entity_id IS DISTINCT FROM evidence.entity_id
                  AND sibling.action = 'update'
                  AND sibling.old_values ->> 'status' = 'draft'
                  AND sibling.new_values ->> 'status' IN ('posted', 'open', 'closed')
            ) AS has_posted_sibling
        FROM audit.central_audit_logs AS evidence
        LEFT JOIN platform.users AS actor ON actor.id = evidence.user_id
        WHERE evidence.store_id = v_store_id
          AND (p_occurred_from IS NULL OR evidence.occurred_at >= p_occurred_from)
          AND (p_occurred_to IS NULL OR evidence.occurred_at <= p_occurred_to)
          AND (p_actor_user_id IS NULL OR evidence.user_id = p_actor_user_id)
          AND (p_entity_id IS NULL OR evidence.entity_id = p_entity_id)
          AND (
              p_cursor_occurred_at IS NULL
              OR evidence.occurred_at < p_cursor_occurred_at
              OR (
                  evidence.occurred_at = p_cursor_occurred_at
                  AND evidence.event_id < p_cursor_event_id
              )
          )
    ),
    mapped AS (
        SELECT
            raw.event_id,
            CASE
                WHEN raw.raw_entity_type = 'ledger.customers' AND raw.raw_action = 'insert'
                    THEN 'CUSTOMER_CREATED'
                WHEN raw.raw_entity_type = 'ledger.customers' AND raw.raw_action = 'update'
                     AND raw.old_values ->> 'status' = 'active'
                     AND raw.new_values ->> 'status' = 'archived'
                    THEN 'CUSTOMER_ARCHIVED'
                WHEN raw.raw_entity_type = 'ledger.customers' AND raw.raw_action = 'update'
                     AND raw.old_values ->> 'status' = 'archived'
                     AND raw.new_values ->> 'status' = 'active'
                    THEN 'CUSTOMER_RESTORED'
                WHEN raw.raw_entity_type = 'ledger.customers' AND raw.raw_action = 'update'
                    THEN 'CUSTOMER_UPDATED'

                WHEN raw.raw_entity_type = 'ledger.suppliers' AND raw.raw_action = 'insert'
                    THEN 'SUPPLIER_CREATED'
                WHEN raw.raw_entity_type = 'ledger.suppliers' AND raw.raw_action = 'update'
                     AND raw.old_values ->> 'status' = 'active'
                     AND raw.new_values ->> 'status' = 'archived'
                    THEN 'SUPPLIER_ARCHIVED'
                WHEN raw.raw_entity_type = 'ledger.suppliers' AND raw.raw_action = 'update'
                     AND raw.old_values ->> 'status' = 'archived'
                     AND raw.new_values ->> 'status' = 'active'
                    THEN 'SUPPLIER_RESTORED'
                WHEN raw.raw_entity_type = 'ledger.suppliers' AND raw.raw_action = 'update'
                    THEN 'SUPPLIER_UPDATED'

                WHEN raw.raw_entity_type = 'ledger.products' AND raw.raw_action = 'insert'
                    THEN 'PRODUCT_CREATED'
                WHEN raw.raw_entity_type = 'ledger.products' AND raw.raw_action = 'update'
                     AND raw.old_values ->> 'status' = 'active'
                     AND raw.new_values ->> 'status' = 'archived'
                    THEN 'PRODUCT_ARCHIVED'
                WHEN raw.raw_entity_type = 'ledger.products' AND raw.raw_action = 'update'
                     AND raw.old_values ->> 'status' = 'archived'
                     AND raw.new_values ->> 'status' = 'active'
                    THEN 'PRODUCT_RESTORED'
                WHEN raw.raw_entity_type = 'ledger.products' AND raw.raw_action = 'update'
                    THEN 'PRODUCT_UPDATED'

                WHEN raw.raw_entity_type = 'ledger.product_units' AND raw.raw_action = 'insert'
                    THEN 'PRODUCT_UNIT_CREATED'
                WHEN raw.raw_entity_type = 'ledger.product_units' AND raw.raw_action = 'update'
                     AND raw.old_values ->> 'status' = 'active'
                     AND raw.new_values ->> 'status' = 'archived'
                    THEN 'PRODUCT_UNIT_ARCHIVED'
                WHEN raw.raw_entity_type = 'ledger.product_units' AND raw.raw_action = 'update'
                     AND raw.old_values ->> 'status' = 'archived'
                     AND raw.new_values ->> 'status' = 'active'
                    THEN 'PRODUCT_UNIT_RESTORED'
                WHEN raw.raw_entity_type = 'ledger.product_units' AND raw.raw_action = 'update'
                    THEN 'PRODUCT_UNIT_UPDATED'

                WHEN raw.raw_entity_type = 'ledger.money_accounts' AND raw.raw_action = 'insert'
                    THEN 'MONEY_ACCOUNT_CREATED'
                WHEN raw.raw_entity_type = 'ledger.money_accounts' AND raw.raw_action = 'update'
                     AND raw.old_values ->> 'status' = 'active'
                     AND raw.new_values ->> 'status' = 'archived'
                    THEN 'MONEY_ACCOUNT_ARCHIVED'
                WHEN raw.raw_entity_type = 'ledger.money_accounts' AND raw.raw_action = 'update'
                     AND raw.old_values ->> 'status' = 'archived'
                     AND raw.new_values ->> 'status' = 'active'
                    THEN 'MONEY_ACCOUNT_RESTORED'
                WHEN raw.raw_entity_type = 'ledger.money_accounts' AND raw.raw_action = 'update'
                    THEN 'MONEY_ACCOUNT_UPDATED'

                WHEN raw.raw_entity_type = 'ledger.accounting_periods'
                     AND raw.raw_action = 'insert'
                    THEN 'ACCOUNTING_PERIOD_CREATED'
                WHEN raw.raw_entity_type = 'ledger.accounting_periods'
                     AND raw.raw_action = 'update'
                     AND raw.old_values ->> 'status' = 'closed'
                     AND raw.new_values ->> 'status' = 'open'
                    THEN 'ACCOUNTING_PERIOD_REOPENED'
                WHEN raw.raw_entity_type = 'ledger.accounting_periods'
                     AND raw.raw_action = 'update'
                     AND raw.new_values ->> 'status' = 'closing'
                    THEN 'ACCOUNTING_PERIOD_CLOSING'
                WHEN raw.raw_entity_type = 'ledger.accounting_periods'
                     AND raw.raw_action = 'update'
                     AND raw.new_values ->> 'status' = 'closed'
                    THEN 'ACCOUNTING_PERIOD_CLOSED'
                WHEN raw.raw_entity_type = 'ledger.accounting_periods'
                     AND raw.raw_action = 'update'
                    THEN 'ACCOUNTING_PERIOD_UPDATED'

                WHEN raw.raw_entity_type = 'ledger.sales' AND raw.raw_action = 'update'
                     AND raw.old_values ->> 'status' = 'draft'
                     AND raw.new_values ->> 'status' = 'posted'
                     AND raw.new_values ->> 'correction_of_id' IS NULL
                     AND NOT raw.has_cancelled_sibling
                    THEN 'SALE_CREATED'
                WHEN raw.raw_entity_type = 'ledger.sales' AND raw.raw_action = 'update'
                     AND raw.new_values ->> 'status' = 'corrected'
                    THEN 'SALE_CORRECTED'
                WHEN raw.raw_entity_type = 'ledger.sales' AND raw.raw_action = 'update'
                     AND raw.new_values ->> 'status' = 'cancelled'
                    THEN 'SALE_CANCELLED'

                WHEN raw.raw_entity_type = 'ledger.purchase_invoices'
                     AND raw.raw_action = 'update'
                     AND raw.old_values ->> 'status' = 'draft'
                     AND raw.new_values ->> 'status' IN ('open', 'closed')
                     AND raw.new_values ->> 'correction_of_id' IS NULL
                     AND NOT raw.has_cancelled_sibling
                    THEN 'SUPPLIER_INVOICE_CREATED'
                WHEN raw.raw_entity_type = 'ledger.purchase_invoices'
                     AND raw.raw_action = 'update'
                     AND raw.new_values ->> 'status' = 'cancelled'
                     AND raw.has_linked_replacement
                    THEN 'SUPPLIER_INVOICE_CORRECTED'
                WHEN raw.raw_entity_type = 'ledger.purchase_invoices'
                     AND raw.raw_action = 'update'
                     AND raw.new_values ->> 'status' = 'cancelled'
                    THEN 'SUPPLIER_INVOICE_CANCELLED'

                WHEN raw.raw_entity_type = 'ledger.customer_payments'
                     AND raw.raw_action = 'update'
                     AND raw.old_values ->> 'status' = 'draft'
                     AND raw.new_values ->> 'status' = 'posted'
                     AND NOT raw.has_cancelled_sibling
                    THEN 'CUSTOMER_COLLECTION_CREATED'
                WHEN raw.raw_entity_type = 'ledger.customer_payments'
                     AND raw.raw_action = 'update'
                     AND raw.new_values ->> 'status' = 'cancelled'
                     AND raw.has_posted_sibling
                    THEN 'CUSTOMER_COLLECTION_CORRECTED'
                WHEN raw.raw_entity_type = 'ledger.customer_payments'
                     AND raw.raw_action = 'update'
                     AND raw.new_values ->> 'status' = 'cancelled'
                    THEN 'CUSTOMER_COLLECTION_CANCELLED'

                WHEN raw.raw_entity_type = 'ledger.supplier_payments'
                     AND raw.raw_action = 'update'
                     AND raw.old_values ->> 'status' = 'draft'
                     AND raw.new_values ->> 'status' = 'posted'
                     AND NOT raw.has_cancelled_sibling
                    THEN 'SUPPLIER_PAYMENT_CREATED'
                WHEN raw.raw_entity_type = 'ledger.supplier_payments'
                     AND raw.raw_action = 'update'
                     AND raw.new_values ->> 'status' = 'cancelled'
                     AND raw.has_posted_sibling
                    THEN 'SUPPLIER_PAYMENT_CORRECTED'
                WHEN raw.raw_entity_type = 'ledger.supplier_payments'
                     AND raw.raw_action = 'update'
                     AND raw.new_values ->> 'status' = 'cancelled'
                    THEN 'SUPPLIER_PAYMENT_CANCELLED'

                WHEN raw.raw_entity_type = 'ledger.expenses' AND raw.raw_action = 'update'
                     AND raw.old_values ->> 'status' = 'draft'
                     AND raw.new_values ->> 'status' = 'posted'
                     AND NOT raw.has_cancelled_sibling
                    THEN 'EXPENSE_CREATED'
                WHEN raw.raw_entity_type = 'ledger.expenses' AND raw.raw_action = 'update'
                     AND raw.new_values ->> 'status' = 'cancelled'
                    THEN 'EXPENSE_CORRECTED'
                WHEN raw.raw_entity_type = 'ledger.expenses' AND raw.raw_action = 'update'
                     AND COALESCE((raw.new_values ->> 'paid_total_minor')::bigint, 0)
                         > COALESCE((raw.old_values ->> 'paid_total_minor')::bigint, 0)
                    THEN 'EXPENSE_PAYMENT_CREATED'
                WHEN raw.raw_entity_type = 'ledger.expenses' AND raw.raw_action = 'update'
                     AND COALESCE((raw.new_values ->> 'paid_total_minor')::bigint, 0)
                         < COALESCE((raw.old_values ->> 'paid_total_minor')::bigint, 0)
                    THEN 'EXPENSE_PAYMENT_CORRECTED'

                WHEN raw.raw_entity_type = 'ledger.money_transfers'
                     AND raw.raw_action = 'update'
                     AND raw.old_values ->> 'status' = 'draft'
                     AND raw.new_values ->> 'status' = 'posted'
                     AND NOT raw.has_cancelled_sibling
                    THEN 'MONEY_TRANSFER_CREATED'
                WHEN raw.raw_entity_type = 'ledger.money_transfers'
                     AND raw.raw_action = 'update'
                     AND raw.new_values ->> 'status' = 'cancelled'
                     AND raw.has_posted_sibling
                    THEN 'MONEY_TRANSFER_CORRECTED'
                WHEN raw.raw_entity_type = 'ledger.money_transfers'
                     AND raw.raw_action = 'update'
                     AND raw.new_values ->> 'status' = 'cancelled'
                    THEN 'MONEY_TRANSFER_CANCELLED'

                WHEN raw.raw_entity_type = 'ledger.sale_returns'
                     AND raw.raw_action = 'update'
                     AND raw.old_values ->> 'status' = 'draft'
                     AND raw.new_values ->> 'status' = 'posted'
                     AND NOT raw.has_cancelled_sibling
                    THEN 'SALE_RETURN_CREATED'
                WHEN raw.raw_entity_type = 'ledger.sale_returns'
                     AND raw.raw_action = 'update'
                     AND raw.new_values ->> 'status' = 'cancelled'
                     AND raw.has_posted_sibling
                    THEN 'SALE_RETURN_CORRECTED'
                WHEN raw.raw_entity_type = 'ledger.sale_returns'
                     AND raw.raw_action = 'update'
                     AND raw.new_values ->> 'status' = 'cancelled'
                    THEN 'SALE_RETURN_CANCELLED'

                WHEN raw.raw_entity_type = 'ledger.supplier_returns'
                     AND raw.raw_action = 'update'
                     AND raw.old_values ->> 'status' = 'draft'
                     AND raw.new_values ->> 'status' = 'posted'
                     AND NOT raw.has_cancelled_sibling
                    THEN 'SUPPLIER_RETURN_CREATED'
                WHEN raw.raw_entity_type = 'ledger.supplier_returns'
                     AND raw.raw_action = 'update'
                     AND raw.new_values ->> 'status' = 'cancelled'
                     AND raw.has_posted_sibling
                    THEN 'SUPPLIER_RETURN_CORRECTED'
                WHEN raw.raw_entity_type = 'ledger.supplier_returns'
                     AND raw.raw_action = 'update'
                     AND raw.new_values ->> 'status' = 'cancelled'
                    THEN 'SUPPLIER_RETURN_CANCELLED'

                WHEN raw.raw_entity_type = 'ledger.stock_counts'
                     AND raw.raw_action = 'update'
                     AND raw.old_values ->> 'status' IN ('draft', 'counting')
                     AND raw.new_values ->> 'status' = 'posted'
                     AND NOT raw.has_cancelled_sibling
                    THEN 'STOCK_COUNT_CREATED'
                WHEN raw.raw_entity_type = 'ledger.stock_counts'
                     AND raw.raw_action = 'update'
                     AND raw.new_values ->> 'status' = 'cancelled'
                     AND raw.has_posted_sibling
                    THEN 'STOCK_COUNT_CORRECTED'
                WHEN raw.raw_entity_type = 'ledger.stock_counts'
                     AND raw.raw_action = 'update'
                     AND raw.new_values ->> 'status' = 'cancelled'
                    THEN 'STOCK_COUNT_CANCELLED'

                WHEN raw.raw_entity_type = 'ledger.manual_inventory_entries'
                     AND raw.raw_action = 'insert'
                    THEN 'MANUAL_INVENTORY_CREATED'

                WHEN raw.raw_entity_type = 'ledger.owner_ledger_entries'
                     AND raw.raw_action = 'insert'
                     AND (
                         raw.new_values ->> 'entry_type' = 'correction'
                         OR raw.new_values ->> 'reversal_of_id' IS NOT NULL
                     )
                    THEN 'OWNER_LEDGER_CORRECTION_CREATED'
                WHEN raw.raw_entity_type = 'ledger.owner_ledger_entries'
                     AND raw.raw_action = 'insert'
                    THEN 'OWNER_LEDGER_ENTRY_CREATED'

                WHEN raw.raw_entity_type = 'ledger.app_settings'
                     AND raw.raw_action = 'update'
                     AND (
                         raw.old_values -> 'daily_report_time_minutes'
                             IS DISTINCT FROM raw.new_values -> 'daily_report_time_minutes'
                         OR raw.old_values -> 'default_credit_policy'
                             IS DISTINCT FROM raw.new_values -> 'default_credit_policy'
                         OR raw.old_values -> 'default_credit_limit_minor'
                             IS DISTINCT FROM raw.new_values -> 'default_credit_limit_minor'
                         OR raw.old_values -> 'allow_negative_stock'
                             IS DISTINCT FROM raw.new_values -> 'allow_negative_stock'
                         OR raw.old_values -> 'low_stock_alert_enabled'
                             IS DISTINCT FROM raw.new_values -> 'low_stock_alert_enabled'
                         OR raw.old_values -> 'debt_age_alert_days'
                             IS DISTINCT FROM raw.new_values -> 'debt_age_alert_days'
                         OR raw.old_values -> 'customer_debt_amount_alert_minor'
                             IS DISTINCT FROM raw.new_values -> 'customer_debt_amount_alert_minor'
                         OR raw.old_values -> 'backup_enabled'
                             IS DISTINCT FROM raw.new_values -> 'backup_enabled'
                         OR raw.old_values -> 'backup_interval_hours'
                             IS DISTINCT FROM raw.new_values -> 'backup_interval_hours'
                     )
                    THEN 'STORE_SETTINGS_UPDATED'
                ELSE NULL
            END AS mapped_action,
            CASE raw.raw_entity_type
                WHEN 'ledger.customers' THEN 'customer'
                WHEN 'ledger.suppliers' THEN 'supplier'
                WHEN 'ledger.products' THEN 'product'
                WHEN 'ledger.product_units' THEN 'product_unit'
                WHEN 'ledger.money_accounts' THEN 'money_account'
                WHEN 'ledger.accounting_periods' THEN 'accounting_period'
                WHEN 'ledger.sales' THEN 'sale'
                WHEN 'ledger.purchase_invoices' THEN 'supplier_invoice'
                WHEN 'ledger.customer_payments' THEN 'customer_collection'
                WHEN 'ledger.supplier_payments' THEN 'supplier_payment'
                WHEN 'ledger.expenses' THEN 'expense'
                WHEN 'ledger.money_transfers' THEN 'money_transfer'
                WHEN 'ledger.sale_returns' THEN 'sale_return'
                WHEN 'ledger.supplier_returns' THEN 'supplier_return'
                WHEN 'ledger.stock_counts' THEN 'stock_count'
                WHEN 'ledger.manual_inventory_entries' THEN 'manual_inventory'
                WHEN 'ledger.owner_ledger_entries' THEN 'owner_ledger'
                WHEN 'ledger.app_settings' THEN 'store_settings'
                ELSE NULL
            END AS mapped_entity_type,
            raw.entity_id,
            COALESCE(
                raw.new_values ->> 'display_number',
                raw.old_values ->> 'display_number',
                raw.new_values ->> 'name',
                raw.old_values ->> 'name',
                raw.new_values ->> 'unit_name',
                raw.old_values ->> 'unit_name',
                raw.new_values ->> 'entry_type',
                raw.old_values ->> 'entry_type'
            ) AS mapped_reference,
            CASE WHEN raw.user_id IS NULL THEN 'system' ELSE 'user' END
                AS mapped_actor_type,
            raw.user_id,
            raw.actor_name,
            raw.occurred_at,
            CASE
                WHEN COALESCE(
                    raw.new_values ->> 'posting_date',
                    raw.old_values ->> 'posting_date',
                    raw.new_values ->> 'business_date',
                    raw.old_values ->> 'business_date'
                ) ~ '^\\d{4}-\\d{2}-\\d{2}$'
                THEN COALESCE(
                    raw.new_values ->> 'posting_date',
                    raw.old_values ->> 'posting_date',
                    raw.new_values ->> 'business_date',
                    raw.old_values ->> 'business_date'
                )::date
                ELSE NULL
            END AS mapped_business_date,
            CASE raw.raw_entity_type
                WHEN 'ledger.app_settings' THEN
                    ledger.sanitize_app_settings_audit_v1(
                        raw.old_values, raw.new_values
                    )
                WHEN 'ledger.owner_ledger_entries' THEN
                    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                        'entryType', raw.new_values ->> 'entry_type',
                        'ownerLiabilityDeltaMinor',
                            raw.new_values ->> 'owner_liability_delta_minor',
                        'equityDeltaMinor', raw.new_values ->> 'equity_delta_minor',
                        'moneyAccountId', raw.new_values ->> 'money_account_id',
                        'referenceType', raw.new_values ->> 'reference_type',
                        'referenceId', raw.new_values ->> 'reference_id',
                        'reversalOfId', raw.new_values ->> 'reversal_of_id'
                    ))
                WHEN 'ledger.sales' THEN
                    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                        'displayNumber', COALESCE(
                            raw.new_values ->> 'display_number',
                            raw.old_values ->> 'display_number'
                        ),
                        'customerId', COALESCE(
                            raw.new_values ->> 'customer_id',
                            raw.old_values ->> 'customer_id'
                        ),
                        'totalMinor', COALESCE(
                            raw.new_values ->> 'total_minor',
                            raw.old_values ->> 'total_minor'
                        ),
                        'paidTotalMinor', COALESCE(
                            raw.new_values ->> 'paid_total_minor',
                            raw.old_values ->> 'paid_total_minor'
                        ),
                        'creditTotalMinor', COALESCE(
                            raw.new_values ->> 'credit_total_minor',
                            raw.old_values ->> 'credit_total_minor'
                        ),
                        'replacementId', raw.new_values ->> 'reversed_by_id'
                    ))
                WHEN 'ledger.purchase_invoices' THEN
                    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                        'displayNumber', COALESCE(
                            raw.new_values ->> 'display_number',
                            raw.old_values ->> 'display_number'
                        ),
                        'supplierId', COALESCE(
                            raw.new_values ->> 'supplier_id',
                            raw.old_values ->> 'supplier_id'
                        ),
                        'totalMinor', COALESCE(
                            raw.new_values ->> 'total_minor',
                            raw.old_values ->> 'total_minor'
                        )
                    ))
                WHEN 'ledger.customer_payments' THEN
                    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                        'customerId', COALESCE(
                            raw.new_values ->> 'customer_id',
                            raw.old_values ->> 'customer_id'
                        ),
                        'amountMinor', COALESCE(
                            raw.new_values ->> 'amount_minor',
                            raw.old_values ->> 'amount_minor'
                        ),
                        'allocatedTotalMinor', COALESCE(
                            raw.new_values ->> 'allocated_total_minor',
                            raw.old_values ->> 'allocated_total_minor'
                        ),
                        'creditCreatedMinor', COALESCE(
                            raw.new_values ->> 'credit_created_minor',
                            raw.old_values ->> 'credit_created_minor'
                        )
                    ))
                WHEN 'ledger.supplier_payments' THEN
                    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                        'supplierId', COALESCE(
                            raw.new_values ->> 'supplier_id',
                            raw.old_values ->> 'supplier_id'
                        ),
                        'amountMinor', COALESCE(
                            raw.new_values ->> 'amount_minor',
                            raw.old_values ->> 'amount_minor'
                        ),
                        'paymentSource', COALESCE(
                            raw.new_values ->> 'payment_source',
                            raw.old_values ->> 'payment_source'
                        )
                    ))
                WHEN 'ledger.expenses' THEN
                    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                        'amountMinor', COALESCE(
                            raw.new_values ->> 'amount_minor',
                            raw.old_values ->> 'amount_minor'
                        ),
                        'paidTotalMinor', COALESCE(
                            raw.new_values ->> 'paid_total_minor',
                            raw.old_values ->> 'paid_total_minor'
                        ),
                        'paymentDeltaMinor', CASE
                            WHEN raw.old_values ? 'paid_total_minor'
                                 AND raw.new_values ? 'paid_total_minor'
                            THEN (
                                (raw.new_values ->> 'paid_total_minor')::bigint
                                - (raw.old_values ->> 'paid_total_minor')::bigint
                            )::text
                            ELSE NULL
                        END
                    ))
                WHEN 'ledger.money_transfers' THEN
                    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                        'displayNumber', COALESCE(
                            raw.new_values ->> 'display_number',
                            raw.old_values ->> 'display_number'
                        ),
                        'amountMinor', COALESCE(
                            raw.new_values ->> 'amount_minor',
                            raw.old_values ->> 'amount_minor'
                        ),
                        'sourceAccountId', COALESCE(
                            raw.new_values ->> 'source_account_id',
                            raw.old_values ->> 'source_account_id'
                        ),
                        'destinationAccountId', COALESCE(
                            raw.new_values ->> 'destination_account_id',
                            raw.old_values ->> 'destination_account_id'
                        )
                    ))
                WHEN 'ledger.sale_returns' THEN
                    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                        'displayNumber', COALESCE(
                            raw.new_values ->> 'display_number',
                            raw.old_values ->> 'display_number'
                        ),
                        'saleId', COALESCE(
                            raw.new_values ->> 'sale_id',
                            raw.old_values ->> 'sale_id'
                        ),
                        'totalMinor', COALESCE(
                            raw.new_values ->> 'total_minor',
                            raw.old_values ->> 'total_minor'
                        )
                    ))
                WHEN 'ledger.supplier_returns' THEN
                    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                        'displayNumber', COALESCE(
                            raw.new_values ->> 'display_number',
                            raw.old_values ->> 'display_number'
                        ),
                        'supplierId', COALESCE(
                            raw.new_values ->> 'supplier_id',
                            raw.old_values ->> 'supplier_id'
                        ),
                        'totalMinor', COALESCE(
                            raw.new_values ->> 'total_minor',
                            raw.old_values ->> 'total_minor'
                        )
                    ))
                WHEN 'ledger.stock_counts' THEN
                    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                        'displayNumber', COALESCE(
                            raw.new_values ->> 'display_number',
                            raw.old_values ->> 'display_number'
                        ),
                        'countType', COALESCE(
                            raw.new_values ->> 'count_type',
                            raw.old_values ->> 'count_type'
                        )
                    ))
                WHEN 'ledger.manual_inventory_entries' THEN
                    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                        'productId', raw.new_values ->> 'product_id',
                        'productUnitId', raw.new_values ->> 'product_unit_id',
                        'quantityMilli', raw.new_values ->> 'base_quantity_milli',
                        'totalPurchaseCostMinor',
                            raw.new_values ->> 'total_purchase_cost_minor',
                        'costStatus', raw.new_values ->> 'cost_status'
                    ))
                WHEN 'ledger.accounting_periods' THEN
                    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                        'year', COALESCE(
                            raw.new_values ->> 'period_year',
                            raw.old_values ->> 'period_year'
                        ),
                        'month', COALESCE(
                            raw.new_values ->> 'period_month',
                            raw.old_values ->> 'period_month'
                        ),
                        'status', COALESCE(
                            raw.new_values ->> 'status',
                            raw.old_values ->> 'status'
                        )
                    ))
                WHEN 'ledger.customers' THEN
                    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                        'name', COALESCE(
                            raw.new_values ->> 'name', raw.old_values ->> 'name'
                        ),
                        'status', COALESCE(
                            raw.new_values ->> 'status', raw.old_values ->> 'status'
                        )
                    ))
                WHEN 'ledger.suppliers' THEN
                    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                        'name', COALESCE(
                            raw.new_values ->> 'name', raw.old_values ->> 'name'
                        ),
                        'status', COALESCE(
                            raw.new_values ->> 'status', raw.old_values ->> 'status'
                        )
                    ))
                WHEN 'ledger.products' THEN
                    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                        'name', COALESCE(
                            raw.new_values ->> 'name', raw.old_values ->> 'name'
                        ),
                        'status', COALESCE(
                            raw.new_values ->> 'status', raw.old_values ->> 'status'
                        ),
                        'measurementType', COALESCE(
                            raw.new_values ->> 'measurement_type',
                            raw.old_values ->> 'measurement_type'
                        )
                    ))
                WHEN 'ledger.product_units' THEN
                    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                        'productId', COALESCE(
                            raw.new_values ->> 'product_id',
                            raw.old_values ->> 'product_id'
                        ),
                        'unitName', COALESCE(
                            raw.new_values ->> 'unit_name',
                            raw.old_values ->> 'unit_name'
                        ),
                        'status', COALESCE(
                            raw.new_values ->> 'status', raw.old_values ->> 'status'
                        ),
                        'salePriceMinor', COALESCE(
                            raw.new_values ->> 'sale_price_minor',
                            raw.old_values ->> 'sale_price_minor'
                        ),
                        'purchasePriceMinor', COALESCE(
                            raw.new_values ->> 'purchase_price_minor',
                            raw.old_values ->> 'purchase_price_minor'
                        )
                    ))
                WHEN 'ledger.money_accounts' THEN
                    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                        'name', COALESCE(
                            raw.new_values ->> 'name', raw.old_values ->> 'name'
                        ),
                        'accountType', COALESCE(
                            raw.new_values ->> 'account_type',
                            raw.old_values ->> 'account_type'
                        ),
                        'status', COALESCE(
                            raw.new_values ->> 'status', raw.old_values ->> 'status'
                        )
                    ))
                ELSE '{}'::jsonb
            END AS mapped_context
        FROM raw_evidence AS raw
    )
    SELECT
        mapped.event_id,
        mapped.mapped_action,
        mapped.mapped_entity_type,
        mapped.entity_id,
        mapped.mapped_reference,
        mapped.mapped_actor_type,
        mapped.user_id,
        mapped.actor_name,
        mapped.occurred_at,
        mapped.mapped_business_date,
        mapped.mapped_context
    FROM mapped
    WHERE mapped.mapped_action IS NOT NULL
      AND mapped.mapped_entity_type IS NOT NULL
      AND (p_action IS NULL OR mapped.mapped_action = p_action)
      AND (p_entity_type IS NULL OR mapped.mapped_entity_type = p_entity_type)
    ORDER BY mapped.occurred_at DESC, mapped.event_id DESC
    LIMIT p_limit;
END
$function$;

REVOKE ALL ON FUNCTION ledger.read_owner_business_audit_v1(
    integer, timestamptz, uuid, timestamptz, timestamptz,
    uuid, text, text, uuid
)
FROM PUBLIC, shop_app_auth, shop_app_auth_owner;
GRANT EXECUTE ON FUNCTION ledger.read_owner_business_audit_v1(
    integer, timestamptz, uuid, timestamptz, timestamptz,
    uuid, text, text, uuid
)
TO shop_app_runtime;

CREATE INDEX idx_central_audit_store_time_event_v1
ON audit.central_audit_logs (store_id, occurred_at DESC, event_id DESC);

CREATE INDEX idx_central_audit_store_request_entity_v1
ON audit.central_audit_logs (store_id, request_id, entity_type)
WHERE request_id IS NOT NULL;

CREATE TRIGGER trg_app_settings_central_audit
AFTER UPDATE ON ledger.app_settings
FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();

CREATE TRIGGER trg_owner_ledger_entries_central_audit
AFTER INSERT ON ledger.owner_ledger_entries
FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();

DO $postconditions$
DECLARE
    v_reader regprocedure :=
        'ledger.read_owner_business_audit_v1(integer,timestamp with time zone,uuid,timestamp with time zone,timestamp with time zone,uuid,text,text,uuid)'::regprocedure;
    v_settings_sanitizer regprocedure :=
        'ledger.sanitize_app_settings_audit_v1(jsonb,jsonb)'::regprocedure;
BEGIN
    IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = v_reader)
            <> 'shop_app_migrator'
       OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_reader)
       OR (SELECT provolatile FROM pg_proc WHERE oid = v_reader) <> 's'
       OR (SELECT proconfig FROM pg_proc WHERE oid = v_reader)
            IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
       OR (SELECT pg_get_userbyid(proowner)
           FROM pg_proc WHERE oid = v_settings_sanitizer) <> 'shop_app_migrator'
       OR (SELECT prosecdef FROM pg_proc WHERE oid = v_settings_sanitizer)
       OR (SELECT proconfig FROM pg_proc WHERE oid = v_settings_sanitizer)
            IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
       OR NOT has_function_privilege('shop_app_runtime', v_reader, 'EXECUTE')
       OR has_function_privilege('public', v_reader, 'EXECUTE')
       OR has_function_privilege('shop_app_auth', v_reader, 'EXECUTE')
       OR has_function_privilege('shop_app_auth_owner', v_reader, 'EXECUTE')
       OR has_function_privilege(
            'shop_app_runtime', v_settings_sanitizer, 'EXECUTE'
       )
       OR has_function_privilege('public', v_settings_sanitizer, 'EXECUTE')
       OR has_table_privilege(
            'shop_app_runtime', 'audit.central_audit_logs', 'SELECT'
       )
       OR has_schema_privilege('shop_app_runtime', 'audit', 'USAGE')
       OR to_regclass('audit.idx_central_audit_store_time_event_v1') IS NULL
       OR to_regclass('audit.idx_central_audit_store_request_entity_v1') IS NULL
       OR NOT EXISTS (
            SELECT 1
            FROM pg_trigger AS trigger_state
            WHERE trigger_state.tgrelid = 'ledger.app_settings'::regclass
              AND trigger_state.tgname = 'trg_app_settings_central_audit'
              AND trigger_state.tgfoid = 'audit.capture_row_change()'::regprocedure
              AND NOT trigger_state.tgisinternal
       )
       OR NOT EXISTS (
            SELECT 1
            FROM pg_trigger AS trigger_state
            WHERE trigger_state.tgrelid = 'ledger.owner_ledger_entries'::regclass
              AND trigger_state.tgname = 'trg_owner_ledger_entries_central_audit'
              AND trigger_state.tgfoid = 'audit.capture_row_change()'::regprocedure
              AND NOT trigger_state.tgisinternal
       ) THEN
        RAISE EXCEPTION '0031 did not install the approved sanitized audit boundary';
    END IF;
END
$postconditions$;
