-- Migration 0021: add the narrow S18.6 Offline License database authority.
--
-- Runtime receives EXECUTE only on the managed SECURITY DEFINER functions below.
-- It receives no platform schema/table/sequence privilege. Issuance uses a two-step
-- prepare/complete protocol inside one outer application transaction so PostgreSQL
-- can choose authoritative timestamps and lock central state before the backend signs
-- the canonical payload. An incomplete signature can never commit.
--
-- Canonical issuance lock order:
--   1. operation advisory lock
--   2. ledger.stores row
--   3. platform.subscriptions row
--   4. ledger.devices row
--   5. latest platform.license_issuances row, when present
--
-- Approved rollback: revoke the five runtime EXECUTE grants and drop the five
-- functions. Existing License issuances, processed operations, and immutable
-- platform.admin_actions records must be retained.

DO $preconditions$
BEGIN
    IF session_user <> 'dokana_migration_login'
       OR current_user <> 'shop_app_migrator' THEN
        RAISE EXCEPTION '0021 requires the approved migration login and effective role';
    END IF;

    IF to_regprocedure('ledger.current_actor_is_platform_admin()') IS NULL
       OR to_regprocedure('ledger.lock_effective_entitlement(uuid)') IS NULL
       OR to_regprocedure('sync.claim_operation(uuid,uuid,uuid,text,uuid,text,text)') IS NULL
       OR to_regclass('ledger.stores') IS NULL
       OR to_regclass('ledger.devices') IS NULL
       OR to_regclass('platform.store_memberships') IS NULL
       OR to_regclass('platform.subscriptions') IS NULL
       OR to_regclass('platform.license_issuances') IS NULL
       OR to_regclass('platform.admin_actions') IS NULL
       OR to_regclass('sync.processed_operations') IS NULL THEN
        RAISE EXCEPTION '0021 requires the verified S18 and idempotency foundations';
    END IF;

    IF to_regprocedure('ledger.prepare_offline_license(uuid,uuid,uuid,uuid,text,text)') IS NOT NULL
       OR to_regprocedure('ledger.complete_offline_license(uuid,uuid,uuid,text,text)') IS NOT NULL
       OR to_regprocedure('ledger.read_offline_license_for_validation(uuid,uuid,uuid)') IS NOT NULL
       OR to_regprocedure('ledger.list_offline_licenses(uuid,integer)') IS NOT NULL
       OR to_regprocedure('ledger.revoke_offline_license(uuid,uuid,uuid,text,text)') IS NOT NULL THEN
        RAISE EXCEPTION '0021 managed functions already exist';
    END IF;

    IF has_schema_privilege('shop_app_runtime', 'platform', 'USAGE')
       OR has_table_privilege('shop_app_runtime', 'platform.license_issuances', 'SELECT')
       OR has_table_privilege('shop_app_runtime', 'platform.license_issuances', 'INSERT')
       OR has_table_privilege('shop_app_runtime', 'platform.license_issuances', 'UPDATE')
       OR has_sequence_privilege(
            'shop_app_runtime',
            'platform.license_issuances_license_serial_seq',
            'USAGE'
       ) THEN
        RAISE EXCEPTION '0021 requires the verified runtime platform firewall';
    END IF;

    IF NOT (
        SELECT relrowsecurity AND relforcerowsecurity
        FROM pg_class
        WHERE oid = 'ledger.stores'::regclass
    ) OR NOT (
        SELECT relrowsecurity AND relforcerowsecurity
        FROM pg_class
        WHERE oid = 'ledger.devices'::regclass
    ) OR NOT (
        SELECT relrowsecurity AND relforcerowsecurity
        FROM pg_class
        WHERE oid = 'platform.subscriptions'::regclass
    ) OR NOT (
        SELECT relrowsecurity AND relforcerowsecurity
        FROM pg_class
        WHERE oid = 'platform.license_issuances'::regclass
    ) OR NOT (
        SELECT relrowsecurity AND relforcerowsecurity
        FROM pg_class
        WHERE oid = 'sync.processed_operations'::regclass
    ) THEN
        RAISE EXCEPTION '0021 requires forced RLS on every managed Store-scoped table';
    END IF;
END
$preconditions$;

CREATE FUNCTION ledger.prepare_offline_license(
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

CREATE FUNCTION ledger.complete_offline_license(
    p_store_id uuid,
    p_license_id uuid,
    p_operation_id uuid,
    p_request_hash text,
    p_signature text
)
RETURNS TABLE (
    license_id uuid,
    signed_payload jsonb,
    signature text,
    key_id text,
    issued_at timestamptz,
    expires_at timestamptz,
    replayed boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_operation sync.processed_operations%ROWTYPE;
    v_license platform.license_issuances%ROWTYPE;
BEGIN
    IF p_store_id IS NULL
       OR p_store_id IS DISTINCT FROM platform.current_store_id()
       OR platform.current_user_id() IS NULL
       OR platform.current_device_id() IS NULL
       OR p_license_id IS NULL
       OR p_operation_id IS NULL
       OR p_request_hash IS NULL
       OR p_request_hash !~ '^[0-9a-f]{64}$'
       OR p_signature IS NULL
       OR p_signature !~ '^[A-Za-z0-9_-]{86}$' THEN
        RAISE EXCEPTION 'S18.6 Offline License completion input is invalid'
            USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended('dokana:s18:offline-license:' || p_operation_id::text, 0)
    );

    SELECT operation_record.*
    INTO v_operation
    FROM sync.processed_operations AS operation_record
    WHERE operation_record.store_id = p_store_id
      AND operation_record.operation_id = p_operation_id
    FOR UPDATE;

    IF NOT FOUND
       OR v_operation.device_id IS DISTINCT FROM platform.current_device_id()
       OR v_operation.aggregate_type <> 'offline_license'
       OR v_operation.aggregate_id IS DISTINCT FROM p_license_id
       OR v_operation.action <> 'issue'
       OR v_operation.request_hash IS DISTINCT FROM p_request_hash
       OR v_operation.status <> 'processing' THEN
        RAISE EXCEPTION 'S18.6 Offline License completion state is invalid'
            USING ERRCODE = '55000';
    END IF;

    SELECT issuance.*
    INTO v_license
    FROM platform.license_issuances AS issuance
    WHERE issuance.store_id = p_store_id
      AND issuance.device_id = platform.current_device_id()
      AND issuance.id = p_license_id
    FOR UPDATE;

    IF NOT FOUND OR v_license.signature <> '' THEN
        RAISE EXCEPTION 'S18.6 Offline License completion target is invalid'
            USING ERRCODE = '55000';
    END IF;

    UPDATE platform.license_issuances AS issuance
    SET signature = p_signature
    WHERE issuance.id = p_license_id
    RETURNING issuance.* INTO v_license;

    UPDATE sync.processed_operations AS operation_record
    SET status = 'applied',
        response_code = 200,
        response_body = jsonb_build_object(
            'licenseId', v_license.id,
            'signedPayload', v_license.signed_payload,
            'signature', v_license.signature,
            'keyId', v_license.key_id,
            'issuedAt', v_license.issued_at,
            'expiresAt', v_license.expires_at
        ),
        error_code = NULL,
        completed_at = clock_timestamp()
    WHERE operation_record.store_id = p_store_id
      AND operation_record.operation_id = p_operation_id;

    RETURN QUERY SELECT
        v_license.id,
        v_license.signed_payload,
        v_license.signature,
        v_license.key_id,
        v_license.issued_at,
        v_license.expires_at,
        false;
END
$function$;

CREATE FUNCTION ledger.read_offline_license_for_validation(
    p_store_id uuid,
    p_device_id uuid,
    p_license_id uuid
)
RETURNS TABLE (
    license_id uuid,
    device_id uuid,
    subscription_id uuid,
    signed_payload jsonb,
    signature text,
    key_id text,
    issued_at timestamptz,
    expires_at timestamptz,
    revoked_at timestamptz,
    revoke_reason text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
    IF p_store_id IS NULL
       OR p_store_id IS DISTINCT FROM platform.current_store_id()
       OR p_device_id IS NULL
       OR p_device_id IS DISTINCT FROM platform.current_device_id()
       OR platform.current_user_id() IS NULL
       OR p_license_id IS NULL THEN
        RAISE EXCEPTION 'S18.6 Offline License validation context is invalid'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
        issuance.id,
        issuance.device_id,
        issuance.subscription_id,
        issuance.signed_payload,
        issuance.signature,
        issuance.key_id,
        issuance.issued_at,
        issuance.expires_at,
        issuance.revoked_at,
        issuance.revoke_reason
    FROM platform.license_issuances AS issuance
    WHERE issuance.store_id = p_store_id
      AND issuance.device_id = p_device_id
      AND issuance.id = p_license_id
      AND issuance.signature <> '';
END
$function$;

CREATE FUNCTION ledger.list_offline_licenses(
    p_store_id uuid,
    p_limit integer
)
RETURNS TABLE (
    checked_at timestamptz,
    license_id uuid,
    device_id uuid,
    subscription_id uuid,
    key_id text,
    issued_at timestamptz,
    expires_at timestamptz,
    revoked_at timestamptz,
    revoke_reason text,
    license_status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_now timestamptz := clock_timestamp();
BEGIN
    IF p_store_id IS NULL
       OR p_store_id IS DISTINCT FROM platform.current_store_id()
       OR platform.current_user_id() IS NULL
       OR NOT ledger.current_actor_is_platform_admin() THEN
        RAISE EXCEPTION 'S18.6 License administration requires an active Platform Admin'
            USING ERRCODE = '42501';
    END IF;
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
        RAISE EXCEPTION 'S18.6 License list limit is invalid'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    SELECT
        v_now,
        issuance.id,
        issuance.device_id,
        issuance.subscription_id,
        issuance.key_id,
        issuance.issued_at,
        issuance.expires_at,
        issuance.revoked_at,
        issuance.revoke_reason,
        CASE
            WHEN issuance.revoked_at IS NOT NULL THEN 'revoked'
            WHEN v_now >= issuance.expires_at THEN 'expired'
            ELSE 'active'
        END
    FROM platform.license_issuances AS issuance
    WHERE issuance.store_id = p_store_id
      AND issuance.signature <> ''
    ORDER BY issuance.issued_at DESC, issuance.license_serial DESC
    LIMIT p_limit;
END
$function$;

CREATE FUNCTION ledger.revoke_offline_license(
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

REVOKE ALL ON FUNCTION
    ledger.prepare_offline_license(uuid, uuid, uuid, uuid, text, text),
    ledger.complete_offline_license(uuid, uuid, uuid, text, text),
    ledger.read_offline_license_for_validation(uuid, uuid, uuid),
    ledger.list_offline_licenses(uuid, integer),
    ledger.revoke_offline_license(uuid, uuid, uuid, text, text)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
    ledger.prepare_offline_license(uuid, uuid, uuid, uuid, text, text),
    ledger.complete_offline_license(uuid, uuid, uuid, text, text),
    ledger.read_offline_license_for_validation(uuid, uuid, uuid),
    ledger.list_offline_licenses(uuid, integer),
    ledger.revoke_offline_license(uuid, uuid, uuid, text, text)
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
            'ledger.prepare_offline_license(uuid,uuid,uuid,uuid,text,text)'::regprocedure,
            'ledger.complete_offline_license(uuid,uuid,uuid,text,text)'::regprocedure,
            'ledger.read_offline_license_for_validation(uuid,uuid,uuid)'::regprocedure,
            'ledger.list_offline_licenses(uuid,integer)'::regprocedure,
            'ledger.revoke_offline_license(uuid,uuid,uuid,text,text)'::regprocedure
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
            RAISE EXCEPTION '0021 managed function security configuration is unexpected';
        END IF;
    END LOOP;

    IF has_schema_privilege('shop_app_runtime', 'platform', 'USAGE')
       OR has_table_privilege('shop_app_runtime', 'platform.license_issuances', 'SELECT')
       OR has_table_privilege('shop_app_runtime', 'platform.license_issuances', 'INSERT')
       OR has_table_privilege('shop_app_runtime', 'platform.license_issuances', 'UPDATE')
       OR has_sequence_privilege(
            'shop_app_runtime',
            'platform.license_issuances_license_serial_seq',
            'USAGE'
       )
       OR NOT (
            SELECT relrowsecurity AND relforcerowsecurity
            FROM pg_class
            WHERE oid = 'platform.license_issuances'::regclass
       ) THEN
        RAISE EXCEPTION '0021 broadened runtime authority or weakened License RLS';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'platform.admin_actions'::regclass
          AND tgname = 'trg_admin_actions_immutable'
          AND tgenabled = 'O'
          AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION '0021 requires immutable administrative history';
    END IF;
END
$postconditions$;
