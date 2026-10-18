DO $preconditions$
BEGIN
    IF session_user <> 'dokana_migration_login'
       OR current_user <> 'shop_app_migrator' THEN
        RAISE EXCEPTION '0032 requires the approved migration login and effective role';
    END IF;

    IF to_regclass('ledger.attachments') IS NULL
       OR to_regclass('audit.central_audit_logs') IS NULL
       OR to_regprocedure('audit.capture_row_change()') IS NULL
       OR to_regprocedure(
            'ledger.read_owner_business_audit_v1(integer,timestamp with time zone,uuid,timestamp with time zone,timestamp with time zone,uuid,text,text,uuid)'
          ) IS NULL
       OR to_regprocedure(
            'ledger.read_owner_business_audit_pre_attachments_v1(integer,timestamp with time zone,uuid,timestamp with time zone,timestamp with time zone,uuid,text,text,uuid)'
          ) IS NOT NULL
       OR to_regprocedure('ledger.remove_attachment_v1(uuid)') IS NOT NULL THEN
        RAISE EXCEPTION '0032 found an unexpected attachment or audit foundation state';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'ledger'
          AND table_name = 'attachments'
          AND column_name IN ('removed_at', 'removed_by_user_id')
    )
       OR EXISTS (
            SELECT 1
            FROM pg_trigger
            WHERE tgrelid = 'ledger.attachments'::regclass
              AND NOT tgisinternal
       )
       OR EXISTS (
            SELECT 1
            FROM ledger.attachments
            WHERE sync_status = 'deleted'
       ) THEN
        RAISE EXCEPTION '0032 requires a clean pre-lifecycle attachment state';
    END IF;

    IF NOT (
        SELECT relrowsecurity AND relforcerowsecurity
        FROM pg_class
        WHERE oid = 'ledger.attachments'::regclass
    )
       OR NOT (
            SELECT relrowsecurity AND relforcerowsecurity
            FROM pg_class
            WHERE oid = 'audit.central_audit_logs'::regclass
       )
       OR (SELECT pg_get_userbyid(relowner)
           FROM pg_class
           WHERE oid = 'ledger.attachments'::regclass) <> 'shop_app_migrator'
       OR has_table_privilege('shop_app_runtime', 'audit.central_audit_logs', 'SELECT')
       OR has_schema_privilege('shop_app_runtime', 'audit', 'USAGE') THEN
        RAISE EXCEPTION '0032 requires the approved forced-RLS and private-audit boundary';
    END IF;
END
$preconditions$;

ALTER TABLE ledger.attachments
    ADD COLUMN removed_at timestamptz,
    ADD COLUMN removed_by_user_id uuid;

ALTER TABLE ledger.attachments
    ADD CONSTRAINT attachments_removed_by_user_id_fkey
        FOREIGN KEY (removed_by_user_id)
        REFERENCES platform.users(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    ADD CONSTRAINT attachments_removal_evidence_check
        CHECK (
            (removed_at IS NULL AND removed_by_user_id IS NULL)
            OR (removed_at IS NOT NULL AND removed_by_user_id IS NOT NULL)
        );

CREATE INDEX idx_attachments_active_entity
ON ledger.attachments(store_id, entity_type, entity_id, created_at, id)
WHERE removed_at IS NULL;

CREATE FUNCTION ledger.remove_attachment_v1(p_attachment_id uuid)
RETURNS TABLE (
    attachment_id uuid,
    removed_at timestamptz,
    removed_by_user_id uuid
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
ROWS 1
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_store_id uuid := platform.current_store_id();
    v_user_id uuid := platform.current_user_id();
BEGIN
    IF v_store_id IS NULL OR v_user_id IS NULL OR p_attachment_id IS NULL THEN
        RAISE EXCEPTION 'ATTACHMENT_REMOVAL_INVALID' USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM ledger.stores AS store_record
        WHERE store_record.id = v_store_id
          AND store_record.status = 'active'
    )
       OR NOT EXISTS (
            SELECT 1
            FROM platform.store_memberships AS membership
            WHERE membership.store_id = v_store_id
              AND membership.user_id = v_user_id
              AND membership.role = 'owner'
              AND membership.status = 'active'
       ) THEN
        RAISE EXCEPTION 'ATTACHMENT_REMOVAL_NOT_ALLOWED' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    UPDATE ledger.attachments AS attachment
    SET removed_at = statement_timestamp(),
        removed_by_user_id = v_user_id,
        updated_at = statement_timestamp()
    WHERE attachment.store_id = v_store_id
      AND attachment.id = p_attachment_id
      AND attachment.removed_at IS NULL
    RETURNING attachment.id, attachment.removed_at, attachment.removed_by_user_id;
END
$function$;

REVOKE ALL ON FUNCTION ledger.remove_attachment_v1(uuid)
FROM PUBLIC, shop_app_auth, shop_app_auth_owner;
GRANT EXECUTE ON FUNCTION ledger.remove_attachment_v1(uuid)
TO shop_app_runtime;

REVOKE UPDATE, DELETE ON ledger.attachments FROM shop_app_runtime;

ALTER FUNCTION ledger.read_owner_business_audit_v1(
    integer, timestamptz, uuid, timestamptz, timestamptz,
    uuid, text, text, uuid
)
RENAME TO read_owner_business_audit_pre_attachments_v1;

REVOKE ALL ON FUNCTION ledger.read_owner_business_audit_pre_attachments_v1(
    integer, timestamptz, uuid, timestamptz, timestamptz,
    uuid, text, text, uuid
)
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
        'STORE_SETTINGS_UPDATED','ATTACHMENT_ADDED','ATTACHMENT_REMOVED'
    ]::text[]) THEN
        RAISE EXCEPTION 'AUDIT_FILTER_NOT_ALLOWED' USING ERRCODE = '22023';
    END IF;

    IF p_entity_type IS NOT NULL AND p_entity_type <> ALL (ARRAY[
        'customer','supplier','product','product_unit','money_account',
        'accounting_period','sale','supplier_invoice','customer_collection',
        'supplier_payment','expense','money_transfer','sale_return',
        'supplier_return','stock_count','manual_inventory','owner_ledger',
        'store_settings','attachment'
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
    WITH existing_events AS (
        SELECT legacy.*
        FROM ledger.read_owner_business_audit_pre_attachments_v1(
            p_limit,
            p_cursor_occurred_at,
            p_cursor_event_id,
            p_occurred_from,
            p_occurred_to,
            p_actor_user_id,
            CASE WHEN p_action IN ('ATTACHMENT_ADDED', 'ATTACHMENT_REMOVED')
                THEN NULL ELSE p_action END,
            CASE WHEN p_entity_type = 'attachment' THEN NULL ELSE p_entity_type END,
            p_entity_id
        ) AS legacy
        WHERE p_action IS DISTINCT FROM 'ATTACHMENT_ADDED'
          AND p_action IS DISTINCT FROM 'ATTACHMENT_REMOVED'
          AND p_entity_type IS DISTINCT FROM 'attachment'
    ),
    attachment_evidence AS (
        SELECT
            evidence.event_id,
            CASE
                WHEN evidence.action = 'insert'
                    AND evidence.new_values ->> 'removed_at' IS NULL
                    THEN 'ATTACHMENT_ADDED'
                WHEN evidence.action = 'update'
                    AND evidence.old_values ->> 'removed_at' IS NULL
                    AND evidence.new_values ->> 'removed_at' IS NOT NULL
                    THEN 'ATTACHMENT_REMOVED'
                ELSE NULL
            END AS mapped_action,
            evidence.entity_id,
            evidence.user_id,
            actor.full_name AS actor_name,
            evidence.occurred_at,
            COALESCE(
                evidence.new_values ->> 'entity_type',
                evidence.old_values ->> 'entity_type'
            ) AS parent_entity_type,
            NULLIF(COALESCE(
                evidence.new_values ->> 'entity_id',
                evidence.old_values ->> 'entity_id'
            ), '')::uuid AS parent_entity_id,
            pg_catalog.left(
                pg_catalog.regexp_replace(
                    COALESCE(
                        evidence.new_values ->> 'file_name',
                        evidence.old_values ->> 'file_name',
                        ''
                    ),
                    E'[[:cntrl:]/\\\\]',
                    '_',
                    'g'
                ),
                255
            ) AS safe_file_name
        FROM audit.central_audit_logs AS evidence
        LEFT JOIN platform.users AS actor ON actor.id = evidence.user_id
        WHERE evidence.store_id = v_store_id
          AND evidence.entity_type = 'ledger.attachments'
          AND COALESCE(
                evidence.new_values ->> 'entity_type',
                evidence.old_values ->> 'entity_type'
              ) IN ('customer', 'product', 'supplier', 'expense')
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
    attachment_events AS (
        SELECT
            evidence.event_id AS audit_event_id,
            evidence.mapped_action AS business_action,
            'attachment'::text AS business_entity_type,
            evidence.entity_id AS business_entity_id,
            NULLIF(evidence.safe_file_name, '') AS entity_reference,
            CASE WHEN evidence.user_id IS NULL THEN 'system' ELSE 'user' END::text
                AS actor_type,
            evidence.user_id AS actor_user_id,
            evidence.actor_name AS actor_display_name,
            evidence.occurred_at,
            NULL::date AS business_date,
            pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                'attachmentId', evidence.entity_id,
                'parentEntityType', evidence.parent_entity_type,
                'parentEntityId', evidence.parent_entity_id,
                'filename', NULLIF(evidence.safe_file_name, '')
            )) AS safe_context
        FROM attachment_evidence AS evidence
        WHERE evidence.mapped_action IS NOT NULL
          AND (p_action IS NULL OR evidence.mapped_action = p_action)
          AND (p_entity_type IS NULL OR p_entity_type = 'attachment')
    ),
    combined AS (
        SELECT * FROM existing_events
        UNION ALL
        SELECT * FROM attachment_events
    )
    SELECT
        combined.audit_event_id,
        combined.business_action,
        combined.business_entity_type,
        combined.business_entity_id,
        combined.entity_reference,
        combined.actor_type,
        combined.actor_user_id,
        combined.actor_display_name,
        combined.occurred_at,
        combined.business_date,
        combined.safe_context
    FROM combined
    ORDER BY combined.occurred_at DESC, combined.audit_event_id DESC
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

CREATE TRIGGER trg_attachments_created_central_audit
AFTER INSERT ON ledger.attachments
FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();

CREATE TRIGGER trg_attachments_removed_central_audit
AFTER UPDATE OF removed_at ON ledger.attachments
FOR EACH ROW
WHEN (OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL)
EXECUTE FUNCTION audit.capture_row_change();

DO $postconditions$
DECLARE
    v_reader regprocedure :=
        'ledger.read_owner_business_audit_v1(integer,timestamp with time zone,uuid,timestamp with time zone,timestamp with time zone,uuid,text,text,uuid)'::regprocedure;
    v_previous_reader regprocedure :=
        'ledger.read_owner_business_audit_pre_attachments_v1(integer,timestamp with time zone,uuid,timestamp with time zone,timestamp with time zone,uuid,text,text,uuid)'::regprocedure;
    v_remover regprocedure := 'ledger.remove_attachment_v1(uuid)'::regprocedure;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'ledger'
          AND table_name = 'attachments'
          AND column_name = 'removed_at'
          AND data_type = 'timestamp with time zone'
          AND is_nullable = 'YES'
    )
       OR NOT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'ledger'
              AND table_name = 'attachments'
              AND column_name = 'removed_by_user_id'
              AND data_type = 'uuid'
              AND is_nullable = 'YES'
       )
       OR NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conrelid = 'ledger.attachments'::regclass
              AND conname = 'attachments_removal_evidence_check'
       )
       OR NOT EXISTS (
            SELECT 1
            FROM pg_indexes
            WHERE schemaname = 'ledger'
              AND tablename = 'attachments'
              AND indexname = 'idx_attachments_active_entity'
       ) THEN
        RAISE EXCEPTION '0032 attachment lifecycle objects are incomplete';
    END IF;

    IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = v_reader)
            <> 'shop_app_migrator'
       OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_reader)
       OR (SELECT provolatile FROM pg_proc WHERE oid = v_reader) <> 's'
       OR (SELECT proconfig FROM pg_proc WHERE oid = v_reader)
            IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
       OR has_function_privilege('public', v_reader, 'EXECUTE')
       OR NOT has_function_privilege('shop_app_runtime', v_reader, 'EXECUTE')
       OR has_function_privilege('shop_app_runtime', v_previous_reader, 'EXECUTE')
       OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = v_remover)
            <> 'shop_app_migrator'
       OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_remover)
       OR (SELECT provolatile FROM pg_proc WHERE oid = v_remover) <> 'v'
       OR (SELECT proconfig FROM pg_proc WHERE oid = v_remover)
            IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
       OR has_function_privilege('public', v_remover, 'EXECUTE')
       OR NOT has_function_privilege('shop_app_runtime', v_remover, 'EXECUTE') THEN
        RAISE EXCEPTION '0032 function ownership, security, or grants are unsafe';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'ledger.attachments'::regclass
          AND tgname = 'trg_attachments_created_central_audit'
          AND NOT tgisinternal
          AND tgenabled <> 'D'
    )
       OR NOT EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgrelid = 'ledger.attachments'::regclass
              AND tgname = 'trg_attachments_removed_central_audit'
              AND NOT tgisinternal
              AND tgenabled <> 'D'
       )
       OR has_table_privilege('shop_app_runtime', 'ledger.attachments', 'UPDATE')
       OR has_table_privilege('shop_app_runtime', 'ledger.attachments', 'DELETE')
       OR NOT has_table_privilege('shop_app_runtime', 'ledger.attachments', 'SELECT')
       OR NOT has_table_privilege('shop_app_runtime', 'ledger.attachments', 'INSERT')
       OR has_table_privilege('shop_app_runtime', 'audit.central_audit_logs', 'SELECT')
       OR has_schema_privilege('shop_app_runtime', 'audit', 'USAGE')
       OR NOT (
            SELECT relrowsecurity AND relforcerowsecurity
            FROM pg_class
            WHERE oid = 'ledger.attachments'::regclass
       ) THEN
        RAISE EXCEPTION '0032 attachment privileges, triggers, or RLS are unsafe';
    END IF;
END
$postconditions$;
