-- Migration 0018: add the narrow S18.4 subscription and Store-provisioning API.
--
-- Runtime receives EXECUTE only on the managed SECURITY DEFINER functions below.
-- It receives no platform schema/table privilege, and every function verifies the
-- transaction-local Store context and an active durable Platform Admin assignment.
-- Store provisioning creates only the protected Store/Owner/optional Subscription
-- identities. Existing S7/S8 application services add Settings and System Cash in
-- the same outer transaction.
--
-- Canonical lock order for lifecycle mutations:
--   1. operation advisory lock
--   2. ledger.stores row
--   3. platform.subscriptions row
--
-- Approved rollback: revoke the five runtime EXECUTE grants and drop the five
-- functions. Existing Subscriptions, Stores, memberships, and immutable
-- platform.admin_actions rows must be retained.

DO $preconditions$
BEGIN
    IF session_user <> 'dokana_migration_login'
       OR current_user <> 'shop_app_migrator' THEN
        RAISE EXCEPTION '0018 requires the approved migration login and effective role';
    END IF;

    IF to_regprocedure('ledger.current_actor_is_platform_admin()') IS NULL
       OR to_regprocedure('ledger.lock_effective_entitlement(uuid)') IS NULL
       OR to_regclass('platform.platform_admin_assignments') IS NULL
       OR to_regclass('platform.subscription_plans') IS NULL
       OR to_regclass('platform.subscriptions') IS NULL
       OR to_regclass('platform.admin_actions') IS NULL
       OR to_regclass('platform.store_memberships') IS NULL
       OR to_regclass('ledger.stores') IS NULL THEN
        RAISE EXCEPTION '0018 requires the verified S18.3 foundation';
    END IF;

    IF to_regprocedure('ledger.manage_subscription_lifecycle(uuid,text,uuid,text,text)') IS NOT NULL
       OR to_regprocedure('ledger.provision_store_identity(uuid,uuid,text,text,uuid,text,text,boolean)') IS NOT NULL
       OR to_regprocedure('ledger.read_subscription_lifecycle(uuid)') IS NOT NULL
       OR to_regprocedure('ledger.read_subscription_history(uuid)') IS NOT NULL
       OR to_regprocedure('ledger.read_store_provisioning_state(uuid)') IS NOT NULL THEN
        RAISE EXCEPTION '0018 managed functions already exist';
    END IF;

    IF has_schema_privilege('shop_app_runtime', 'platform', 'USAGE')
       OR has_table_privilege('shop_app_runtime', 'platform.subscriptions', 'SELECT')
       OR has_table_privilege('shop_app_runtime', 'platform.subscriptions', 'INSERT')
       OR has_table_privilege('shop_app_runtime', 'platform.subscriptions', 'UPDATE')
       OR has_table_privilege('shop_app_runtime', 'platform.store_memberships', 'INSERT')
       OR has_table_privilege('shop_app_runtime', 'platform.admin_actions', 'INSERT') THEN
        RAISE EXCEPTION '0018 requires the verified runtime accounting firewall';
    END IF;

    IF NOT (
        SELECT relrowsecurity AND relforcerowsecurity
        FROM pg_class
        WHERE oid = 'ledger.stores'::regclass
    ) OR NOT (
        SELECT relrowsecurity AND relforcerowsecurity
        FROM pg_class
        WHERE oid = 'platform.store_memberships'::regclass
    ) OR NOT (
        SELECT relrowsecurity AND relforcerowsecurity
        FROM pg_class
        WHERE oid = 'platform.subscriptions'::regclass
    ) THEN
        RAISE EXCEPTION '0018 requires forced RLS on managed Store-scoped tables';
    END IF;
END
$preconditions$;

CREATE FUNCTION ledger.manage_subscription_lifecycle(
    p_store_id uuid,
    p_action text,
    p_operation_id uuid,
    p_request_hash text,
    p_reason text
)
RETURNS TABLE (
    subscription_id uuid,
    plan_id uuid,
    subscription_status text,
    starts_at timestamptz,
    ends_at timestamptz,
    cancelled_at timestamptz,
    subscription_version bigint,
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
    v_store_status text;
    v_plan platform.subscription_plans%ROWTYPE;
    v_plan_count integer;
    v_subscription platform.subscriptions%ROWTYPE;
    v_previous jsonb;
    v_current jsonb;
    v_audit platform.admin_actions%ROWTYPE;
    v_expected_action text;
BEGIN
    IF p_store_id IS NULL
       OR p_store_id IS DISTINCT FROM platform.current_store_id() THEN
        RAISE EXCEPTION 'S18.4 lifecycle requires matching Store context'
            USING ERRCODE = '42501';
    END IF;
    IF p_action NOT IN ('activate', 'extend', 'cancel', 'reactivate')
       OR p_operation_id IS NULL
       OR p_request_hash !~ '^[0-9a-f]{64}$'
       OR p_reason IS NULL
       OR length(trim(p_reason)) = 0 THEN
        RAISE EXCEPTION 'S18.4 lifecycle input is invalid'
            USING ERRCODE = '22023';
    END IF;

    v_actor_id := platform.current_user_id();
    IF v_actor_id IS NULL OR NOT ledger.current_actor_is_platform_admin() THEN
        RAISE EXCEPTION 'S18.4 lifecycle requires an active Platform Admin'
            USING ERRCODE = '42501';
    END IF;

    v_expected_action := 'subscription_' || p_action;
    PERFORM pg_advisory_xact_lock(hashtextextended('dokana:s18:' || p_operation_id::text, 0));

    SELECT action_record.*
    INTO v_audit
    FROM platform.admin_actions AS action_record
    WHERE action_record.request_id = p_operation_id
      AND (
        action_record.action LIKE 'subscription_%'
        OR action_record.action = 'store_provisioned'
      )
    ORDER BY action_record.occurred_at, action_record.id
    LIMIT 1;

    IF FOUND THEN
        IF v_audit.admin_user_id IS DISTINCT FROM v_actor_id
           OR v_audit.store_id IS DISTINCT FROM p_store_id
           OR v_audit.action IS DISTINCT FROM v_expected_action
           OR v_audit.metadata->>'requestHash' IS DISTINCT FROM p_request_hash THEN
            RAISE EXCEPTION 'S18.4 operation ID was reused with different semantics'
                USING ERRCODE = '23505';
        END IF;

        RETURN QUERY SELECT
            (v_audit.metadata #>> '{result,subscriptionId}')::uuid,
            (v_audit.metadata #>> '{result,planId}')::uuid,
            v_audit.metadata #>> '{result,status}',
            (v_audit.metadata #>> '{result,startsAt}')::timestamptz,
            (v_audit.metadata #>> '{result,endsAt}')::timestamptz,
            (v_audit.metadata #>> '{result,cancelledAt}')::timestamptz,
            (v_audit.metadata #>> '{result,version}')::bigint,
            p_action,
            v_audit.occurred_at,
            true;
        RETURN;
    END IF;

    SELECT store_record.status
    INTO v_store_status
    FROM ledger.stores AS store_record
    WHERE store_record.id = p_store_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'S18.4 lifecycle requires an authorized Store'
            USING ERRCODE = '42501';
    END IF;
    IF v_store_status IN ('suspended', 'archived') THEN
        RAISE EXCEPTION 'S18.4 lifecycle cannot activate a restricted Store'
            USING ERRCODE = '55000';
    END IF;

    SELECT subscription_record.*
    INTO v_subscription
    FROM platform.subscriptions AS subscription_record
    WHERE subscription_record.store_id = p_store_id
      AND subscription_record.status IN ('trial', 'active', 'past_due', 'suspended')
    ORDER BY subscription_record.starts_at DESC,
             subscription_record.expires_at DESC,
             subscription_record.id DESC
    LIMIT 1
    FOR UPDATE;

    IF p_action = 'activate' THEN
        IF FOUND THEN
            RAISE EXCEPTION 'S18.4 activation requires no current Subscription'
                USING ERRCODE = '55000';
        END IF;

        SELECT count(*)::integer
        INTO v_plan_count
        FROM platform.subscription_plans AS plan_record
        WHERE plan_record.status = 'active';
        IF v_plan_count <> 1 THEN
            RAISE EXCEPTION 'S18.4 requires exactly one active MVP plan'
                USING ERRCODE = '55000';
        END IF;
        SELECT plan_record.*
        INTO v_plan
        FROM platform.subscription_plans AS plan_record
        WHERE plan_record.status = 'active'
        FOR SHARE;

        SELECT jsonb_build_object(
            'subscriptionId', prior.id,
            'planId', prior.plan_id,
            'status', prior.status,
            'startsAt', prior.starts_at,
            'endsAt', prior.expires_at,
            'cancelledAt', prior.cancelled_at,
            'version', prior.version::text
        )
        INTO v_previous
        FROM platform.subscriptions AS prior
        WHERE prior.store_id = p_store_id
        ORDER BY prior.starts_at DESC, prior.expires_at DESC, prior.id DESC
        LIMIT 1;

        INSERT INTO platform.subscriptions (
            id, store_id, plan_id, status, starts_at, expires_at,
            suspended_at, cancelled_at, created_at, updated_at, version
        ) VALUES (
            gen_random_uuid(), p_store_id, v_plan.id, 'active', v_now,
            v_now + make_interval(days => v_plan.duration_days),
            NULL, NULL, v_now, v_now, 1
        )
        RETURNING * INTO v_subscription;
    ELSIF p_action = 'extend' THEN
        IF NOT FOUND
           OR v_subscription.status <> 'active'
           OR NOT (v_subscription.starts_at <= v_now AND v_now < v_subscription.expires_at) THEN
            RAISE EXCEPTION 'S18.4 extension requires a currently active Subscription'
                USING ERRCODE = '55000';
        END IF;

        SELECT count(*)::integer
        INTO v_plan_count
        FROM platform.subscription_plans AS plan_record
        WHERE plan_record.status = 'active';
        SELECT plan_record.*
        INTO v_plan
        FROM platform.subscription_plans AS plan_record
        WHERE plan_record.id = v_subscription.plan_id
          AND plan_record.status = 'active'
        FOR SHARE;
        IF v_plan_count <> 1 OR NOT FOUND THEN
            RAISE EXCEPTION 'S18.4 extension requires the one active MVP plan'
                USING ERRCODE = '55000';
        END IF;

        v_previous := jsonb_build_object(
            'subscriptionId', v_subscription.id,
            'planId', v_subscription.plan_id,
            'status', v_subscription.status,
            'startsAt', v_subscription.starts_at,
            'endsAt', v_subscription.expires_at,
            'cancelledAt', v_subscription.cancelled_at,
            'version', v_subscription.version::text
        );
        UPDATE platform.subscriptions AS subscription_record
        SET expires_at = subscription_record.expires_at
                + make_interval(days => v_plan.duration_days),
            updated_at = v_now,
            version = subscription_record.version + 1
        WHERE subscription_record.id = v_subscription.id
        RETURNING subscription_record.* INTO v_subscription;
    ELSIF p_action = 'cancel' THEN
        IF NOT FOUND
           OR v_subscription.status <> 'active'
           OR v_now >= v_subscription.expires_at THEN
            RAISE EXCEPTION 'S18.4 cancellation requires a non-expired active Subscription'
                USING ERRCODE = '55000';
        END IF;

        v_previous := jsonb_build_object(
            'subscriptionId', v_subscription.id,
            'planId', v_subscription.plan_id,
            'status', v_subscription.status,
            'startsAt', v_subscription.starts_at,
            'endsAt', v_subscription.expires_at,
            'cancelledAt', v_subscription.cancelled_at,
            'version', v_subscription.version::text
        );
        UPDATE platform.subscriptions AS subscription_record
        SET status = 'cancelled',
            cancelled_at = v_now,
            updated_at = v_now,
            version = subscription_record.version + 1
        WHERE subscription_record.id = v_subscription.id
        RETURNING subscription_record.* INTO v_subscription;
    ELSE
        IF FOUND THEN
            IF v_subscription.status <> 'active' OR v_now < v_subscription.expires_at THEN
                RAISE EXCEPTION 'S18.4 reactivation requires an expired Subscription interval'
                    USING ERRCODE = '55000';
            END IF;
        ELSE
            SELECT subscription_record.*
            INTO v_subscription
            FROM platform.subscriptions AS subscription_record
            WHERE subscription_record.store_id = p_store_id
            ORDER BY subscription_record.starts_at DESC,
                     subscription_record.expires_at DESC,
                     subscription_record.id DESC
            LIMIT 1
            FOR UPDATE;
            IF NOT FOUND OR v_subscription.status <> 'expired' THEN
                RAISE EXCEPTION 'S18.4 reactivation requires an expired Subscription interval'
                    USING ERRCODE = '55000';
            END IF;
        END IF;

        v_previous := jsonb_build_object(
            'subscriptionId', v_subscription.id,
            'planId', v_subscription.plan_id,
            'status', 'expired',
            'storedStatus', v_subscription.status,
            'startsAt', v_subscription.starts_at,
            'endsAt', v_subscription.expires_at,
            'cancelledAt', v_subscription.cancelled_at,
            'version', v_subscription.version::text
        );

        IF v_subscription.status = 'active' THEN
            UPDATE platform.subscriptions AS subscription_record
            SET status = 'expired',
                updated_at = v_now,
                version = subscription_record.version + 1
            WHERE subscription_record.id = v_subscription.id;
        END IF;

        SELECT count(*)::integer
        INTO v_plan_count
        FROM platform.subscription_plans AS plan_record
        WHERE plan_record.status = 'active';
        IF v_plan_count <> 1 THEN
            RAISE EXCEPTION 'S18.4 requires exactly one active MVP plan'
                USING ERRCODE = '55000';
        END IF;
        SELECT plan_record.*
        INTO v_plan
        FROM platform.subscription_plans AS plan_record
        WHERE plan_record.status = 'active'
        FOR SHARE;

        INSERT INTO platform.subscriptions (
            id, store_id, plan_id, status, starts_at, expires_at,
            suspended_at, cancelled_at, created_at, updated_at, version
        ) VALUES (
            gen_random_uuid(), p_store_id, v_plan.id, 'active', v_now,
            v_now + make_interval(days => v_plan.duration_days),
            NULL, NULL, v_now, v_now, 1
        )
        RETURNING * INTO v_subscription;
    END IF;

    v_current := jsonb_build_object(
        'subscriptionId', v_subscription.id,
        'planId', v_subscription.plan_id,
        'status', v_subscription.status,
        'startsAt', v_subscription.starts_at,
        'endsAt', v_subscription.expires_at,
        'cancelledAt', v_subscription.cancelled_at,
        'version', v_subscription.version::text
    );

    INSERT INTO platform.admin_actions (
        id, admin_user_id, store_id, action, reason, request_id, metadata, occurred_at
    ) VALUES (
        gen_random_uuid(), v_actor_id, p_store_id, v_expected_action, trim(p_reason),
        p_operation_id,
        jsonb_build_object(
            'requestHash', p_request_hash,
            'previous', v_previous,
            'current', v_current,
            'result', v_current
        ),
        v_now
    );

    RETURN QUERY SELECT
        v_subscription.id,
        v_subscription.plan_id,
        v_subscription.status,
        v_subscription.starts_at,
        v_subscription.expires_at,
        v_subscription.cancelled_at,
        v_subscription.version,
        p_action,
        v_now,
        false;
END
$function$;

CREATE FUNCTION ledger.provision_store_identity(
    p_store_id uuid,
    p_owner_user_id uuid,
    p_store_name text,
    p_store_phone text,
    p_operation_id uuid,
    p_request_hash text,
    p_reason text,
    p_activate_subscription boolean
)
RETURNS TABLE (
    store_id uuid,
    owner_user_id uuid,
    membership_id uuid,
    subscription_id uuid,
    subscription_status text,
    starts_at timestamptz,
    ends_at timestamptz,
    subscription_version bigint,
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
    v_owner_status text;
    v_membership_id uuid;
    v_plan platform.subscription_plans%ROWTYPE;
    v_plan_count integer;
    v_subscription platform.subscriptions%ROWTYPE;
    v_audit platform.admin_actions%ROWTYPE;
    v_current jsonb;
BEGIN
    IF p_store_id IS NULL
       OR p_store_id IS DISTINCT FROM platform.current_store_id() THEN
        RAISE EXCEPTION 'S18.4 provisioning requires matching Store context'
            USING ERRCODE = '42501';
    END IF;
    IF p_owner_user_id IS NULL
       OR p_operation_id IS NULL
       OR p_store_name IS NULL
       OR length(trim(p_store_name)) = 0
       OR p_request_hash !~ '^[0-9a-f]{64}$'
       OR p_reason IS NULL
       OR length(trim(p_reason)) = 0
       OR p_activate_subscription IS NULL THEN
        RAISE EXCEPTION 'S18.4 provisioning input is invalid'
            USING ERRCODE = '22023';
    END IF;

    v_actor_id := platform.current_user_id();
    IF v_actor_id IS NULL OR NOT ledger.current_actor_is_platform_admin() THEN
        RAISE EXCEPTION 'S18.4 provisioning requires an active Platform Admin'
            USING ERRCODE = '42501';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('dokana:s18:' || p_operation_id::text, 0));

    SELECT action_record.*
    INTO v_audit
    FROM platform.admin_actions AS action_record
    WHERE action_record.request_id = p_operation_id
      AND (
        action_record.action LIKE 'subscription_%'
        OR action_record.action = 'store_provisioned'
      )
    ORDER BY action_record.occurred_at, action_record.id
    LIMIT 1;

    IF FOUND THEN
        IF v_audit.admin_user_id IS DISTINCT FROM v_actor_id
           OR v_audit.action <> 'store_provisioned'
           OR v_audit.store_id IS DISTINCT FROM p_store_id
           OR v_audit.metadata->>'requestHash' IS DISTINCT FROM p_request_hash THEN
            RAISE EXCEPTION 'S18.4 operation ID was reused with different semantics'
                USING ERRCODE = '23505';
        END IF;

        RETURN QUERY SELECT
            (v_audit.metadata #>> '{result,storeId}')::uuid,
            (v_audit.metadata #>> '{result,ownerUserId}')::uuid,
            (v_audit.metadata #>> '{result,membershipId}')::uuid,
            (v_audit.metadata #>> '{result,subscriptionId}')::uuid,
            v_audit.metadata #>> '{result,subscriptionStatus}',
            (v_audit.metadata #>> '{result,startsAt}')::timestamptz,
            (v_audit.metadata #>> '{result,endsAt}')::timestamptz,
            (v_audit.metadata #>> '{result,subscriptionVersion}')::bigint,
            v_audit.occurred_at,
            true;
        RETURN;
    END IF;

    SELECT user_record.status
    INTO v_owner_status
    FROM platform.users AS user_record
    WHERE user_record.id = p_owner_user_id
    FOR SHARE;
    IF NOT FOUND OR v_owner_status <> 'active' THEN
        RAISE EXCEPTION 'S18.4 provisioning requires an active intended Owner'
            USING ERRCODE = '42501';
    END IF;

    IF EXISTS (SELECT 1 FROM ledger.stores AS store_record WHERE store_record.id = p_store_id) THEN
        RAISE EXCEPTION 'S18.4 Store identity already exists for another operation'
            USING ERRCODE = '23505';
    END IF;

    INSERT INTO ledger.stores (
        id, name, phone, currency_code, status, created_at, updated_at, version
    ) VALUES (
        p_store_id, trim(p_store_name), NULLIF(trim(p_store_phone), ''),
        'ILS', 'active', v_now, v_now, 1
    );

    INSERT INTO platform.store_memberships (
        id, store_id, user_id, role, status, created_at, updated_at, version
    ) VALUES (
        gen_random_uuid(), p_store_id, p_owner_user_id, 'owner', 'active', v_now, v_now, 1
    )
    RETURNING id INTO v_membership_id;

    IF p_activate_subscription THEN
        SELECT count(*)::integer
        INTO v_plan_count
        FROM platform.subscription_plans AS plan_record
        WHERE plan_record.status = 'active';
        IF v_plan_count <> 1 THEN
            RAISE EXCEPTION 'S18.4 requires exactly one active MVP plan'
                USING ERRCODE = '55000';
        END IF;
        SELECT plan_record.*
        INTO v_plan
        FROM platform.subscription_plans AS plan_record
        WHERE plan_record.status = 'active'
        FOR SHARE;

        INSERT INTO platform.subscriptions (
            id, store_id, plan_id, status, starts_at, expires_at,
            suspended_at, cancelled_at, created_at, updated_at, version
        ) VALUES (
            gen_random_uuid(), p_store_id, v_plan.id, 'active', v_now,
            v_now + make_interval(days => v_plan.duration_days),
            NULL, NULL, v_now, v_now, 1
        )
        RETURNING * INTO v_subscription;
    END IF;

    v_current := jsonb_build_object(
        'storeId', p_store_id,
        'ownerUserId', p_owner_user_id,
        'membershipId', v_membership_id,
        'subscriptionId', v_subscription.id,
        'subscriptionStatus', v_subscription.status,
        'startsAt', v_subscription.starts_at,
        'endsAt', v_subscription.expires_at,
        'subscriptionVersion', CASE
            WHEN v_subscription.id IS NULL THEN NULL
            ELSE v_subscription.version::text
        END
    );

    INSERT INTO platform.admin_actions (
        id, admin_user_id, store_id, action, reason, request_id, metadata, occurred_at
    ) VALUES (
        gen_random_uuid(), v_actor_id, p_store_id, 'store_provisioned', trim(p_reason),
        p_operation_id,
        jsonb_build_object(
            'requestHash', p_request_hash,
            'previous', NULL,
            'current', v_current,
            'result', v_current
        ),
        v_now
    );

    RETURN QUERY SELECT
        p_store_id,
        p_owner_user_id,
        v_membership_id,
        v_subscription.id,
        v_subscription.status,
        v_subscription.starts_at,
        v_subscription.expires_at,
        v_subscription.version,
        v_now,
        false;
END
$function$;

CREATE FUNCTION ledger.read_subscription_lifecycle(p_store_id uuid)
RETURNS TABLE (
    checked_at timestamptz,
    store_id uuid,
    store_status text,
    subscription_id uuid,
    plan_id uuid,
    plan_code text,
    plan_name text,
    subscription_status text,
    effective_status text,
    starts_at timestamptz,
    ends_at timestamptz,
    cancelled_at timestamptz,
    subscription_version bigint,
    current_subscription boolean,
    write_eligible boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_actor_id uuid;
    v_now timestamptz := clock_timestamp();
BEGIN
    IF p_store_id IS NULL
       OR p_store_id IS DISTINCT FROM platform.current_store_id() THEN
        RAISE EXCEPTION 'S18.4 read requires matching Store context'
            USING ERRCODE = '42501';
    END IF;
    v_actor_id := platform.current_user_id();
    IF v_actor_id IS NULL OR NOT ledger.current_actor_is_platform_admin() THEN
        RAISE EXCEPTION 'S18.4 read requires an active Platform Admin'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    WITH current_record AS (
        SELECT subscription_record.id
        FROM platform.subscriptions AS subscription_record
        WHERE subscription_record.store_id = p_store_id
        ORDER BY
            CASE subscription_record.status
                WHEN 'active' THEN 0
                WHEN 'trial' THEN 1
                WHEN 'past_due' THEN 2
                WHEN 'suspended' THEN 3
                WHEN 'cancelled' THEN 4
                WHEN 'expired' THEN 5
                ELSE 6
            END,
            subscription_record.starts_at DESC,
            subscription_record.expires_at DESC,
            subscription_record.id DESC
        LIMIT 1
    )
    SELECT
        v_now,
        store_record.id,
        store_record.status,
        subscription_record.id,
        subscription_record.plan_id,
        plan_record.code,
        plan_record.name,
        subscription_record.status,
        CASE
            WHEN subscription_record.status = 'active'
             AND v_now >= subscription_record.expires_at THEN 'expired'
            ELSE subscription_record.status
        END,
        subscription_record.starts_at,
        subscription_record.expires_at,
        subscription_record.cancelled_at,
        subscription_record.version,
        subscription_record.id IS NOT NULL
            AND subscription_record.id = (SELECT id FROM current_record),
        store_record.status = 'active'
            AND subscription_record.status = 'active'
            AND subscription_record.starts_at <= v_now
            AND v_now < subscription_record.expires_at
    FROM ledger.stores AS store_record
    LEFT JOIN platform.subscriptions AS subscription_record
        ON subscription_record.store_id = store_record.id
    LEFT JOIN platform.subscription_plans AS plan_record
        ON plan_record.id = subscription_record.plan_id
    WHERE store_record.id = p_store_id
    ORDER BY subscription_record.starts_at DESC NULLS LAST,
             subscription_record.expires_at DESC NULLS LAST,
             subscription_record.id DESC NULLS LAST;
END
$function$;

CREATE FUNCTION ledger.read_subscription_history(p_store_id uuid)
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
        RAISE EXCEPTION 'S18.4 history requires an active Platform Admin and matching Store context'
            USING ERRCODE = '42501';
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
        action_record.action LIKE 'subscription_%'
        OR (
            action_record.action = 'store_provisioned'
            AND action_record.metadata #>> '{current,subscriptionId}' IS NOT NULL
        )
      )
    ORDER BY action_record.occurred_at, action_record.id;
END
$function$;

CREATE FUNCTION ledger.read_store_provisioning_state(p_store_id uuid)
RETURNS TABLE (
    store_id uuid,
    store_name text,
    store_status text,
    owner_count bigint,
    owner_user_id uuid,
    settings_count bigint,
    system_cash_count bigint,
    subscription_count bigint,
    current_subscription_id uuid
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
        RAISE EXCEPTION 'S18.4 provisioning read requires an active Platform Admin and matching Store context'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
        store_record.id,
        store_record.name,
        store_record.status,
        (
            SELECT count(*)
            FROM platform.store_memberships AS membership
            WHERE membership.store_id = store_record.id
              AND membership.role = 'owner'
              AND membership.status = 'active'
        ),
        (
            SELECT min(membership.user_id)
            FROM platform.store_memberships AS membership
            WHERE membership.store_id = store_record.id
              AND membership.role = 'owner'
              AND membership.status = 'active'
        ),
        (
            SELECT count(*)
            FROM ledger.app_settings AS settings
            WHERE settings.store_id = store_record.id
        ),
        (
            SELECT count(*)
            FROM ledger.money_accounts AS account
            WHERE account.store_id = store_record.id
              AND account.account_type = 'cash'
              AND account.status = 'active'
              AND account.is_default
        ),
        (
            SELECT count(*)
            FROM platform.subscriptions AS subscription_record
            WHERE subscription_record.store_id = store_record.id
        ),
        (
            SELECT subscription_record.id
            FROM platform.subscriptions AS subscription_record
            WHERE subscription_record.store_id = store_record.id
            ORDER BY
                CASE subscription_record.status
                    WHEN 'active' THEN 0
                    WHEN 'trial' THEN 1
                    WHEN 'past_due' THEN 2
                    WHEN 'suspended' THEN 3
                    WHEN 'cancelled' THEN 4
                    WHEN 'expired' THEN 5
                    ELSE 6
                END,
                subscription_record.starts_at DESC,
                subscription_record.expires_at DESC,
                subscription_record.id DESC
            LIMIT 1
        )
    FROM ledger.stores AS store_record
    WHERE store_record.id = p_store_id;
END
$function$;

REVOKE ALL ON FUNCTION
    ledger.manage_subscription_lifecycle(uuid, text, uuid, text, text),
    ledger.provision_store_identity(uuid, uuid, text, text, uuid, text, text, boolean),
    ledger.read_subscription_lifecycle(uuid),
    ledger.read_subscription_history(uuid),
    ledger.read_store_provisioning_state(uuid)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
    ledger.manage_subscription_lifecycle(uuid, text, uuid, text, text),
    ledger.provision_store_identity(uuid, uuid, text, text, uuid, text, text, boolean),
    ledger.read_subscription_lifecycle(uuid),
    ledger.read_subscription_history(uuid),
    ledger.read_store_provisioning_state(uuid)
TO shop_app_runtime;

DO $postconditions$
DECLARE
    managed_function record;
BEGIN
    FOR managed_function IN
        SELECT
            function_state.oid,
            pg_get_userbyid(function_state.proowner) AS owner,
            function_state.prosecdef AS security_definer,
            function_state.proconfig AS configuration
        FROM pg_proc AS function_state
        WHERE function_state.oid IN (
            'ledger.manage_subscription_lifecycle(uuid,text,uuid,text,text)'::regprocedure,
            'ledger.provision_store_identity(uuid,uuid,text,text,uuid,text,text,boolean)'::regprocedure,
            'ledger.read_subscription_lifecycle(uuid)'::regprocedure,
            'ledger.read_subscription_history(uuid)'::regprocedure,
            'ledger.read_store_provisioning_state(uuid)'::regprocedure
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
           OR NOT has_function_privilege('shop_app_runtime', managed_function.oid, 'EXECUTE') THEN
            RAISE EXCEPTION '0018 managed function security configuration is unexpected';
        END IF;
    END LOOP;

    IF has_schema_privilege('shop_app_runtime', 'platform', 'USAGE')
       OR has_table_privilege('shop_app_runtime', 'platform.subscriptions', 'SELECT')
       OR has_table_privilege('shop_app_runtime', 'platform.subscriptions', 'INSERT')
       OR has_table_privilege('shop_app_runtime', 'platform.subscriptions', 'UPDATE')
       OR has_table_privilege('shop_app_runtime', 'platform.store_memberships', 'INSERT')
       OR has_table_privilege('shop_app_runtime', 'platform.admin_actions', 'INSERT') THEN
        RAISE EXCEPTION '0018 broadened runtime platform privileges';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'platform.admin_actions'::regclass
          AND tgname = 'trg_admin_actions_immutable'
          AND tgenabled = 'O'
          AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION '0018 requires immutable administrative history';
    END IF;
END
$postconditions$;
