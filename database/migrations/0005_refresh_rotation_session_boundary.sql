-- Migration 0005: clamp refresh-token rotation to the fixed session boundary.
--
-- The original 0004 timestamp-based function remains unchanged for migration
-- immutability. Application execution is moved to this TTL-based wrapper,
-- which computes a bounded expiry and invokes the original transactional,
-- locking rotation function as shop_app_auth_owner.
--
-- Rollback (backend-owner approval required):
-- grant execute on auth_api.rotate_refresh_token(text,uuid,text,uuid,timestamptz)
-- to shop_app_auth, then drop the integer overload below.

DO $preconditions$
BEGIN
    IF session_user <> 'dokana_migration_login'
       OR current_user <> 'shop_app_migrator'
       OR NOT pg_has_role('shop_app_migrator', 'shop_app_auth_owner', 'SET') THEN
        RAISE EXCEPTION '0005 requires the approved migration role chain';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_proc AS function_state
        INNER JOIN pg_namespace AS namespace ON namespace.oid = function_state.pronamespace
        WHERE namespace.nspname = 'auth_api'
          AND function_state.proname = 'rotate_refresh_token'
          AND pg_get_function_identity_arguments(function_state.oid)
              = 'p_current_token_hash text, p_new_token_id uuid, p_new_token_hash text, p_new_access_token_jti uuid, p_new_refresh_expires_at timestamp with time zone'
    ) OR EXISTS (
        SELECT 1
        FROM pg_proc AS function_state
        INNER JOIN pg_namespace AS namespace ON namespace.oid = function_state.pronamespace
        WHERE namespace.nspname = 'auth_api'
          AND function_state.proname = 'rotate_refresh_token'
          AND pg_get_function_identity_arguments(function_state.oid)
              = 'p_current_token_hash text, p_new_token_id uuid, p_new_token_hash text, p_new_access_token_jti uuid, p_refresh_ttl_seconds integer'
    ) THEN
        RAISE EXCEPTION '0005 authentication function precondition failed';
    END IF;
END
$preconditions$;

SET LOCAL ROLE shop_app_auth_owner;

DO $owner_transition$
BEGIN
    IF session_user <> 'dokana_migration_login'
       OR current_user <> 'shop_app_auth_owner' THEN
        RAISE EXCEPTION '0005 failed to assume the managed authentication owner';
    END IF;
END
$owner_transition$;

CREATE FUNCTION auth_api.rotate_refresh_token(
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
    session_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth_api, platform, pg_temp
AS $function$
DECLARE
    requested_expiry timestamptz;
    fixed_session_expiry timestamptz;
BEGIN
    IF p_refresh_ttl_seconds IS NULL
       OR p_refresh_ttl_seconds < 3600
       OR p_refresh_ttl_seconds > 2678400 THEN
        RETURN QUERY SELECT
            'invalid'::text,
            NULL::uuid,
            NULL::text,
            NULL::text,
            NULL::uuid,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::bigint,
            NULL::uuid,
            NULL::uuid,
            NULL::timestamptz;
        RETURN;
    END IF;

    requested_expiry :=
        clock_timestamp() + make_interval(secs => p_refresh_ttl_seconds);

    SELECT sessions.expires_at
    INTO fixed_session_expiry
    FROM platform.refresh_tokens AS tokens
    INNER JOIN platform.auth_sessions AS sessions ON sessions.id = tokens.session_id
    WHERE tokens.token_hash = p_current_token_hash;

    RETURN QUERY
    SELECT *
    FROM auth_api.rotate_refresh_token(
        p_current_token_hash,
        p_new_token_id,
        p_new_token_hash,
        p_new_access_token_jti,
        LEAST(COALESCE(fixed_session_expiry, requested_expiry), requested_expiry)
    );
END
$function$;

REVOKE ALL ON FUNCTION
    auth_api.rotate_refresh_token(text, uuid, text, uuid, integer)
FROM PUBLIC, shop_app_runtime;
REVOKE EXECUTE ON FUNCTION
    auth_api.rotate_refresh_token(text, uuid, text, uuid, timestamptz)
FROM shop_app_auth;
GRANT EXECUTE ON FUNCTION
    auth_api.rotate_refresh_token(text, uuid, text, uuid, integer)
TO shop_app_auth;

DO $postconditions$
DECLARE
    function_state record;
BEGIN
    SELECT
        pg_get_userbyid(routine.proowner) AS owner,
        routine.prosecdef AS security_definer,
        routine.proconfig AS configuration
    INTO function_state
    FROM pg_proc AS routine
    WHERE routine.oid = 'auth_api.rotate_refresh_token(text,uuid,text,uuid,integer)'::regprocedure;

    IF function_state.owner <> 'shop_app_auth_owner'
       OR NOT function_state.security_definer
       OR function_state.configuration IS NULL
       OR NOT (
           'search_path=pg_catalog, auth_api, platform, pg_temp'
           = ANY (function_state.configuration)
       )
       OR has_function_privilege(
           'shop_app_runtime',
           'auth_api.rotate_refresh_token(text,uuid,text,uuid,integer)',
           'EXECUTE'
       )
       OR NOT has_function_privilege(
           'shop_app_auth',
           'auth_api.rotate_refresh_token(text,uuid,text,uuid,integer)',
           'EXECUTE'
       )
       OR has_function_privilege(
           'shop_app_auth',
           'auth_api.rotate_refresh_token(text,uuid,text,uuid,timestamptz)',
           'EXECUTE'
       ) THEN
        RAISE EXCEPTION '0005 authentication function postcondition failed';
    END IF;
END
$postconditions$;
