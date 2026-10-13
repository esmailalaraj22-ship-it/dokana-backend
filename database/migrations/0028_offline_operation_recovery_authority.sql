-- S19.7: durable, Store-scoped offline-operation inspection and recovery authority.
--
-- The canonical business-effect idempotency authority remains sync.processed_operations.
-- Recovery only re-authorizes the immutable original envelope for the existing typed
-- domain dispatcher; it contains no accounting or inventory mutation logic.

DO $preconditions$
DECLARE
    begin_v1 regprocedure :=
        'sync.begin_offline_operation_v1(uuid,uuid,uuid,text,bigint,text,uuid,uuid,bigint,timestamptz,timestamptz,timestamptz,text,text,timestamptz,uuid[])'::regprocedure;
    finish_v1 regprocedure :=
        'sync.finish_offline_operation_v1(uuid,uuid,text,jsonb)'::regprocedure;
BEGIN
    IF session_user <> 'dokana_migration_login'
       OR current_user <> 'shop_app_migrator' THEN
        RAISE EXCEPTION '0028 requires the approved migration login and effective role';
    END IF;

    IF to_regclass('sync.offline_operation_provenance_v1') IS NULL
       OR to_regclass('sync.processed_operations') IS NULL
       OR to_regclass('sync.offline_operation_recovery_events_v1') IS NOT NULL
       OR begin_v1 IS NULL
       OR finish_v1 IS NULL THEN
        RAISE EXCEPTION '0028 found an unexpected offline-operation foundation';
    END IF;

    IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = begin_v1)
            <> 'shop_app_migrator'
       OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = begin_v1)
       OR (SELECT proconfig FROM pg_proc WHERE oid = begin_v1)
            IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
       OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = finish_v1)
            <> 'shop_app_migrator'
       OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = finish_v1)
       OR (SELECT proconfig FROM pg_proc WHERE oid = finish_v1)
            IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[] THEN
        RAISE EXCEPTION '0028 requires the verified 0026 offline-operation authority';
    END IF;

    IF NOT (
        SELECT relrowsecurity AND relforcerowsecurity
        FROM pg_class
        WHERE oid = 'sync.offline_operation_provenance_v1'::regclass
    ) OR has_table_privilege(
        'shop_app_runtime', 'sync.offline_operation_provenance_v1', 'SELECT'
    ) OR has_table_privilege(
        'shop_app_runtime', 'sync.offline_operation_provenance_v1', 'UPDATE'
    ) THEN
        RAISE EXCEPTION '0028 requires the verified provenance RLS and privilege boundary';
    END IF;
END
$preconditions$;

CREATE TABLE sync.offline_operation_recovery_events_v1 (
    store_id uuid NOT NULL,
    recovery_attempt_id uuid NOT NULL,
    event_sequence smallint NOT NULL CHECK (event_sequence IN (1, 2)),
    operation_id uuid NOT NULL,
    provenance_hash text NOT NULL CHECK (provenance_hash ~ '^[0-9a-f]{64}$'),
    original_quarantine_reason text,
    event_type text NOT NULL CHECK (event_type IN ('began', 'completed')),
    result_status text CHECK (result_status IS NULL OR result_status IN (
        'applied', 'exact_replay', 'rejected',
        'dependency_pending', 'conflict', 'quarantined'
    )),
    reason_code text,
    response_body jsonb,
    recovery_policy_version smallint NOT NULL DEFAULT 1
        CHECK (recovery_policy_version = 1),
    authorized_user_id uuid NOT NULL REFERENCES platform.users(id) ON DELETE RESTRICT,
    authorization_xid xid8,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (store_id, recovery_attempt_id, event_sequence),
    FOREIGN KEY (store_id, operation_id)
        REFERENCES sync.offline_operation_provenance_v1(store_id, operation_id)
        ON DELETE RESTRICT,
    CHECK (response_body IS NULL OR jsonb_typeof(response_body) = 'object'),
    CHECK (
        (event_sequence = 1 AND event_type = 'began'
            AND result_status IS NULL AND reason_code IS NULL
            AND response_body IS NULL AND authorization_xid IS NOT NULL)
        OR
        (event_sequence = 2 AND event_type = 'completed'
            AND result_status IS NOT NULL AND authorization_xid IS NULL)
    )
);

CREATE INDEX idx_offline_operation_recovery_events_v1_operation
ON sync.offline_operation_recovery_events_v1(
    store_id, operation_id, recorded_at, recovery_attempt_id
);

ALTER TABLE sync.offline_operation_recovery_events_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync.offline_operation_recovery_events_v1 FORCE ROW LEVEL SECURITY;
CREATE POLICY offline_operation_recovery_events_v1_store_isolation
ON sync.offline_operation_recovery_events_v1
USING (store_id = platform.current_store_id() OR current_user = 'shop_app_migrator')
WITH CHECK (store_id = platform.current_store_id() OR current_user = 'shop_app_migrator');

REVOKE ALL ON TABLE sync.offline_operation_recovery_events_v1
FROM PUBLIC, shop_app_runtime, shop_app_auth, shop_app_auth_owner;

CREATE FUNCTION sync.reject_offline_recovery_event_mutation_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
    RAISE EXCEPTION 'Offline operation recovery events are immutable'
        USING ERRCODE = '55000';
END
$function$;

CREATE TRIGGER trg_offline_operation_recovery_events_v1_immutable
BEFORE UPDATE OR DELETE ON sync.offline_operation_recovery_events_v1
FOR EACH ROW EXECUTE FUNCTION sync.reject_offline_recovery_event_mutation_v1();

CREATE FUNCTION sync.offline_recovery_finished_at_commit_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
    IF NEW.event_sequence = 1 AND NOT EXISTS (
        SELECT 1
        FROM sync.offline_operation_recovery_events_v1 AS completed
        WHERE completed.store_id = NEW.store_id
          AND completed.recovery_attempt_id = NEW.recovery_attempt_id
          AND completed.event_sequence = 2
    ) THEN
        RAISE EXCEPTION 'S19.7 recovery transaction ended without a final outcome'
            USING ERRCODE = '55000';
    END IF;
    RETURN NULL;
END
$function$;

CREATE CONSTRAINT TRIGGER trg_offline_recovery_finished_at_commit_v1
AFTER INSERT ON sync.offline_operation_recovery_events_v1
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION sync.offline_recovery_finished_at_commit_v1();

CREATE FUNCTION sync.offline_dependency_cycle_v1(
    p_store_id uuid,
    p_operation_id uuid,
    p_dependency_operation_ids uuid[]
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
    WITH RECURSIVE dependency_walk(operation_id, path, depth, cycle) AS (
        SELECT dependency.operation_id,
               ARRAY[p_operation_id, dependency.operation_id]::uuid[],
               1,
               dependency.operation_id = p_operation_id
        FROM unnest(p_dependency_operation_ids) AS dependency(operation_id)

        UNION ALL

        SELECT child.operation_id,
               walk.path || child.operation_id,
               walk.depth + 1,
               child.operation_id = ANY(walk.path)
        FROM dependency_walk AS walk
        JOIN sync.offline_operation_provenance_v1 AS provenance
          ON provenance.store_id = p_store_id
         AND provenance.operation_id = walk.operation_id
        CROSS JOIN LATERAL unnest(provenance.dependency_operation_ids)
          AS child(operation_id)
        WHERE NOT walk.cycle
          AND walk.depth < 256
    )
    SELECT COALESCE(
        bool_or(
            cycle OR (
                depth = 256 AND EXISTS (
                    SELECT 1
                    FROM sync.offline_operation_provenance_v1 AS bounded
                    WHERE bounded.store_id = p_store_id
                      AND bounded.operation_id = dependency_walk.operation_id
                      AND cardinality(bounded.dependency_operation_ids) > 0
                )
            )
        ),
        false
    )
    FROM dependency_walk
$function$;

CREATE FUNCTION sync.begin_offline_operation_v2(
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
    v_begin record;
BEGIN
    SELECT * INTO v_begin
    FROM sync.begin_offline_operation_v1(
        p_store_id, p_device_id, p_operation_id, p_operation_type,
        p_local_sequence, p_provenance_hash, p_license_id, p_subscription_id,
        p_subscription_version, p_client_recorded_at, p_trusted_server_time,
        p_observed_device_time, p_clock_state, p_known_store_status,
        p_known_store_status_at, p_dependency_operation_ids
    );

    IF v_begin.disposition = 'dependency_pending'
       AND sync.offline_dependency_cycle_v1(
            p_store_id, p_operation_id, p_dependency_operation_ids
       ) THEN
        UPDATE sync.offline_operation_provenance_v1 AS provenance
        SET disposition = 'conflict',
            reason_code = 'OFFLINE_DEPENDENCY_CYCLE',
            response_body = pg_catalog.jsonb_build_object(
                'code', 'OFFLINE_DEPENDENCY_CYCLE',
                'message', 'Offline operation dependencies contain a cycle.'
            ),
            authorized_user_id = NULL,
            authorization_xid = NULL,
            completed_at = clock_timestamp()
        WHERE provenance.store_id = p_store_id
          AND provenance.operation_id = p_operation_id;

        RETURN QUERY SELECT
            'conflict'::text,
            'OFFLINE_DEPENDENCY_CYCLE'::text,
            pg_catalog.jsonb_build_object(
                'code', 'OFFLINE_DEPENDENCY_CYCLE',
                'message', 'Offline operation dependencies contain a cycle.'
            ),
            v_begin.processed_operation_preexisted;
        RETURN;
    END IF;

    RETURN QUERY SELECT
        v_begin.disposition::text,
        v_begin.reason_code::text,
        v_begin.response_body::jsonb,
        v_begin.processed_operation_preexisted::boolean;
END
$function$;

CREATE FUNCTION sync.read_offline_operation_status_v1(
    p_store_id uuid,
    p_operation_id uuid,
    p_provenance_hash text DEFAULT NULL
)
RETURNS TABLE (
    operation_id uuid,
    status text,
    reason_code text,
    response_body jsonb,
    recovery_eligible boolean,
    recovery_attempt_count integer,
    last_recovery_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_provenance sync.offline_operation_provenance_v1%ROWTYPE;
    v_status text;
    v_reason text;
    v_response jsonb;
    v_recovery_eligible boolean := false;
BEGIN
    IF p_store_id IS NULL
       OR p_store_id IS DISTINCT FROM platform.current_store_id()
       OR p_operation_id IS NULL
       OR (p_provenance_hash IS NOT NULL
           AND p_provenance_hash !~ '^[0-9a-f]{64}$') THEN
        RAISE EXCEPTION 'S19.7 offline operation status input is invalid'
            USING ERRCODE = '22023';
    END IF;

    SELECT provenance.* INTO v_provenance
    FROM sync.offline_operation_provenance_v1 AS provenance
    WHERE provenance.store_id = p_store_id
      AND provenance.operation_id = p_operation_id;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    IF p_provenance_hash IS NOT NULL
       AND p_provenance_hash IS DISTINCT FROM v_provenance.provenance_hash THEN
        v_status := 'conflict';
        v_reason := 'OFFLINE_OPERATION_ID_CONFLICT';
        v_response := pg_catalog.jsonb_build_object(
            'code', 'OFFLINE_OPERATION_ID_CONFLICT',
            'message', 'Offline operation conflicts with the original request.'
        );
    ELSE
        v_status := CASE
            WHEN v_provenance.disposition = 'applied'
                 AND p_provenance_hash IS NOT NULL THEN 'exact_replay'
            ELSE v_provenance.disposition
        END;
        v_reason := v_provenance.reason_code;
        SELECT COALESCE(operation.response_body, v_provenance.response_body)
        INTO v_response
        FROM (SELECT 1) AS one
        LEFT JOIN sync.processed_operations AS operation
          ON operation.store_id = p_store_id
         AND operation.operation_id = p_operation_id;
    END IF;

    IF v_provenance.disposition = 'quarantined' THEN
        IF v_provenance.reason_code = 'OFFLINE_CLOCK_ROLLBACK_SUSPECTED' THEN
            v_recovery_eligible := true;
        ELSIF v_provenance.reason_code = 'OFFLINE_DEPENDENCY_QUARANTINED' THEN
            SELECT cardinality(v_provenance.dependency_operation_ids) > 0
                   AND bool_and(
                       operation.status = 'applied'
                       AND (dependency.operation_id IS NULL OR dependency.disposition = 'applied')
                   )
            INTO v_recovery_eligible
            FROM unnest(v_provenance.dependency_operation_ids) AS requested(operation_id)
            LEFT JOIN sync.processed_operations AS operation
              ON operation.store_id = p_store_id
             AND operation.operation_id = requested.operation_id
            LEFT JOIN sync.offline_operation_provenance_v1 AS dependency
              ON dependency.store_id = p_store_id
             AND dependency.operation_id = requested.operation_id;
            v_recovery_eligible := COALESCE(v_recovery_eligible, false);
        END IF;
    END IF;

    RETURN QUERY
    SELECT p_operation_id,
           v_status,
           v_reason,
           v_response,
           v_recovery_eligible,
           count(*) FILTER (WHERE event.event_sequence = 1)::integer,
           max(event.recorded_at)
    FROM sync.offline_operation_recovery_events_v1 AS event
    WHERE event.store_id = p_store_id
      AND event.operation_id = p_operation_id;
END
$function$;

CREATE FUNCTION sync.begin_offline_operation_recovery_v1(
    p_store_id uuid,
    p_device_id uuid,
    p_operation_id uuid,
    p_recovery_attempt_id uuid,
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
    v_provenance sync.offline_operation_provenance_v1%ROWTYPE;
    v_existing_attempt record;
    v_store ledger.stores%ROWTYPE;
    v_device ledger.devices%ROWTYPE;
    v_license platform.license_issuances%ROWTYPE;
    v_subscription platform.subscriptions%ROWTYPE;
    v_payload_subscription_version bigint;
    v_dependency_status text;
    v_result text;
    v_reason text;
    v_response jsonb;
    v_processed_preexisted boolean;
BEGIN
    v_user_id := platform.current_user_id();
    IF p_store_id IS NULL
       OR p_store_id IS DISTINCT FROM platform.current_store_id()
       OR p_device_id IS NULL
       OR p_device_id IS DISTINCT FROM platform.current_device_id()
       OR v_user_id IS NULL
       OR p_operation_id IS NULL
       OR p_recovery_attempt_id IS NULL
       OR p_provenance_hash IS NULL
       OR p_provenance_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'S19.7 offline recovery context or input is invalid'
            USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            'dokana:s19:offline-operation:' || p_store_id::text || ':' || p_operation_id::text,
            0
        )
    );

    SELECT began.operation_id,
           began.provenance_hash,
           completed.result_status,
           completed.reason_code,
           completed.response_body
    INTO v_existing_attempt
    FROM sync.offline_operation_recovery_events_v1 AS began
    LEFT JOIN sync.offline_operation_recovery_events_v1 AS completed
      ON completed.store_id = began.store_id
     AND completed.recovery_attempt_id = began.recovery_attempt_id
     AND completed.event_sequence = 2
    WHERE began.store_id = p_store_id
      AND began.recovery_attempt_id = p_recovery_attempt_id
      AND began.event_sequence = 1;

    IF FOUND THEN
        IF v_existing_attempt.operation_id IS DISTINCT FROM p_operation_id
           OR v_existing_attempt.provenance_hash IS DISTINCT FROM p_provenance_hash THEN
            RAISE EXCEPTION 'S19.7 recovery attempt identity conflicts with its original request'
                USING ERRCODE = '22023';
        END IF;
        IF v_existing_attempt.result_status IS NULL THEN
            RAISE EXCEPTION 'S19.7 recovery attempt has no committed final outcome'
                USING ERRCODE = '55000';
        END IF;
        RETURN QUERY SELECT
            v_existing_attempt.result_status::text,
            v_existing_attempt.reason_code::text,
            v_existing_attempt.response_body::jsonb,
            true;
        RETURN;
    END IF;

    SELECT provenance.* INTO v_provenance
    FROM sync.offline_operation_provenance_v1 AS provenance
    WHERE provenance.store_id = p_store_id
      AND provenance.operation_id = p_operation_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'S19.7 offline recovery target was not found'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_provenance.provenance_hash IS DISTINCT FROM p_provenance_hash THEN
        RETURN QUERY SELECT
            'conflict'::text,
            'OFFLINE_OPERATION_ID_CONFLICT'::text,
            pg_catalog.jsonb_build_object(
                'code', 'OFFLINE_OPERATION_ID_CONFLICT',
                'message', 'Offline operation conflicts with the original request.'
            ),
            false;
        RETURN;
    END IF;

    IF v_provenance.device_id IS DISTINCT FROM p_device_id
       OR v_provenance.operation_type IS DISTINCT FROM p_operation_type
       OR v_provenance.local_sequence IS DISTINCT FROM p_local_sequence
       OR v_provenance.license_id IS DISTINCT FROM p_license_id
       OR v_provenance.subscription_id IS DISTINCT FROM p_subscription_id
       OR v_provenance.subscription_version IS DISTINCT FROM p_subscription_version
       OR v_provenance.client_recorded_at IS DISTINCT FROM p_client_recorded_at
       OR v_provenance.trusted_server_time IS DISTINCT FROM p_trusted_server_time
       OR v_provenance.observed_device_time IS DISTINCT FROM p_observed_device_time
       OR v_provenance.clock_state IS DISTINCT FROM p_clock_state
       OR v_provenance.known_store_status IS DISTINCT FROM p_known_store_status
       OR v_provenance.known_store_status_at IS DISTINCT FROM p_known_store_status_at
       OR v_provenance.dependency_operation_ids IS DISTINCT FROM p_dependency_operation_ids THEN
        RETURN QUERY SELECT
            'conflict'::text,
            'OFFLINE_RECOVERY_EVIDENCE_CONFLICT'::text,
            pg_catalog.jsonb_build_object(
                'code', 'OFFLINE_RECOVERY_EVIDENCE_CONFLICT',
                'message', 'Offline recovery evidence differs from the original operation.'
            ),
            false;
        RETURN;
    END IF;

    INSERT INTO sync.offline_operation_recovery_events_v1 (
        store_id, recovery_attempt_id, event_sequence, operation_id,
        provenance_hash, original_quarantine_reason, event_type,
        authorized_user_id, authorization_xid
    ) VALUES (
        p_store_id, p_recovery_attempt_id, 1, p_operation_id,
        p_provenance_hash, v_provenance.reason_code, 'began',
        v_user_id, pg_current_xact_id()
    );

    v_processed_preexisted := EXISTS (
        SELECT 1 FROM sync.processed_operations AS operation
        WHERE operation.store_id = p_store_id
          AND operation.operation_id = p_operation_id
    );

    IF v_provenance.disposition = 'applied'
       AND EXISTS (
            SELECT 1 FROM sync.processed_operations AS operation
            WHERE operation.store_id = p_store_id
              AND operation.operation_id = p_operation_id
              AND operation.status = 'applied'
       ) THEN
        v_result := 'exact_replay';
        SELECT operation.response_body INTO v_response
        FROM sync.processed_operations AS operation
        WHERE operation.store_id = p_store_id
          AND operation.operation_id = p_operation_id;
    ELSIF v_provenance.disposition <> 'quarantined' THEN
        v_result := CASE
            WHEN v_provenance.disposition = 'processing' THEN 'conflict'
            ELSE v_provenance.disposition
        END;
        v_reason := CASE
            WHEN v_provenance.disposition = 'processing'
                THEN 'OFFLINE_RECOVERY_STATE_CONFLICT'
            ELSE v_provenance.reason_code
        END;
        v_response := v_provenance.response_body;
    ELSIF v_provenance.reason_code NOT IN (
        'OFFLINE_CLOCK_ROLLBACK_SUSPECTED',
        'OFFLINE_DEPENDENCY_QUARANTINED'
    ) THEN
        v_result := 'quarantined';
        v_reason := 'OFFLINE_RECOVERY_NOT_ALLOWED';
        v_response := pg_catalog.jsonb_build_object(
            'code', v_reason,
            'message', 'Offline operation quarantine is not recoverable.'
        );
    END IF;

    IF v_result IS NULL THEN
        SELECT store_record.* INTO v_store
        FROM ledger.stores AS store_record
        WHERE store_record.id = p_store_id
        FOR SHARE;
        IF NOT FOUND OR v_store.status = 'archived' THEN
            v_result := 'rejected';
            v_reason := 'OFFLINE_STORE_UNAVAILABLE';
        END IF;
    END IF;

    IF v_result IS NULL AND NOT EXISTS (
        SELECT 1 FROM platform.store_memberships AS membership
        WHERE membership.store_id = p_store_id
          AND membership.user_id = v_user_id
          AND membership.status = 'active'
          AND membership.role = 'owner'
    ) THEN
        v_result := 'rejected';
        v_reason := 'OFFLINE_ACTOR_NOT_ALLOWED';
    END IF;

    IF v_result IS NULL THEN
        SELECT device_record.* INTO v_device
        FROM ledger.devices AS device_record
        WHERE device_record.store_id = p_store_id
          AND device_record.id = p_device_id
        FOR SHARE;
        IF NOT FOUND OR v_device.status <> 'active' THEN
            v_result := 'rejected';
            v_reason := 'OFFLINE_DEVICE_UNAVAILABLE';
        END IF;
    END IF;

    IF v_result IS NULL THEN
        SELECT issuance.* INTO v_license
        FROM platform.license_issuances AS issuance
        WHERE issuance.id = p_license_id
          AND issuance.store_id = p_store_id
          AND issuance.device_id = p_device_id
          AND issuance.subscription_id = p_subscription_id
          AND issuance.signature <> ''
        FOR SHARE;
        IF NOT FOUND THEN
            v_result := 'rejected';
            v_reason := 'OFFLINE_LICENSE_INVALID';
        ELSIF v_license.revoked_at IS NOT NULL THEN
            v_result := 'rejected';
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
                v_result := 'rejected';
                v_reason := 'OFFLINE_LICENSE_BINDING_INVALID';
            END IF;
        END IF;
    END IF;

    IF v_result IS NULL THEN
        SELECT subscription.* INTO v_subscription
        FROM platform.subscriptions AS subscription
        WHERE subscription.id = p_subscription_id
          AND subscription.store_id = p_store_id
        FOR SHARE;
        IF NOT FOUND OR v_subscription.version < p_subscription_version THEN
            v_result := 'rejected';
            v_reason := 'OFFLINE_SUBSCRIPTION_EVIDENCE_INVALID';
        END IF;
    END IF;

    IF v_result IS NULL AND (
        p_trusted_server_time IS DISTINCT FROM v_license.issued_at
        OR p_observed_device_time IS DISTINCT FROM p_client_recorded_at
        OR p_known_store_status_at > p_client_recorded_at
        OR p_client_recorded_at < v_license.issued_at
        OR p_client_recorded_at >= v_license.expires_at
    ) THEN
        v_result := 'rejected';
        v_reason := 'OFFLINE_CREATION_OUTSIDE_LICENSE';
    END IF;
    IF v_result IS NULL AND p_known_store_status = 'suspended' THEN
        v_result := 'rejected';
        v_reason := 'OFFLINE_CREATED_AFTER_KNOWN_SUSPENSION';
    END IF;

    IF v_result IS NULL
       AND sync.offline_dependency_cycle_v1(
            p_store_id, p_operation_id, p_dependency_operation_ids
       ) THEN
        v_result := 'conflict';
        v_reason := 'OFFLINE_DEPENDENCY_CYCLE';
    END IF;

    IF v_result IS NULL AND cardinality(p_dependency_operation_ids) > 0 THEN
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
            v_result := 'quarantined';
            v_reason := 'OFFLINE_DEPENDENCY_QUARANTINED';
        ELSIF v_dependency_status = 'conflict' THEN
            v_result := 'conflict';
            v_reason := 'OFFLINE_DEPENDENCY_CONFLICT';
        ELSIF v_dependency_status = 'rejected' THEN
            v_result := 'rejected';
            v_reason := 'OFFLINE_DEPENDENCY_REJECTED';
        ELSIF v_dependency_status = 'dependency_pending' THEN
            v_result := 'dependency_pending';
            v_reason := 'OFFLINE_DEPENDENCY_PENDING';
        END IF;
    END IF;

    IF v_result IS NULL THEN
        UPDATE sync.offline_operation_provenance_v1 AS provenance
        SET disposition = 'processing',
            reason_code = NULL,
            response_body = NULL,
            authorized_user_id = v_user_id,
            authorization_xid = pg_current_xact_id(),
            completed_at = NULL
        WHERE provenance.store_id = p_store_id
          AND provenance.operation_id = p_operation_id;

        RETURN QUERY SELECT
            'authorized'::text,
            NULL::text,
            NULL::jsonb,
            v_processed_preexisted;
        RETURN;
    END IF;

    IF v_response IS NULL AND v_reason IS NOT NULL THEN
        v_response := pg_catalog.jsonb_build_object(
            'code', v_reason,
            'message', 'Offline operation recovery did not authorize domain execution.'
        );
    END IF;

    IF v_provenance.disposition = 'quarantined'
       AND v_result IN ('rejected', 'dependency_pending', 'conflict') THEN
        UPDATE sync.offline_operation_provenance_v1 AS provenance
        SET disposition = v_result,
            reason_code = v_reason,
            response_body = v_response,
            authorized_user_id = NULL,
            authorization_xid = NULL,
            completed_at = clock_timestamp()
        WHERE provenance.store_id = p_store_id
          AND provenance.operation_id = p_operation_id;
    END IF;

    INSERT INTO sync.offline_operation_recovery_events_v1 (
        store_id, recovery_attempt_id, event_sequence, operation_id,
        provenance_hash, original_quarantine_reason, event_type,
        result_status, reason_code, response_body, authorized_user_id
    ) VALUES (
        p_store_id, p_recovery_attempt_id, 2, p_operation_id,
        p_provenance_hash, v_provenance.reason_code, 'completed',
        v_result, v_reason, v_response, v_user_id
    );

    RETURN QUERY SELECT v_result, v_reason, v_response, v_processed_preexisted;
END
$function$;

CREATE FUNCTION sync.finish_offline_operation_recovery_v1(
    p_store_id uuid,
    p_operation_id uuid,
    p_recovery_attempt_id uuid,
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
    v_began sync.offline_operation_recovery_events_v1%ROWTYPE;
    v_completed record;
BEGIN
    IF p_store_id IS NULL
       OR p_store_id IS DISTINCT FROM platform.current_store_id()
       OR p_operation_id IS NULL
       OR p_recovery_attempt_id IS NULL THEN
        RAISE EXCEPTION 'S19.7 offline recovery completion input is invalid'
            USING ERRCODE = '22023';
    END IF;

    SELECT event.* INTO v_began
    FROM sync.offline_operation_recovery_events_v1 AS event
    WHERE event.store_id = p_store_id
      AND event.recovery_attempt_id = p_recovery_attempt_id
      AND event.event_sequence = 1
    FOR SHARE;

    IF NOT FOUND
       OR v_began.operation_id IS DISTINCT FROM p_operation_id
       OR v_began.authorization_xid IS DISTINCT FROM pg_current_xact_id()
       OR v_began.authorized_user_id IS DISTINCT FROM platform.current_user_id()
       OR EXISTS (
            SELECT 1 FROM sync.offline_operation_recovery_events_v1 AS event
            WHERE event.store_id = p_store_id
              AND event.recovery_attempt_id = p_recovery_attempt_id
              AND event.event_sequence = 2
       ) THEN
        RAISE EXCEPTION 'S19.7 offline recovery completion authority is invalid'
            USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_completed
    FROM sync.finish_offline_operation_v1(
        p_store_id, p_operation_id, p_disposition, p_response_body
    );

    INSERT INTO sync.offline_operation_recovery_events_v1 (
        store_id, recovery_attempt_id, event_sequence, operation_id,
        provenance_hash, original_quarantine_reason, event_type,
        result_status, reason_code, response_body, authorized_user_id
    ) VALUES (
        p_store_id, p_recovery_attempt_id, 2, p_operation_id,
        v_began.provenance_hash, v_began.original_quarantine_reason, 'completed',
        v_completed.disposition,
        CASE WHEN v_completed.disposition = 'applied' THEN NULL
             ELSE COALESCE(p_response_body->>'code', upper(v_completed.disposition)) END,
        v_completed.response_body,
        v_began.authorized_user_id
    );

    RETURN QUERY SELECT
        v_completed.disposition::text,
        v_completed.canonical_request_hash::text,
        v_completed.response_body::jsonb;
END
$function$;

REVOKE ALL ON FUNCTION
    sync.reject_offline_recovery_event_mutation_v1(),
    sync.offline_recovery_finished_at_commit_v1(),
    sync.offline_dependency_cycle_v1(uuid, uuid, uuid[]),
    sync.begin_offline_operation_v1(
        uuid, uuid, uuid, text, bigint, text, uuid, uuid, bigint,
        timestamptz, timestamptz, timestamptz, text, text, timestamptz, uuid[]
    ),
    sync.begin_offline_operation_v2(
        uuid, uuid, uuid, text, bigint, text, uuid, uuid, bigint,
        timestamptz, timestamptz, timestamptz, text, text, timestamptz, uuid[]
    ),
    sync.read_offline_operation_status_v1(uuid, uuid, text),
    sync.begin_offline_operation_recovery_v1(
        uuid, uuid, uuid, uuid, text, bigint, text, uuid, uuid, bigint,
        timestamptz, timestamptz, timestamptz, text, text, timestamptz, uuid[]
    ),
    sync.finish_offline_operation_recovery_v1(uuid, uuid, uuid, text, jsonb)
FROM PUBLIC, shop_app_runtime, shop_app_auth, shop_app_auth_owner;

GRANT EXECUTE ON FUNCTION
    sync.begin_offline_operation_v2(
        uuid, uuid, uuid, text, bigint, text, uuid, uuid, bigint,
        timestamptz, timestamptz, timestamptz, text, text, timestamptz, uuid[]
    ),
    sync.read_offline_operation_status_v1(uuid, uuid, text),
    sync.begin_offline_operation_recovery_v1(
        uuid, uuid, uuid, uuid, text, bigint, text, uuid, uuid, bigint,
        timestamptz, timestamptz, timestamptz, text, text, timestamptz, uuid[]
    ),
    sync.finish_offline_operation_recovery_v1(uuid, uuid, uuid, text, jsonb)
TO shop_app_runtime;

DO $postconditions$
DECLARE
    managed_function regprocedure;
BEGIN
    IF NOT (
        SELECT relrowsecurity AND relforcerowsecurity
        FROM pg_class
        WHERE oid = 'sync.offline_operation_recovery_events_v1'::regclass
    ) OR has_table_privilege(
        'shop_app_runtime', 'sync.offline_operation_recovery_events_v1', 'SELECT'
    ) OR has_table_privilege(
        'shop_app_runtime', 'sync.offline_operation_recovery_events_v1', 'INSERT'
    ) OR has_table_privilege(
        'shop_app_runtime', 'sync.offline_operation_recovery_events_v1', 'UPDATE'
    ) OR has_table_privilege(
        'shop_app_runtime', 'sync.offline_operation_recovery_events_v1', 'DELETE'
    ) THEN
        RAISE EXCEPTION '0028 broadened runtime table authority or weakened recovery RLS';
    END IF;

    IF has_function_privilege(
        'shop_app_runtime',
        'sync.begin_offline_operation_v1(uuid,uuid,uuid,text,bigint,text,uuid,uuid,bigint,timestamptz,timestamptz,timestamptz,text,text,timestamptz,uuid[])',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION '0028 did not retire the cycle-unsafe runtime begin authority';
    END IF;

    FOREACH managed_function IN ARRAY ARRAY[
        'sync.begin_offline_operation_v2(uuid,uuid,uuid,text,bigint,text,uuid,uuid,bigint,timestamptz,timestamptz,timestamptz,text,text,timestamptz,uuid[])'::regprocedure,
        'sync.read_offline_operation_status_v1(uuid,uuid,text)'::regprocedure,
        'sync.begin_offline_operation_recovery_v1(uuid,uuid,uuid,uuid,text,bigint,text,uuid,uuid,bigint,timestamptz,timestamptz,timestamptz,text,text,timestamptz,uuid[])'::regprocedure,
        'sync.finish_offline_operation_recovery_v1(uuid,uuid,uuid,text,jsonb)'::regprocedure
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
            RAISE EXCEPTION '0028 created an unsafe recovery function security boundary';
        END IF;
    END LOOP;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'sync.offline_operation_recovery_events_v1'::regclass
          AND tgname = 'trg_offline_operation_recovery_events_v1_immutable'
          AND NOT tgisinternal
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'sync.offline_operation_recovery_events_v1'::regclass
          AND tgname = 'trg_offline_recovery_finished_at_commit_v1'
          AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION '0028 recovery lineage triggers are missing';
    END IF;
END
$postconditions$;
