-- S11.5: represent a physical zero count without inventing a prior zero balance.
-- The runner owns the transaction. The reference package and SQLite stay frozen.
-- Rollback before commit is transactional. After commit, use an approved forward
-- migration; accepted count and movement facts must never be deleted or rewritten.

DO $preconditions$
BEGIN
    IF session_user <> 'dokana_migration_login' OR current_user <> 'shop_app_migrator'
       OR EXISTS (
           SELECT 1 FROM pg_catalog.pg_roles
           WHERE rolname = current_user AND (rolsuper OR rolbypassrls OR rolcanlogin)
       ) THEN
        RAISE EXCEPTION '0008 requires the approved migration session and owner';
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_class
        WHERE oid IN ('ledger.inventory_movements'::regclass, 'ledger.stock_balances'::regclass,
                      'ledger.stock_counts'::regclass, 'ledger.stock_count_items'::regclass)
          AND relowner = current_user::regrole AND relrowsecurity AND relforcerowsecurity) <> 4
       OR (SELECT proowner <> current_user::regrole OR NOT prosecdef
                  OR proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
           FROM pg_catalog.pg_proc
           WHERE oid = 'ledger.apply_inventory_movement()'::regprocedure) THEN
        RAISE EXCEPTION '0008 encountered unexpected inventory ownership, RLS, or trigger state';
    END IF;
END;
$preconditions$;

ALTER TABLE ledger.inventory_movements
    ADD COLUMN quantity_fact_kind text NOT NULL DEFAULT 'movement',
    ADD CONSTRAINT inventory_movements_quantity_fact_kind_check
        CHECK (quantity_fact_kind IN ('movement', 'count_zero_establishment')),
    DROP CONSTRAINT inventory_movements_quantity_delta_milli_check,
    DROP CONSTRAINT inventory_movements_quantity_snapshot_check,
    ADD CONSTRAINT inventory_movements_quantity_delta_milli_check CHECK (
        (quantity_fact_kind = 'movement' AND quantity_delta_milli <> 0)
        OR
        (quantity_fact_kind = 'count_zero_establishment'
         AND quantity_delta_milli = 0
         AND movement_type = 'stock_count'
         AND reference_type = 'stock_count'
         AND quantity_before_milli = 0
         AND quantity_after_milli = 0
         AND selected_quantity_milli = 0
         AND inventory_value_before_minor = 0
         AND value_delta_minor = 0
         AND inventory_value_after_minor = 0
         AND average_unit_cost_after_minor = 0
         AND cost_status = 'unknown'
         AND cost_state_before = 'unknown'
         AND cost_state_after = 'unknown'
         AND NOT has_pending_cost_after
         AND reversal_of_id IS NULL)),
    ADD CONSTRAINT inventory_movements_quantity_snapshot_check CHECK (
        factor_num > 0 AND factor_den > 0
        AND
        ((quantity_fact_kind = 'movement'
          AND selected_quantity_milli > 0
          AND abs(quantity_delta_milli::numeric) =
              ledger.inventory_base_quantity(selected_quantity_milli, factor_num, factor_den)::numeric)
         OR
         (quantity_fact_kind = 'count_zero_establishment'
          AND selected_quantity_milli = 0
          AND ledger.inventory_base_quantity(selected_quantity_milli, factor_num, factor_den) = 0)));

ALTER TABLE ledger.stock_count_items
    ADD COLUMN previous_projection_state text NOT NULL DEFAULT 'established';

ALTER TABLE ledger.stock_count_items
    ALTER COLUMN previous_projection_state DROP DEFAULT,
    ALTER COLUMN system_quantity_milli DROP NOT NULL,
    ALTER COLUMN difference_milli DROP NOT NULL,
    DROP CONSTRAINT stock_count_items_check,
    ADD CONSTRAINT stock_count_items_previous_projection_state_check
        CHECK (previous_projection_state IN ('missing', 'established')),
    ADD CONSTRAINT stock_count_items_previous_quantity_check CHECK (
        (previous_projection_state = 'missing'
         AND system_quantity_milli IS NULL
         AND difference_milli IS NULL)
        OR
        (previous_projection_state = 'established'
         AND system_quantity_milli IS NOT NULL
         AND difference_milli IS NOT NULL
         AND difference_milli = actual_quantity_milli - system_quantity_milli));

-- The application inserts the immutable accepted count item before its linked
-- movement so the movement trigger can prove the narrow zero exception.
ALTER TABLE ledger.stock_count_items
    ALTER CONSTRAINT stock_count_items_store_id_adjustment_movement_id_fkey
        DEFERRABLE INITIALLY DEFERRED,
    ALTER CONSTRAINT stock_count_items_movement_product_fkey
        DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION ledger.apply_inventory_movement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    b ledger.stock_balances%ROWTYPE;
    p ledger.products%ROWTYPE;
    u ledger.product_units%ROWTYPE;
    allow_negative boolean;
    zero_establishment boolean := NEW.quantity_fact_kind = 'count_zero_establishment';
    balance_exists boolean;
    count_establishment boolean := false;
BEGIN
    IF TG_RELID <> 'ledger.inventory_movements'::regclass OR TG_OP <> 'INSERT'
       OR NEW.store_id IS DISTINCT FROM nullif(current_setting('app.store_id', true), '')::uuid
       OR nullif(current_setting('app.user_id', true), '')::uuid IS NULL
       OR nullif(current_setting('app.device_id', true), '')::uuid IS NULL
       OR nullif(current_setting('app.request_id', true), '')::uuid IS NULL
       OR NEW.device_id IS DISTINCT FROM nullif(current_setting('app.device_id', true), '')::uuid THEN
        RAISE EXCEPTION 'Inventory tenant context is required' USING ERRCODE = '42501';
    END IF;
    PERFORM 1 FROM ledger.accounting_periods
        WHERE store_id = NEW.store_id AND id = NEW.accounting_period_id FOR SHARE;
    PERFORM ledger.assert_period_open(NEW.store_id, NEW.accounting_period_id, NEW.occurred_at);
    SELECT * INTO p FROM ledger.products
        WHERE store_id = NEW.store_id AND id = NEW.product_id FOR UPDATE;
    IF NOT FOUND OR p.status <> 'active' OR NOT p.track_inventory THEN
        RAISE EXCEPTION 'Inventory Product is unavailable' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO u FROM ledger.product_units
        WHERE store_id = NEW.store_id AND product_id = NEW.product_id
          AND id = NEW.product_unit_id FOR SHARE;
    IF NOT FOUND OR u.status <> 'active' OR u.measurement_type <> p.measurement_type
       OR u.factor_num <> NEW.factor_num OR u.factor_den <> NEW.factor_den THEN
        RAISE EXCEPTION 'Inventory ProductUnit is unavailable or stale' USING ERRCODE = '23514';
    END IF;
    IF (zero_establishment AND
          (NEW.selected_quantity_milli <> 0 OR NEW.quantity_delta_milli <> 0
           OR ledger.inventory_base_quantity(
                NEW.selected_quantity_milli, NEW.factor_num, NEW.factor_den) <> 0))
       OR (NOT zero_establishment AND
          (NEW.selected_quantity_milli <= 0 OR NEW.quantity_delta_milli = 0
           OR abs(NEW.quantity_delta_milli::numeric) <>
              ledger.inventory_base_quantity(
                NEW.selected_quantity_milli, NEW.factor_num, NEW.factor_den)::numeric)) THEN
        RAISE EXCEPTION 'Inventory quantity is inconsistent' USING ERRCODE = '23514';
    END IF;

    SELECT * INTO b FROM ledger.stock_balances
        WHERE store_id = NEW.store_id AND product_id = NEW.product_id FOR UPDATE;
    balance_exists := FOUND;
    IF NOT balance_exists THEN
        SELECT EXISTS (
            SELECT 1
            FROM ledger.stock_count_items i
            JOIN ledger.stock_counts c
              ON c.store_id = i.store_id AND c.id = i.stock_count_id
            WHERE i.store_id = NEW.store_id
              AND i.stock_count_id = NEW.reference_id
              AND i.product_id = NEW.product_id
              AND i.adjustment_movement_id = NEW.id
              AND i.previous_projection_state = 'missing'
              AND i.system_quantity_milli IS NULL
              AND i.difference_milli IS NULL
              AND i.actual_quantity_milli = NEW.quantity_after_milli
              AND NEW.quantity_before_milli = 0
              AND NEW.quantity_delta_milli = i.actual_quantity_milli
              AND c.status IN ('draft', 'counting')
              AND c.operation_id = NEW.transaction_group_id
              AND c.accounting_period_id = NEW.accounting_period_id
              AND c.occurred_at = NEW.occurred_at
              AND c.business_date = NEW.business_date
              AND c.posting_date = NEW.posting_date
              AND c.device_id = NEW.device_id
              AND ((zero_establishment
                    AND i.actual_quantity_milli = 0
                    AND i.selected_quantity_milli = 0
                    AND i.product_unit_id = NEW.product_unit_id
                    AND i.factor_num = NEW.factor_num
                    AND i.factor_den = NEW.factor_den)
                   OR (NOT zero_establishment AND i.actual_quantity_milli > 0))
        ) INTO count_establishment;
    END IF;
    IF zero_establishment THEN
        IF balance_exists THEN
            RAISE EXCEPTION 'Inventory quantity is already established' USING ERRCODE = '23514';
        END IF;
        IF NOT count_establishment THEN
            RAISE EXCEPTION 'Zero establishment requires an accepted Stock Count item'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NOT balance_exists THEN
        -- Count establishment starts from an explicit non-authoritative arithmetic
        -- seed; ordinary first movements retain the S11.2 known-zero expectation.
        INSERT INTO ledger.stock_balances(
            store_id, product_id, quantity_milli, average_unit_cost_minor,
            inventory_value_minor, has_pending_cost, cost_state)
        VALUES (
            NEW.store_id, NEW.product_id,
            CASE WHEN count_establishment THEN NEW.quantity_before_milli ELSE 0 END,
            0,
            CASE WHEN count_establishment THEN NEW.inventory_value_before_minor ELSE 0 END,
            CASE WHEN count_establishment THEN NEW.cost_state_before = 'pending' ELSE false END,
            CASE WHEN count_establishment THEN NEW.cost_state_before ELSE 'known' END);
        SELECT * INTO b FROM ledger.stock_balances
            WHERE store_id = NEW.store_id AND product_id = NEW.product_id FOR UPDATE;
    END IF;
    IF (NEW.quantity_before_milli, NEW.inventory_value_before_minor, NEW.cost_state_before)
       IS DISTINCT FROM (b.quantity_milli, b.inventory_value_minor, b.cost_state) THEN
        RAISE EXCEPTION 'Stale inventory snapshot' USING ERRCODE = '40001';
    END IF;
    IF NEW.quantity_after_milli::numeric <>
          NEW.quantity_before_milli::numeric + NEW.quantity_delta_milli::numeric
       OR NEW.inventory_value_after_minor::numeric <>
          NEW.inventory_value_before_minor::numeric + NEW.value_delta_minor::numeric THEN
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
        last_movement_id = NEW.id,
        updated_at = clock_timestamp(),
        version = version + 1
        WHERE store_id = NEW.store_id AND product_id = NEW.product_id;
    RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION ledger.apply_inventory_movement() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger.apply_inventory_movement() TO shop_app_runtime;

CREATE OR REPLACE FUNCTION ledger.validate_inventory_count_facts()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    i ledger.stock_count_items%ROWTYPE;
    m ledger.inventory_movements%ROWTYPE;
BEGIN
    IF NEW.status <> 'posted' THEN
        RETURN NULL;
    END IF;
    FOR i IN
        SELECT * FROM ledger.stock_count_items
        WHERE store_id = NEW.store_id AND stock_count_id = NEW.id
    LOOP
        IF i.previous_projection_state = 'established' AND i.difference_milli = 0 THEN
            IF i.adjustment_movement_id IS NOT NULL THEN
                RAISE EXCEPTION 'Posted Stock Count no-op has an unexpected movement'
                    USING ERRCODE = '23514';
            END IF;
            CONTINUE;
        END IF;
        SELECT * INTO m FROM ledger.inventory_movements
        WHERE store_id = i.store_id AND id = i.adjustment_movement_id;
        IF NOT FOUND
           OR m.movement_type <> 'stock_count'
           OR m.reversal_of_id IS NOT NULL
           OR m.product_id <> i.product_id
           OR m.accounting_period_id <> NEW.accounting_period_id
           OR m.occurred_at <> NEW.occurred_at
           OR m.business_date <> NEW.business_date
           OR m.posting_date <> NEW.posting_date
           OR m.transaction_group_id <> NEW.operation_id
           OR m.device_id <> NEW.device_id
           OR m.reference_type <> 'stock_count'
           OR m.reference_id <> NEW.id THEN
            RAISE EXCEPTION 'Posted Stock Count movement facts are inconsistent'
                USING ERRCODE = '23514';
        END IF;
        IF i.previous_projection_state = 'established' THEN
            IF m.quantity_fact_kind <> 'movement'
               OR (m.quantity_before_milli, m.quantity_delta_milli, m.quantity_after_milli)
                  IS DISTINCT FROM
                  (i.system_quantity_milli, i.difference_milli, i.actual_quantity_milli) THEN
                RAISE EXCEPTION 'Posted Stock Count variance facts are inconsistent'
                    USING ERRCODE = '23514';
            END IF;
        ELSIF m.quantity_before_milli <> 0
           OR m.quantity_delta_milli <> i.actual_quantity_milli
           OR m.quantity_after_milli <> i.actual_quantity_milli
           OR (i.actual_quantity_milli = 0
               AND m.quantity_fact_kind <> 'count_zero_establishment')
           OR (i.actual_quantity_milli > 0 AND m.quantity_fact_kind <> 'movement') THEN
            RAISE EXCEPTION 'Posted Stock Count establishment facts are inconsistent'
                USING ERRCODE = '23514';
        END IF;
    END LOOP;
    RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION ledger.validate_inventory_count_facts() FROM PUBLIC;

REVOKE INSERT, UPDATE, DELETE ON ledger.stock_balances FROM shop_app_runtime;
REVOKE UPDATE, DELETE ON ledger.inventory_movements FROM shop_app_runtime;

DO $postconditions$
BEGIN
    IF (SELECT proowner <> current_user::regrole OR NOT prosecdef
               OR proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
        FROM pg_catalog.pg_proc WHERE oid = 'ledger.apply_inventory_movement()'::regprocedure)
       OR pg_catalog.has_table_privilege(
            'shop_app_runtime', 'ledger.stock_balances', 'INSERT,UPDATE,DELETE')
       OR (SELECT count(*) FROM pg_catalog.pg_class
           WHERE oid IN ('ledger.inventory_movements'::regclass,
                         'ledger.stock_balances'::regclass,
                         'ledger.stock_counts'::regclass,
                         'ledger.stock_count_items'::regclass)
             AND relowner = current_user::regrole
             AND relrowsecurity AND relforcerowsecurity) <> 4
       OR NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_attribute
            WHERE attrelid = 'ledger.inventory_movements'::regclass
              AND attname = 'quantity_fact_kind' AND attnotnull)
       OR NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_attribute
            WHERE attrelid = 'ledger.stock_count_items'::regclass
              AND attname = 'previous_projection_state' AND attnotnull)
       OR EXISTS (
            SELECT 1 FROM pg_catalog.pg_attribute
            WHERE attrelid = 'ledger.stock_count_items'::regclass
              AND attname IN ('system_quantity_milli', 'difference_milli') AND attnotnull) THEN
        RAISE EXCEPTION '0008 stock-count security or schema postconditions failed';
    END IF;
END;
$postconditions$;
