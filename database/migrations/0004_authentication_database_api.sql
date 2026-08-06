-- Migration 0004: create the least-privileged authentication database API.
--
-- Applied by scripts/migrate.ts through dokana_migration_login. The runner
-- first assumes shop_app_migrator. This migration switches locally to
-- shop_app_auth_owner only while creating and verifying managed auth objects.
--
-- Rollback (backend-owner approval required):
-- 1. revoke usage on schema auth_api from shop_app_auth;
-- 2. drop the six auth_api functions and the auth_api schema;
-- 3. drop the auth_* policies added below;
-- 4. revoke the listed column and schema privileges from shop_app_auth_owner;
-- 5. REVOKE shop_app_auth_owner FROM shop_app_migrator when rolling back the
--    complete managed-auth ownership model.
--
-- Existing baseline tables, constraints, runtime policies, and migration 0001
-- are not recreated or modified.

DO $preconditions$
BEGIN
    IF session_user <> 'dokana_migration_login'
       OR current_user <> 'shop_app_migrator' THEN
        RAISE EXCEPTION '0004 requires the approved migration role chain';
    END IF;

    IF NOT pg_has_role('dokana_migration_login', 'shop_app_migrator', 'SET')
       OR NOT pg_has_role('shop_app_migrator', 'shop_app_auth_owner', 'SET')
       OR pg_has_role('dokana_migration_login', 'shop_app_auth', 'SET')
       OR pg_has_role('dokana_migration_login', 'shop_app_runtime', 'SET')
       OR pg_has_role('shop_app_migrator', 'shop_app_auth', 'SET')
       OR pg_has_role('shop_app_migrator', 'shop_app_runtime', 'SET') THEN
        RAISE EXCEPTION '0004 role transitions do not match the approved state';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = 'shop_app_auth_owner'
          AND NOT rolcanlogin
          AND NOT rolinherit
          AND NOT rolsuper
          AND NOT rolcreatedb
          AND NOT rolcreaterole
          AND NOT rolreplication
          AND NOT rolbypassrls
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = 'shop_app_auth'
          AND NOT rolcanlogin
          AND NOT rolinherit
          AND NOT rolsuper
          AND NOT rolcreatedb
          AND NOT rolcreaterole
          AND NOT rolreplication
          AND NOT rolbypassrls
    ) THEN
        RAISE EXCEPTION '0004 authentication roles have unexpected attributes';
    END IF;

    IF (
        SELECT pg_get_userbyid(namespace.nspowner)
        FROM pg_namespace AS namespace
        WHERE namespace.nspname = 'auth_api'
    ) IS DISTINCT FROM 'shop_app_auth_owner' OR EXISTS (
        SELECT 1
        FROM pg_proc AS function_state
        INNER JOIN pg_namespace AS namespace ON namespace.oid = function_state.pronamespace
        WHERE namespace.nspname = 'auth_api'
    ) OR EXISTS (
        SELECT 1
        FROM pg_class AS relation
        INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'auth_api'
    ) THEN
        RAISE EXCEPTION '0004 requires the verified empty auth_api schema';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_class AS relation
        WHERE relation.oid = ANY (ARRAY[
            'platform.users'::regclass,
            'platform.store_memberships'::regclass,
            'platform.auth_sessions'::regclass,
            'platform.refresh_tokens'::regclass,
            'ledger.stores'::regclass,
            'ledger.devices'::regclass
        ])
          AND relation.relowner <> (
              SELECT oid FROM pg_roles WHERE rolname = 'shop_app_migrator'
          )
    ) THEN
        RAISE EXCEPTION '0004 target tables have unexpected ownership';
    END IF;
END
$preconditions$;

GRANT USAGE ON SCHEMA platform, ledger TO shop_app_auth_owner;
REVOKE CREATE ON SCHEMA platform, ledger FROM shop_app_auth_owner;

REVOKE ALL ON TABLE
    platform.users,
    platform.store_memberships,
    platform.auth_sessions,
    platform.refresh_tokens,
    ledger.stores,
    ledger.devices
FROM shop_app_auth, dokana_auth_login, shop_app_auth_owner;

GRANT SELECT (id, normalized_email, password_hash, status)
    ON platform.users TO shop_app_auth_owner;
GRANT SELECT (id, email, full_name, status)
    ON platform.users TO shop_app_auth_owner;
GRANT UPDATE (last_login_at)
    ON platform.users TO shop_app_auth_owner;

GRANT SELECT (id, store_id, user_id, role, status, version)
    ON platform.store_memberships TO shop_app_auth_owner;

GRANT SELECT (
    id,
    user_id,
    store_id,
    device_id,
    access_token_jti,
    issued_at,
    expires_at,
    revoked_at,
    revoke_reason
) ON platform.auth_sessions TO shop_app_auth_owner;
GRANT INSERT (
    id,
    user_id,
    store_id,
    device_id,
    access_token_jti,
    ip_hash,
    user_agent_hash,
    issued_at,
    expires_at
) ON platform.auth_sessions TO shop_app_auth_owner;
GRANT UPDATE (access_token_jti, revoked_at, revoke_reason)
    ON platform.auth_sessions TO shop_app_auth_owner;

GRANT SELECT (
    id,
    session_id,
    token_hash,
    family_id,
    parent_token_id,
    issued_at,
    expires_at,
    used_at,
    revoked_at,
    replaced_by_id
) ON platform.refresh_tokens TO shop_app_auth_owner;
GRANT INSERT (
    id,
    session_id,
    token_hash,
    family_id,
    parent_token_id,
    issued_at,
    expires_at
) ON platform.refresh_tokens TO shop_app_auth_owner;
GRANT UPDATE (used_at, revoked_at, replaced_by_id)
    ON platform.refresh_tokens TO shop_app_auth_owner;

GRANT SELECT (id, name, currency_code, status, version)
    ON ledger.stores TO shop_app_auth_owner;

GRANT SELECT (
    id,
    store_id,
    device_name,
    platform,
    installation_id,
    device_prefix,
    status,
    last_seen_at,
    version
) ON ledger.devices TO shop_app_auth_owner;
GRANT INSERT (
    id,
    store_id,
    device_name,
    platform,
    installation_id,
    device_prefix,
    status,
    last_seen_at
) ON ledger.devices TO shop_app_auth_owner;
GRANT UPDATE (last_seen_at, updated_at, version)
    ON ledger.devices TO shop_app_auth_owner;

GRANT EXECUTE ON FUNCTION
    platform.current_store_id(),
    platform.current_user_id()
TO shop_app_auth_owner;

CREATE POLICY auth_membership_self_permissive
ON platform.store_memberships
AS PERMISSIVE
FOR SELECT
TO shop_app_auth_owner
USING (user_id = platform.current_user_id());

CREATE POLICY auth_membership_self_restrictive
ON platform.store_memberships
AS RESTRICTIVE
FOR SELECT
TO shop_app_auth_owner
USING (user_id = platform.current_user_id());

CREATE POLICY auth_store_membership_permissive
ON ledger.stores
AS PERMISSIVE
FOR SELECT
TO shop_app_auth_owner
USING (
    EXISTS (
        SELECT 1
        FROM platform.store_memberships AS membership
        WHERE membership.store_id = stores.id
          AND membership.user_id = platform.current_user_id()
          AND membership.status = 'active'
    )
);

CREATE POLICY auth_store_membership_restrictive
ON ledger.stores
AS RESTRICTIVE
FOR SELECT
TO shop_app_auth_owner
USING (
    EXISTS (
        SELECT 1
        FROM platform.store_memberships AS membership
        WHERE membership.store_id = stores.id
          AND membership.user_id = platform.current_user_id()
          AND membership.status = 'active'
    )
);

CREATE POLICY auth_device_membership_restrictive
ON ledger.devices
AS RESTRICTIVE
FOR ALL
TO shop_app_auth_owner
USING (
    store_id = platform.current_store_id()
    AND EXISTS (
        SELECT 1
        FROM platform.store_memberships AS membership
        WHERE membership.store_id = devices.store_id
          AND membership.user_id = platform.current_user_id()
          AND membership.status = 'active'
    )
)
WITH CHECK (
    store_id = platform.current_store_id()
    AND EXISTS (
        SELECT 1
        FROM platform.store_memberships AS membership
        WHERE membership.store_id = devices.store_id
          AND membership.user_id = platform.current_user_id()
          AND membership.status = 'active'
    )
);

SET LOCAL ROLE shop_app_auth_owner;

DO $owner_transition$
BEGIN
    IF session_user <> 'dokana_migration_login'
       OR current_user <> 'shop_app_auth_owner' THEN
        RAISE EXCEPTION '0004 failed to assume the managed authentication owner';
    END IF;
END
$owner_transition$;

CREATE FUNCTION auth_api.lookup_credentials(p_normalized_email text)
RETURNS TABLE (
    user_id uuid,
    password_hash text,
    user_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
STRICT
SET search_path = pg_catalog, auth_api, platform, pg_temp
AS $function$
BEGIN
    IF p_normalized_email <> lower(trim(p_normalized_email))
       OR length(p_normalized_email) < 3
       OR length(p_normalized_email) > 320 THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT users.id, users.password_hash, users.status
    FROM platform.users AS users
    WHERE users.normalized_email = p_normalized_email
    LIMIT 1;
END
$function$;

CREATE FUNCTION auth_api.list_authorized_stores(p_user_id uuid)
RETURNS TABLE (
    store_id uuid,
    store_name text,
    currency_code text,
    store_status text,
    membership_role text,
    membership_version bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
STRICT
SET search_path = pg_catalog, auth_api, platform, ledger, pg_temp
AS $function$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM platform.users AS users
        WHERE users.id = p_user_id
          AND users.status = 'active'
    ) THEN
        RETURN;
    END IF;

    PERFORM pg_catalog.set_config('app.user_id', p_user_id::text, true);

    RETURN QUERY
    SELECT
        stores.id,
        stores.name,
        stores.currency_code,
        stores.status,
        memberships.role,
        memberships.version
    FROM platform.store_memberships AS memberships
    INNER JOIN ledger.stores AS stores ON stores.id = memberships.store_id
    WHERE memberships.user_id = p_user_id
      AND memberships.status = 'active'
      AND stores.status IN ('active', 'read_only')
    ORDER BY stores.name, stores.id;
END
$function$;

CREATE FUNCTION auth_api.issue_session(
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
    device_status text,
    session_id uuid,
    session_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth_api, platform, ledger, pg_temp
AS $function$
DECLARE
    device_state record;
BEGIN
    IF p_device_name IS NULL
       OR length(trim(p_device_name)) < 1
       OR length(trim(p_device_name)) > 120
       OR p_device_platform NOT IN ('android', 'ios')
       OR p_refresh_token_hash !~ '^[0-9a-f]{64}$'
       OR (p_ip_hash IS NOT NULL AND p_ip_hash !~ '^[0-9a-f]{64}$')
       OR (p_user_agent_hash IS NOT NULL AND p_user_agent_hash !~ '^[0-9a-f]{64}$')
       OR p_session_expires_at <= clock_timestamp()
       OR p_session_expires_at > clock_timestamp() + interval '31 days'
       OR p_refresh_expires_at <= clock_timestamp()
       OR p_refresh_expires_at > p_session_expires_at THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'invalid authentication session input';
    END IF;

    PERFORM pg_catalog.set_config('app.user_id', p_user_id::text, true);
    PERFORM pg_catalog.set_config('app.store_id', p_store_id::text, true);
    PERFORM pg_catalog.set_config('app.device_id', p_device_id::text, true);

    IF NOT EXISTS (
        SELECT 1
        FROM platform.users AS users
        WHERE users.id = p_user_id
          AND users.status = 'active'
    ) OR NOT EXISTS (
        SELECT 1
        FROM platform.store_memberships AS memberships
        WHERE memberships.user_id = p_user_id
          AND memberships.store_id = p_store_id
          AND memberships.status = 'active'
    ) OR NOT EXISTS (
        SELECT 1
        FROM ledger.stores AS stores
        WHERE stores.id = p_store_id
          AND stores.status IN ('active', 'read_only')
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '28000',
            MESSAGE = 'authentication not permitted';
    END IF;

    INSERT INTO ledger.devices (
        id,
        store_id,
        device_name,
        platform,
        installation_id,
        device_prefix,
        status,
        last_seen_at
    )
    VALUES (
        p_device_id,
        p_store_id,
        trim(p_device_name),
        p_device_platform,
        p_device_id,
        left(replace(p_device_id::text, '-', ''), 12),
        'active',
        clock_timestamp()
    )
    ON CONFLICT (id) DO NOTHING;

    SELECT devices.store_id, devices.status, devices.installation_id
    INTO device_state
    FROM ledger.devices AS devices
    WHERE devices.id = p_device_id;

    IF NOT FOUND
       OR device_state.store_id <> p_store_id
       OR device_state.installation_id <> p_device_id
       OR device_state.status <> 'active' THEN
        RAISE EXCEPTION USING
            ERRCODE = '28000',
            MESSAGE = 'authentication not permitted';
    END IF;

    UPDATE ledger.devices AS devices
    SET
        last_seen_at = clock_timestamp(),
        updated_at = clock_timestamp(),
        version = devices.version + 1
    WHERE devices.id = p_device_id
      AND devices.store_id = p_store_id;

    INSERT INTO platform.auth_sessions (
        id,
        user_id,
        store_id,
        device_id,
        access_token_jti,
        ip_hash,
        user_agent_hash,
        issued_at,
        expires_at
    )
    VALUES (
        p_session_id,
        p_user_id,
        p_store_id,
        p_device_id,
        p_access_token_jti,
        p_ip_hash,
        p_user_agent_hash,
        clock_timestamp(),
        p_session_expires_at
    );

    INSERT INTO platform.refresh_tokens (
        id,
        session_id,
        token_hash,
        family_id,
        issued_at,
        expires_at
    )
    VALUES (
        p_refresh_token_id,
        p_session_id,
        p_refresh_token_hash,
        p_refresh_family_id,
        clock_timestamp(),
        p_refresh_expires_at
    );

    UPDATE platform.users AS users
    SET last_login_at = clock_timestamp()
    WHERE users.id = p_user_id;

    RETURN QUERY
    SELECT
        users.id,
        users.email,
        users.full_name,
        stores.id,
        stores.name,
        stores.status,
        memberships.role,
        memberships.version,
        devices.id,
        devices.status,
        sessions.id,
        sessions.expires_at
    FROM platform.users AS users
    INNER JOIN platform.store_memberships AS memberships
        ON memberships.user_id = users.id
       AND memberships.store_id = p_store_id
       AND memberships.status = 'active'
    INNER JOIN ledger.stores AS stores
        ON stores.id = memberships.store_id
       AND stores.status IN ('active', 'read_only')
    INNER JOIN ledger.devices AS devices
        ON devices.id = p_device_id
       AND devices.store_id = stores.id
       AND devices.status = 'active'
    INNER JOIN platform.auth_sessions AS sessions
        ON sessions.id = p_session_id
    WHERE users.id = p_user_id
      AND users.status = 'active';
END
$function$;

CREATE FUNCTION auth_api.validate_session(
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
    session_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
STRICT
SET search_path = pg_catalog, auth_api, platform, ledger, pg_temp
AS $function$
BEGIN
    PERFORM pg_catalog.set_config('app.user_id', p_user_id::text, true);
    PERFORM pg_catalog.set_config('app.store_id', p_store_id::text, true);
    PERFORM pg_catalog.set_config('app.device_id', p_device_id::text, true);

    RETURN QUERY
    SELECT
        users.id,
        users.email,
        users.full_name,
        stores.id,
        stores.name,
        stores.status,
        memberships.role,
        memberships.version,
        devices.id,
        sessions.id,
        sessions.expires_at
    FROM platform.auth_sessions AS sessions
    INNER JOIN platform.users AS users
        ON users.id = sessions.user_id
       AND users.status = 'active'
    INNER JOIN platform.store_memberships AS memberships
        ON memberships.user_id = users.id
       AND memberships.store_id = sessions.store_id
       AND memberships.status = 'active'
    INNER JOIN ledger.stores AS stores
        ON stores.id = memberships.store_id
       AND stores.status IN ('active', 'read_only')
    INNER JOIN ledger.devices AS devices
        ON devices.id = sessions.device_id
       AND devices.store_id = stores.id
       AND devices.status = 'active'
    WHERE sessions.id = p_session_id
      AND sessions.user_id = p_user_id
      AND sessions.store_id = p_store_id
      AND sessions.device_id = p_device_id
      AND sessions.access_token_jti = p_access_token_jti
      AND sessions.revoked_at IS NULL
      AND sessions.expires_at > clock_timestamp();
END
$function$;

CREATE FUNCTION auth_api.rotate_refresh_token(
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

CREATE FUNCTION auth_api.revoke_session(
    p_user_id uuid,
    p_session_id uuid,
    p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STRICT
SET search_path = pg_catalog, auth_api, platform, pg_temp
AS $function$
DECLARE
    matched_session boolean;
BEGIN
    IF p_reason NOT IN ('logout', 'security', 'administrative') THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'invalid session revocation reason';
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM platform.auth_sessions AS sessions
        WHERE sessions.id = p_session_id
          AND sessions.user_id = p_user_id
    )
    INTO matched_session;

    IF NOT matched_session THEN
        RETURN false;
    END IF;

    UPDATE platform.auth_sessions
    SET
        revoked_at = COALESCE(revoked_at, clock_timestamp()),
        revoke_reason = COALESCE(revoke_reason, p_reason)
    WHERE id = p_session_id
      AND user_id = p_user_id;

    UPDATE platform.refresh_tokens
    SET revoked_at = COALESCE(revoked_at, clock_timestamp())
    WHERE session_id = p_session_id;

    RETURN true;
END
$function$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA auth_api FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA auth_api FROM shop_app_runtime;
GRANT USAGE ON SCHEMA auth_api TO shop_app_auth;

GRANT EXECUTE ON FUNCTION auth_api.lookup_credentials(text) TO shop_app_auth;
GRANT EXECUTE ON FUNCTION auth_api.list_authorized_stores(uuid) TO shop_app_auth;
GRANT EXECUTE ON FUNCTION auth_api.issue_session(
    uuid,
    uuid,
    uuid,
    text,
    text,
    uuid,
    uuid,
    uuid,
    text,
    uuid,
    timestamptz,
    timestamptz,
    text,
    text
) TO shop_app_auth;
GRANT EXECUTE ON FUNCTION auth_api.validate_session(uuid, uuid, uuid, uuid, uuid)
    TO shop_app_auth;
GRANT EXECUTE ON FUNCTION auth_api.rotate_refresh_token(text, uuid, text, uuid, timestamptz)
    TO shop_app_auth;
GRANT EXECUTE ON FUNCTION auth_api.revoke_session(uuid, uuid, text)
    TO shop_app_auth;

ALTER DEFAULT PRIVILEGES FOR ROLE shop_app_auth_owner IN SCHEMA auth_api
    REVOKE ALL ON FUNCTIONS FROM PUBLIC;

DO $postconditions$
DECLARE
    function_count integer;
BEGIN
    IF session_user <> 'dokana_migration_login'
       OR current_user <> 'shop_app_auth_owner' THEN
        RAISE EXCEPTION '0004 authentication owner was not retained locally';
    END IF;

    IF (
        SELECT pg_get_userbyid(namespace.nspowner)
        FROM pg_namespace AS namespace
        WHERE namespace.nspname = 'auth_api'
    ) <> 'shop_app_auth_owner' THEN
        RAISE EXCEPTION 'auth_api schema owner is unexpected';
    END IF;

    SELECT count(*)
    INTO function_count
    FROM pg_proc AS function_state
    INNER JOIN pg_namespace AS namespace ON namespace.oid = function_state.pronamespace
    WHERE namespace.nspname = 'auth_api'
      AND pg_get_userbyid(function_state.proowner) = 'shop_app_auth_owner'
      AND function_state.prosecdef
      AND function_state.proconfig IS NOT NULL
      AND EXISTS (
          SELECT 1
          FROM unnest(function_state.proconfig) AS configuration(value)
          WHERE configuration.value LIKE 'search_path=pg_catalog, auth_api,%pg_temp'
      );

    IF function_count <> 6 THEN
        RAISE EXCEPTION 'authentication function ownership or security configuration is unexpected';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_class AS relation
        INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE relation.relowner = (
            SELECT oid FROM pg_roles WHERE rolname = 'shop_app_auth_owner'
        )
          AND NOT (
              namespace.nspname = 'auth_api'
              AND relation.relkind IN ('i', 'I')
          )
    ) THEN
        RAISE EXCEPTION 'authentication owner owns an unexpected relation';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.role_table_grants AS grant_state
        WHERE grant_state.grantee IN ('shop_app_auth', 'dokana_auth_login')
          AND grant_state.table_schema IN ('platform', 'ledger')
    ) OR has_schema_privilege('shop_app_auth', 'auth_api', 'CREATE')
       OR has_schema_privilege('dokana_auth_login', 'auth_api', 'CREATE') THEN
        RAISE EXCEPTION 'authentication execution roles have unexpected direct privileges';
    END IF;
END
$postconditions$;
