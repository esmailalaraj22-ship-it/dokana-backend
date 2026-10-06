-- SQLite compatibility patch v1.3.0
-- Adds the local persistence contract required by the S19.2 offline sync protocol.
-- Apply after sqlite_v1_2_settings_patch.sql (user_version 10200).
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

CREATE TEMP TABLE dokana_v103_guard (
    valid INTEGER NOT NULL CHECK (valid = 1)
) STRICT;

INSERT INTO dokana_v103_guard(valid)
SELECT CASE WHEN user_version = 10200 THEN 1 ELSE 0 END
FROM pragma_user_version;

DROP TABLE dokana_v103_guard;

-- Preserve legacy License rows without manufacturing missing S18 evidence.
CREATE TABLE local_license_v103 (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    license_version INTEGER CHECK (license_version IS NULL OR license_version = 1),
    subscription_id TEXT,
    subscription_version TEXT,
    central_entitlement_end INTEGER,
    signing_key_id TEXT,
    signing_algorithm TEXT
        CHECK (signing_algorithm IS NULL OR signing_algorithm = 'Ed25519'),
    signed_payload TEXT NOT NULL,
    signature TEXT,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_trusted_server_at INTEGER,
    last_seen_device_time INTEGER,
    revoked_at INTEGER,
    revoke_reason TEXT,
    last_revalidated_at INTEGER,
    verification_state TEXT NOT NULL
        CHECK (verification_state IN (
            'legacy_unverified', 'verified', 'invalid', 'revalidation_required', 'revoked'
        )),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'expired', 'revoked')),
    CHECK (expires_at > issued_at),
    CHECK (
        central_entitlement_end IS NULL
        OR central_entitlement_end >= issued_at
    ),
    CHECK (
        verification_state <> 'verified'
        OR (
            license_version = 1
            AND subscription_id IS NOT NULL
            AND length(trim(subscription_id)) > 0
            AND subscription_version IS NOT NULL
            AND length(trim(subscription_version)) > 0
            AND central_entitlement_end IS NOT NULL
            AND signing_key_id IS NOT NULL
            AND length(trim(signing_key_id)) > 0
            AND signing_algorithm = 'Ed25519'
            AND json_valid(signed_payload)
            AND signature IS NOT NULL
            AND length(trim(signature)) > 0
            AND expires_at <= central_entitlement_end
        )
    ),
    CHECK (
        verification_state = 'legacy_unverified'
        OR (
            verification_state = 'revoked'
            AND status = 'revoked'
            AND revoked_at IS NOT NULL
            AND revoke_reason IS NOT NULL
            AND length(trim(revoke_reason)) > 0
        )
        OR (
            verification_state <> 'revoked'
            AND status <> 'revoked'
        )
    ),
    UNIQUE (store_id, id),
    UNIQUE (store_id, device_id, id),
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE CASCADE
) STRICT;

INSERT INTO local_license_v103 (
    id,
    store_id,
    device_id,
    license_version,
    subscription_id,
    subscription_version,
    central_entitlement_end,
    signing_key_id,
    signing_algorithm,
    signed_payload,
    signature,
    issued_at,
    expires_at,
    last_trusted_server_at,
    last_seen_device_time,
    revoked_at,
    revoke_reason,
    last_revalidated_at,
    verification_state,
    status
)
SELECT
    id,
    store_id,
    device_id,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    signed_payload,
    NULL,
    issued_at,
    expires_at,
    last_trusted_server_at,
    last_seen_device_time,
    NULL,
    NULL,
    NULL,
    'legacy_unverified',
    status
FROM local_license;

DROP TABLE local_license;
ALTER TABLE local_license_v103 RENAME TO local_license;

CREATE TABLE offline_license_verification_keys (
    key_id TEXT PRIMARY KEY CHECK (length(trim(key_id)) > 0),
    algorithm TEXT NOT NULL CHECK (algorithm = 'Ed25519'),
    public_key_spki TEXT NOT NULL CHECK (length(trim(public_key_spki)) > 0),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'retired', 'revoked')),
    first_trusted_at INTEGER NOT NULL,
    last_trusted_at INTEGER NOT NULL,
    CHECK (last_trusted_at >= first_trusted_at)
) STRICT;

CREATE TABLE offline_trusted_time_state (
    store_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    license_id TEXT,
    state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version >= 1),
    last_trusted_server_at INTEGER,
    last_seen_device_time INTEGER,
    last_trusted_local_sequence INTEGER
        CHECK (last_trusted_local_sequence IS NULL OR last_trusted_local_sequence >= 0),
    clock_rollback_suspected INTEGER NOT NULL DEFAULT 0
        CHECK (clock_rollback_suspected IN (0, 1)),
    online_revalidation_required INTEGER NOT NULL DEFAULT 1
        CHECK (online_revalidation_required IN (0, 1)),
    observed_store_status TEXT
        CHECK (observed_store_status IS NULL OR observed_store_status IN (
            'active', 'suspended', 'read_only', 'archived'
        )),
    observed_store_status_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (store_id, device_id),
    CHECK (
        observed_store_status IS NULL
        OR observed_store_status_at IS NOT NULL
    ),
    CHECK (
        clock_rollback_suspected = 0
        OR online_revalidation_required = 1
    ),
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (store_id, device_id, license_id)
        REFERENCES local_license(store_id, device_id, id)
        ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

-- Move the cursor contract from one row per Store to one row per Store/device.
CREATE TABLE sync_state_v103 (
    store_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    protocol_version INTEGER CHECK (protocol_version IS NULL OR protocol_version >= 1),
    change_feed_version INTEGER
        CHECK (change_feed_version IS NULL OR change_feed_version >= 1),
    last_safe_cursor TEXT,
    active_dataset_id TEXT,
    bootstrap_generation_id TEXT,
    cursor_application_status TEXT NOT NULL DEFAULT 'legacy'
        CHECK (cursor_application_status IN ('legacy', 'ready', 'applying', 'failed')),
    last_push_at INTEGER,
    last_pull_at INTEGER,
    last_success_at INTEGER,
    last_error TEXT,
    pending_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
    PRIMARY KEY (store_id, device_id),
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

INSERT INTO sync_state_v103 (
    store_id,
    device_id,
    protocol_version,
    change_feed_version,
    last_safe_cursor,
    active_dataset_id,
    bootstrap_generation_id,
    cursor_application_status,
    last_push_at,
    last_pull_at,
    last_success_at,
    last_error,
    pending_count
)
SELECT
    store_id,
    device_id,
    NULL,
    NULL,
    pull_cursor,
    NULL,
    NULL,
    'legacy',
    last_push_at,
    last_pull_at,
    last_success_at,
    last_error,
    pending_count
FROM sync_state;

DROP TABLE sync_state;
ALTER TABLE sync_state_v103 RENAME TO sync_state;

-- Rebuild the outbox so envelope-conditional fields are actually nullable.
CREATE TABLE sync_outbox_v103 (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    contract_state TEXT NOT NULL
        CHECK (contract_state IN ('legacy_unclassified', 'v1')),
    protocol_version INTEGER CHECK (protocol_version IS NULL OR protocol_version >= 1),
    operation_type TEXT,
    aggregate_type TEXT,
    aggregate_id TEXT,
    action TEXT CHECK (
        action IS NULL OR action IN (
            'create', 'update', 'archive', 'restore', 'post', 'cancel', 'reverse'
        )
    ),
    expected_version INTEGER CHECK (expected_version IS NULL OR expected_version >= 1),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    occurred_at INTEGER,
    client_recorded_at INTEGER,
    offline_license_id TEXT,
    license_version INTEGER CHECK (license_version IS NULL OR license_version = 1),
    signing_key_id TEXT,
    subscription_id TEXT,
    subscription_version TEXT,
    signed_license_json TEXT
        CHECK (signed_license_json IS NULL OR json_valid(signed_license_json)),
    trusted_time_evidence_json TEXT
        CHECK (
            trusted_time_evidence_json IS NULL
            OR json_valid(trusted_time_evidence_json)
        ),
    local_sequence INTEGER CHECK (local_sequence IS NULL OR local_sequence > 0),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sending', 'synced', 'failed', 'blocked')),
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    next_retry_at INTEGER,
    last_attempt_at INTEGER,
    last_error TEXT,
    server_ack_json TEXT CHECK (server_ack_json IS NULL OR json_valid(server_ack_json)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (
        contract_state = 'legacy_unclassified'
        OR (
            contract_state = 'v1'
            AND protocol_version = 1
            AND operation_type IS NOT NULL
            AND length(trim(operation_type)) > 0
            AND operation_type = lower(operation_type)
            AND operation_type LIKE '%.v1'
            AND aggregate_type IS NULL
            AND action IS NULL
            AND client_recorded_at IS NOT NULL
            AND offline_license_id IS NOT NULL
            AND license_version = 1
            AND signing_key_id IS NOT NULL
            AND subscription_id IS NOT NULL
            AND subscription_version IS NOT NULL
            AND signed_license_json IS NOT NULL
            AND trusted_time_evidence_json IS NOT NULL
            AND local_sequence IS NOT NULL
        )
    ),
    UNIQUE (store_id, id),
    UNIQUE (store_id, operation_id),
    UNIQUE (store_id, device_id, operation_id),
    UNIQUE (store_id, device_id, local_sequence),
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id, offline_license_id)
        REFERENCES local_license(store_id, device_id, id)
        ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

INSERT INTO sync_outbox_v103 (
    id,
    store_id,
    device_id,
    operation_id,
    contract_state,
    protocol_version,
    operation_type,
    aggregate_type,
    aggregate_id,
    action,
    expected_version,
    payload_json,
    occurred_at,
    client_recorded_at,
    offline_license_id,
    license_version,
    signing_key_id,
    subscription_id,
    subscription_version,
    signed_license_json,
    trusted_time_evidence_json,
    local_sequence,
    status,
    retry_count,
    next_retry_at,
    last_attempt_at,
    last_error,
    server_ack_json,
    created_at,
    updated_at
)
SELECT
    id,
    store_id,
    device_id,
    operation_id,
    'legacy_unclassified',
    NULL,
    NULL,
    aggregate_type,
    aggregate_id,
    action,
    NULL,
    payload_json,
    occurred_at,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    status,
    retry_count,
    next_retry_at,
    last_attempt_at,
    last_error,
    server_ack_json,
    created_at,
    updated_at
FROM sync_outbox;

DROP TABLE sync_outbox;
ALTER TABLE sync_outbox_v103 RENAME TO sync_outbox;

CREATE INDEX idx_sync_outbox_pending
ON sync_outbox (store_id, device_id, status, next_retry_at, local_sequence);

CREATE TRIGGER trg_sync_outbox_require_v1_insert
BEFORE INSERT ON sync_outbox
WHEN NEW.contract_state <> 'v1'
BEGIN
    SELECT RAISE(ABORT, 'NEW_SYNC_OUTBOX_OPERATION_REQUIRES_V1_ENVELOPE');
END;

CREATE TRIGGER trg_sync_outbox_envelope_immutable
BEFORE UPDATE OF
    store_id,
    device_id,
    operation_id,
    contract_state,
    protocol_version,
    operation_type,
    aggregate_type,
    aggregate_id,
    action,
    expected_version,
    payload_json,
    occurred_at,
    client_recorded_at,
    offline_license_id,
    license_version,
    signing_key_id,
    subscription_id,
    subscription_version,
    signed_license_json,
    trusted_time_evidence_json,
    local_sequence
ON sync_outbox
BEGIN
    SELECT RAISE(ABORT, 'SYNC_OUTBOX_ENVELOPE_IS_IMMUTABLE');
END;

CREATE TABLE sync_outbox_dependencies (
    store_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    depends_on_operation_id TEXT NOT NULL,
    dependency_order INTEGER NOT NULL CHECK (dependency_order >= 0),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (store_id, operation_id, depends_on_operation_id),
    UNIQUE (store_id, operation_id, dependency_order),
    CHECK (operation_id <> depends_on_operation_id),
    FOREIGN KEY (store_id, operation_id)
        REFERENCES sync_outbox(store_id, operation_id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (store_id, depends_on_operation_id)
        REFERENCES sync_outbox(store_id, operation_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE sync_local_sequence_state (
    store_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    last_allocated_sequence INTEGER NOT NULL DEFAULT 0
        CHECK (last_allocated_sequence >= 0),
    next_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (store_id, device_id),
    CHECK (next_sequence = last_allocated_sequence + 1),
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TRIGGER trg_sync_local_sequence_initial
BEFORE INSERT ON sync_local_sequence_state
WHEN NEW.last_allocated_sequence <> 0 OR NEW.next_sequence <> 1
BEGIN
    SELECT RAISE(ABORT, 'SYNC_LOCAL_SEQUENCE_MUST_START_AT_ONE');
END;

CREATE TRIGGER trg_sync_local_sequence_monotonic
BEFORE UPDATE OF last_allocated_sequence, next_sequence ON sync_local_sequence_state
WHEN NEW.last_allocated_sequence <= OLD.last_allocated_sequence
  OR NEW.next_sequence <= OLD.next_sequence
BEGIN
    SELECT RAISE(ABORT, 'SYNC_LOCAL_SEQUENCE_CANNOT_MOVE_BACKWARD_OR_REPEAT');
END;

CREATE TRIGGER trg_sync_local_sequence_no_delete
BEFORE DELETE ON sync_local_sequence_state
BEGIN
    SELECT RAISE(ABORT, 'SYNC_LOCAL_SEQUENCE_CANNOT_BE_DELETED');
END;

CREATE TABLE sync_operation_results (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    classification TEXT NOT NULL CHECK (classification IN (
        'APPLIED',
        'EXACT_REPLAY',
        'REJECTED',
        'DEPENDENCY_PENDING',
        'CONFLICT',
        'QUARANTINED'
    )),
    domain_code TEXT,
    response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
    recovery_json TEXT CHECK (recovery_json IS NULL OR json_valid(recovery_json)),
    server_recorded_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    application_status TEXT NOT NULL DEFAULT 'received'
        CHECK (application_status IN ('received', 'applied', 'failed')),
    applied_locally_at INTEGER,
    CHECK (
        application_status <> 'applied'
        OR applied_locally_at IS NOT NULL
    ),
    UNIQUE (store_id, id),
    UNIQUE (store_id, operation_id),
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id, operation_id)
        REFERENCES sync_outbox(store_id, device_id, operation_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

-- Pull receipts retain both receipt and crash-safe application state.
CREATE TABLE sync_inbox_receipts_v103 (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    contract_state TEXT NOT NULL CHECK (contract_state IN ('legacy', 'v1')),
    protocol_version INTEGER CHECK (protocol_version IS NULL OR protocol_version >= 1),
    change_feed_version INTEGER
        CHECK (change_feed_version IS NULL OR change_feed_version >= 1),
    cursor TEXT,
    server_event_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    server_version INTEGER CHECK (server_version IS NULL OR server_version >= 1),
    bootstrap_generation_id TEXT,
    payload_hash TEXT,
    application_status TEXT NOT NULL
        CHECK (application_status IN ('received', 'staged', 'applied', 'failed')),
    received_at INTEGER NOT NULL,
    applied_at INTEGER,
    CHECK (
        contract_state = 'legacy'
        OR (
            protocol_version = 1
            AND change_feed_version IS NOT NULL
            AND cursor IS NOT NULL
            AND length(trim(cursor)) > 0
        )
    ),
    CHECK (
        application_status <> 'applied'
        OR applied_at IS NOT NULL
    ),
    UNIQUE (store_id, id),
    UNIQUE (store_id, server_event_id),
    FOREIGN KEY (store_id) REFERENCES stores(id) ON UPDATE CASCADE ON DELETE CASCADE
) STRICT;

INSERT INTO sync_inbox_receipts_v103 (
    id,
    store_id,
    contract_state,
    protocol_version,
    change_feed_version,
    cursor,
    server_event_id,
    entity_type,
    entity_id,
    server_version,
    bootstrap_generation_id,
    payload_hash,
    application_status,
    received_at,
    applied_at
)
SELECT
    id,
    store_id,
    'legacy',
    NULL,
    NULL,
    NULL,
    server_event_id,
    entity_type,
    entity_id,
    server_version,
    NULL,
    NULL,
    'applied',
    applied_at,
    applied_at
FROM sync_inbox_receipts;

DROP TABLE sync_inbox_receipts;
ALTER TABLE sync_inbox_receipts_v103 RENAME TO sync_inbox_receipts;

CREATE UNIQUE INDEX uq_sync_inbox_store_cursor
ON sync_inbox_receipts(store_id, cursor)
WHERE cursor IS NOT NULL;

CREATE TRIGGER trg_sync_inbox_require_v1_insert
BEFORE INSERT ON sync_inbox_receipts
WHEN NEW.contract_state <> 'v1'
BEGIN
    SELECT RAISE(ABORT, 'NEW_SYNC_INBOX_RECEIPT_REQUIRES_V1_CONTRACT');
END;

-- A bootstrap uses a separate staging database file. This singleton identifies
-- whether the current file is staging, validated, or the active local dataset.
CREATE TABLE local_dataset_state (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    store_id TEXT,
    device_id TEXT,
    dataset_id TEXT UNIQUE,
    bootstrap_generation_id TEXT,
    snapshot_id TEXT,
    protocol_version INTEGER CHECK (protocol_version IS NULL OR protocol_version >= 1),
    change_feed_version INTEGER
        CHECK (change_feed_version IS NULL OR change_feed_version >= 1),
    safe_base_cursor TEXT,
    dataset_status TEXT NOT NULL DEFAULT 'uninitialized'
        CHECK (dataset_status IN (
            'uninitialized', 'staging', 'validated', 'active', 'rejected'
        )),
    checksum_manifest_json TEXT
        CHECK (
            checksum_manifest_json IS NULL
            OR json_valid(checksum_manifest_json)
        ),
    started_at INTEGER,
    validated_at INTEGER,
    activated_at INTEGER,
    last_error TEXT,
    CHECK (
        dataset_status = 'uninitialized'
        OR (
            store_id IS NOT NULL
            AND device_id IS NOT NULL
            AND dataset_id IS NOT NULL
            AND bootstrap_generation_id IS NOT NULL
            AND snapshot_id IS NOT NULL
            AND protocol_version IS NOT NULL
            AND change_feed_version IS NOT NULL
            AND started_at IS NOT NULL
        )
    ),
    CHECK (
        dataset_status <> 'validated'
        OR validated_at IS NOT NULL
    ),
    CHECK (
        dataset_status <> 'active'
        OR (
            validated_at IS NOT NULL
            AND activated_at IS NOT NULL
            AND safe_base_cursor IS NOT NULL
        )
    )
) STRICT;

-- Current PostgreSQL Manual Inventory roots were added after the v1.1 SQLite
-- baseline. The root ID is client-created; movement IDs remain server-derived.
CREATE TABLE manual_inventory_entries (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    product_unit_id TEXT NOT NULL,
    selected_quantity_milli INTEGER NOT NULL CHECK (selected_quantity_milli > 0),
    base_quantity_milli INTEGER NOT NULL CHECK (base_quantity_milli > 0),
    factor_num INTEGER NOT NULL CHECK (factor_num > 0),
    factor_den INTEGER NOT NULL CHECK (factor_den > 0),
    total_purchase_cost_minor INTEGER
        CHECK (total_purchase_cost_minor IS NULL OR total_purchase_cost_minor >= 0),
    cost_status TEXT NOT NULL CHECK (cost_status IN ('known', 'unknown', 'pending')),
    occurred_at INTEGER NOT NULL,
    business_date TEXT NOT NULL,
    posting_date TEXT NOT NULL,
    accounting_period_id TEXT NOT NULL,
    movement_id TEXT NOT NULL,
    transaction_group_id TEXT NOT NULL,
    reason TEXT,
    device_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    CHECK (base_quantity_milli * factor_den = selected_quantity_milli * factor_num),
    CHECK (transaction_group_id = operation_id),
    CHECK (
        (total_purchase_cost_minor IS NULL OR cost_status = 'known')
        AND (cost_status <> 'unknown' OR total_purchase_cost_minor IS NULL)
    ),
    CHECK (posting_date = business_date),
    UNIQUE (store_id, id),
    UNIQUE (store_id, operation_id),
    UNIQUE (store_id, movement_id),
    FOREIGN KEY (store_id, product_id)
        REFERENCES products(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, product_id, product_unit_id)
        REFERENCES product_units(store_id, product_id, id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES accounting_periods(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, product_id, movement_id)
        REFERENCES inventory_movements(store_id, product_id, id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, device_id)
        REFERENCES devices(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_manual_inventory_entries_product_time
ON manual_inventory_entries(store_id, product_id, occurred_at, id);

CREATE UNIQUE INDEX uq_inventory_movements_store_product_id
ON inventory_movements(store_id, product_id, id);

CREATE UNIQUE INDEX uq_inventory_movement_reversal
ON inventory_movements(store_id, reversal_of_id)
WHERE reversal_of_id IS NOT NULL;

-- Opening Receivable allocations require exactly one target type.
DROP TRIGGER IF EXISTS trg_customer_payment_post_validate;
DROP TRIGGER IF EXISTS trg_customer_payment_outstanding_validate;

CREATE TABLE customer_payment_allocations_v103 (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    customer_payment_id TEXT NOT NULL,
    sale_id TEXT,
    opening_receivable_ledger_entry_id TEXT,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    customer_ledger_entry_id TEXT,
    created_at INTEGER NOT NULL,
    CHECK (
        (sale_id IS NOT NULL)
        + (opening_receivable_ledger_entry_id IS NOT NULL) = 1
    ),
    UNIQUE (store_id, id),
    UNIQUE (store_id, customer_ledger_entry_id),
    UNIQUE (customer_payment_id, sale_id),
    UNIQUE (customer_payment_id, opening_receivable_ledger_entry_id),
    FOREIGN KEY (store_id, customer_payment_id)
        REFERENCES customer_payments(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, sale_id)
        REFERENCES sales(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, opening_receivable_ledger_entry_id)
        REFERENCES customer_ledger_entries(store_id, id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, customer_ledger_entry_id)
        REFERENCES customer_ledger_entries(store_id, id)
        ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

INSERT INTO customer_payment_allocations_v103 (
    id,
    store_id,
    customer_payment_id,
    sale_id,
    opening_receivable_ledger_entry_id,
    amount_minor,
    customer_ledger_entry_id,
    created_at
)
SELECT
    id,
    store_id,
    customer_payment_id,
    sale_id,
    NULL,
    amount_minor,
    customer_ledger_entry_id,
    created_at
FROM customer_payment_allocations;

DROP TABLE customer_payment_allocations;
ALTER TABLE customer_payment_allocations_v103 RENAME TO customer_payment_allocations;

CREATE INDEX idx_customer_allocations_sale
ON customer_payment_allocations(store_id, sale_id);

CREATE INDEX idx_customer_allocations_opening_receivable
ON customer_payment_allocations(store_id, opening_receivable_ledger_entry_id);

CREATE TRIGGER trg_customer_allocations_draft_only_insert
BEFORE INSERT ON customer_payment_allocations
BEGIN
    SELECT RAISE(ABORT, 'CUSTOMER_ALLOCATION_REQUIRES_DRAFT_PAYMENT')
    WHERE NOT EXISTS (
        SELECT 1 FROM customer_payments p
        WHERE p.store_id = NEW.store_id
          AND p.id = NEW.customer_payment_id
          AND p.status = 'draft'
    );

    SELECT RAISE(ABORT, 'CUSTOMER_ALLOCATION_CUSTOMER_MISMATCH')
    WHERE NOT (
        (
            NEW.sale_id IS NOT NULL
            AND EXISTS (
                SELECT 1
                FROM customer_payments p
                JOIN sales s
                  ON s.store_id = p.store_id
                 AND s.id = NEW.sale_id
                WHERE p.store_id = NEW.store_id
                  AND p.id = NEW.customer_payment_id
                  AND p.customer_id = s.customer_id
                  AND s.status = 'posted'
            )
        )
        OR
        (
            NEW.opening_receivable_ledger_entry_id IS NOT NULL
            AND EXISTS (
                SELECT 1
                FROM customer_payments p
                JOIN customer_ledger_entries opening
                  ON opening.store_id = p.store_id
                 AND opening.id = NEW.opening_receivable_ledger_entry_id
                WHERE p.store_id = NEW.store_id
                  AND p.id = NEW.customer_payment_id
                  AND p.customer_id = opening.customer_id
                  AND opening.entry_type = 'opening_balance'
                  AND opening.receivable_delta_minor > 0
                  AND opening.credit_delta_minor = 0
                  AND opening.source_sale_id IS NULL
                  AND opening.reference_type = 'customer_opening_receivable'
                  AND opening.reference_id = opening.id
                  AND opening.reversal_of_id IS NULL
            )
        )
    );
END;

CREATE TRIGGER trg_customer_allocations_draft_only_update
BEFORE UPDATE ON customer_payment_allocations
BEGIN
    SELECT RAISE(ABORT, 'POSTED_CUSTOMER_ALLOCATION_IMMUTABLE')
    WHERE NOT EXISTS (
        SELECT 1 FROM customer_payments p
        WHERE p.store_id = OLD.store_id
          AND p.id = OLD.customer_payment_id
          AND p.status = 'draft'
    );
END;

CREATE TRIGGER trg_customer_allocations_draft_only_delete
BEFORE DELETE ON customer_payment_allocations
BEGIN
    SELECT RAISE(ABORT, 'POSTED_CUSTOMER_ALLOCATION_CANNOT_BE_DELETED')
    WHERE NOT EXISTS (
        SELECT 1 FROM customer_payments p
        WHERE p.store_id = OLD.store_id
          AND p.id = OLD.customer_payment_id
          AND p.status = 'draft'
    );
END;

CREATE TRIGGER trg_customer_allocations_totals_ai
AFTER INSERT ON customer_payment_allocations
BEGIN
    UPDATE customer_payments
    SET
        allocated_total_minor = COALESCE((
            SELECT SUM(amount_minor)
            FROM customer_payment_allocations
            WHERE store_id = NEW.store_id AND customer_payment_id = NEW.customer_payment_id
        ), 0),
        credit_created_minor = amount_minor - COALESCE((
            SELECT SUM(amount_minor)
            FROM customer_payment_allocations
            WHERE store_id = NEW.store_id AND customer_payment_id = NEW.customer_payment_id
        ), 0)
    WHERE store_id = NEW.store_id AND id = NEW.customer_payment_id;
END;

CREATE TRIGGER trg_customer_allocations_totals_au
AFTER UPDATE ON customer_payment_allocations
BEGIN
    UPDATE customer_payments
    SET
        allocated_total_minor = COALESCE((
            SELECT SUM(amount_minor)
            FROM customer_payment_allocations
            WHERE store_id = NEW.store_id AND customer_payment_id = NEW.customer_payment_id
        ), 0),
        credit_created_minor = amount_minor - COALESCE((
            SELECT SUM(amount_minor)
            FROM customer_payment_allocations
            WHERE store_id = NEW.store_id AND customer_payment_id = NEW.customer_payment_id
        ), 0)
    WHERE store_id = NEW.store_id AND id = NEW.customer_payment_id;
END;

CREATE TRIGGER trg_customer_allocations_totals_ad
AFTER DELETE ON customer_payment_allocations
BEGIN
    UPDATE customer_payments
    SET
        allocated_total_minor = COALESCE((
            SELECT SUM(amount_minor)
            FROM customer_payment_allocations
            WHERE store_id = OLD.store_id AND customer_payment_id = OLD.customer_payment_id
        ), 0),
        credit_created_minor = amount_minor - COALESCE((
            SELECT SUM(amount_minor)
            FROM customer_payment_allocations
            WHERE store_id = OLD.store_id AND customer_payment_id = OLD.customer_payment_id
        ), 0)
    WHERE store_id = OLD.store_id AND id = OLD.customer_payment_id;
END;

CREATE TRIGGER trg_customer_payment_post_validate
BEFORE UPDATE OF status ON customer_payments
WHEN OLD.status = 'draft' AND NEW.status = 'posted'
BEGIN
    SELECT RAISE(ABORT, 'CUSTOMER_PAYMENT_PERIOD_NOT_OPEN')
    WHERE NEW.accounting_period_id IS NULL
       OR NOT EXISTS (
            SELECT 1 FROM accounting_periods p
            WHERE p.store_id = NEW.store_id
              AND p.id = NEW.accounting_period_id
              AND p.status = 'open'
              AND NEW.payment_at >= p.starts_at
              AND NEW.payment_at < p.ends_at
       );

    SELECT RAISE(ABORT, 'CUSTOMER_PAYMENT_ALLOCATION_EXCEEDS_AMOUNT')
    WHERE NEW.allocated_total_minor > NEW.amount_minor;

    SELECT RAISE(ABORT, 'CUSTOMER_PAYMENT_MONEY_MOVEMENT_MISMATCH')
    WHERE NOT EXISTS (
        SELECT 1
        FROM money_movements m
        WHERE m.store_id = NEW.store_id
          AND m.id = NEW.money_movement_id
          AND m.account_id = NEW.money_account_id
          AND m.amount_delta_minor = NEW.amount_minor
          AND m.movement_type = 'customer_payment'
          AND m.reference_type = 'customer_payment'
          AND m.reference_id = NEW.id
          AND m.accounting_period_id = NEW.accounting_period_id
    );

    SELECT RAISE(ABORT, 'CUSTOMER_PAYMENT_ALLOCATION_LEDGER_MISMATCH')
    WHERE EXISTS (
        SELECT 1
        FROM customer_payment_allocations a
        LEFT JOIN customer_ledger_entries l
          ON l.store_id = a.store_id
         AND l.id = a.customer_ledger_entry_id
        WHERE a.store_id = NEW.store_id
          AND a.customer_payment_id = NEW.id
          AND (
              l.id IS NULL
              OR l.customer_id <> NEW.customer_id
              OR l.entry_type <> 'payment'
              OR l.receivable_delta_minor <> -a.amount_minor
              OR l.credit_delta_minor <> 0
              OR l.source_sale_id IS NOT a.sale_id
              OR l.reference_type <> 'customer_payment'
              OR l.reference_id <> NEW.id
              OR l.accounting_period_id <> NEW.accounting_period_id
          )
    );

    SELECT RAISE(ABORT, 'CUSTOMER_PAYMENT_CREDIT_LEDGER_MISMATCH')
    WHERE COALESCE((
        SELECT SUM(l.credit_delta_minor)
        FROM customer_ledger_entries l
        WHERE l.store_id = NEW.store_id
          AND l.customer_id = NEW.customer_id
          AND l.reference_type = 'customer_payment'
          AND l.reference_id = NEW.id
          AND l.entry_type = 'credit_created'
    ), 0) <> NEW.credit_created_minor;
END;

CREATE TRIGGER trg_customer_payment_outstanding_validate
BEFORE UPDATE OF status ON customer_payments
WHEN OLD.status = 'draft' AND NEW.status = 'posted'
BEGIN
    SELECT RAISE(ABORT, 'CUSTOMER_ALLOCATION_EXCEEDS_RECEIVABLE_OUTSTANDING')
    WHERE EXISTS (
        SELECT 1
        FROM customer_payment_allocations a
        WHERE a.store_id = NEW.store_id
          AND a.customer_payment_id = NEW.id
          AND a.amount_minor > CASE
              WHEN a.sale_id IS NOT NULL THEN COALESCE((
                  SELECT SUM(l.receivable_delta_minor)
                  FROM customer_ledger_entries l
                  WHERE l.store_id = NEW.store_id
                    AND l.customer_id = NEW.customer_id
                    AND l.source_sale_id = a.sale_id
                    AND NOT (
                        l.reference_type = 'customer_payment'
                        AND l.reference_id = NEW.id
                    )
              ), 0)
              ELSE COALESCE((
                  SELECT opening.receivable_delta_minor - COALESCE(SUM(prior.amount_minor), 0)
                  FROM customer_ledger_entries opening
                  LEFT JOIN customer_payment_allocations prior
                    ON prior.store_id = opening.store_id
                   AND prior.opening_receivable_ledger_entry_id = opening.id
                   AND prior.customer_payment_id <> NEW.id
                  WHERE opening.store_id = NEW.store_id
                    AND opening.id = a.opening_receivable_ledger_entry_id
                  GROUP BY opening.receivable_delta_minor
              ), 0)
          END
    );
END;

-- Sale Customer Credit is a liability tender, not a negative receivable.
CREATE TABLE sale_customer_credit_applications (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    sale_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    customer_ledger_entry_id TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    applied_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (store_id, id),
    UNIQUE (store_id, sale_id),
    UNIQUE (store_id, customer_ledger_entry_id),
    FOREIGN KEY (store_id, sale_id)
        REFERENCES sales(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, customer_id)
        REFERENCES customers(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (store_id, customer_ledger_entry_id)
        REFERENCES customer_ledger_entries(store_id, id)
        ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER trg_sale_customer_credit_application_lineage
BEFORE INSERT ON sale_customer_credit_applications
BEGIN
    SELECT RAISE(ABORT, 'SALE_CUSTOMER_CREDIT_LINEAGE_INVALID')
    WHERE NOT EXISTS (
        SELECT 1
        FROM sales s
        JOIN customer_ledger_entries l
          ON l.store_id = s.store_id
         AND l.id = NEW.customer_ledger_entry_id
        WHERE s.store_id = NEW.store_id
          AND s.id = NEW.sale_id
          AND s.customer_id = NEW.customer_id
          AND l.customer_id = NEW.customer_id
          AND l.entry_type = 'credit_used'
          AND l.receivable_delta_minor = 0
          AND l.credit_delta_minor = -NEW.amount_minor
          AND l.source_sale_id = NEW.sale_id
          AND l.reference_type = 'sale'
          AND l.reference_id = NEW.sale_id
          AND l.reversal_of_id IS NULL
    );
END;

CREATE TRIGGER trg_sale_customer_credit_application_no_update
BEFORE UPDATE ON sale_customer_credit_applications
BEGIN
    SELECT RAISE(ABORT, 'SALE_CUSTOMER_CREDIT_APPLICATION_IMMUTABLE');
END;

CREATE TRIGGER trg_sale_customer_credit_application_no_delete
BEFORE DELETE ON sale_customer_credit_applications
BEGIN
    SELECT RAISE(ABORT, 'SALE_CUSTOMER_CREDIT_APPLICATION_IMMUTABLE');
END;

UPDATE local_meta
SET value = '1.3.0'
WHERE key = 'schema_version';

PRAGMA user_version = 10300;
COMMIT;
