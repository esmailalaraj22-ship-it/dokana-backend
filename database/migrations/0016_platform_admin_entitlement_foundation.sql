-- Migration 0016: add the narrow Platform Admin and effective-entitlement foundation.
--
-- Scope is limited to durable Platform Admin assignment, immutable administrative audit,
-- and tenant-bound server-time entitlement resolution. This migration does not integrate
-- entitlement into authentication or business writes and does not implement licensing.
--
-- Canonical lock order for future protected writes and S18 admin mutations:
--   1. ledger.stores row
--   2. platform.subscriptions row
--
-- Rollback requires backend-owner approval: revoke the two function grants, drop the two
-- functions, drop the admin-action immutability trigger and added checks, then drop
-- platform.platform_admin_assignments. Existing administrative audit rows must be retained
-- or exported before any approved rollback.

DO $preconditions$
BEGIN
    IF session_user <> 'dokana_migration_login'
       OR current_user <> 'shop_app_migrator' THEN
        RAISE EXCEPTION '0016 requires the approved migration login and effective role';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = 'shop_app_migrator'
          AND NOT rolcanlogin
          AND NOT rolinherit
          AND NOT rolsuper
          AND NOT rolcreatedb
          AND NOT rolcreaterole
          AND NOT rolreplication
          AND NOT rolbypassrls
    ) OR pg_has_role('shop_app_migrator', 'shop_app_runtime', 'SET')
       OR pg_has_role('shop_app_migrator', 'shop_app_auth', 'SET') THEN
        RAISE EXCEPTION '0016 migration role state is not least privileged';
    END IF;

    IF to_regclass('platform.users') IS NULL
       OR to_regclass('platform.subscriptions') IS NULL
       OR to_regclass('platform.admin_actions') IS NULL
       OR to_regclass('ledger.stores') IS NULL
       OR pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'platform.users'::regclass))
            <> 'shop_app_migrator'
       OR pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'platform.subscriptions'::regclass))
            <> 'shop_app_migrator'
       OR pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'platform.admin_actions'::regclass))
            <> 'shop_app_migrator'
       OR pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'ledger.stores'::regclass))
            <> 'shop_app_migrator' THEN
        RAISE EXCEPTION '0016 requires the verified S18.1 physical foundation';
    END IF;

    IF NOT (
        SELECT relrowsecurity AND relforcerowsecurity
        FROM pg_class
        WHERE oid = 'platform.subscriptions'::regclass
    ) OR NOT (
        SELECT relrowsecurity AND relforcerowsecurity
        FROM pg_class
        WHERE oid = 'ledger.stores'::regclass
    ) THEN
        RAISE EXCEPTION '0016 requires forced RLS on Stores and Subscriptions';
    END IF;

    IF to_regclass('platform.platform_admin_assignments') IS NOT NULL
       OR to_regprocedure('ledger.current_actor_is_platform_admin()') IS NOT NULL
       OR to_regprocedure('ledger.lock_effective_entitlement(uuid)') IS NOT NULL THEN
        RAISE EXCEPTION '0016 managed objects already exist';
    END IF;

    IF has_schema_privilege('shop_app_runtime', 'platform', 'USAGE')
       OR has_table_privilege('shop_app_runtime', 'platform.subscriptions', 'SELECT')
       OR has_table_privilege('shop_app_runtime', 'platform.admin_actions', 'INSERT') THEN
        RAISE EXCEPTION '0016 requires the verified runtime accounting firewall';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM platform.admin_actions
        WHERE length(trim(action)) = 0
           OR length(trim(reason)) = 0
           OR jsonb_typeof(metadata) <> 'object'
    ) THEN
        RAISE EXCEPTION '0016 cannot harden invalid existing administrative audit rows';
    END IF;
END
$preconditions$;

CREATE TABLE platform.platform_admin_assignments (
    user_id uuid PRIMARY KEY
        REFERENCES platform.users(id) ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked')),
    assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    assigned_by_user_id uuid
        REFERENCES platform.users(id) ON DELETE RESTRICT,
    revoked_at timestamptz,
    revoked_by_user_id uuid
        REFERENCES platform.users(id) ON DELETE RESTRICT,
    revoke_reason text,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    CONSTRAINT platform_admin_assignments_state_check CHECK (
        (
            status = 'active'
            AND revoked_at IS NULL
            AND revoked_by_user_id IS NULL
            AND revoke_reason IS NULL
        )
        OR
        (
            status = 'revoked'
            AND revoked_at IS NOT NULL
            AND revoked_by_user_id IS NOT NULL
            AND length(trim(revoke_reason)) > 0
        )
    )
);

COMMENT ON TABLE platform.platform_admin_assignments IS
    'Durable global Platform Admin authorization; never implied by Store membership';
COMMENT ON COLUMN platform.platform_admin_assignments.assigned_by_user_id IS
    'Nullable only for the future controlled first-admin operational bootstrap';

REVOKE ALL ON TABLE platform.platform_admin_assignments FROM PUBLIC;
REVOKE ALL ON TABLE platform.platform_admin_assignments
    FROM shop_app_runtime, shop_app_auth, shop_app_auth_owner,
         dokana_runtime_login, dokana_auth_login;

ALTER TABLE platform.platform_admin_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.platform_admin_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY platform_admin_assignments_migrator
ON platform.platform_admin_assignments
FOR ALL
TO shop_app_migrator
USING (true)
WITH CHECK (true);

ALTER TABLE platform.admin_actions
    ADD CONSTRAINT admin_actions_action_nonempty_check
        CHECK (length(trim(action)) > 0),
    ADD CONSTRAINT admin_actions_reason_nonempty_check
        CHECK (length(trim(reason)) > 0),
    ADD CONSTRAINT admin_actions_metadata_object_check
        CHECK (jsonb_typeof(metadata) = 'object');

CREATE TRIGGER trg_admin_actions_immutable
BEFORE UPDATE OR DELETE ON platform.admin_actions
FOR EACH ROW EXECUTE FUNCTION audit.prevent_central_audit_mutation();

CREATE FUNCTION ledger.current_actor_is_platform_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
    SELECT EXISTS (
        SELECT 1
        FROM platform.platform_admin_assignments AS assignment
        INNER JOIN platform.users AS actor
            ON actor.id = assignment.user_id
        WHERE assignment.user_id = platform.current_user_id()
          AND assignment.status = 'active'
          AND actor.status = 'active'
    )
$function$;

CREATE FUNCTION ledger.lock_effective_entitlement(p_store_id uuid)
RETURNS TABLE (
    checked_at timestamptz,
    store_id uuid,
    store_status text,
    subscription_id uuid,
    subscription_status text,
    entitlement_starts_at timestamptz,
    entitlement_ends_at timestamptz,
    effective_access text,
    write_eligible boolean,
    denial_reason text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_checked_at timestamptz := clock_timestamp();
    v_store_status text;
    v_subscription_id uuid;
    v_subscription_status text;
    v_starts_at timestamptz;
    v_ends_at timestamptz;
    v_write_eligible boolean;
    v_effective_access text;
    v_denial_reason text;
BEGIN
    IF p_store_id IS NULL
       OR p_store_id IS DISTINCT FROM platform.current_store_id() THEN
        RAISE EXCEPTION 'Effective entitlement requires matching tenant context'
            USING ERRCODE = '42501';
    END IF;

    SELECT store_record.status
    INTO v_store_status
    FROM ledger.stores AS store_record
    WHERE store_record.id = p_store_id
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Effective entitlement requires an authorized Store'
            USING ERRCODE = '42501';
    END IF;

    SELECT
        subscription.id,
        subscription.status,
        subscription.starts_at,
        subscription.expires_at
    INTO
        v_subscription_id,
        v_subscription_status,
        v_starts_at,
        v_ends_at
    FROM platform.subscriptions AS subscription
    WHERE subscription.store_id = p_store_id
    ORDER BY
        CASE subscription.status
            WHEN 'active' THEN 0
            WHEN 'trial' THEN 1
            WHEN 'past_due' THEN 2
            WHEN 'suspended' THEN 3
            WHEN 'cancelled' THEN 4
            WHEN 'expired' THEN 5
            ELSE 6
        END,
        subscription.starts_at DESC,
        subscription.expires_at DESC,
        subscription.id DESC
    LIMIT 1
    FOR SHARE;

    v_write_eligible :=
        v_store_status = 'active'
        AND v_subscription_status = 'active'
        AND v_starts_at <= v_checked_at
        AND v_checked_at < v_ends_at;

    v_effective_access := CASE
        WHEN v_store_status IN ('suspended', 'archived') THEN 'blocked'
        WHEN v_write_eligible THEN 'write'
        ELSE 'read_only'
    END;

    v_denial_reason := CASE
        WHEN v_store_status = 'read_only' THEN 'store_read_only'
        WHEN v_store_status = 'suspended' THEN 'store_suspended'
        WHEN v_store_status = 'archived' THEN 'store_archived'
        WHEN v_subscription_id IS NULL THEN 'subscription_missing'
        WHEN v_subscription_status = 'cancelled' THEN 'subscription_cancelled'
        WHEN v_subscription_status <> 'active' THEN 'subscription_inactive'
        WHEN v_starts_at > v_checked_at THEN 'subscription_not_started'
        WHEN v_checked_at >= v_ends_at THEN 'subscription_expired'
        ELSE NULL
    END;

    RETURN QUERY SELECT
        v_checked_at,
        p_store_id,
        v_store_status,
        v_subscription_id,
        v_subscription_status,
        v_starts_at,
        v_ends_at,
        v_effective_access,
        v_write_eligible,
        v_denial_reason;
END
$function$;

REVOKE ALL ON FUNCTION ledger.current_actor_is_platform_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION ledger.lock_effective_entitlement(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION ledger.current_actor_is_platform_admin()
    TO shop_app_runtime, shop_app_auth_owner;
GRANT EXECUTE ON FUNCTION ledger.lock_effective_entitlement(uuid)
    TO shop_app_runtime, shop_app_auth_owner;

DO $postconditions$
DECLARE
    managed_function record;
BEGIN
    IF pg_get_userbyid((
        SELECT relowner
        FROM pg_class
        WHERE oid = 'platform.platform_admin_assignments'::regclass
    )) <> 'shop_app_migrator' OR NOT (
        SELECT relrowsecurity AND relforcerowsecurity
        FROM pg_class
        WHERE oid = 'platform.platform_admin_assignments'::regclass
    ) THEN
        RAISE EXCEPTION '0016 Platform Admin assignment ownership or RLS is unexpected';
    END IF;

    IF (
        SELECT count(*)
        FROM pg_policies
        WHERE schemaname = 'platform'
          AND tablename = 'platform_admin_assignments'
          AND policyname = 'platform_admin_assignments_migrator'
          AND roles = ARRAY['shop_app_migrator']::name[]
          AND cmd = 'ALL'
    ) <> 1 THEN
        RAISE EXCEPTION '0016 Platform Admin assignment policy is unexpected';
    END IF;

    IF has_table_privilege('shop_app_runtime', 'platform.platform_admin_assignments', 'SELECT')
       OR has_table_privilege('shop_app_runtime', 'platform.platform_admin_assignments', 'INSERT')
       OR has_table_privilege('shop_app_runtime', 'platform.platform_admin_assignments', 'UPDATE')
       OR has_table_privilege('shop_app_auth_owner', 'platform.platform_admin_assignments', 'SELECT')
       OR has_schema_privilege('shop_app_runtime', 'platform', 'USAGE') THEN
        RAISE EXCEPTION '0016 Platform Admin assignment privileges are too broad';
    END IF;

    FOR managed_function IN
        SELECT
            function_state.oid,
            pg_get_userbyid(function_state.proowner) AS owner,
            function_state.prosecdef AS security_definer,
            function_state.proconfig AS configuration
        FROM pg_proc AS function_state
        WHERE function_state.oid IN (
            'ledger.current_actor_is_platform_admin()'::regprocedure,
            'ledger.lock_effective_entitlement(uuid)'::regprocedure
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
           ) THEN
            RAISE EXCEPTION '0016 managed function security configuration is unexpected';
        END IF;
    END LOOP;

    IF NOT has_function_privilege(
        'shop_app_runtime',
        'ledger.current_actor_is_platform_admin()',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'shop_app_runtime',
        'ledger.lock_effective_entitlement(uuid)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'shop_app_auth_owner',
        'ledger.current_actor_is_platform_admin()',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'shop_app_auth_owner',
        'ledger.lock_effective_entitlement(uuid)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION '0016 managed function grants are incomplete';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'platform.admin_actions'::regclass
          AND tgname = 'trg_admin_actions_immutable'
          AND tgenabled = 'O'
          AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION '0016 administrative audit immutability is missing';
    END IF;
END
$postconditions$;
