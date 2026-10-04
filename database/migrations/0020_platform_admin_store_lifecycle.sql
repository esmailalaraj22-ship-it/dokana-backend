-- Migration 0020: expose the minimum Store administration authority for S18.5.
--
-- Scope is limited to bounded Platform Admin Store listing, versioned/idempotent
-- Store suspension and restoration, and bounded immutable administrative history.
-- It adds no business table or column and grants no direct platform/accounting access.
--
-- Rollback requires backend-owner approval: revoke the three function grants, drop
-- the functions, and drop platform_admin_global_store_read. Existing admin_actions
-- rows are immutable evidence and must be retained.

DO $preconditions$
BEGIN
    IF session_user <> 'dokana_migration_login'
       OR current_user <> 'shop_app_migrator' THEN
        RAISE EXCEPTION '0020 requires the approved migration login and effective role';
    END IF;

    IF to_regclass('ledger.stores') IS NULL
       OR to_regclass('platform.platform_admin_assignments') IS NULL
       OR to_regclass('platform.admin_actions') IS NULL
       OR to_regprocedure('ledger.current_actor_is_platform_admin()') IS NULL
       OR pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'ledger.stores'::regclass))
            <> 'shop_app_migrator'
       OR pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'platform.admin_actions'::regclass))
            <> 'shop_app_migrator' THEN
        RAISE EXCEPTION '0020 requires the verified S18.3/S18.4 authority';
    END IF;

    IF NOT (
        SELECT relrowsecurity AND relforcerowsecurity
        FROM pg_class
        WHERE oid = 'ledger.stores'::regclass
    ) THEN
        RAISE EXCEPTION '0020 requires forced RLS on Stores';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'platform.admin_actions'::regclass
          AND tgname = 'trg_admin_actions_immutable'
          AND tgenabled = 'O'
          AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION '0020 requires immutable administrative history';
    END IF;

    IF to_regprocedure('ledger.list_platform_stores(timestamp with time zone,uuid,integer)')
            IS NOT NULL
       OR to_regprocedure('ledger.manage_store_lifecycle(uuid,text,bigint,uuid,text,text)')
            IS NOT NULL
       OR to_regprocedure(
            'ledger.read_store_admin_history(uuid,timestamp with time zone,uuid,integer)'
       ) IS NOT NULL
       OR EXISTS (
            SELECT 1
            FROM pg_policies
            WHERE schemaname = 'ledger'
              AND tablename = 'stores'
              AND policyname = 'platform_admin_global_store_read'
       ) THEN
        RAISE EXCEPTION '0020 managed objects already exist';
    END IF;

    IF has_schema_privilege('shop_app_runtime', 'platform', 'USAGE')
       OR has_table_privilege('shop_app_runtime', 'platform.admin_actions', 'INSERT')
       OR has_table_privilege('shop_app_runtime', 'platform.platform_admin_assignments', 'SELECT')
       OR has_table_privilege('shop_app_runtime', 'platform.subscriptions', 'SELECT') THEN
        RAISE EXCEPTION '0020 requires the verified runtime accounting firewall';
    END IF;
END
$preconditions$;

CREATE POLICY platform_admin_global_store_read
ON ledger.stores
AS PERMISSIVE
FOR SELECT
TO shop_app_migrator
USING (ledger.current_actor_is_platform_admin());

CREATE FUNCTION ledger.list_platform_stores(
    p_after_created_at timestamptz,
    p_after_store_id uuid,
    p_limit integer
)
RETURNS TABLE (
    store_id uuid,
    store_name text,
    store_phone text,
    currency_code text,
    store_status text,
    created_at timestamptz,
    updated_at timestamptz,
    store_version bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
    IF platform.current_user_id() IS NULL
       OR NOT ledger.current_actor_is_platform_admin() THEN
        RAISE EXCEPTION 'S18.5 Store listing requires an active Platform Admin'
            USING ERRCODE = '42501';
    END IF;

    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 101
       OR (p_after_created_at IS NULL) <> (p_after_store_id IS NULL) THEN
        RAISE EXCEPTION 'S18.5 Store listing input is invalid'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    SELECT
        store_record.id,
        store_record.name,
        store_record.phone,
        store_record.currency_code,
        store_record.status,
        store_record.created_at,
        store_record.updated_at,
        store_record.version
    FROM ledger.stores AS store_record
    WHERE p_after_created_at IS NULL
       OR (store_record.created_at, store_record.id) > (p_after_created_at, p_after_store_id)
    ORDER BY store_record.created_at, store_record.id
    LIMIT p_limit;
END
$function$;

CREATE FUNCTION ledger.manage_store_lifecycle(
    p_store_id uuid,
    p_action text,
    p_expected_version bigint,
    p_operation_id uuid,
    p_request_hash text,
    p_reason text
)
RETURNS TABLE (
    store_id uuid,
    store_status text,
    store_version bigint,
    lifecycle_action text,
    changed_at timestamptz,
    replayed boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_actor_id uuid;
    v_now timestamptz := clock_timestamp();
    v_store ledger.stores%ROWTYPE;
    v_audit platform.admin_actions%ROWTYPE;
    v_target_status text;
    v_previous jsonb;
    v_current jsonb;
BEGIN
    IF p_store_id IS NULL
       OR p_store_id IS DISTINCT FROM platform.current_store_id() THEN
        RAISE EXCEPTION 'S18.5 Store lifecycle requires matching Store context'
            USING ERRCODE = '42501';
    END IF;

    IF p_action NOT IN ('suspend', 'restore')
       OR p_expected_version IS NULL
       OR p_expected_version < 1
       OR p_operation_id IS NULL
       OR p_request_hash !~ '^[0-9a-f]{64}$'
       OR p_reason IS NULL
       OR length(trim(p_reason)) = 0 THEN
        RAISE EXCEPTION 'S18.5 Store lifecycle input is invalid'
            USING ERRCODE = '22023';
    END IF;

    v_actor_id := platform.current_user_id();
    IF v_actor_id IS NULL OR NOT ledger.current_actor_is_platform_admin() THEN
        RAISE EXCEPTION 'S18.5 Store lifecycle requires an active Platform Admin'
            USING ERRCODE = '42501';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('dokana:s18:' || p_operation_id::text, 0));

    SELECT action_record.*
    INTO v_audit
    FROM platform.admin_actions AS action_record
    WHERE action_record.request_id = p_operation_id
    ORDER BY action_record.occurred_at, action_record.id
    LIMIT 1;

    IF FOUND THEN
        IF v_audit.admin_user_id IS DISTINCT FROM v_actor_id
           OR v_audit.action <> 'store_' || p_action
           OR v_audit.store_id IS DISTINCT FROM p_store_id
           OR v_audit.metadata->>'requestHash' IS DISTINCT FROM p_request_hash THEN
            RAISE EXCEPTION 'S18.5 operation ID was reused with different semantics'
                USING ERRCODE = '23505';
        END IF;

        RETURN QUERY SELECT
            (v_audit.metadata #>> '{result,storeId}')::uuid,
            v_audit.metadata #>> '{result,status}',
            (v_audit.metadata #>> '{result,version}')::bigint,
            p_action,
            v_audit.occurred_at,
            true;
        RETURN;
    END IF;

    SELECT store_record.*
    INTO v_store
    FROM ledger.stores AS store_record
    WHERE store_record.id = p_store_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'S18.5 Store lifecycle target is unavailable'
            USING ERRCODE = '42501';
    END IF;

    IF v_store.version IS DISTINCT FROM p_expected_version THEN
        RAISE EXCEPTION 'S18.5 Store lifecycle version is stale'
            USING ERRCODE = '40001';
    END IF;

    IF p_action = 'suspend' THEN
        IF v_store.status NOT IN ('active', 'read_only') THEN
            RAISE EXCEPTION 'S18.5 Store cannot be suspended from its current state'
                USING ERRCODE = '55000';
        END IF;
        v_target_status := 'suspended';
    ELSE
        IF v_store.status <> 'suspended' THEN
            RAISE EXCEPTION 'S18.5 only a suspended Store can be restored'
                USING ERRCODE = '55000';
        END IF;
        v_target_status := 'active';
    END IF;

    v_previous := jsonb_build_object(
        'storeId', v_store.id,
        'status', v_store.status,
        'version', v_store.version::text
    );

    UPDATE ledger.stores AS store_record
    SET status = v_target_status,
        updated_at = v_now,
        version = store_record.version + 1
    WHERE store_record.id = p_store_id
    RETURNING store_record.* INTO v_store;

    v_current := jsonb_build_object(
        'storeId', v_store.id,
        'status', v_store.status,
        'version', v_store.version::text
    );

    INSERT INTO platform.admin_actions (
        id, admin_user_id, store_id, action, reason, request_id, metadata, occurred_at
    ) VALUES (
        gen_random_uuid(), v_actor_id, p_store_id, 'store_' || p_action,
        trim(p_reason), p_operation_id,
        jsonb_build_object(
            'requestHash', p_request_hash,
            'previous', v_previous,
            'current', v_current,
            'result', v_current
        ),
        v_now
    );

    RETURN QUERY SELECT
        v_store.id,
        v_store.status,
        v_store.version,
        p_action,
        v_now,
        false;
END
$function$;

CREATE FUNCTION ledger.read_store_admin_history(
    p_store_id uuid,
    p_after_occurred_at timestamptz,
    p_after_action_id uuid,
    p_limit integer
)
RETURNS TABLE (
    action_id uuid,
    admin_user_id uuid,
    action text,
    reason text,
    operation_id uuid,
    previous_values jsonb,
    current_values jsonb,
    occurred_at timestamptz
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
       OR NOT ledger.current_actor_is_platform_admin() THEN
        RAISE EXCEPTION 'S18.5 administrative history requires an active Platform Admin and matching Store context'
            USING ERRCODE = '42501';
    END IF;

    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 101
       OR (p_after_occurred_at IS NULL) <> (p_after_action_id IS NULL) THEN
        RAISE EXCEPTION 'S18.5 administrative history input is invalid'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    SELECT
        action_record.id,
        action_record.admin_user_id,
        action_record.action,
        action_record.reason,
        action_record.request_id,
        action_record.metadata->'previous',
        action_record.metadata->'current',
        action_record.occurred_at
    FROM platform.admin_actions AS action_record
    WHERE action_record.store_id = p_store_id
      AND (
        p_after_occurred_at IS NULL
        OR (action_record.occurred_at, action_record.id)
             < (p_after_occurred_at, p_after_action_id)
      )
    ORDER BY action_record.occurred_at DESC, action_record.id DESC
    LIMIT p_limit;
END
$function$;

REVOKE ALL ON FUNCTION
    ledger.list_platform_stores(timestamptz, uuid, integer),
    ledger.manage_store_lifecycle(uuid, text, bigint, uuid, text, text),
    ledger.read_store_admin_history(uuid, timestamptz, uuid, integer)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
    ledger.list_platform_stores(timestamptz, uuid, integer),
    ledger.manage_store_lifecycle(uuid, text, bigint, uuid, text, text),
    ledger.read_store_admin_history(uuid, timestamptz, uuid, integer)
TO shop_app_runtime;

DO $postconditions$
DECLARE
    managed_function record;
BEGIN
    IF (
        SELECT count(*)
        FROM pg_policies
        WHERE schemaname = 'ledger'
          AND tablename = 'stores'
          AND policyname = 'platform_admin_global_store_read'
          AND roles = ARRAY['shop_app_migrator']::name[]
          AND cmd = 'SELECT'
          AND permissive = 'PERMISSIVE'
    ) <> 1 THEN
        RAISE EXCEPTION '0020 global Store read policy is unexpected';
    END IF;

    FOR managed_function IN
        SELECT
            function_state.oid,
            pg_get_userbyid(function_state.proowner) AS owner,
            function_state.prosecdef AS security_definer,
            function_state.proconfig AS configuration
        FROM pg_proc AS function_state
        WHERE function_state.oid IN (
            'ledger.list_platform_stores(timestamp with time zone,uuid,integer)'::regprocedure,
            'ledger.manage_store_lifecycle(uuid,text,bigint,uuid,text,text)'::regprocedure,
            'ledger.read_store_admin_history(uuid,timestamp with time zone,uuid,integer)'::regprocedure
        )
    LOOP
        IF managed_function.owner <> 'shop_app_migrator'
           OR NOT managed_function.security_definer
           OR managed_function.configuration IS DISTINCT FROM
                ARRAY['search_path=pg_catalog, pg_temp']::text[]
           OR EXISTS (
                SELECT 1
                FROM aclexplode(COALESCE(
                    (SELECT proacl FROM pg_proc WHERE oid = managed_function.oid),
                    acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = managed_function.oid))
                )) AS privilege
                WHERE privilege.grantee = 0
                  AND privilege.privilege_type = 'EXECUTE'
           )
           OR NOT has_function_privilege('shop_app_runtime', managed_function.oid, 'EXECUTE')
           OR has_function_privilege('shop_app_auth', managed_function.oid, 'EXECUTE')
           OR has_function_privilege('shop_app_auth_owner', managed_function.oid, 'EXECUTE') THEN
            RAISE EXCEPTION '0020 managed function security configuration is unexpected';
        END IF;
    END LOOP;

    IF has_schema_privilege('shop_app_runtime', 'platform', 'USAGE')
       OR has_table_privilege('shop_app_runtime', 'platform.admin_actions', 'INSERT')
       OR has_table_privilege('shop_app_runtime', 'platform.platform_admin_assignments', 'SELECT')
       OR has_table_privilege('shop_app_runtime', 'platform.subscriptions', 'SELECT')
       OR NOT (
            SELECT relrowsecurity AND relforcerowsecurity
            FROM pg_class
            WHERE oid = 'ledger.stores'::regclass
       ) THEN
        RAISE EXCEPTION '0020 broadened runtime authority or weakened Store RLS';
    END IF;
END
$postconditions$;
