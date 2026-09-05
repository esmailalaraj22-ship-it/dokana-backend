-- S11.2: immutable manual inventory facts and a movement-maintained projection.
-- The runner owns this transaction. No baseline, supplier, or goods-receipt changes.
-- New mandatory snapshots deliberately fail on populated legacy inventory tables:
-- never classify historical zero/estimated values or invent accepted unit facts.
-- Ownership stays with the existing NOLOGIN, non-BYPASSRLS migrator. Only the
-- projection trigger elevates to that owner; FORCE RLS and explicit context apply.
-- Rollback: transaction failure restores the previous schema and grants. After
-- commit, use an owner-approved forward repair; do not drop accepted facts or
-- restore unrestricted projection DML. SQLite parity is deferred to its own work.

DO $preconditions$
BEGIN
    IF session_user <> 'dokana_migration_login' OR current_user <> 'shop_app_migrator'
       OR EXISTS (
           SELECT 1 FROM pg_catalog.pg_roles
           WHERE rolname = current_user AND (rolsuper OR rolbypassrls OR rolcanlogin)
       ) THEN
        RAISE EXCEPTION '0007 requires the approved migration session and owner';
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_class
        WHERE oid IN ('ledger.inventory_movements'::regclass, 'ledger.stock_balances'::regclass,
                      'ledger.stock_counts'::regclass, 'ledger.stock_count_items'::regclass)
          AND relowner = current_user::regrole AND relrowsecurity AND relforcerowsecurity) <> 4
       OR (SELECT proowner FROM pg_catalog.pg_proc
           WHERE oid = 'ledger.apply_inventory_movement()'::regprocedure) <> current_user::regrole THEN
        RAISE EXCEPTION '0007 encountered unexpected inventory ownership or RLS';
    END IF;
END;
$preconditions$;

-- NUMERIC is an exact, widened intermediate, never a floating point quantity.
-- Only the accepted inputs and final quotient must fit int8, not their product.
CREATE FUNCTION ledger.inventory_base_quantity(p_selected bigint, p_num integer, p_den integer)
RETURNS bigint
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    numerator numeric;
    result numeric;
BEGIN
    IF p_selected < 0 OR p_num <= 0 OR p_den <= 0 THEN
        RAISE EXCEPTION 'Invalid inventory quantity or unit factor' USING ERRCODE = '23514';
    END IF;
    numerator := p_selected::numeric * p_num::numeric;
    IF mod(numerator, p_den::numeric) <> 0 THEN
        RAISE EXCEPTION 'Inventory quantity is not exactly representable' USING ERRCODE = '23514';
    END IF;
    result := div(numerator, p_den::numeric);
    IF result > 9223372036854775807 THEN
        RAISE EXCEPTION 'Inventory quantity exceeds int8' USING ERRCODE = '22003';
    END IF;
    RETURN result::bigint;
END;
$function$;
REVOKE ALL ON FUNCTION ledger.inventory_base_quantity(bigint, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger.inventory_base_quantity(bigint, integer, integer)
    TO shop_app_runtime, shop_app_readonly;

ALTER TABLE ledger.inventory_movements
    ADD COLUMN product_unit_id uuid NOT NULL,
    ADD COLUMN selected_quantity_milli bigint NOT NULL,
    ADD COLUMN factor_num integer NOT NULL,
    ADD COLUMN factor_den integer NOT NULL,
    ADD COLUMN business_date date NOT NULL,
    ADD COLUMN posting_date date NOT NULL,
    ADD COLUMN cost_state_before text NOT NULL,
    ADD COLUMN cost_state_after text NOT NULL,
    DROP CONSTRAINT inventory_movements_cost_status_check,
    ADD CONSTRAINT inventory_movements_cost_status_check CHECK (cost_status IN ('known', 'unknown', 'pending')),
    ADD CONSTRAINT inventory_movements_cost_state_before_check CHECK (cost_state_before IN ('known', 'unknown', 'pending')),
    ADD CONSTRAINT inventory_movements_cost_state_after_check CHECK (cost_state_after IN ('known', 'unknown', 'pending')),
    ADD CONSTRAINT inventory_movements_unit_fkey FOREIGN KEY (store_id, product_id, product_unit_id)
        REFERENCES ledger.product_units(store_id, product_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT inventory_movements_quantity_snapshot_check CHECK (
        selected_quantity_milli > 0 AND factor_num > 0 AND factor_den > 0
        AND abs(quantity_delta_milli::numeric) =
            ledger.inventory_base_quantity(selected_quantity_milli, factor_num, factor_den)::numeric),
    ADD CONSTRAINT inventory_movements_dates_check CHECK (
        isfinite(occurred_at) AND business_date = (occurred_at AT TIME ZONE 'Asia/Hebron')::date
        AND posting_date = business_date),
    ADD CONSTRAINT inventory_movements_cost_values_check CHECK (
        (cost_state_before = 'known' OR inventory_value_before_minor = 0)
        AND (cost_state_after = 'known' OR (inventory_value_after_minor = 0 AND average_unit_cost_after_minor = 0))
        AND (cost_state_after <> 'known' OR inventory_value_after_minor >= 0)
        AND has_pending_cost_after = (cost_state_after = 'pending')
        AND (quantity_after_milli >= 0 OR cost_state_after = 'pending')),
    ADD CONSTRAINT inventory_movements_cost_transition_check CHECK (
        (cost_status <> 'unknown' OR cost_state_after <> 'known' OR quantity_after_milli = 0)
        AND (cost_state_before = 'known' OR cost_state_after <> 'known'
             OR quantity_before_milli = 0 OR quantity_after_milli = 0)),
    ADD CONSTRAINT inventory_movements_product_identity_key UNIQUE (store_id, product_id, id);

ALTER TABLE ledger.inventory_movements
    ADD CONSTRAINT inventory_movements_reversal_product_fkey FOREIGN KEY (store_id, product_id, reversal_of_id)
        REFERENCES ledger.inventory_movements(store_id, product_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT inventory_movements_reversal_identity_check CHECK (reversal_of_id IS NULL OR reversal_of_id <> id);

ALTER TABLE ledger.stock_balances
    ADD COLUMN cost_state text NOT NULL,
    ADD CONSTRAINT stock_balances_cost_state_check CHECK (cost_state IN ('known', 'unknown', 'pending')),
    ADD CONSTRAINT stock_balances_cost_values_check CHECK (
        (cost_state = 'known' OR (inventory_value_minor = 0 AND average_unit_cost_minor = 0))
        AND (cost_state <> 'known' OR inventory_value_minor >= 0)
        AND has_pending_cost = (cost_state = 'pending')
        AND (quantity_milli >= 0 OR cost_state = 'pending')
        AND (quantity_milli <> 0 OR (inventory_value_minor = 0 AND average_unit_cost_minor = 0))),
    ADD CONSTRAINT stock_balances_last_movement_fkey FOREIGN KEY (store_id, product_id, last_movement_id)
        REFERENCES ledger.inventory_movements(store_id, product_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE ledger.manual_inventory_entries (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    product_id uuid NOT NULL,
    product_unit_id uuid NOT NULL,
    selected_quantity_milli bigint NOT NULL CHECK (selected_quantity_milli > 0),
    base_quantity_milli bigint NOT NULL CHECK (base_quantity_milli > 0),
    factor_num integer NOT NULL CHECK (factor_num > 0),
    factor_den integer NOT NULL CHECK (factor_den > 0),
    total_purchase_cost_minor bigint CHECK (total_purchase_cost_minor >= 0),
    cost_status text NOT NULL CHECK (cost_status IN ('known', 'unknown', 'pending')),
    occurred_at timestamptz NOT NULL,
    business_date date NOT NULL,
    posting_date date NOT NULL,
    accounting_period_id uuid NOT NULL,
    movement_id uuid NOT NULL,
    transaction_group_id uuid NOT NULL,
    reason text,
    device_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (store_id, id),
    UNIQUE (store_id, operation_id),
    UNIQUE (store_id, movement_id),
    CONSTRAINT manual_inventory_entries_product_fkey FOREIGN KEY (store_id, product_id)
        REFERENCES ledger.products(store_id, id) ON DELETE RESTRICT,
    CONSTRAINT manual_inventory_entries_unit_fkey FOREIGN KEY (store_id, product_id, product_unit_id)
        REFERENCES ledger.product_units(store_id, product_id, id) ON DELETE RESTRICT,
    CONSTRAINT manual_inventory_entries_period_fkey FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES ledger.accounting_periods(store_id, id) ON DELETE RESTRICT,
    CONSTRAINT manual_inventory_entries_device_fkey FOREIGN KEY (store_id, device_id)
        REFERENCES ledger.devices(store_id, id) ON DELETE RESTRICT,
    CONSTRAINT manual_inventory_entries_movement_fkey FOREIGN KEY (store_id, product_id, movement_id)
        REFERENCES ledger.inventory_movements(store_id, product_id, id) DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT manual_inventory_entries_quantity_check CHECK (
        base_quantity_milli = ledger.inventory_base_quantity(selected_quantity_milli, factor_num, factor_den)),
    CONSTRAINT manual_inventory_entries_cost_check CHECK (
        (total_purchase_cost_minor IS NULL OR cost_status = 'known')
        AND (cost_status <> 'unknown' OR total_purchase_cost_minor IS NULL)),
    CONSTRAINT manual_inventory_entries_dates_check CHECK (
        isfinite(occurred_at) AND business_date = (occurred_at AT TIME ZONE 'Asia/Hebron')::date
        AND posting_date = business_date),
    CONSTRAINT manual_inventory_entries_group_check CHECK (transaction_group_id = operation_id)
);
ALTER TABLE ledger.manual_inventory_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.manual_inventory_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY manual_inventory_entries_store_isolation ON ledger.manual_inventory_entries
    USING (store_id = platform.current_store_id()) WITH CHECK (store_id = platform.current_store_id());
REVOKE ALL ON ledger.manual_inventory_entries FROM PUBLIC;
GRANT SELECT, INSERT ON ledger.manual_inventory_entries TO shop_app_runtime;
GRANT SELECT ON ledger.manual_inventory_entries TO shop_app_readonly;

CREATE INDEX idx_manual_inventory_entries_product_time
    ON ledger.manual_inventory_entries(store_id, product_id, occurred_at, id);
CREATE INDEX idx_inventory_movements_group ON ledger.inventory_movements(store_id, transaction_group_id, id);
CREATE UNIQUE INDEX uq_inventory_movement_reversal
    ON ledger.inventory_movements(store_id, reversal_of_id) WHERE reversal_of_id IS NOT NULL;

-- Keep the Product -> Unit locking order used by catalog lifecycle writes.
CREATE FUNCTION ledger.validate_inventory_unit()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    p ledger.products%ROWTYPE;
    u ledger.product_units%ROWTYPE;
BEGIN
    IF NEW.store_id IS DISTINCT FROM nullif(current_setting('app.store_id', true), '')::uuid
       OR nullif(current_setting('app.user_id', true), '')::uuid IS NULL
       OR nullif(current_setting('app.device_id', true), '')::uuid IS NULL
       OR nullif(current_setting('app.request_id', true), '')::uuid IS NULL THEN
        RAISE EXCEPTION 'Inventory tenant context is required' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO p FROM ledger.products WHERE store_id = NEW.store_id AND id = NEW.product_id FOR UPDATE;
    IF NOT FOUND OR p.status <> 'active' OR NOT p.track_inventory THEN
        RAISE EXCEPTION 'Inventory Product is unavailable' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO u FROM ledger.product_units
        WHERE store_id = NEW.store_id AND product_id = NEW.product_id AND id = NEW.product_unit_id FOR SHARE;
    IF NOT FOUND OR u.status <> 'active' OR u.measurement_type <> p.measurement_type
       OR u.factor_num <> NEW.factor_num OR u.factor_den <> NEW.factor_den THEN
        RAISE EXCEPTION 'Inventory ProductUnit is unavailable or stale' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION ledger.validate_inventory_unit() FROM PUBLIC;

CREATE TRIGGER trg_manual_inventory_entries_unit BEFORE INSERT ON ledger.manual_inventory_entries
    FOR EACH ROW EXECUTE FUNCTION ledger.validate_inventory_unit();
CREATE TRIGGER trg_manual_inventory_entries_no_mutation BEFORE UPDATE OR DELETE ON ledger.manual_inventory_entries
    FOR EACH ROW EXECUTE FUNCTION ledger.prevent_mutation();
CREATE TRIGGER trg_manual_inventory_entries_change_event AFTER INSERT ON ledger.manual_inventory_entries
    FOR EACH ROW EXECUTE FUNCTION sync.capture_change_event();
CREATE TRIGGER trg_manual_inventory_entries_audit AFTER INSERT ON ledger.manual_inventory_entries
    FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();

-- A deferred relationship allows either insertion order within the atomic operation.
CREATE FUNCTION ledger.validate_manual_inventory_movement()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    m ledger.inventory_movements%ROWTYPE;
BEGIN
    SELECT * INTO m FROM ledger.inventory_movements WHERE store_id = NEW.store_id AND id = NEW.movement_id;
    IF NOT FOUND OR (m.product_id, m.product_unit_id, m.selected_quantity_milli, m.factor_num, m.factor_den,
                    m.occurred_at, m.business_date, m.posting_date, m.accounting_period_id,
                    m.transaction_group_id, m.device_id, m.cost_status)
        IS DISTINCT FROM (NEW.product_id, NEW.product_unit_id, NEW.selected_quantity_milli, NEW.factor_num, NEW.factor_den,
                          NEW.occurred_at, NEW.business_date, NEW.posting_date, NEW.accounting_period_id,
                          NEW.transaction_group_id, NEW.device_id, NEW.cost_status)
       OR abs(m.quantity_delta_milli::numeric) <> NEW.base_quantity_milli::numeric
       OR m.reference_type <> 'manual_inventory_entry' OR m.reference_id <> NEW.id THEN
        RAISE EXCEPTION 'Manual inventory movement does not match accepted facts' USING ERRCODE = '23514';
    END IF;
    IF m.quantity_delta_milli > 0 AND m.reversal_of_id IS NULL
       AND ((NEW.total_purchase_cost_minor IS NULL AND NEW.cost_status <> 'unknown')
            OR (NEW.total_purchase_cost_minor IS NOT NULL AND m.cost_state_before = 'known'
                AND m.cost_state_after = 'known' AND m.value_delta_minor <> NEW.total_purchase_cost_minor)) THEN
        RAISE EXCEPTION 'Manual inventory purchase cost is inconsistent' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION ledger.validate_manual_inventory_movement() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_manual_inventory_entries_movement AFTER INSERT ON ledger.manual_inventory_entries
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.validate_manual_inventory_movement();

CREATE FUNCTION ledger.validate_inventory_manual_reference()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
    IF NEW.reference_type = 'manual_inventory_entry' AND NOT EXISTS (
        SELECT 1 FROM ledger.manual_inventory_entries e
        WHERE e.store_id = NEW.store_id AND e.id = NEW.reference_id AND e.product_id = NEW.product_id
          AND e.transaction_group_id = NEW.transaction_group_id
          AND (e.movement_id = NEW.id OR NEW.reversal_of_id IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'Manual inventory reference is unavailable' USING ERRCODE = '23503';
    END IF;
    RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION ledger.validate_inventory_manual_reference() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_inventory_manual_reference AFTER INSERT ON ledger.inventory_movements
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.validate_inventory_manual_reference();

CREATE OR REPLACE FUNCTION ledger.apply_inventory_movement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    b ledger.stock_balances%ROWTYPE;
    p ledger.products%ROWTYPE;
    u ledger.product_units%ROWTYPE;
    allow_negative boolean;
BEGIN
    IF TG_RELID <> 'ledger.inventory_movements'::regclass OR TG_OP <> 'INSERT'
       OR NEW.store_id IS DISTINCT FROM nullif(current_setting('app.store_id', true), '')::uuid
       OR nullif(current_setting('app.user_id', true), '')::uuid IS NULL
       OR nullif(current_setting('app.device_id', true), '')::uuid IS NULL
       OR nullif(current_setting('app.request_id', true), '')::uuid IS NULL
       OR NEW.device_id IS DISTINCT FROM nullif(current_setting('app.device_id', true), '')::uuid THEN
        RAISE EXCEPTION 'Inventory tenant context is required' USING ERRCODE = '42501';
    END IF;
    -- Preserve S9's eligibility check and hold its period row for the transaction.
    PERFORM 1 FROM ledger.accounting_periods
        WHERE store_id = NEW.store_id AND id = NEW.accounting_period_id FOR SHARE;
    PERFORM ledger.assert_period_open(NEW.store_id, NEW.accounting_period_id, NEW.occurred_at);
    SELECT * INTO p FROM ledger.products WHERE store_id = NEW.store_id AND id = NEW.product_id FOR UPDATE;
    IF NOT FOUND OR p.status <> 'active' OR NOT p.track_inventory THEN
        RAISE EXCEPTION 'Inventory Product is unavailable' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO u FROM ledger.product_units
        WHERE store_id = NEW.store_id AND product_id = NEW.product_id AND id = NEW.product_unit_id FOR SHARE;
    IF NOT FOUND OR u.status <> 'active' OR u.measurement_type <> p.measurement_type
       OR u.factor_num <> NEW.factor_num OR u.factor_den <> NEW.factor_den THEN
        RAISE EXCEPTION 'Inventory ProductUnit is unavailable or stale' USING ERRCODE = '23514';
    END IF;
    IF NEW.selected_quantity_milli <= 0 OR NEW.quantity_delta_milli = 0
       OR abs(NEW.quantity_delta_milli::numeric) <>
            ledger.inventory_base_quantity(NEW.selected_quantity_milli, NEW.factor_num, NEW.factor_den)::numeric THEN
        RAISE EXCEPTION 'Inventory quantity is inconsistent' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO b FROM ledger.stock_balances
        WHERE store_id = NEW.store_id AND product_id = NEW.product_id FOR UPDATE;
    IF NOT FOUND THEN
        -- The Product lock serializes concurrent creation of the first projection.
        INSERT INTO ledger.stock_balances(store_id, product_id, cost_state)
            VALUES (NEW.store_id, NEW.product_id, 'known');
        SELECT * INTO b FROM ledger.stock_balances
            WHERE store_id = NEW.store_id AND product_id = NEW.product_id FOR UPDATE;
    END IF;
    IF (NEW.quantity_before_milli, NEW.inventory_value_before_minor, NEW.cost_state_before)
       IS DISTINCT FROM (b.quantity_milli, b.inventory_value_minor, b.cost_state) THEN
        RAISE EXCEPTION 'Stale inventory snapshot' USING ERRCODE = '40001';
    END IF;
    IF NEW.quantity_after_milli::numeric <> NEW.quantity_before_milli::numeric + NEW.quantity_delta_milli::numeric
       OR NEW.inventory_value_after_minor::numeric <> NEW.inventory_value_before_minor::numeric + NEW.value_delta_minor::numeric THEN
        RAISE EXCEPTION 'Inventory movement arithmetic is inconsistent' USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(p.allow_negative_stock_override, s.allow_negative_stock, false)
        INTO allow_negative FROM ledger.app_settings s WHERE s.store_id = NEW.store_id FOR SHARE;
    allow_negative := COALESCE(p.allow_negative_stock_override, allow_negative, false);
    IF NEW.quantity_after_milli < 0 AND NOT allow_negative THEN
        RAISE EXCEPTION 'Negative inventory is not permitted' USING ERRCODE = '23514';
    END IF;
    IF NEW.cost_state_after = 'known' AND NEW.quantity_after_milli > 0
       AND NEW.average_unit_cost_after_minor::numeric <>
           div(NEW.inventory_value_after_minor::numeric * 2000 + NEW.quantity_after_milli::numeric,
               NEW.quantity_after_milli::numeric * 2) THEN
        RAISE EXCEPTION 'Inventory average cost is inconsistent' USING ERRCODE = '23514';
    END IF;
    UPDATE ledger.stock_balances SET
        quantity_milli = NEW.quantity_after_milli,
        average_unit_cost_minor = NEW.average_unit_cost_after_minor,
        inventory_value_minor = NEW.inventory_value_after_minor,
        cost_state = NEW.cost_state_after,
        has_pending_cost = NEW.has_pending_cost_after,
        last_movement_id = NEW.id, updated_at = clock_timestamp(), version = version + 1
        WHERE store_id = NEW.store_id AND product_id = NEW.product_id;
    RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION ledger.apply_inventory_movement() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger.apply_inventory_movement() TO shop_app_runtime;
REVOKE INSERT, UPDATE, DELETE ON ledger.stock_balances FROM shop_app_runtime;
REVOKE UPDATE, DELETE ON ledger.inventory_movements FROM shop_app_runtime;
CREATE TRIGGER trg_inventory_movements_change_event AFTER INSERT ON ledger.inventory_movements
    FOR EACH ROW EXECUTE FUNCTION sync.capture_change_event();
CREATE TRIGGER trg_inventory_movements_audit AFTER INSERT ON ledger.inventory_movements
    FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();

ALTER TABLE ledger.stock_counts
    ADD COLUMN occurred_at timestamptz,
    ADD COLUMN business_date date,
    ADD COLUMN posting_date date,
    ADD CONSTRAINT stock_counts_posting_context_check CHECK (
        status <> 'posted' OR (accounting_period_id IS NOT NULL AND occurred_at IS NOT NULL
            AND business_date IS NOT NULL AND posting_date IS NOT NULL AND isfinite(occurred_at)
            AND business_date = (occurred_at AT TIME ZONE 'Asia/Hebron')::date AND posting_date = business_date));
ALTER TABLE ledger.stock_count_items
    ADD COLUMN product_unit_id uuid NOT NULL,
    ADD COLUMN selected_quantity_milli bigint NOT NULL,
    ADD COLUMN factor_num integer NOT NULL,
    ADD COLUMN factor_den integer NOT NULL,
    ADD CONSTRAINT stock_count_items_unit_fkey FOREIGN KEY (store_id, product_id, product_unit_id)
        REFERENCES ledger.product_units(store_id, product_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT stock_count_items_movement_product_fkey FOREIGN KEY (store_id, product_id, adjustment_movement_id)
        REFERENCES ledger.inventory_movements(store_id, product_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT stock_count_items_actual_quantity_check CHECK (
        actual_quantity_milli >= 0 AND selected_quantity_milli >= 0 AND factor_num > 0 AND factor_den > 0
        AND actual_quantity_milli = ledger.inventory_base_quantity(selected_quantity_milli, factor_num, factor_den));

-- Dedicated count guards avoid changing any other aggregate's draft semantics.
CREATE FUNCTION ledger.guard_inventory_count_item()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    parent ledger.stock_counts%ROWTYPE;
BEGIN
    IF TG_OP = 'UPDATE' AND (NEW.id, NEW.store_id, NEW.stock_count_id, NEW.product_id)
       IS DISTINCT FROM (OLD.id, OLD.store_id, OLD.stock_count_id, OLD.product_id) THEN
        RAISE EXCEPTION 'Stock count item identity is immutable' USING ERRCODE = '55000';
    END IF;
    SELECT * INTO parent FROM ledger.stock_counts
        WHERE store_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.store_id ELSE NEW.store_id END
          AND id = CASE WHEN TG_OP = 'DELETE' THEN OLD.stock_count_id ELSE NEW.stock_count_id END FOR UPDATE;
    IF NOT FOUND OR parent.status NOT IN ('draft', 'counting') THEN
        RAISE EXCEPTION 'Stock count is not editable' USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION ledger.guard_inventory_count_item() FROM PUBLIC;
DROP TRIGGER trg_stock_count_items_parent_draft ON ledger.stock_count_items;
CREATE TRIGGER trg_stock_count_items_parent_draft BEFORE INSERT OR UPDATE OR DELETE ON ledger.stock_count_items
    FOR EACH ROW EXECUTE FUNCTION ledger.guard_inventory_count_item();
CREATE TRIGGER trg_stock_count_items_unit BEFORE INSERT OR UPDATE ON ledger.stock_count_items
    FOR EACH ROW EXECUTE FUNCTION ledger.validate_inventory_unit();

CREATE FUNCTION ledger.guard_inventory_count_header()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.status NOT IN ('draft', 'counting') THEN
        RAISE EXCEPTION 'Stock count must start editable' USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'UPDATE' AND (OLD.status IN ('posted', 'cancelled')
        OR (NEW.id, NEW.store_id) IS DISTINCT FROM (OLD.id, OLD.store_id)) THEN
        RAISE EXCEPTION 'Final stock count or identity is immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW.status = 'posted' THEN
        PERFORM 1 FROM ledger.accounting_periods
            WHERE store_id = NEW.store_id AND id = NEW.accounting_period_id FOR SHARE;
        PERFORM ledger.assert_period_open(NEW.store_id, NEW.accounting_period_id, NEW.occurred_at);
    END IF;
    RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION ledger.guard_inventory_count_header() FROM PUBLIC;
CREATE TRIGGER trg_stock_counts_inventory_guard BEFORE INSERT OR UPDATE ON ledger.stock_counts
    FOR EACH ROW EXECUTE FUNCTION ledger.guard_inventory_count_header();
REVOKE DELETE ON ledger.stock_counts FROM shop_app_runtime;

CREATE FUNCTION ledger.validate_inventory_count_facts()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
    IF NEW.status = 'posted' AND EXISTS (
        SELECT 1 FROM ledger.stock_count_items i
        LEFT JOIN ledger.inventory_movements m ON m.store_id = i.store_id AND m.id = i.adjustment_movement_id
        WHERE i.store_id = NEW.store_id AND i.stock_count_id = NEW.id
          AND ((i.difference_milli = 0 AND i.adjustment_movement_id IS NOT NULL)
               OR (i.difference_milli <> 0 AND (m.id IS NULL
                   OR (m.product_id, m.quantity_before_milli, m.quantity_delta_milli, m.quantity_after_milli,
                       m.accounting_period_id, m.occurred_at, m.business_date, m.posting_date)
                      IS DISTINCT FROM (i.product_id, i.system_quantity_milli, i.difference_milli, i.actual_quantity_milli,
                                        NEW.accounting_period_id, NEW.occurred_at, NEW.business_date, NEW.posting_date)
                   OR m.reference_type <> 'stock_count' OR m.reference_id <> NEW.id)))
    ) THEN
        RAISE EXCEPTION 'Posted stock count movement facts are inconsistent' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION ledger.validate_inventory_count_facts() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_stock_counts_inventory_facts AFTER INSERT OR UPDATE ON ledger.stock_counts
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.validate_inventory_count_facts();

DO $postconditions$
BEGIN
    IF (SELECT proowner <> current_user::regrole OR NOT prosecdef
               OR proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
        FROM pg_catalog.pg_proc WHERE oid = 'ledger.apply_inventory_movement()'::regprocedure)
       OR pg_catalog.has_table_privilege('shop_app_runtime', 'ledger.stock_balances', 'INSERT,UPDATE,DELETE')
       OR NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_catalog.pg_class
               WHERE oid = 'ledger.manual_inventory_entries'::regclass) THEN
        RAISE EXCEPTION '0007 inventory security postconditions failed';
    END IF;
END;
$postconditions$;
