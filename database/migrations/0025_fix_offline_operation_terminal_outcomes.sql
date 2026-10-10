-- Migration 0025: correct terminal dependency and changed-replay outcomes for S19.5.
--
-- Migration 0024 remains immutable. This migration replaces only its begin/finish
-- authorities, preserving ownership, signatures, transaction binding, RLS, and grants.

DO $preconditions$
DECLARE
    managed_function regprocedure;
BEGIN
    IF session_user <> 'dokana_migration_login'
       OR current_user <> 'shop_app_migrator' THEN
        RAISE EXCEPTION '0025 requires the approved migration login and effective role';
    END IF;

    IF to_regclass('sync.offline_operation_provenance_v1') IS NULL
       OR to_regclass('sync.processed_operations') IS NULL
       OR to_regprocedure('sync.begin_offline_operation_v1(uuid,uuid,uuid,text,bigint,text,uuid,uuid,bigint,timestamptz,timestamptz,timestamptz,text,text,timestamptz,uuid[])') IS NULL
       OR to_regprocedure('sync.finish_offline_operation_v1(uuid,uuid,text,jsonb)') IS NULL THEN
        RAISE EXCEPTION '0025 requires the applied 0024 offline-operation authority';
    END IF;

    FOREACH managed_function IN ARRAY ARRAY[
        'sync.begin_offline_operation_v1(uuid,uuid,uuid,text,bigint,text,uuid,uuid,bigint,timestamptz,timestamptz,timestamptz,text,text,timestamptz,uuid[])'::regprocedure,
        'sync.finish_offline_operation_v1(uuid,uuid,text,jsonb)'::regprocedure
    ] LOOP
        IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = managed_function)
                <> 'shop_app_migrator'
           OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = managed_function)
           OR (SELECT proconfig FROM pg_proc WHERE oid = managed_function)
                IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
           OR has_function_privilege('public', managed_function, 'EXECUTE')
           OR NOT has_function_privilege('shop_app_runtime', managed_function, 'EXECUTE') THEN
            RAISE EXCEPTION '0025 found unexpected 0024 function security configuration';
        END IF;
    END LOOP;

    IF NOT (
        SELECT relrowsecurity AND relforcerowsecurity
        FROM pg_class
        WHERE oid = 'sync.offline_operation_provenance_v1'::regclass
    ) OR has_table_privilege(
        'shop_app_runtime', 'sync.offline_operation_provenance_v1', 'SELECT'
    ) THEN
        RAISE EXCEPTION '0025 requires the verified provenance RLS and privilege boundary';
    END IF;
END
$preconditions$;

CREATE OR REPLACE FUNCTION sync.begin_offline_operation_v1(
    p_store_id uuid,
    p_device_id uuid,
    p_operation_id uuid,
    p_operation_type text,
    p_local_sequence bigint,
    p_provenance_hash text,
    p_license_id uuid,
    p_subscription_id uuid,
    p_subscription_version bigint,
    p_client_recorded_at timestamptz,
    p_trusted_server_time timestamptz,
    p_observed_device_time timestamptz,
    p_clock_state text,
    p_known_store_status text,
    p_known_store_status_at timestamptz,
    p_dependency_operation_ids uuid[]
)
RETURNS TABLE (
    disposition text,
    reason_code text,
    response_body jsonb,
    processed_operation_preexisted boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_user_id uuid;
    v_store ledger.stores%ROWTYPE;
    v_device ledger.devices%ROWTYPE;
    v_license platform.license_issuances%ROWTYPE;
    v_subscription platform.subscriptions%ROWTYPE;
    v_existing sync.offline_operation_provenance_v1%ROWTYPE;
    v_sequence sync.offline_operation_provenance_v1%ROWTYPE;
    v_dependency_status text;
    v_disposition text;
    v_reason text;
    v_processed_preexisted boolean;
    v_payload_subscription_version bigint;
BEGIN
    v_user_id := platform.current_user_id();
    IF p_store_id IS NULL
       OR p_store_id IS DISTINCT FROM platform.current_store_id()
       OR p_device_id IS NULL
       OR p_device_id IS DISTINCT FROM platform.current_device_id()
       OR v_user_id IS NULL
       OR p_operation_id IS NULL
       OR p_operation_type IS NULL
       OR p_local_sequence IS NULL OR p_local_sequence <= 0
       OR p_provenance_hash IS NULL OR p_provenance_hash !~ '^[0-9a-f]{64}$'
       OR p_license_id IS NULL
       OR p_subscription_id IS NULL
       OR p_subscription_version IS NULL OR p_subscription_version < 1
       OR p_client_recorded_at IS NULL
       OR p_trusted_server_time IS NULL
       OR p_observed_device_time IS NULL
       OR p_clock_state NOT IN ('trusted', 'clock_rollback_suspected')
       OR p_known_store_status NOT IN ('active', 'read_only', 'suspended')
       OR p_known_store_status_at IS NULL
       OR p_dependency_operation_ids IS NULL
       OR cardinality(p_dependency_operation_ids) > 32
       OR p_operation_id = ANY(p_dependency_operation_ids)
       OR p_operation_type NOT IN (
            'customers.create.v1', 'customers.update.v1',
            'suppliers.create.v1', 'suppliers.update.v1',
            'products.create.v1', 'products.update.v1',
            'product_units.create.v1', 'product_units.update.v1',
            'owner_contributions.post.v1', 'owner_loans.post.v1',
            'owner_reimbursements.post.v1', 'owner_personal_withdrawals.post.v1',
            'owner_capital_withdrawals.post.v1', 'owner_events.reverse.v1',
            'owner_events.replace.v1', 'money_transfers.post.v1',
            'money_transfers.reverse.v1', 'money_transfers.replace.v1',
            'inventory.opening.post.v1', 'inventory.increase.post.v1',
            'inventory.decrease.post.v1', 'inventory.corrections.post.v1',
            'stock_counts.post.v1', 'supplier_invoices.post.v1',
            'supplier_invoices.cancel.v1', 'supplier_invoices.edit.v1',
            'supplier_payments.post.v1', 'supplier_payments.cancel.v1',
            'supplier_payments.edit.v1', 'supplier_returns.post.v1',
            'supplier_credits.apply.v1', 'supplier_refunds.post.v1',
            'supplier_returns.cancel.v1', 'supplier_returns.replace.v1',
            'supplier_credits.cancel.v1', 'supplier_credits.replace.v1',
            'supplier_refunds.cancel.v1', 'supplier_refunds.replace.v1',
            'sales.post.v1', 'sales.cancel.v1', 'sales.edit.v1',
            'customer_collections.post.v1', 'customer_collections.cancel.v1',
            'customer_collections.edit.v1', 'customer_credits.apply.v1',
            'customer_credits.apply_cancel.v1', 'customer_credits.apply_edit.v1',
            'customer_credits.refund.v1', 'customer_credits.refund_cancel.v1',
            'customer_credits.refund_edit.v1', 'customer_settlements.post.v1',
            'customer_settlements.cancel.v1', 'customer_settlements.edit.v1',
            'expenses.post.v1', 'expense_payments.post.v1',
            'expenses.cancel.v1', 'expenses.edit.v1',
            'expense_payments.cancel.v1', 'expense_payments.edit.v1',
            'sale_returns.post.v1', 'sale_returns.cancel.v1', 'sale_returns.replace.v1'
       ) THEN
        RAISE EXCEPTION 'S19.5 offline operation context or input is invalid'
            USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended('dokana:s19:offline-operation:' || p_store_id::text || ':' || p_operation_id::text, 0)
    );
    PERFORM pg_advisory_xact_lock(
        hashtextextended('dokana:s19:offline-sequence:' || p_store_id::text || ':'
            || p_device_id::text || ':' || p_local_sequence::text, 0)
    );

    SELECT provenance.* INTO v_existing
    FROM sync.offline_operation_provenance_v1 AS provenance
    WHERE provenance.store_id = p_store_id
      AND provenance.operation_id = p_operation_id
    FOR UPDATE;

    IF FOUND THEN
        IF v_existing.device_id IS DISTINCT FROM p_device_id
           OR v_existing.local_sequence IS DISTINCT FROM p_local_sequence
           OR v_existing.operation_type IS DISTINCT FROM p_operation_type
           OR v_existing.provenance_hash IS DISTINCT FROM p_provenance_hash
           OR v_existing.license_id IS DISTINCT FROM p_license_id
           OR v_existing.subscription_id IS DISTINCT FROM p_subscription_id
           OR v_existing.subscription_version IS DISTINCT FROM p_subscription_version
           OR v_existing.client_recorded_at IS DISTINCT FROM p_client_recorded_at
           OR v_existing.trusted_server_time IS DISTINCT FROM p_trusted_server_time
           OR v_existing.observed_device_time IS DISTINCT FROM p_observed_device_time
           OR v_existing.clock_state IS DISTINCT FROM p_clock_state
           OR v_existing.known_store_status IS DISTINCT FROM p_known_store_status
           OR v_existing.known_store_status_at IS DISTINCT FROM p_known_store_status_at
           OR v_existing.dependency_operation_ids IS DISTINCT FROM p_dependency_operation_ids THEN
            RETURN QUERY SELECT 'conflict'::text, 'OFFLINE_OPERATION_ID_CONFLICT'::text,
                NULL::jsonb, false;
            RETURN;
        END IF;
        IF v_existing.disposition <> 'dependency_pending' THEN
            RETURN QUERY SELECT
                CASE WHEN v_existing.disposition = 'applied' THEN 'exact_replay'
                     ELSE v_existing.disposition END,
                v_existing.reason_code,
                COALESCE(
                    (SELECT operation.response_body
                     FROM sync.processed_operations AS operation
                     WHERE operation.store_id = p_store_id
                       AND operation.operation_id = p_operation_id),
                    v_existing.response_body
                ),
                true;
            RETURN;
        END IF;
    END IF;

    SELECT provenance.* INTO v_sequence
    FROM sync.offline_operation_provenance_v1 AS provenance
    WHERE provenance.store_id = p_store_id
      AND provenance.device_id = p_device_id
      AND provenance.local_sequence = p_local_sequence
    FOR UPDATE;
    IF FOUND AND v_sequence.operation_id IS DISTINCT FROM p_operation_id THEN
        RETURN QUERY SELECT 'conflict'::text, 'OFFLINE_LOCAL_SEQUENCE_CONFLICT'::text,
            NULL::jsonb, false;
        RETURN;
    END IF;

    SELECT store_record.* INTO v_store
    FROM ledger.stores AS store_record
    WHERE store_record.id = p_store_id
    FOR SHARE;
    IF NOT FOUND OR v_store.status = 'archived' THEN
        v_disposition := 'rejected';
        v_reason := 'OFFLINE_STORE_UNAVAILABLE';
    END IF;

    IF v_disposition IS NULL AND NOT EXISTS (
        SELECT 1 FROM platform.store_memberships AS membership
        WHERE membership.store_id = p_store_id
          AND membership.user_id = v_user_id
          AND membership.status = 'active'
          AND membership.role = 'owner'
    ) THEN
        v_disposition := 'rejected';
        v_reason := 'OFFLINE_ACTOR_NOT_ALLOWED';
    END IF;

    IF v_disposition IS NULL THEN
        SELECT device_record.* INTO v_device
        FROM ledger.devices AS device_record
        WHERE device_record.store_id = p_store_id
          AND device_record.id = p_device_id
        FOR SHARE;
        IF NOT FOUND OR v_device.status <> 'active' THEN
            v_disposition := 'rejected';
            v_reason := 'OFFLINE_DEVICE_UNAVAILABLE';
        END IF;
    END IF;

    IF v_disposition IS NULL THEN
        SELECT issuance.* INTO v_license
        FROM platform.license_issuances AS issuance
        WHERE issuance.id = p_license_id
          AND issuance.store_id = p_store_id
          AND issuance.device_id = p_device_id
          AND issuance.subscription_id = p_subscription_id
          AND issuance.signature <> ''
        FOR SHARE;
        IF NOT FOUND THEN
            v_disposition := 'rejected';
            v_reason := 'OFFLINE_LICENSE_INVALID';
        ELSIF v_license.revoked_at IS NOT NULL THEN
            v_disposition := 'rejected';
            v_reason := 'OFFLINE_LICENSE_REVOKED';
        ELSE
            BEGIN
                v_payload_subscription_version :=
                    (v_license.signed_payload->>'subscriptionVersion')::bigint;
            EXCEPTION WHEN OTHERS THEN
                v_payload_subscription_version := NULL;
            END;
            IF v_license.signed_payload->>'licenseId' IS DISTINCT FROM p_license_id::text
               OR v_license.signed_payload->>'storeId' IS DISTINCT FROM p_store_id::text
               OR v_license.signed_payload->>'deviceId' IS DISTINCT FROM p_device_id::text
               OR v_license.signed_payload->>'subscriptionId' IS DISTINCT FROM p_subscription_id::text
               OR v_payload_subscription_version IS DISTINCT FROM p_subscription_version THEN
                v_disposition := 'rejected';
                v_reason := 'OFFLINE_LICENSE_BINDING_INVALID';
            END IF;
        END IF;
    END IF;

    IF v_disposition IS NULL THEN
        SELECT subscription.* INTO v_subscription
        FROM platform.subscriptions AS subscription
        WHERE subscription.id = p_subscription_id
          AND subscription.store_id = p_store_id
        FOR SHARE;
        IF NOT FOUND OR v_subscription.version < p_subscription_version THEN
            v_disposition := 'rejected';
            v_reason := 'OFFLINE_SUBSCRIPTION_EVIDENCE_INVALID';
        END IF;
    END IF;

    IF v_disposition IS NULL AND p_clock_state = 'clock_rollback_suspected' THEN
        v_disposition := 'quarantined';
        v_reason := 'OFFLINE_CLOCK_ROLLBACK_SUSPECTED';
    END IF;
    IF v_disposition IS NULL AND (
        p_trusted_server_time IS DISTINCT FROM v_license.issued_at
        OR p_observed_device_time IS DISTINCT FROM p_client_recorded_at
        OR p_known_store_status_at > p_client_recorded_at
        OR p_client_recorded_at < v_license.issued_at
        OR p_client_recorded_at >= v_license.expires_at
    ) THEN
        v_disposition := 'rejected';
        v_reason := 'OFFLINE_CREATION_OUTSIDE_LICENSE';
    END IF;
    IF v_disposition IS NULL AND p_known_store_status = 'suspended' THEN
        v_disposition := 'rejected';
        v_reason := 'OFFLINE_CREATED_AFTER_KNOWN_SUSPENSION';
    END IF;

    IF v_disposition IS NULL AND cardinality(p_dependency_operation_ids) > 0 THEN
        SELECT CASE
            WHEN bool_or(provenance.disposition = 'quarantined') THEN 'quarantined'
            WHEN bool_or(provenance.disposition = 'conflict') THEN 'conflict'
            WHEN bool_or(
                provenance.disposition = 'rejected' OR operation.status = 'rejected'
            ) THEN 'rejected'
            WHEN bool_and(
                operation.status = 'applied'
                AND (provenance.operation_id IS NULL OR provenance.disposition = 'applied')
            ) THEN NULL
            ELSE 'dependency_pending'
        END
        INTO v_dependency_status
        FROM unnest(p_dependency_operation_ids) AS dependency(operation_id)
        LEFT JOIN sync.processed_operations AS operation
          ON operation.store_id = p_store_id
         AND operation.operation_id = dependency.operation_id
        LEFT JOIN sync.offline_operation_provenance_v1 AS provenance
          ON provenance.store_id = p_store_id
         AND provenance.operation_id = dependency.operation_id;

        IF v_dependency_status = 'quarantined' THEN
            v_disposition := 'quarantined';
            v_reason := 'OFFLINE_DEPENDENCY_QUARANTINED';
        ELSIF v_dependency_status = 'conflict' THEN
            v_disposition := 'conflict';
            v_reason := 'OFFLINE_DEPENDENCY_CONFLICT';
        ELSIF v_dependency_status = 'rejected' THEN
            v_disposition := 'rejected';
            v_reason := 'OFFLINE_DEPENDENCY_REJECTED';
        ELSIF v_dependency_status = 'dependency_pending' THEN
            v_disposition := 'dependency_pending';
            v_reason := 'OFFLINE_DEPENDENCY_PENDING';
        END IF;
    END IF;

    v_processed_preexisted := EXISTS (
        SELECT 1 FROM sync.processed_operations AS operation
        WHERE operation.store_id = p_store_id
          AND operation.operation_id = p_operation_id
    );
    v_disposition := COALESCE(v_disposition, 'processing');

    INSERT INTO sync.offline_operation_provenance_v1 (
        store_id, operation_id, device_id, local_sequence, operation_type,
        provenance_hash, license_id, subscription_id, subscription_version,
        client_recorded_at, trusted_server_time, observed_device_time, clock_state,
        known_store_status, known_store_status_at, dependency_operation_ids,
        disposition, reason_code, authorized_user_id, authorization_xid, completed_at
    ) VALUES (
        p_store_id, p_operation_id, p_device_id, p_local_sequence, p_operation_type,
        p_provenance_hash, p_license_id, p_subscription_id, p_subscription_version,
        p_client_recorded_at, p_trusted_server_time, p_observed_device_time, p_clock_state,
        p_known_store_status, p_known_store_status_at, p_dependency_operation_ids,
        v_disposition, v_reason,
        CASE WHEN v_disposition = 'processing' THEN v_user_id ELSE NULL END,
        CASE WHEN v_disposition = 'processing' THEN pg_current_xact_id() ELSE NULL END,
        CASE WHEN v_disposition = 'processing' THEN NULL ELSE clock_timestamp() END
    )
    ON CONFLICT (store_id, operation_id) DO UPDATE
    SET disposition = EXCLUDED.disposition,
        reason_code = EXCLUDED.reason_code,
        authorized_user_id = EXCLUDED.authorized_user_id,
        authorization_xid = EXCLUDED.authorization_xid,
        completed_at = EXCLUDED.completed_at;

    RETURN QUERY SELECT
        CASE WHEN v_disposition = 'processing' THEN 'authorized' ELSE v_disposition END,
        v_reason,
        NULL::jsonb,
        v_processed_preexisted;
END
$function$;

CREATE OR REPLACE FUNCTION sync.finish_offline_operation_v1(
    p_store_id uuid,
    p_operation_id uuid,
    p_disposition text,
    p_response_body jsonb
)
RETURNS TABLE (
    disposition text,
    canonical_request_hash text,
    response_body jsonb
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_provenance sync.offline_operation_provenance_v1%ROWTYPE;
    v_operation sync.processed_operations%ROWTYPE;
    v_final_disposition text;
BEGIN
    IF p_store_id IS NULL
       OR p_store_id IS DISTINCT FROM platform.current_store_id()
       OR p_operation_id IS NULL
       OR p_disposition NOT IN ('applied', 'rejected', 'conflict', 'quarantined')
       OR p_response_body IS NULL
       OR jsonb_typeof(p_response_body) <> 'object' THEN
        RAISE EXCEPTION 'S19.5 offline operation completion input is invalid'
            USING ERRCODE = '22023';
    END IF;

    SELECT provenance.* INTO v_provenance
    FROM sync.offline_operation_provenance_v1 AS provenance
    WHERE provenance.store_id = p_store_id
      AND provenance.operation_id = p_operation_id
    FOR UPDATE;

    IF NOT FOUND
       OR v_provenance.disposition <> 'processing'
       OR v_provenance.authorization_xid IS DISTINCT FROM pg_current_xact_id()
       OR v_provenance.authorized_user_id IS DISTINCT FROM platform.current_user_id()
       OR v_provenance.device_id IS DISTINCT FROM platform.current_device_id() THEN
        RAISE EXCEPTION 'S19.5 offline operation completion authority is invalid'
            USING ERRCODE = '42501';
    END IF;

    SELECT operation.* INTO v_operation
    FROM sync.processed_operations AS operation
    WHERE operation.store_id = p_store_id
      AND operation.operation_id = p_operation_id
    FOR SHARE;

    IF p_disposition = 'applied' THEN
        IF NOT FOUND OR v_operation.status <> 'applied' THEN
            RAISE EXCEPTION 'S19.5 applied outcome requires the canonical processed operation'
                USING ERRCODE = '55000';
        END IF;
        v_final_disposition := 'applied';
    ELSIF FOUND AND v_operation.status = 'applied' THEN
        IF p_disposition = 'conflict'
           AND p_response_body->>'code' = 'OPERATION_ID_CONFLICT' THEN
            v_final_disposition := 'conflict';
        ELSE
            RAISE EXCEPTION 'S19.5 cannot reject an applied canonical operation'
                USING ERRCODE = '55000';
        END IF;
    ELSE
        v_final_disposition := p_disposition;
    END IF;

    UPDATE sync.offline_operation_provenance_v1 AS provenance
    SET disposition = v_final_disposition,
        reason_code = CASE
            WHEN v_final_disposition = 'applied' THEN NULL
            ELSE COALESCE(p_response_body->>'code', upper(v_final_disposition))
        END,
        response_body = p_response_body,
        canonical_request_hash = v_operation.request_hash,
        authorized_user_id = NULL,
        authorization_xid = NULL,
        completed_at = clock_timestamp()
    WHERE provenance.store_id = p_store_id
      AND provenance.operation_id = p_operation_id;

    RETURN QUERY SELECT
        v_final_disposition,
        v_operation.request_hash,
        CASE
            WHEN v_final_disposition = 'conflict' AND v_operation.status = 'applied'
                THEN p_response_body
            ELSE COALESCE(v_operation.response_body, p_response_body)
        END;
END
$function$;

DO $postconditions$
DECLARE
    managed_function regprocedure;
BEGIN
    FOREACH managed_function IN ARRAY ARRAY[
        'sync.begin_offline_operation_v1(uuid,uuid,uuid,text,bigint,text,uuid,uuid,bigint,timestamptz,timestamptz,timestamptz,text,text,timestamptz,uuid[])'::regprocedure,
        'sync.finish_offline_operation_v1(uuid,uuid,text,jsonb)'::regprocedure
    ] LOOP
        IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = managed_function)
                <> 'shop_app_migrator'
           OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = managed_function)
           OR (SELECT proconfig FROM pg_proc WHERE oid = managed_function)
                IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
           OR has_function_privilege('public', managed_function, 'EXECUTE')
           OR NOT has_function_privilege('shop_app_runtime', managed_function, 'EXECUTE')
           OR has_function_privilege('shop_app_auth', managed_function, 'EXECUTE')
           OR has_function_privilege('shop_app_auth_owner', managed_function, 'EXECUTE') THEN
            RAISE EXCEPTION '0025 changed offline-operation ownership or execution grants';
        END IF;
    END LOOP;

    IF has_table_privilege(
            'shop_app_runtime', 'sync.offline_operation_provenance_v1', 'SELECT'
       )
       OR has_table_privilege(
            'shop_app_runtime', 'sync.offline_operation_provenance_v1', 'INSERT'
       )
       OR has_table_privilege(
            'shop_app_runtime', 'sync.offline_operation_provenance_v1', 'UPDATE'
       )
       OR has_schema_privilege('shop_app_runtime', 'platform', 'USAGE')
       OR NOT (
            SELECT relrowsecurity AND relforcerowsecurity
            FROM pg_class
            WHERE oid = 'sync.offline_operation_provenance_v1'::regclass
       ) THEN
        RAISE EXCEPTION '0025 broadened runtime authority or weakened provenance RLS';
    END IF;
END
$postconditions$;
