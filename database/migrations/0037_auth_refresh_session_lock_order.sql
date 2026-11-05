-- S2A-02: owner-authorized bounded repair of refresh/logout lock inversion.
-- Only the internal timestamp overload body changes. Function identity, owner,
-- ACL, SECURITY DEFINER/search_path, wrappers, token lifetime, replay revocation,
-- table/RLS/trigger contracts and API behavior remain intact.
-- The canonical runner owns the transaction, advisory lock and checksum entry.
-- If deployment fails, the runner rolls back the function and ledger together.
-- After commit, remediation requires a reviewed forward migration; reverting to
-- token-first locking reintroduces the deadlock and is not a safe rollback.

DO $preconditions$
BEGIN
    IF session_user <> 'dokana_migration_login'
       OR current_user <> 'shop_app_migrator' THEN
        RAISE EXCEPTION '0037 requires the approved migration login and effective role';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM platform.schema_migrations
        WHERE filename = '0036_harden_default_function_privileges.sql'
    ) AND NOT EXISTS (
        SELECT 1 FROM platform.release_baseline_provenance
        WHERE migration_ceiling >= '0036_harden_default_function_privileges.sql'
    ) THEN
        RAISE EXCEPTION '0037 requires the verified 0036 foundation';
    END IF;
END
$preconditions$;

SET LOCAL ROLE shop_app_auth_owner;

DO $auth_boundary$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc
        WHERE oid = 'auth_api.rotate_refresh_token(text,uuid,text,uuid,timestamptz)'::regprocedure
          AND proowner = 'shop_app_auth_owner'::regrole
          AND prosecdef
          AND proconfig = ARRAY['search_path=pg_catalog, auth_api, platform, ledger, pg_temp']
    ) THEN
        RAISE EXCEPTION '0037 requires the approved internal refresh function boundary';
    END IF;
END
$auth_boundary$;

CREATE OR REPLACE FUNCTION auth_api.rotate_refresh_token(
    p_current_token_hash text,
    p_new_token_id uuid,
    p_new_token_hash text,
    p_new_access_token_jti uuid,
    p_new_refresh_expires_at timestamptz
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
SET search_path = pg_catalog, auth_api, platform, ledger, pg_temp
AS $function$
DECLARE
    token_state record;
    eligibility record;
BEGIN
    IF p_current_token_hash IS NULL
       OR p_current_token_hash !~ '^[0-9a-f]{64}$'
       OR p_new_token_hash IS NULL
       OR p_new_token_hash !~ '^[0-9a-f]{64}$'
       OR p_current_token_hash = p_new_token_hash THEN
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

    -- All token-family mutations serialize on their owning session first.
    -- revoke_session already uses this order. Do not lock a token and then wait
    -- for its session: logout can hold that session while waiting for the token.
    -- The unlocked lookup only identifies the parent; the existing locked read
    -- below revalidates current token/session state after any wait.
    PERFORM sessions.id
    FROM platform.auth_sessions AS sessions
    WHERE sessions.id = (
        SELECT tokens.session_id
        FROM platform.refresh_tokens AS tokens
        WHERE tokens.token_hash = p_current_token_hash
    )
    FOR UPDATE OF sessions;

    SELECT
        tokens.id AS token_id,
        tokens.session_id,
        tokens.family_id,
        tokens.expires_at AS token_expires_at,
        tokens.used_at,
        tokens.revoked_at AS token_revoked_at,
        tokens.replaced_by_id,
        sessions.user_id,
        sessions.store_id,
        sessions.device_id,
        sessions.expires_at AS session_expires_at,
        sessions.revoked_at AS session_revoked_at
    INTO token_state
    FROM platform.refresh_tokens AS tokens
    INNER JOIN platform.auth_sessions AS sessions ON sessions.id = tokens.session_id
    WHERE tokens.token_hash = p_current_token_hash
    FOR UPDATE OF tokens, sessions;

    IF NOT FOUND THEN
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

    IF token_state.used_at IS NOT NULL OR token_state.replaced_by_id IS NOT NULL THEN
        UPDATE platform.refresh_tokens AS tokens
        SET revoked_at = COALESCE(tokens.revoked_at, clock_timestamp())
        WHERE tokens.family_id = token_state.family_id;

        UPDATE platform.auth_sessions
        SET
            revoked_at = COALESCE(revoked_at, clock_timestamp()),
            revoke_reason = COALESCE(revoke_reason, 'refresh_token_reuse')
        WHERE id = token_state.session_id;

        RETURN QUERY SELECT
            'reused'::text,
            NULL::uuid,
            NULL::text,
            NULL::text,
            NULL::uuid,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::bigint,
            NULL::uuid,
            token_state.session_id::uuid,
            token_state.session_expires_at::timestamptz;
        RETURN;
    END IF;

    IF token_state.token_revoked_at IS NOT NULL
       OR token_state.session_revoked_at IS NOT NULL
       OR token_state.token_expires_at <= clock_timestamp()
       OR token_state.session_expires_at <= clock_timestamp()
       OR p_new_refresh_expires_at <= clock_timestamp()
       OR p_new_refresh_expires_at > token_state.session_expires_at THEN
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

    PERFORM pg_catalog.set_config('app.user_id', token_state.user_id::text, true);
    PERFORM pg_catalog.set_config('app.store_id', token_state.store_id::text, true);
    PERFORM pg_catalog.set_config('app.device_id', token_state.device_id::text, true);

    SELECT
        users.id AS user_id,
        users.email,
        users.full_name,
        stores.id AS store_id,
        stores.name AS store_name,
        stores.status AS store_status,
        memberships.role AS membership_role,
        memberships.version AS membership_version,
        devices.id AS device_id
    INTO eligibility
    FROM platform.users AS users
    INNER JOIN platform.store_memberships AS memberships
        ON memberships.user_id = users.id
       AND memberships.store_id = token_state.store_id
       AND memberships.status = 'active'
    INNER JOIN ledger.stores AS stores
        ON stores.id = memberships.store_id
       AND stores.status IN ('active', 'read_only')
    INNER JOIN ledger.devices AS devices
        ON devices.id = token_state.device_id
       AND devices.store_id = stores.id
       AND devices.status = 'active'
    WHERE users.id = token_state.user_id
      AND users.status = 'active';

    IF NOT FOUND THEN
        UPDATE platform.refresh_tokens AS tokens
        SET revoked_at = COALESCE(tokens.revoked_at, clock_timestamp())
        WHERE tokens.family_id = token_state.family_id;

        UPDATE platform.auth_sessions
        SET
            revoked_at = COALESCE(revoked_at, clock_timestamp()),
            revoke_reason = COALESCE(revoke_reason, 'session_ineligible')
        WHERE id = token_state.session_id;

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

    INSERT INTO platform.refresh_tokens (
        id,
        session_id,
        token_hash,
        family_id,
        parent_token_id,
        issued_at,
        expires_at
    )
    VALUES (
        p_new_token_id,
        token_state.session_id,
        p_new_token_hash,
        token_state.family_id,
        token_state.token_id,
        clock_timestamp(),
        p_new_refresh_expires_at
    );

    UPDATE platform.refresh_tokens
    SET
        used_at = clock_timestamp(),
        replaced_by_id = p_new_token_id
    WHERE id = token_state.token_id;

    UPDATE platform.auth_sessions
    SET access_token_jti = p_new_access_token_jti
    WHERE id = token_state.session_id;

    RETURN QUERY SELECT
        'rotated'::text,
        eligibility.user_id::uuid,
        eligibility.email::text,
        eligibility.full_name::text,
        eligibility.store_id::uuid,
        eligibility.store_name::text,
        eligibility.store_status::text,
        eligibility.membership_role::text,
        eligibility.membership_version::bigint,
        eligibility.device_id::uuid,
        token_state.session_id::uuid,
        token_state.session_expires_at::timestamptz;
END
$function$;

