-- Migration 0039: transaction-time actor authority for S2B-02 and S2B-03.
-- One helper plus four existing authority bodies; no tables, RLS or business schema change.
-- Ordinary online order: recovery fence -> Store SHARE -> Subscription SHARE ->
-- Device SHARE -> Membership SHARE -> post-lock entitlement clock -> business effects.
-- Offline authority already holds Store/device/license/subscription SHARE locks;
-- the helper adds device (reentrant SHARE) then membership, without lock upgrades.
-- Store lifecycle: recovery fence -> operation advisory -> Store UPDATE ->
-- Admin assignment SHARE -> effects. Replays lock the assignment after the advisory.
-- Subscription lifecycle uses the same Store-first assignment admission, followed
-- by its existing Subscription/plan locks; entitlement rules are unchanged.
-- License issuance: existing operation -> Store -> Subscription -> Device -> License
-- locks, then Membership SHARE. Preserve any active member eligibility and signing.
-- License revocation: existing operation -> Store SHARE -> License UPDATE ->
-- Admin assignment SHARE. No offline payload, duration or replay redesign.
-- Refresh/logout (0037): session UPDATE -> token UPDATE, no actor row locks.
-- Revocation UPDATE conflicts with SHARE and serializes until transaction end.
-- Devices are Store-owned, not user-owned; trusted authentication binds the actor
-- to the device. Do not invent an absent device.user_id ownership rule.
-- Runtime receives only EXECUTE on this fixed-requirement helper, no identity reads.
-- Existing function ownership, signature, ACL and fixed search_path are preserved.
-- Failed migration rolls back atomically. Remediation is forward-only; never
-- restore stale authorization or edit this file after canonical application.

DO $preconditions$
BEGIN
    IF session_user <> 'dokana_migration_login' OR current_user <> 'shop_app_migrator'
       OR to_regprocedure('ledger.lock_mutation_actor_v1(text)') IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM platform.schema_migrations
                      WHERE filename = '0038_entitlement_time_after_authority_locks.sql') THEN
        RAISE EXCEPTION '0039 requires the approved migration role and applied 0038';
    END IF;
END
$preconditions$;

CREATE FUNCTION ledger.lock_mutation_actor_v1(p_required_authority text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_store_id uuid := platform.current_store_id();
    v_user_id uuid := platform.current_user_id();
    v_device_id uuid := platform.current_device_id();
    v_status text;
    v_role text;
BEGIN
    IF v_store_id IS NULL OR v_user_id IS NULL
       OR p_required_authority IS NULL
       OR p_required_authority NOT IN ('owner', 'owner_or_manager', 'member', 'platform_admin') THEN
        RAISE EXCEPTION 'Mutation authority is unavailable' USING ERRCODE = '42501';
    END IF;

    IF p_required_authority = 'platform_admin' THEN
        SELECT assignment.status INTO v_status
        FROM platform.platform_admin_assignments AS assignment
        WHERE assignment.user_id = v_user_id
        FOR SHARE;
        IF NOT FOUND OR v_status <> 'active'
           OR NOT ledger.current_actor_is_platform_admin() THEN
            RAISE EXCEPTION 'Mutation authority is unavailable' USING ERRCODE = '42501';
        END IF;
        RETURN;
    END IF;

    SELECT device.status INTO v_status
    FROM ledger.devices AS device
    WHERE device.id = v_device_id AND device.store_id = v_store_id
    FOR SHARE;
    IF NOT FOUND OR v_status <> 'active' THEN
        RAISE EXCEPTION 'Mutation authority is unavailable' USING ERRCODE = '42501';
    END IF;

    SELECT membership.status, membership.role INTO v_status, v_role
    FROM platform.store_memberships AS membership
    WHERE membership.store_id = v_store_id AND membership.user_id = v_user_id
    FOR SHARE;
    IF NOT FOUND OR v_status <> 'active'
       OR NOT (p_required_authority = 'member' OR v_role = 'owner' OR
               (p_required_authority = 'owner_or_manager' AND v_role = 'manager')) THEN
        RAISE EXCEPTION 'Mutation authority is unavailable' USING ERRCODE = '42501';
    END IF;
END
$function$;

REVOKE ALL ON FUNCTION ledger.lock_mutation_actor_v1(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger.lock_mutation_actor_v1(text) TO shop_app_runtime;

CREATE OR REPLACE FUNCTION ledger.manage_store_lifecycle(
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
        PERFORM ledger.lock_mutation_actor_v1('platform_admin');
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

    -- Target admission precedes assignment admission; revocation may win the wait.
    PERFORM ledger.lock_mutation_actor_v1('platform_admin');

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

CREATE OR REPLACE FUNCTION ledger.manage_subscription_lifecycle(
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
        PERFORM ledger.lock_mutation_actor_v1('platform_admin');
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
    PERFORM ledger.lock_mutation_actor_v1('platform_admin');

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

CREATE OR REPLACE FUNCTION ledger.prepare_offline_license(
    p_store_id uuid,
    p_device_id uuid,
    p_license_id uuid,
    p_operation_id uuid,
    p_request_hash text,
    p_key_id text
)
RETURNS TABLE (
    license_id uuid,
    signed_payload jsonb,
    signature text,
    key_id text,
    issued_at timestamptz,
    expires_at timestamptz,
    replayed boolean,
    requires_signature boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_actor_id uuid;
    v_authority record;
    v_subscription platform.subscriptions%ROWTYPE;
    v_device ledger.devices%ROWTYPE;
    v_latest_license platform.license_issuances%ROWTYPE;
    v_existing_operation sync.processed_operations%ROWTYPE;
    v_license platform.license_issuances%ROWTYPE;
    v_now timestamptz;
    v_expires_at timestamptz;
    v_payload jsonb;
    v_claimed boolean;
BEGIN
    IF p_store_id IS NULL
       OR p_store_id IS DISTINCT FROM platform.current_store_id()
       OR p_device_id IS NULL
       OR p_device_id IS DISTINCT FROM platform.current_device_id()
       OR p_license_id IS NULL
       OR p_operation_id IS NULL
       OR p_request_hash IS NULL
       OR p_request_hash !~ '^[0-9a-f]{64}$'
       OR p_key_id IS NULL
       OR p_key_id !~ '^[A-Za-z0-9._-]{1,64}$' THEN
        RAISE EXCEPTION 'S18.6 Offline License request context or input is invalid'
            USING ERRCODE = '22023';
    END IF;

    v_actor_id := platform.current_user_id();
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'S18.6 Offline License issuance requires an authenticated actor'
            USING ERRCODE = '42501';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended('dokana:s18:offline-license:' || p_operation_id::text, 0)
    );

    SELECT operation_record.*
    INTO v_existing_operation
    FROM sync.processed_operations AS operation_record
    WHERE operation_record.store_id = p_store_id
      AND operation_record.operation_id = p_operation_id
    FOR UPDATE;

    IF FOUND THEN
        IF v_existing_operation.device_id IS DISTINCT FROM p_device_id
           OR v_existing_operation.aggregate_type <> 'offline_license'
           OR v_existing_operation.action <> 'issue'
           OR v_existing_operation.request_hash IS DISTINCT FROM p_request_hash THEN
            RAISE EXCEPTION 'S18.6 operation ID was reused with different semantics'
                USING ERRCODE = '23505';
        END IF;
        IF v_existing_operation.status <> 'applied' THEN
            RAISE EXCEPTION 'S18.6 Offline License operation is not complete'
                USING ERRCODE = '55000';
        END IF;

        SELECT issuance.*
        INTO v_license
        FROM platform.license_issuances AS issuance
        WHERE issuance.store_id = p_store_id
          AND issuance.id = v_existing_operation.aggregate_id;

        IF NOT FOUND OR v_license.signature = '' THEN
            RAISE EXCEPTION 'S18.6 completed operation has no durable License issuance'
                USING ERRCODE = '55000';
        END IF;

        PERFORM ledger.lock_mutation_actor_v1('member');
        RETURN QUERY SELECT
            v_license.id,
            v_license.signed_payload,
            v_license.signature,
            v_license.key_id,
            v_license.issued_at,
            v_license.expires_at,
            true,
            false;
        RETURN;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM platform.store_memberships AS membership
        WHERE membership.store_id = p_store_id
          AND membership.user_id = v_actor_id
          AND membership.status = 'active'
    ) THEN
        RAISE EXCEPTION 'S18.6 Offline License issuance requires active Store membership'
            USING ERRCODE = '42501';
    END IF;

    SELECT entitlement.*
    INTO v_authority
    FROM ledger.lock_effective_entitlement(p_store_id) AS entitlement;

    IF NOT FOUND
       OR v_authority.store_status <> 'active'
       OR v_authority.subscription_status <> 'active'
       OR NOT v_authority.write_eligible
       OR v_authority.subscription_id IS NULL THEN
        RAISE EXCEPTION 'S18.6 central Store or Subscription state cannot issue an Offline License'
            USING ERRCODE = '55000';
    END IF;

    SELECT subscription_record.*
    INTO v_subscription
    FROM platform.subscriptions AS subscription_record
    WHERE subscription_record.id = v_authority.subscription_id
      AND subscription_record.store_id = p_store_id
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'S18.6 authoritative Subscription disappeared during issuance'
            USING ERRCODE = '55000';
    END IF;

    SELECT device_record.*
    INTO v_device
    FROM ledger.devices AS device_record
    WHERE device_record.store_id = p_store_id
      AND device_record.id = p_device_id
    FOR SHARE;

    IF NOT FOUND OR v_device.status <> 'active' THEN
        RAISE EXCEPTION 'S18.6 Offline License issuance requires an active registered device'
            USING ERRCODE = '42501';
    END IF;

    SELECT issuance.*
    INTO v_latest_license
    FROM platform.license_issuances AS issuance
    WHERE issuance.store_id = p_store_id
      AND issuance.device_id = p_device_id
    ORDER BY issuance.issued_at DESC, issuance.license_serial DESC
    LIMIT 1
    FOR SHARE;

    IF FOUND AND v_latest_license.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'S18.6 latest device License is centrally revoked'
            USING ERRCODE = '55000';
    END IF;

    PERFORM ledger.lock_mutation_actor_v1('member');

    v_now := date_trunc('milliseconds', clock_timestamp());
    IF v_subscription.status <> 'active'
       OR v_subscription.starts_at > v_now
       OR v_now >= v_subscription.expires_at THEN
        RAISE EXCEPTION 'S18.6 Subscription is not currently eligible for Offline License issuance'
            USING ERRCODE = '55000';
    END IF;

    v_expires_at := LEAST(v_now + interval '168 hours', v_subscription.expires_at);
    IF v_expires_at <= v_now THEN
        RAISE EXCEPTION 'S18.6 Offline License interval is empty'
            USING ERRCODE = '55000';
    END IF;

    v_payload := jsonb_build_object(
        'licenseVersion', 1,
        'licenseId', p_license_id::text,
        'storeId', p_store_id::text,
        'deviceId', p_device_id::text,
        'subscriptionId', v_subscription.id::text,
        'subscriptionVersion', v_subscription.version::text,
        'issuedAt', to_char(
            v_now AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ),
        'offlineValidUntil', to_char(
            v_expires_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ),
        'centralEntitlementEnd', to_char(
            v_subscription.expires_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ),
        'storeEntitlement', jsonb_build_object(
            'storeStatus', 'active',
            'subscriptionStatus', 'active',
            'effectiveAccess', 'write'
        ),
        'signingKeyId', p_key_id
    );

    SELECT sync.claim_operation(
        p_store_id,
        p_operation_id,
        p_device_id,
        'offline_license',
        p_license_id,
        'issue',
        p_request_hash
    ) INTO v_claimed;

    IF NOT v_claimed THEN
        RAISE EXCEPTION 'S18.6 Offline License operation could not be claimed'
            USING ERRCODE = '55000';
    END IF;

    INSERT INTO platform.license_issuances (
        id,
        store_id,
        device_id,
        subscription_id,
        signed_payload,
        signature,
        key_id,
        issued_at,
        expires_at
    ) VALUES (
        p_license_id,
        p_store_id,
        p_device_id,
        v_subscription.id,
        v_payload,
        '',
        p_key_id,
        v_now,
        v_expires_at
    )
    RETURNING * INTO v_license;

    RETURN QUERY SELECT
        v_license.id,
        v_license.signed_payload,
        v_license.signature,
        v_license.key_id,
        v_license.issued_at,
        v_license.expires_at,
        false,
        true;
END
$function$;

CREATE OR REPLACE FUNCTION ledger.revoke_offline_license(
    p_store_id uuid,
    p_license_id uuid,
    p_operation_id uuid,
    p_request_hash text,
    p_reason text
)
RETURNS TABLE (
    license_id uuid,
    revoked_at timestamptz,
    revoke_reason text,
    replayed boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_actor_id uuid;
    v_now timestamptz := date_trunc('milliseconds', clock_timestamp());
    v_existing_action platform.admin_actions%ROWTYPE;
    v_license platform.license_issuances%ROWTYPE;
BEGIN
    IF p_store_id IS NULL
       OR p_store_id IS DISTINCT FROM platform.current_store_id()
       OR p_license_id IS NULL
       OR p_operation_id IS NULL
       OR p_request_hash IS NULL
       OR p_request_hash !~ '^[0-9a-f]{64}$'
       OR p_reason IS NULL
       OR length(trim(p_reason)) = 0 THEN
        RAISE EXCEPTION 'S18.6 License revocation input is invalid'
            USING ERRCODE = '22023';
    END IF;

    v_actor_id := platform.current_user_id();
    IF v_actor_id IS NULL OR NOT ledger.current_actor_is_platform_admin() THEN
        RAISE EXCEPTION 'S18.6 License revocation requires an active Platform Admin'
            USING ERRCODE = '42501';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended('dokana:s18:offline-license-admin:' || p_operation_id::text, 0)
    );

    SELECT action_record.*
    INTO v_existing_action
    FROM platform.admin_actions AS action_record
    WHERE action_record.request_id = p_operation_id
    ORDER BY action_record.occurred_at, action_record.id
    LIMIT 1;

    IF FOUND THEN
        PERFORM ledger.lock_mutation_actor_v1('platform_admin');
        IF v_existing_action.admin_user_id IS DISTINCT FROM v_actor_id
           OR v_existing_action.store_id IS DISTINCT FROM p_store_id
           OR v_existing_action.action <> 'offline_license_revoked'
           OR v_existing_action.metadata->>'requestHash' IS DISTINCT FROM p_request_hash
           OR (v_existing_action.metadata #>> '{result,licenseId}')::uuid
                IS DISTINCT FROM p_license_id THEN
            RAISE EXCEPTION 'S18.6 administrative operation ID was reused with different semantics'
                USING ERRCODE = '23505';
        END IF;

        RETURN QUERY SELECT
            (v_existing_action.metadata #>> '{result,licenseId}')::uuid,
            (v_existing_action.metadata #>> '{result,revokedAt}')::timestamptz,
            v_existing_action.metadata #>> '{result,revokeReason}',
            true;
        RETURN;
    END IF;

    PERFORM 1
    FROM ledger.stores AS store_record
    WHERE store_record.id = p_store_id
    FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'S18.6 License revocation target is unavailable'
            USING ERRCODE = '42501';
    END IF;

    SELECT issuance.*
    INTO v_license
    FROM platform.license_issuances AS issuance
    WHERE issuance.store_id = p_store_id
      AND issuance.id = p_license_id
      AND issuance.signature <> ''
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'S18.6 License revocation target is unavailable'
            USING ERRCODE = 'P0002';
    END IF;
    PERFORM ledger.lock_mutation_actor_v1('platform_admin');

    IF v_license.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'S18.6 Offline License is already revoked'
            USING ERRCODE = '55000';
    END IF;

    UPDATE platform.license_issuances AS issuance
    SET revoked_at = v_now,
        revoke_reason = trim(p_reason)
    WHERE issuance.id = p_license_id
    RETURNING issuance.* INTO v_license;

    INSERT INTO platform.admin_actions (
        id,
        admin_user_id,
        store_id,
        action,
        reason,
        request_id,
        metadata,
        occurred_at
    ) VALUES (
        gen_random_uuid(),
        v_actor_id,
        p_store_id,
        'offline_license_revoked',
        trim(p_reason),
        p_operation_id,
        jsonb_build_object(
            'requestHash', p_request_hash,
            'previous', jsonb_build_object(
                'licenseId', v_license.id,
                'revokedAt', NULL,
                'revokeReason', NULL
            ),
            'current', jsonb_build_object(
                'licenseId', v_license.id,
                'revokedAt', v_license.revoked_at,
                'revokeReason', v_license.revoke_reason
            ),
            'result', jsonb_build_object(
                'licenseId', v_license.id,
                'revokedAt', v_license.revoked_at,
                'revokeReason', v_license.revoke_reason
            )
        ),
        v_now
    );

    RETURN QUERY SELECT
        v_license.id,
        v_license.revoked_at,
        v_license.revoke_reason,
        false;
END
$function$;

DO $postconditions$
DECLARE
    v_function record;
BEGIN
    FOR v_function IN
        SELECT oid, proowner, prosecdef, proconfig FROM pg_proc
        WHERE oid IN ('ledger.lock_mutation_actor_v1(text)'::regprocedure,
                      'ledger.prepare_offline_license(uuid,uuid,uuid,uuid,text,text)'::regprocedure,
                      'ledger.revoke_offline_license(uuid,uuid,uuid,text,text)'::regprocedure,
                      'ledger.manage_subscription_lifecycle(uuid,text,uuid,text,text)'::regprocedure,
                      'ledger.manage_store_lifecycle(uuid,text,bigint,uuid,text,text)'::regprocedure)
    LOOP
        IF pg_get_userbyid(v_function.proowner) <> 'shop_app_migrator'
           OR NOT v_function.prosecdef
           OR v_function.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
           OR NOT has_function_privilege('shop_app_runtime', v_function.oid, 'EXECUTE')
           OR has_function_privilege('shop_app_auth', v_function.oid, 'EXECUTE')
           OR has_function_privilege('shop_app_auth_owner', v_function.oid, 'EXECUTE')
           OR EXISTS (SELECT 1 FROM aclexplode(
               (SELECT proacl FROM pg_proc WHERE oid = v_function.oid))
               WHERE grantee = 0 AND privilege_type = 'EXECUTE') THEN
            RAISE EXCEPTION '0039 authority function security state is unexpected';
        END IF;
    END LOOP;
END
$postconditions$;
