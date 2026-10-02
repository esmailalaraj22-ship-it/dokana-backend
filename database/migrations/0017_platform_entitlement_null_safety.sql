-- Migration 0017: make missing-subscription entitlement resolution fail closed.
--
-- Migration 0016 is already applied and immutable. Its boolean expression produced NULL
-- when no Subscription row existed. This corrective migration changes only that result to
-- false; it adds no capability or database object.

DO $preconditions$
BEGIN
    IF session_user <> 'dokana_migration_login'
       OR current_user <> 'shop_app_migrator' THEN
        RAISE EXCEPTION '0017 requires the approved migration login and effective role';
    END IF;

    IF to_regprocedure('ledger.lock_effective_entitlement(uuid)') IS NULL
       OR pg_get_userbyid((
            SELECT proowner
            FROM pg_proc
            WHERE oid = 'ledger.lock_effective_entitlement(uuid)'::regprocedure
       )) <> 'shop_app_migrator' THEN
        RAISE EXCEPTION '0017 requires the applied 0016 entitlement authority';
    END IF;
END
$preconditions$;

CREATE OR REPLACE FUNCTION ledger.lock_effective_entitlement(p_store_id uuid)
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

    v_write_eligible := COALESCE(
        v_store_status = 'active'
        AND v_subscription_status = 'active'
        AND v_starts_at <= v_checked_at
        AND v_checked_at < v_ends_at,
        false
    );

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
    WHERE routine.oid = 'ledger.lock_effective_entitlement(uuid)'::regprocedure;

    IF function_state.owner <> 'shop_app_migrator'
       OR NOT function_state.security_definer
       OR function_state.configuration IS DISTINCT FROM
            ARRAY['search_path=pg_catalog, pg_temp']::text[]
       OR NOT has_function_privilege(
            'shop_app_runtime',
            'ledger.lock_effective_entitlement(uuid)',
            'EXECUTE'
       )
       OR NOT has_function_privilege(
            'shop_app_auth_owner',
            'ledger.lock_effective_entitlement(uuid)',
            'EXECUTE'
       )
       OR EXISTS (
            SELECT 1
            FROM aclexplode(COALESCE(
                (SELECT proacl FROM pg_proc
                 WHERE oid = 'ledger.lock_effective_entitlement(uuid)'::regprocedure),
                acldefault('f', (SELECT proowner FROM pg_proc
                                 WHERE oid = 'ledger.lock_effective_entitlement(uuid)'::regprocedure))
            )) AS privilege
            WHERE privilege.grantee = 0
              AND privilege.privilege_type = 'EXECUTE'
       ) THEN
        RAISE EXCEPTION '0017 entitlement function security state is unexpected';
    END IF;
END
$postconditions$;
