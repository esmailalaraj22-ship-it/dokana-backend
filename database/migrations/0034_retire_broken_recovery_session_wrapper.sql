-- Migration 0034: retire the unused broken recovery-aware session issuance wrapper.
--
-- The production authentication flow remains auth_api.issue_session() followed by
-- auth_api.validate_session_recovery_v1() in one application-owned transaction.
-- If a combined wrapper is ever required again, it must be introduced by a new
-- forward migration with an explicitly approved and tested return contract.

DO $preconditions$
DECLARE
    v_wrapper oid;
    v_dependency_count integer;
BEGIN
    IF session_user <> 'dokana_migration_login'
       OR current_user <> 'shop_app_migrator'
       OR NOT pg_has_role('dokana_migration_login', 'shop_app_migrator', 'SET')
       OR NOT pg_has_role('shop_app_migrator', 'shop_app_auth_owner', 'SET')
       OR pg_has_role('dokana_migration_login', 'shop_app_runtime', 'SET')
       OR pg_has_role('dokana_migration_login', 'shop_app_auth', 'SET')
       OR pg_has_role('shop_app_migrator', 'shop_app_runtime', 'SET')
       OR pg_has_role('shop_app_migrator', 'shop_app_auth', 'SET') THEN
        RAISE EXCEPTION '0034 requires the approved migration login and role boundary';
    END IF;

    SELECT function_state.oid
    INTO v_wrapper
    FROM pg_proc AS function_state
    INNER JOIN pg_namespace AS namespace_state
        ON namespace_state.oid = function_state.pronamespace
    WHERE namespace_state.nspname = 'auth_api'
      AND function_state.proname = 'issue_session_recovery_v1'
      AND pg_get_function_identity_arguments(function_state.oid) =
        'p_user_id uuid, p_store_id uuid, p_device_id uuid, p_device_name text, p_device_platform text, p_session_id uuid, p_access_token_jti uuid, p_refresh_token_id uuid, p_refresh_token_hash text, p_refresh_family_id uuid, p_session_expires_at timestamp with time zone, p_refresh_expires_at timestamp with time zone, p_ip_hash text, p_user_agent_hash text';

    IF v_wrapper IS NULL OR (
        SELECT count(*)
        FROM pg_proc AS function_state
        INNER JOIN pg_namespace AS namespace_state
            ON namespace_state.oid = function_state.pronamespace
        WHERE namespace_state.nspname = 'auth_api'
          AND function_state.proname = 'issue_session_recovery_v1'
    ) <> 1 THEN
        RAISE EXCEPTION '0034 requires the exact broken authentication wrapper';
    END IF;

    IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = v_wrapper)
            <> 'shop_app_auth_owner'
       OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_wrapper)
       OR (SELECT proconfig FROM pg_proc WHERE oid = v_wrapper)
            IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
       OR has_function_privilege('public', v_wrapper, 'EXECUTE')
       OR NOT has_function_privilege('shop_app_auth', v_wrapper, 'EXECUTE')
       OR has_function_privilege('shop_app_runtime', v_wrapper, 'EXECUTE') THEN
        RAISE EXCEPTION '0034 found an unexpected wrapper security state';
    END IF;

    SELECT count(*)::integer
    INTO v_dependency_count
    FROM pg_depend AS dependency
    WHERE dependency.refclassid = 'pg_proc'::regclass
      AND dependency.refobjid = v_wrapper
      AND dependency.deptype IN ('n', 'a', 'e');

    IF v_dependency_count <> 0 THEN
        RAISE EXCEPTION '0034 found an unexpected wrapper dependency';
    END IF;

    IF (
        SELECT count(*)
        FROM pg_proc AS function_state
        INNER JOIN pg_namespace AS namespace_state
            ON namespace_state.oid = function_state.pronamespace
        WHERE namespace_state.nspname = 'auth_api'
    ) <> 14 THEN
        RAISE EXCEPTION '0034 found an unexpected authentication API inventory';
    END IF;
END
$preconditions$;

SET LOCAL ROLE shop_app_auth_owner;

DO $owner_boundary$
BEGIN
    IF session_user <> 'dokana_migration_login'
       OR current_user <> 'shop_app_auth_owner' THEN
        RAISE EXCEPTION '0034 failed to enter the approved authentication owner boundary';
    END IF;
END
$owner_boundary$;

REVOKE EXECUTE ON FUNCTION
    auth_api.issue_session_recovery_v1(
        uuid, uuid, uuid, text, text, uuid, uuid, uuid, text, uuid,
        timestamptz, timestamptz, text, text
    )
FROM shop_app_auth;

DROP FUNCTION auth_api.issue_session_recovery_v1(
    uuid, uuid, uuid, text, text, uuid, uuid, uuid, text, uuid,
    timestamptz, timestamptz, text, text
);

DO $postconditions$
DECLARE
    v_function regprocedure;
BEGIN
    IF session_user <> 'dokana_migration_login'
       OR current_user <> 'shop_app_auth_owner' THEN
        RAISE EXCEPTION '0034 left the approved authentication owner boundary unexpectedly';
    END IF;

    IF to_regprocedure(
        'auth_api.issue_session_recovery_v1(uuid,uuid,uuid,text,text,uuid,uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone,text,text)'
    ) IS NOT NULL OR EXISTS (
        SELECT 1
        FROM pg_proc AS function_state
        INNER JOIN pg_namespace AS namespace_state
            ON namespace_state.oid = function_state.pronamespace
        WHERE namespace_state.nspname = 'auth_api'
          AND function_state.proname = 'issue_session_recovery_v1'
    ) THEN
        RAISE EXCEPTION '0034 failed to retire the broken authentication wrapper';
    END IF;

    IF (
        SELECT count(*)
        FROM pg_proc AS function_state
        INNER JOIN pg_namespace AS namespace_state
            ON namespace_state.oid = function_state.pronamespace
        WHERE namespace_state.nspname = 'auth_api'
    ) <> 13 OR (
        SELECT count(*)
        FROM pg_proc AS function_state
        INNER JOIN pg_namespace AS namespace_state
            ON namespace_state.oid = function_state.pronamespace
        WHERE namespace_state.nspname = 'auth_api'
          AND has_function_privilege('shop_app_auth', function_state.oid, 'EXECUTE')
    ) <> 12 THEN
        RAISE EXCEPTION '0034 changed the approved authentication API inventory unexpectedly';
    END IF;

    FOREACH v_function IN ARRAY ARRAY[
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
            RAISE EXCEPTION '0034 changed a required recovery authentication function';
        END IF;
    END LOOP;

    IF EXISTS (
        SELECT 1
        FROM pg_proc AS function_state
        INNER JOIN pg_namespace AS namespace_state
            ON namespace_state.oid = function_state.pronamespace
        WHERE namespace_state.nspname = 'auth_api'
          AND (
              pg_get_userbyid(function_state.proowner) <> 'shop_app_auth_owner'
              OR NOT function_state.prosecdef
              OR has_function_privilege('public', function_state.oid, 'EXECUTE')
              OR has_function_privilege('shop_app_runtime', function_state.oid, 'EXECUTE')
          )
    ) THEN
        RAISE EXCEPTION '0034 weakened authentication function security';
    END IF;
END
$postconditions$;
