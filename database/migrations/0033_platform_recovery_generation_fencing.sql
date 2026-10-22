-- Migration 0033: durable platform recovery generation and transactional fencing.
--
-- The control row is platform-wide. Normal writes acquire the shared transaction
-- advisory lock through hardened functions; recovery transitions acquire the
-- exclusive form of the same lock. Applying this migration establishes lineage
-- but is not itself a disaster-recovery cutover.
--
-- Rollback requires backend-owner approval and must not be attempted after a
-- recovery activation. Before the first activation only: remove application use
-- of the v1 recovery functions, revoke their grants, drop the managed functions,
-- then drop platform.recovery_control.

DO $preconditions$
BEGIN
    IF session_user <> 'dokana_migration_login'
       OR current_user <> 'shop_app_migrator'
       OR NOT pg_has_role('dokana_migration_login', 'shop_app_migrator', 'SET')
       OR pg_has_role('dokana_migration_login', 'shop_app_runtime', 'SET')
       OR pg_has_role('dokana_migration_login', 'shop_app_auth', 'SET')
       OR pg_has_role('shop_app_migrator', 'shop_app_runtime', 'SET')
       OR pg_has_role('shop_app_migrator', 'shop_app_auth', 'SET') THEN
        RAISE EXCEPTION '0033 requires the approved migration login and role boundary';
    END IF;

    IF to_regclass('platform.recovery_control') IS NOT NULL
       OR to_regprocedure('ledger.assert_platform_write_authority_v1(uuid)') IS NOT NULL
       OR to_regprocedure('sync.capture_platform_recovery_authority_v1()') IS NOT NULL
       OR to_regprocedure('sync.assert_platform_recovery_authority_v1(uuid)') IS NOT NULL
       OR to_regprocedure('platform.fence_platform_recovery_v1(uuid)') IS NOT NULL
       OR to_regprocedure('platform.activate_new_recovery_generation_v1(uuid)') IS NOT NULL
       OR EXISTS (
            SELECT 1
            FROM pg_proc AS function_state
            INNER JOIN pg_namespace AS namespace_state
                ON namespace_state.oid = function_state.pronamespace
            WHERE namespace_state.nspname = 'auth_api'
              AND function_state.proname IN (
                  'issue_session_recovery_v1',
                  'validate_session_recovery_v1',
                  'rotate_refresh_token_recovery_v1',
                  'validate_sync_session_recovery_v1',
                  'validate_sync_refresh_token_recovery_v1'
              )
       ) THEN
        RAISE EXCEPTION '0033 found an unexpected recovery-authority state';
    END IF;

    IF to_regclass('platform.auth_sessions') IS NULL
       OR (
            SELECT count(DISTINCT function_state.proname)
            FROM pg_proc AS function_state
            INNER JOIN pg_namespace AS namespace_state
                ON namespace_state.oid = function_state.pronamespace
            WHERE namespace_state.nspname = 'auth_api'
              AND function_state.proname IN (
                  'issue_session',
                  'validate_session',
                  'rotate_refresh_token',
                  'validate_sync_session',
                  'validate_sync_refresh_token'
              )
       ) <> 5 THEN
        RAISE EXCEPTION '0033 requires the approved authentication foundation';
    END IF;
END
$preconditions$;

CREATE TABLE platform.recovery_control (
    singleton_key boolean PRIMARY KEY DEFAULT true,
    recovery_generation_id uuid NOT NULL,
    service_state text NOT NULL,
    authority_not_before timestamptz,
    fenced_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT recovery_control_singleton_check CHECK (singleton_key),
    CONSTRAINT recovery_control_service_state_check
        CHECK (service_state IN ('ACTIVE', 'FENCED')),
    CONSTRAINT recovery_control_fenced_state_check CHECK (
        (service_state = 'ACTIVE')
        OR (service_state = 'FENCED' AND fenced_at IS NOT NULL)
    ),
    CONSTRAINT recovery_control_cutoff_check CHECK (
        authority_not_before IS NULL OR fenced_at IS NOT NULL
    )
);

INSERT INTO platform.recovery_control (
    singleton_key,
    recovery_generation_id,
    service_state,
    authority_not_before,
    fenced_at,
    updated_at
) VALUES (
    true,
    pg_catalog.gen_random_uuid(),
    'ACTIVE',
    NULL,
    NULL,
    clock_timestamp()
);

REVOKE ALL ON TABLE platform.recovery_control
FROM PUBLIC, shop_app_runtime, shop_app_auth, shop_app_auth_owner;

ALTER TABLE platform.recovery_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.recovery_control FORCE ROW LEVEL SECURITY;

CREATE POLICY recovery_control_migrator
ON platform.recovery_control
FOR ALL
TO shop_app_migrator
USING (true)
WITH CHECK (true);

CREATE FUNCTION platform.lock_platform_recovery_authority_v1(
    p_expected_generation uuid,
    p_allow_generationless_after_cutoff boolean,
    p_session_issued_at timestamptz,
    p_require_session_cutoff boolean
)
RETURNS TABLE (
    recovery_generation_id uuid,
    authority_not_before timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
ROWS 1
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_control platform.recovery_control%ROWTYPE;
BEGIN
    IF p_allow_generationless_after_cutoff IS NULL
       OR p_require_session_cutoff IS NULL THEN
        RAISE EXCEPTION 'PLATFORM_RECOVERY_AUTHORITY_INVALID'
            USING ERRCODE = '22023';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock_shared(
        pg_catalog.hashtextextended('dokana:s22:platform-recovery-authority:v1', 0)
    );

    SELECT control.*
    INTO v_control
    FROM platform.recovery_control AS control
    WHERE control.singleton_key = true;

    IF NOT FOUND OR v_control.recovery_generation_id IS NULL THEN
        RAISE EXCEPTION 'PLATFORM_RECOVERY_AUTHORITY_UNAVAILABLE'
            USING ERRCODE = '55000';
    END IF;

    IF v_control.service_state <> 'ACTIVE' THEN
        RAISE EXCEPTION 'PLATFORM_RECOVERY_FENCED'
            USING ERRCODE = '55000';
    END IF;

    IF p_expected_generation IS NOT NULL
       AND p_expected_generation <> v_control.recovery_generation_id THEN
        RAISE EXCEPTION 'PLATFORM_RECOVERY_REVALIDATION_REQUIRED'
            USING ERRCODE = '55000';
    END IF;

    IF p_expected_generation IS NULL
       AND v_control.authority_not_before IS NOT NULL
       AND NOT p_allow_generationless_after_cutoff THEN
        RAISE EXCEPTION 'PLATFORM_RECOVERY_REVALIDATION_REQUIRED'
            USING ERRCODE = '55000';
    END IF;

    IF p_require_session_cutoff
       AND (
            p_session_issued_at IS NULL
            OR (
                v_control.authority_not_before IS NOT NULL
                AND p_session_issued_at < v_control.authority_not_before
            )
       ) THEN
        RAISE EXCEPTION 'PLATFORM_RECOVERY_SESSION_STALE'
            USING ERRCODE = '28000';
    END IF;

    RETURN QUERY SELECT
        v_control.recovery_generation_id,
        v_control.authority_not_before;
END
$function$;

CREATE FUNCTION ledger.assert_platform_write_authority_v1(p_expected_generation uuid)
RETURNS TABLE (
    recovery_generation_id uuid,
    authority_not_before timestamptz
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
ROWS 1
SET search_path = pg_catalog, pg_temp
AS $function$
    SELECT authority.recovery_generation_id, authority.authority_not_before
    FROM platform.lock_platform_recovery_authority_v1(
        p_expected_generation,
        false,
        NULL,
        false
    ) AS authority;
$function$;

CREATE FUNCTION sync.capture_platform_recovery_authority_v1()
RETURNS TABLE (
    recovery_generation_id uuid,
    authority_not_before timestamptz
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
ROWS 1
SET search_path = pg_catalog, pg_temp
AS $function$
    SELECT authority.recovery_generation_id, authority.authority_not_before
    FROM platform.lock_platform_recovery_authority_v1(NULL, true, NULL, false) AS authority;
$function$;

CREATE FUNCTION sync.assert_platform_recovery_authority_v1(p_expected_generation uuid)
RETURNS TABLE (
    recovery_generation_id uuid,
    authority_not_before timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
ROWS 1
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
    IF p_expected_generation IS NULL THEN
        RAISE EXCEPTION 'SYNC_REBOOTSTRAP_REQUIRED' USING ERRCODE = '55000';
    END IF;

    RETURN QUERY
    SELECT authority.recovery_generation_id, authority.authority_not_before
    FROM platform.lock_platform_recovery_authority_v1(
        p_expected_generation,
        false,
        NULL,
        false
    ) AS authority;
EXCEPTION
    WHEN SQLSTATE '55000' THEN
        RAISE EXCEPTION 'SYNC_REBOOTSTRAP_REQUIRED' USING ERRCODE = '55000';
END
$function$;

CREATE FUNCTION platform.capture_platform_auth_authority_v1()
RETURNS TABLE (
    recovery_generation_id uuid,
    authority_not_before timestamptz
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
ROWS 1
SET search_path = pg_catalog, pg_temp
AS $function$
    SELECT authority.recovery_generation_id, authority.authority_not_before
    FROM platform.lock_platform_recovery_authority_v1(NULL, true, NULL, false) AS authority;
$function$;

CREATE FUNCTION platform.assert_platform_session_authority_v1(
    p_session_issued_at timestamptz
)
RETURNS TABLE (
    recovery_generation_id uuid,
    authority_not_before timestamptz
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
ROWS 1
SET search_path = pg_catalog, pg_temp
AS $function$
    SELECT authority.recovery_generation_id, authority.authority_not_before
    FROM platform.lock_platform_recovery_authority_v1(
        NULL,
        true,
        p_session_issued_at,
        true
    ) AS authority;
$function$;

CREATE FUNCTION platform.read_platform_recovery_control_v1()
RETURNS TABLE (
    recovery_generation_id uuid,
    service_state text,
    authority_not_before timestamptz,
    fenced_at timestamptz,
    updated_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
ROWS 1
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_control platform.recovery_control%ROWTYPE;
BEGIN
    IF session_user <> 'dokana_migration_login' THEN
        RAISE EXCEPTION 'PLATFORM_RECOVERY_OPERATOR_REQUIRED'
            USING ERRCODE = '42501';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock_shared(
        pg_catalog.hashtextextended('dokana:s22:platform-recovery-authority:v1', 0)
    );

    SELECT control.*
    INTO v_control
    FROM platform.recovery_control AS control
    WHERE control.singleton_key = true;

    IF NOT FOUND OR v_control.service_state NOT IN ('ACTIVE', 'FENCED') THEN
        RAISE EXCEPTION 'PLATFORM_RECOVERY_AUTHORITY_UNAVAILABLE'
            USING ERRCODE = '55000';
    END IF;

    RETURN QUERY SELECT
        v_control.recovery_generation_id,
        v_control.service_state,
        v_control.authority_not_before,
        v_control.fenced_at,
        v_control.updated_at;
END
$function$;

CREATE FUNCTION platform.fence_platform_recovery_v1(p_expected_generation uuid)
RETURNS TABLE (
    recovery_generation_id uuid,
    service_state text,
    authority_not_before timestamptz,
    fenced_at timestamptz,
    updated_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
ROWS 1
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_control platform.recovery_control%ROWTYPE;
    v_now timestamptz;
BEGIN
    IF session_user <> 'dokana_migration_login' OR p_expected_generation IS NULL THEN
        RAISE EXCEPTION 'PLATFORM_RECOVERY_OPERATOR_REQUIRED'
            USING ERRCODE = '42501';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('dokana:s22:platform-recovery-authority:v1', 0)
    );

    SELECT control.*
    INTO v_control
    FROM platform.recovery_control AS control
    WHERE control.singleton_key = true
    FOR UPDATE;

    IF NOT FOUND
       OR v_control.service_state NOT IN ('ACTIVE', 'FENCED')
       OR v_control.recovery_generation_id <> p_expected_generation THEN
        RAISE EXCEPTION 'PLATFORM_RECOVERY_FENCE_STATE_INVALID'
            USING ERRCODE = '55000';
    END IF;

    IF v_control.service_state = 'ACTIVE' THEN
        v_now := clock_timestamp();
        UPDATE platform.recovery_control AS control
        SET service_state = 'FENCED',
            fenced_at = v_now,
            updated_at = v_now
        WHERE control.singleton_key = true
        RETURNING control.* INTO v_control;
    END IF;

    RETURN QUERY SELECT
        v_control.recovery_generation_id,
        v_control.service_state,
        v_control.authority_not_before,
        v_control.fenced_at,
        v_control.updated_at;
END
$function$;

CREATE FUNCTION platform.activate_new_recovery_generation_v1(p_expected_generation uuid)
RETURNS TABLE (
    recovery_generation_id uuid,
    service_state text,
    authority_not_before timestamptz,
    fenced_at timestamptz,
    updated_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
ROWS 1
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_control platform.recovery_control%ROWTYPE;
    v_generation uuid;
    v_now timestamptz;
BEGIN
    IF session_user <> 'dokana_migration_login' OR p_expected_generation IS NULL THEN
        RAISE EXCEPTION 'PLATFORM_RECOVERY_OPERATOR_REQUIRED'
            USING ERRCODE = '42501';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('dokana:s22:platform-recovery-authority:v1', 0)
    );

    SELECT control.*
    INTO v_control
    FROM platform.recovery_control AS control
    WHERE control.singleton_key = true
    FOR UPDATE;

    IF NOT FOUND
       OR v_control.service_state <> 'FENCED'
       OR v_control.recovery_generation_id <> p_expected_generation THEN
        RAISE EXCEPTION 'PLATFORM_RECOVERY_ACTIVATION_STATE_INVALID'
            USING ERRCODE = '55000';
    END IF;

    v_generation := pg_catalog.gen_random_uuid();
    IF v_generation = v_control.recovery_generation_id THEN
        RAISE EXCEPTION 'PLATFORM_RECOVERY_GENERATION_COLLISION'
            USING ERRCODE = '55000';
    END IF;
    v_now := clock_timestamp();

    UPDATE platform.recovery_control AS control
    SET recovery_generation_id = v_generation,
        service_state = 'ACTIVE',
        authority_not_before = v_now,
        updated_at = v_now
    WHERE control.singleton_key = true
    RETURNING control.* INTO v_control;

    RETURN QUERY SELECT
        v_control.recovery_generation_id,
        v_control.service_state,
        v_control.authority_not_before,
        v_control.fenced_at,
        v_control.updated_at;
END
$function$;

REVOKE ALL ON FUNCTION
    platform.lock_platform_recovery_authority_v1(uuid, boolean, timestamptz, boolean),
    ledger.assert_platform_write_authority_v1(uuid),
    sync.capture_platform_recovery_authority_v1(),
    sync.assert_platform_recovery_authority_v1(uuid),
    platform.capture_platform_auth_authority_v1(),
    platform.assert_platform_session_authority_v1(timestamptz),
    platform.read_platform_recovery_control_v1(),
    platform.fence_platform_recovery_v1(uuid),
    platform.activate_new_recovery_generation_v1(uuid)
FROM PUBLIC, shop_app_runtime, shop_app_auth, shop_app_auth_owner;

GRANT EXECUTE ON FUNCTION
    ledger.assert_platform_write_authority_v1(uuid),
    sync.capture_platform_recovery_authority_v1(),
    sync.assert_platform_recovery_authority_v1(uuid)
TO shop_app_runtime;

GRANT EXECUTE ON FUNCTION
    platform.capture_platform_auth_authority_v1(),
    platform.assert_platform_session_authority_v1(timestamptz)
TO shop_app_auth_owner;

DO $platform_postconditions$
DECLARE
    v_control platform.recovery_control%ROWTYPE;
    v_function regprocedure;
    v_rls_enabled boolean;
    v_rls_forced boolean;
BEGIN
    SELECT control.* INTO STRICT v_control
    FROM platform.recovery_control AS control;

    IF v_control.singleton_key IS NOT TRUE
       OR v_control.recovery_generation_id IS NULL
       OR v_control.service_state <> 'ACTIVE'
       OR v_control.authority_not_before IS NOT NULL
       OR v_control.fenced_at IS NOT NULL THEN
        RAISE EXCEPTION '0033 initial recovery authority is invalid';
    END IF;

    SELECT relation.relrowsecurity, relation.relforcerowsecurity
    INTO STRICT v_rls_enabled, v_rls_forced
    FROM pg_class AS relation
    WHERE relation.oid = 'platform.recovery_control'::regclass;

    IF NOT v_rls_enabled
       OR NOT v_rls_forced
       OR NOT EXISTS (
            SELECT 1
            FROM pg_policies AS policy
            WHERE policy.schemaname = 'platform'
              AND policy.tablename = 'recovery_control'
              AND policy.policyname = 'recovery_control_migrator'
              AND policy.roles = ARRAY['shop_app_migrator']::name[]
              AND policy.cmd = 'ALL'
       ) THEN
        RAISE EXCEPTION '0033 recovery-control RLS is unsafe';
    END IF;

    IF has_table_privilege('shop_app_runtime', 'platform.recovery_control', 'SELECT')
       OR has_table_privilege('shop_app_runtime', 'platform.recovery_control', 'INSERT')
       OR has_table_privilege('shop_app_runtime', 'platform.recovery_control', 'UPDATE')
       OR has_table_privilege('shop_app_runtime', 'platform.recovery_control', 'DELETE')
       OR has_table_privilege('shop_app_auth', 'platform.recovery_control', 'SELECT')
       OR has_table_privilege('shop_app_auth_owner', 'platform.recovery_control', 'SELECT') THEN
        RAISE EXCEPTION '0033 exposed direct recovery-control table access';
    END IF;

    FOREACH v_function IN ARRAY ARRAY[
        'ledger.assert_platform_write_authority_v1(uuid)'::regprocedure,
        'sync.capture_platform_recovery_authority_v1()'::regprocedure,
        'sync.assert_platform_recovery_authority_v1(uuid)'::regprocedure,
        'platform.capture_platform_auth_authority_v1()'::regprocedure,
        'platform.assert_platform_session_authority_v1(timestamp with time zone)'::regprocedure,
        'platform.read_platform_recovery_control_v1()'::regprocedure,
        'platform.fence_platform_recovery_v1(uuid)'::regprocedure,
        'platform.activate_new_recovery_generation_v1(uuid)'::regprocedure
    ] LOOP
        IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = v_function)
                <> 'shop_app_migrator'
           OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_function)
           OR (SELECT proconfig FROM pg_proc WHERE oid = v_function)
                IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
           OR has_function_privilege('public', v_function, 'EXECUTE') THEN
            RAISE EXCEPTION '0033 recovery function security configuration is unsafe';
        END IF;
    END LOOP;

    IF NOT has_function_privilege(
            'shop_app_runtime',
            'ledger.assert_platform_write_authority_v1(uuid)',
            'EXECUTE'
       )
       OR NOT has_function_privilege(
            'shop_app_runtime',
            'sync.capture_platform_recovery_authority_v1()',
            'EXECUTE'
       )
       OR NOT has_function_privilege(
            'shop_app_runtime',
            'sync.assert_platform_recovery_authority_v1(uuid)',
            'EXECUTE'
       )
       OR has_function_privilege(
            'shop_app_runtime',
            'platform.fence_platform_recovery_v1(uuid)',
            'EXECUTE'
       )
       OR has_function_privilege(
            'shop_app_runtime',
            'platform.activate_new_recovery_generation_v1(uuid)',
            'EXECUTE'
       ) THEN
        RAISE EXCEPTION '0033 recovery function grants are unsafe';
    END IF;
END
$platform_postconditions$;

SET LOCAL ROLE shop_app_auth_owner;

CREATE FUNCTION auth_api.issue_session_recovery_v1(
    p_user_id uuid,
    p_store_id uuid,
    p_device_id uuid,
    p_device_name text,
    p_device_platform text,
    p_session_id uuid,
    p_access_token_jti uuid,
    p_refresh_token_id uuid,
    p_refresh_token_hash text,
    p_refresh_family_id uuid,
    p_session_expires_at timestamptz,
    p_refresh_expires_at timestamptz,
    p_ip_hash text,
    p_user_agent_hash text
)
RETURNS TABLE (
    user_id uuid,
    email text,
    full_name text,
    store_id uuid,
    store_name text,
    store_status text,
    membership_role text,
    membership_version bigint,
    device_id uuid,
    session_id uuid,
    session_expires_at timestamptz,
    recovery_generation_id uuid
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
ROWS 1
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_generation uuid;
BEGIN
    SELECT authority.recovery_generation_id
    INTO STRICT v_generation
    FROM platform.capture_platform_auth_authority_v1() AS authority;

    RETURN QUERY
    SELECT issued.*, v_generation
    FROM auth_api.issue_session(
        p_user_id,
        p_store_id,
        p_device_id,
        p_device_name,
        p_device_platform,
        p_session_id,
        p_access_token_jti,
        p_refresh_token_id,
        p_refresh_token_hash,
        p_refresh_family_id,
        p_session_expires_at,
        p_refresh_expires_at,
        p_ip_hash,
        p_user_agent_hash
    ) AS issued;
END
$function$;

CREATE FUNCTION auth_api.validate_session_recovery_v1(
    p_user_id uuid,
    p_session_id uuid,
    p_store_id uuid,
    p_device_id uuid,
    p_access_token_jti uuid
)
RETURNS TABLE (
    user_id uuid,
    email text,
    full_name text,
    store_id uuid,
    store_name text,
    store_status text,
    membership_role text,
    membership_version bigint,
    device_id uuid,
    session_id uuid,
    session_expires_at timestamptz,
    recovery_generation_id uuid
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
ROWS 1
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_session_issued_at timestamptz;
    v_generation uuid;
BEGIN
    SELECT sessions.issued_at
    INTO v_session_issued_at
    FROM platform.auth_sessions AS sessions
    WHERE sessions.id = p_session_id
      AND sessions.user_id = p_user_id
      AND sessions.store_id = p_store_id
      AND sessions.device_id = p_device_id;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    SELECT authority.recovery_generation_id
    INTO STRICT v_generation
    FROM platform.assert_platform_session_authority_v1(v_session_issued_at) AS authority;

    RETURN QUERY
    SELECT validated.*, v_generation
    FROM auth_api.validate_session(
        p_user_id,
        p_session_id,
        p_store_id,
        p_device_id,
        p_access_token_jti
    ) AS validated;
END
$function$;

CREATE FUNCTION auth_api.rotate_refresh_token_recovery_v1(
    p_current_token_hash text,
    p_new_token_id uuid,
    p_new_token_hash text,
    p_new_access_token_jti uuid,
    p_refresh_ttl_seconds integer
)
RETURNS TABLE (
    outcome text,
    user_id uuid,
    email text,
    full_name text,
    store_id uuid,
    store_name text,
    store_status text,
    membership_role text,
    membership_version bigint,
    device_id uuid,
    session_id uuid,
    session_expires_at timestamptz,
    recovery_generation_id uuid
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
ROWS 1
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_session_issued_at timestamptz;
    v_generation uuid;
BEGIN
    SELECT sessions.issued_at
    INTO v_session_issued_at
    FROM platform.refresh_tokens AS tokens
    INNER JOIN platform.auth_sessions AS sessions ON sessions.id = tokens.session_id
    WHERE tokens.token_hash = p_current_token_hash
    LIMIT 1;

    IF FOUND THEN
        SELECT authority.recovery_generation_id
        INTO STRICT v_generation
        FROM platform.assert_platform_session_authority_v1(v_session_issued_at) AS authority;
    ELSE
        SELECT authority.recovery_generation_id
        INTO STRICT v_generation
        FROM platform.capture_platform_auth_authority_v1() AS authority;
    END IF;

    RETURN QUERY
    SELECT rotated.*, v_generation
    FROM auth_api.rotate_refresh_token(
        p_current_token_hash,
        p_new_token_id,
        p_new_token_hash,
        p_new_access_token_jti,
        p_refresh_ttl_seconds
    ) AS rotated;
END
$function$;

CREATE FUNCTION auth_api.validate_sync_session_recovery_v1(
    p_user_id uuid,
    p_session_id uuid,
    p_store_id uuid,
    p_device_id uuid
)
RETURNS TABLE (
    user_id uuid,
    email text,
    full_name text,
    store_id uuid,
    store_name text,
    store_status text,
    membership_role text,
    membership_version bigint,
    device_id uuid,
    session_id uuid,
    session_expires_at timestamptz,
    recovery_generation_id uuid
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
ROWS 1
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_session_issued_at timestamptz;
    v_generation uuid;
BEGIN
    SELECT sessions.issued_at
    INTO v_session_issued_at
    FROM platform.auth_sessions AS sessions
    WHERE sessions.id = p_session_id
      AND sessions.user_id = p_user_id
      AND sessions.store_id = p_store_id
      AND sessions.device_id = p_device_id;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    SELECT authority.recovery_generation_id
    INTO STRICT v_generation
    FROM platform.assert_platform_session_authority_v1(v_session_issued_at) AS authority;

    RETURN QUERY
    SELECT validated.*, v_generation
    FROM auth_api.validate_sync_session(
        p_user_id,
        p_session_id,
        p_store_id,
        p_device_id
    ) AS validated;
END
$function$;

CREATE FUNCTION auth_api.validate_sync_refresh_token_recovery_v1(p_token_hash text)
RETURNS TABLE (
    user_id uuid,
    email text,
    full_name text,
    store_id uuid,
    store_name text,
    store_status text,
    membership_role text,
    membership_version bigint,
    device_id uuid,
    session_id uuid,
    session_expires_at timestamptz,
    recovery_generation_id uuid
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
ROWS 1
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_session_issued_at timestamptz;
    v_generation uuid;
BEGIN
    SELECT sessions.issued_at
    INTO v_session_issued_at
    FROM platform.refresh_tokens AS tokens
    INNER JOIN platform.auth_sessions AS sessions ON sessions.id = tokens.session_id
    WHERE tokens.token_hash = p_token_hash
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    SELECT authority.recovery_generation_id
    INTO STRICT v_generation
    FROM platform.assert_platform_session_authority_v1(v_session_issued_at) AS authority;

    RETURN QUERY
    SELECT validated.*, v_generation
    FROM auth_api.validate_sync_refresh_token(p_token_hash) AS validated;
END
$function$;

REVOKE ALL ON FUNCTION
    auth_api.issue_session_recovery_v1(
        uuid, uuid, uuid, text, text, uuid, uuid, uuid, text, uuid,
        timestamptz, timestamptz, text, text
    ),
    auth_api.validate_session_recovery_v1(uuid, uuid, uuid, uuid, uuid),
    auth_api.rotate_refresh_token_recovery_v1(text, uuid, text, uuid, integer),
    auth_api.validate_sync_session_recovery_v1(uuid, uuid, uuid, uuid),
    auth_api.validate_sync_refresh_token_recovery_v1(text)
FROM PUBLIC, shop_app_runtime;

GRANT EXECUTE ON FUNCTION
    auth_api.issue_session_recovery_v1(
        uuid, uuid, uuid, text, text, uuid, uuid, uuid, text, uuid,
        timestamptz, timestamptz, text, text
    ),
    auth_api.validate_session_recovery_v1(uuid, uuid, uuid, uuid, uuid),
    auth_api.rotate_refresh_token_recovery_v1(text, uuid, text, uuid, integer),
    auth_api.validate_sync_session_recovery_v1(uuid, uuid, uuid, uuid),
    auth_api.validate_sync_refresh_token_recovery_v1(text)
TO shop_app_auth;

DO $auth_postconditions$
DECLARE
    v_function regprocedure;
BEGIN
    FOREACH v_function IN ARRAY ARRAY[
        'auth_api.issue_session_recovery_v1(uuid,uuid,uuid,text,text,uuid,uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone,text,text)'::regprocedure,
        'auth_api.validate_session_recovery_v1(uuid,uuid,uuid,uuid,uuid)'::regprocedure,
        'auth_api.rotate_refresh_token_recovery_v1(text,uuid,text,uuid,integer)'::regprocedure,
        'auth_api.validate_sync_session_recovery_v1(uuid,uuid,uuid,uuid)'::regprocedure,
        'auth_api.validate_sync_refresh_token_recovery_v1(text)'::regprocedure
    ] LOOP
        IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = v_function)
                <> 'shop_app_auth_owner'
           OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_function)
           OR (SELECT proconfig FROM pg_proc WHERE oid = v_function)
                IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
           OR has_function_privilege('public', v_function, 'EXECUTE')
           OR NOT has_function_privilege('shop_app_auth', v_function, 'EXECUTE')
           OR has_function_privilege('shop_app_runtime', v_function, 'EXECUTE') THEN
            RAISE EXCEPTION '0033 authentication recovery wrapper is unsafe';
        END IF;
    END LOOP;

    IF has_table_privilege('shop_app_auth', 'platform.recovery_control', 'SELECT')
       OR has_table_privilege('shop_app_auth_owner', 'platform.recovery_control', 'SELECT')
       OR has_function_privilege(
            'shop_app_auth',
            'platform.fence_platform_recovery_v1(uuid)',
            'EXECUTE'
       )
       OR has_function_privilege(
            'shop_app_auth_owner',
            'platform.fence_platform_recovery_v1(uuid)',
            'EXECUTE'
       ) THEN
        RAISE EXCEPTION '0033 broadened authentication recovery authority';
    END IF;
END
$auth_postconditions$;
