-- Migration 0024: add the narrow S19.5 offline push authority.
--
-- This migration has two deliberately separate boundaries:
--   1. auth_api functions authenticate a real session or refresh credential for the
--      dedicated sync-push route, including a suspended (but never archived) Store;
--   2. sync/ledger functions validate and bind one historical offline operation to the
--      same PostgreSQL transaction that executes the existing domain authority.
--
-- Runtime receives EXECUTE only. It receives no direct platform, provenance, or accounting
-- table privileges. The xid8 binding is durable evidence but is usable only by the exact
-- operation in the transaction that created it.
--
-- Approved rollback: revoke the managed EXECUTE grants, drop the managed functions and
-- trigger, then drop sync.offline_operation_provenance_v1. Retain provenance after any
-- production push has been accepted.

DO $preconditions$
BEGIN
    IF session_user <> 'dokana_migration_login'
       OR current_user <> 'shop_app_migrator' THEN
        RAISE EXCEPTION '0024 requires the approved migration login and effective role';
    END IF;

    IF NOT pg_has_role('shop_app_migrator', 'shop_app_auth_owner', 'SET')
       OR NOT EXISTS (
            SELECT 1
            FROM pg_proc AS function_state
            JOIN pg_namespace AS namespace
              ON namespace.oid = function_state.pronamespace
            WHERE namespace.nspname = 'auth_api'
              AND function_state.proname = 'validate_session'
              AND pg_catalog.oidvectortypes(function_state.proargtypes)
                    = 'uuid, uuid, uuid, uuid, uuid'
       )
       OR to_regprocedure('ledger.lock_effective_entitlement(uuid)') IS NULL
       OR to_regprocedure('sync.claim_operation(uuid,uuid,uuid,text,uuid,text,text)') IS NULL
       OR to_regclass('platform.refresh_tokens') IS NULL
       OR to_regclass('platform.auth_sessions') IS NULL
       OR to_regclass('platform.license_issuances') IS NULL
       OR to_regclass('platform.subscriptions') IS NULL
       OR to_regclass('sync.processed_operations') IS NULL THEN
        RAISE EXCEPTION '0024 requires the verified authentication, License, and idempotency foundations';
    END IF;

    IF to_regclass('sync.offline_operation_provenance_v1') IS NOT NULL
       OR EXISTS (
            SELECT 1
            FROM pg_proc AS function_state
            JOIN pg_namespace AS namespace
              ON namespace.oid = function_state.pronamespace
            WHERE namespace.nspname = 'auth_api'
              AND function_state.proname IN (
                    'validate_sync_session', 'validate_sync_refresh_token'
              )
       )
       OR to_regprocedure('sync.begin_offline_operation_v1(uuid,uuid,uuid,text,bigint,text,uuid,uuid,bigint,timestamptz,timestamptz,timestamptz,text,text,timestamptz,uuid[])') IS NOT NULL
       OR to_regprocedure('sync.finish_offline_operation_v1(uuid,uuid,text,jsonb)') IS NOT NULL
       OR to_regprocedure('ledger.lock_business_write_authority_v1(uuid,uuid,text)') IS NOT NULL THEN
        RAISE EXCEPTION '0024 managed objects already exist';
    END IF;

    IF has_schema_privilege('shop_app_runtime', 'platform', 'USAGE')
       OR has_table_privilege('shop_app_runtime', 'platform.license_issuances', 'SELECT')
       OR has_table_privilege('shop_app_runtime', 'platform.subscriptions', 'SELECT') THEN
        RAISE EXCEPTION '0024 requires the verified runtime platform firewall';
    END IF;

    IF NOT (
        SELECT relrowsecurity AND relforcerowsecurity
        FROM pg_class WHERE oid = 'ledger.stores'::regclass
    ) OR NOT (
        SELECT relrowsecurity AND relforcerowsecurity
        FROM pg_class WHERE oid = 'ledger.devices'::regclass
    ) OR NOT (
        SELECT relrowsecurity AND relforcerowsecurity
        FROM pg_class WHERE oid = 'platform.subscriptions'::regclass
    ) OR NOT (
        SELECT relrowsecurity AND relforcerowsecurity
        FROM pg_class WHERE oid = 'platform.license_issuances'::regclass
    ) OR NOT (
        SELECT relrowsecurity AND relforcerowsecurity
        FROM pg_class WHERE oid = 'sync.processed_operations'::regclass
    ) THEN
        RAISE EXCEPTION '0024 requires forced RLS on every protected Store-scoped relation';
    END IF;
END
$preconditions$;

CREATE TABLE sync.offline_operation_provenance_v1 (
    store_id uuid NOT NULL REFERENCES ledger.stores(id) ON DELETE CASCADE,
    operation_id uuid NOT NULL,
    device_id uuid NOT NULL,
    local_sequence bigint NOT NULL CHECK (local_sequence > 0),
    operation_type text NOT NULL CHECK (
        operation_type ~ '^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+[.]v[1-9][0-9]*$'
    ),
    provenance_hash text NOT NULL CHECK (provenance_hash ~ '^[0-9a-f]{64}$'),
    canonical_request_hash text CHECK (
        canonical_request_hash IS NULL OR canonical_request_hash ~ '^[0-9a-f]{64}$'
    ),
    license_id uuid NOT NULL REFERENCES platform.license_issuances(id) ON DELETE RESTRICT,
    subscription_id uuid NOT NULL REFERENCES platform.subscriptions(id) ON DELETE RESTRICT,
    subscription_version bigint NOT NULL CHECK (subscription_version >= 1),
    client_recorded_at timestamptz NOT NULL,
    trusted_server_time timestamptz NOT NULL,
    observed_device_time timestamptz NOT NULL,
    clock_state text NOT NULL CHECK (clock_state IN ('trusted', 'clock_rollback_suspected')),
    known_store_status text NOT NULL CHECK (
        known_store_status IN ('active', 'read_only', 'suspended')
    ),
    known_store_status_at timestamptz NOT NULL,
    dependency_operation_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
    disposition text NOT NULL CHECK (disposition IN (
        'processing', 'applied', 'rejected', 'conflict',
        'quarantined', 'dependency_pending'
    )),
    reason_code text,
    response_body jsonb,
    authorized_user_id uuid,
    authorization_xid xid8,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz,
    PRIMARY KEY (store_id, operation_id),
    UNIQUE (store_id, device_id, local_sequence),
    FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON DELETE RESTRICT,
    CHECK (cardinality(dependency_operation_ids) <= 32),
    CHECK (array_position(dependency_operation_ids, operation_id) IS NULL),
    CHECK (response_body IS NULL OR jsonb_typeof(response_body) = 'object'),
    CHECK (
        (disposition = 'processing' AND authorization_xid IS NOT NULL
            AND authorized_user_id IS NOT NULL AND completed_at IS NULL)
        OR
        (disposition <> 'processing' AND authorization_xid IS NULL AND completed_at IS NOT NULL)
    )
);

CREATE INDEX idx_offline_operation_provenance_v1_license
ON sync.offline_operation_provenance_v1(store_id, license_id, client_recorded_at);

ALTER TABLE sync.offline_operation_provenance_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync.offline_operation_provenance_v1 FORCE ROW LEVEL SECURITY;
CREATE POLICY offline_operation_provenance_v1_store_isolation
ON sync.offline_operation_provenance_v1
USING (store_id = platform.current_store_id() OR current_user = 'shop_app_migrator')
WITH CHECK (store_id = platform.current_store_id() OR current_user = 'shop_app_migrator');

REVOKE ALL ON TABLE sync.offline_operation_provenance_v1
FROM PUBLIC, shop_app_runtime, shop_app_auth, shop_app_auth_owner;

CREATE FUNCTION sync.offline_operation_finished_at_commit_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM sync.offline_operation_provenance_v1 AS provenance
        WHERE provenance.store_id = NEW.store_id
          AND provenance.operation_id = NEW.operation_id
          AND provenance.disposition = 'processing'
    ) THEN
        RAISE EXCEPTION 'S19.5 offline operation transaction ended without a final outcome'
            USING ERRCODE = '55000';
    END IF;
    RETURN NULL;
END
$function$;

CREATE CONSTRAINT TRIGGER trg_offline_operation_finished_at_commit_v1
AFTER INSERT OR UPDATE ON sync.offline_operation_provenance_v1
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION sync.offline_operation_finished_at_commit_v1();

CREATE FUNCTION sync.begin_offline_operation_v1(
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
            WHEN bool_or(operation.status = 'rejected') THEN 'rejected'
            WHEN count(operation.operation_id) < cardinality(p_dependency_operation_ids)
                 OR bool_or(operation.status = 'processing') THEN 'dependency_pending'
            ELSE NULL
        END
        INTO v_dependency_status
        FROM unnest(p_dependency_operation_ids) AS dependency(operation_id)
        LEFT JOIN sync.processed_operations AS operation
          ON operation.store_id = p_store_id
         AND operation.operation_id = dependency.operation_id;
        IF v_dependency_status = 'rejected' THEN
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

CREATE FUNCTION ledger.lock_business_write_authority_v1(
    p_store_id uuid,
    p_operation_id uuid,
    p_operation_type text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_current record;
BEGIN
    SELECT entitlement.* INTO v_current
    FROM ledger.lock_effective_entitlement(p_store_id) AS entitlement;
    IF FOUND AND v_current.write_eligible THEN
        RETURN true;
    END IF;

    IF p_operation_id IS NULL OR p_operation_type IS NULL THEN
        RETURN false;
    END IF;

    RETURN EXISTS (
        SELECT 1
        FROM sync.offline_operation_provenance_v1 AS provenance
        WHERE provenance.store_id = p_store_id
          AND provenance.operation_id = p_operation_id
          AND provenance.operation_type = p_operation_type
          AND provenance.device_id = platform.current_device_id()
          AND provenance.authorized_user_id = platform.current_user_id()
          AND provenance.disposition = 'processing'
          AND provenance.authorization_xid = pg_current_xact_id()
    );
END
$function$;

CREATE FUNCTION sync.finish_offline_operation_v1(
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
        RAISE EXCEPTION 'S19.5 cannot reject an applied canonical operation'
            USING ERRCODE = '55000';
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
        COALESCE(v_operation.response_body, p_response_body);
END
$function$;

REVOKE ALL ON FUNCTION
    sync.offline_operation_finished_at_commit_v1(),
    sync.begin_offline_operation_v1(
        uuid, uuid, uuid, text, bigint, text, uuid, uuid, bigint,
        timestamptz, timestamptz, timestamptz, text, text, timestamptz, uuid[]
    ),
    ledger.lock_business_write_authority_v1(uuid, uuid, text),
    sync.finish_offline_operation_v1(uuid, uuid, text, jsonb)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
    sync.begin_offline_operation_v1(
        uuid, uuid, uuid, text, bigint, text, uuid, uuid, bigint,
        timestamptz, timestamptz, timestamptz, text, text, timestamptz, uuid[]
    ),
    ledger.lock_business_write_authority_v1(uuid, uuid, text),
    sync.finish_offline_operation_v1(uuid, uuid, text, jsonb)
TO shop_app_runtime;

DO $sync_postconditions$
DECLARE
    managed_function regprocedure;
BEGIN
    FOREACH managed_function IN ARRAY ARRAY[
        'sync.offline_operation_finished_at_commit_v1()'::regprocedure,
        'sync.begin_offline_operation_v1(uuid,uuid,uuid,text,bigint,text,uuid,uuid,bigint,timestamptz,timestamptz,timestamptz,text,text,timestamptz,uuid[])'::regprocedure,
        'ledger.lock_business_write_authority_v1(uuid,uuid,text)'::regprocedure,
        'sync.finish_offline_operation_v1(uuid,uuid,text,jsonb)'::regprocedure
    ] LOOP
        IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = managed_function)
                <> 'shop_app_migrator'
           OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = managed_function)
           OR (SELECT proconfig FROM pg_proc WHERE oid = managed_function)
                IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
           OR has_function_privilege('public', managed_function, 'EXECUTE') THEN
            RAISE EXCEPTION '0024 sync function ownership or security configuration is unsafe';
        END IF;
    END LOOP;

    IF NOT has_function_privilege(
            'shop_app_runtime',
            'sync.begin_offline_operation_v1(uuid,uuid,uuid,text,bigint,text,uuid,uuid,bigint,timestamptz,timestamptz,timestamptz,text,text,timestamptz,uuid[])',
            'EXECUTE'
       )
       OR NOT has_function_privilege(
            'shop_app_runtime', 'ledger.lock_business_write_authority_v1(uuid,uuid,text)',
            'EXECUTE'
       )
       OR NOT has_function_privilege(
            'shop_app_runtime', 'sync.finish_offline_operation_v1(uuid,uuid,text,jsonb)',
            'EXECUTE'
       )
       OR has_function_privilege(
            'shop_app_auth', 'ledger.lock_business_write_authority_v1(uuid,uuid,text)',
            'EXECUTE'
       )
       OR has_table_privilege(
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
            SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
            WHERE oid = 'sync.offline_operation_provenance_v1'::regclass
       ) THEN
        RAISE EXCEPTION '0024 broadened runtime authority or weakened provenance RLS';
    END IF;
END
$sync_postconditions$;

-- Authentication objects remain owned by the dedicated auth owner. Ordinary session and
-- refresh functions are intentionally untouched. The migration runner restores the approved
-- migrator role after this file finishes.
SET LOCAL ROLE shop_app_auth_owner;

CREATE FUNCTION auth_api.validate_sync_session(
    p_user_id uuid,
    p_session_id uuid,
    p_store_id uuid,
    p_device_id uuid
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
SET search_path = pg_catalog, pg_temp
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
    JOIN platform.users AS users
      ON users.id = sessions.user_id
     AND users.status = 'active'
    JOIN platform.store_memberships AS memberships
      ON memberships.user_id = users.id
     AND memberships.store_id = sessions.store_id
     AND memberships.status = 'active'
    JOIN ledger.stores AS stores
      ON stores.id = memberships.store_id
     AND stores.status IN ('active', 'read_only', 'suspended')
    JOIN ledger.devices AS devices
      ON devices.id = sessions.device_id
     AND devices.store_id = stores.id
     AND devices.status = 'active'
    WHERE sessions.id = p_session_id
      AND sessions.user_id = p_user_id
      AND sessions.store_id = p_store_id
      AND sessions.device_id = p_device_id
      AND sessions.revoked_at IS NULL
      AND sessions.expires_at > clock_timestamp();
END
$function$;

CREATE FUNCTION auth_api.validate_sync_refresh_token(p_token_hash text)
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
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
    IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH token_context AS (
        SELECT
            sessions.id AS session_id,
            sessions.user_id,
            sessions.store_id,
            sessions.device_id,
            sessions.expires_at AS session_expires_at
        FROM platform.refresh_tokens AS tokens
        JOIN platform.auth_sessions AS sessions ON sessions.id = tokens.session_id
        WHERE tokens.token_hash = p_token_hash
          AND tokens.used_at IS NULL
          AND tokens.replaced_by_id IS NULL
          AND tokens.revoked_at IS NULL
          AND tokens.expires_at > clock_timestamp()
          AND sessions.revoked_at IS NULL
          AND sessions.expires_at > clock_timestamp()
        LIMIT 1
    ), configured AS (
        SELECT
            context.*,
            pg_catalog.set_config('app.user_id', context.user_id::text, true) AS user_context,
            pg_catalog.set_config('app.store_id', context.store_id::text, true) AS store_context,
            pg_catalog.set_config('app.device_id', context.device_id::text, true) AS device_context
        FROM token_context AS context
    )
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
        configured.session_id,
        configured.session_expires_at
    FROM configured
    JOIN platform.users AS users
      ON users.id = configured.user_id
     AND users.status = 'active'
    JOIN platform.store_memberships AS memberships
      ON memberships.user_id = users.id
     AND memberships.store_id = configured.store_id
     AND memberships.status = 'active'
    JOIN ledger.stores AS stores
      ON stores.id = memberships.store_id
     AND stores.status IN ('active', 'read_only', 'suspended')
    JOIN ledger.devices AS devices
      ON devices.id = configured.device_id
     AND devices.store_id = stores.id
     AND devices.status = 'active';
END
$function$;

REVOKE ALL ON FUNCTION
    auth_api.validate_sync_session(uuid, uuid, uuid, uuid),
    auth_api.validate_sync_refresh_token(text)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
    auth_api.validate_sync_session(uuid, uuid, uuid, uuid),
    auth_api.validate_sync_refresh_token(text)
TO shop_app_auth;

DO $auth_postconditions$
DECLARE
    managed_function regprocedure;
BEGIN
    FOREACH managed_function IN ARRAY ARRAY[
        'auth_api.validate_sync_session(uuid,uuid,uuid,uuid)'::regprocedure,
        'auth_api.validate_sync_refresh_token(text)'::regprocedure
    ] LOOP
        IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = managed_function)
                <> 'shop_app_auth_owner'
           OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = managed_function)
           OR (SELECT proconfig FROM pg_proc WHERE oid = managed_function)
                IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
           OR has_function_privilege('public', managed_function, 'EXECUTE')
           OR NOT has_function_privilege('shop_app_auth', managed_function, 'EXECUTE')
           OR has_function_privilege('shop_app_runtime', managed_function, 'EXECUTE') THEN
            RAISE EXCEPTION '0024 sync-auth function ownership or grants are unsafe';
        END IF;
    END LOOP;

    IF has_table_privilege('shop_app_auth', 'platform.refresh_tokens', 'SELECT')
       OR has_table_privilege('shop_app_auth', 'platform.auth_sessions', 'SELECT')
       OR has_schema_privilege('shop_app_auth', 'platform', 'USAGE') THEN
        RAISE EXCEPTION '0024 broadened authentication execution-role privileges';
    END IF;
END
$auth_postconditions$;
