-- S14.5: permit an exact linked reversal to use archived historical catalog
-- identities while retaining the normal active-catalog inventory boundary.
-- No table, baseline, SQLite, supplier, or goods-receipt behavior changes.
-- Rollback before commit is transactional. After commit, restore the previous
-- function body only through an approved forward migration.

DO $preconditions$
BEGIN
    IF session_user <> 'dokana_migration_login' OR current_user <> 'shop_app_migrator'
       OR EXISTS (
           SELECT 1 FROM pg_catalog.pg_roles
           WHERE rolname = current_user AND (rolsuper OR rolbypassrls OR rolcanlogin)
       ) THEN
        RAISE EXCEPTION '0013 requires the approved migration session and owner';
    END IF;

    IF (SELECT count(*) FROM pg_catalog.pg_class
        WHERE oid IN (
            'ledger.products'::regclass,
            'ledger.product_units'::regclass,
            'ledger.inventory_movements'::regclass,
            'ledger.stock_balances'::regclass,
            'ledger.accounting_periods'::regclass
        )
          AND relowner = current_user::regrole
          AND relrowsecurity
          AND relforcerowsecurity) <> 5
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_proc
           WHERE oid = 'ledger.apply_inventory_movement()'::regprocedure
             AND proowner = current_user::regrole
             AND prosecdef
             AND proconfig = ARRAY['search_path=pg_catalog, pg_temp']
             AND position('p.status <> ''active'' OR NOT p.track_inventory'
                 IN pg_catalog.pg_get_functiondef(oid)) > 0
             AND position('exact_historical_reversal'
                 IN pg_catalog.pg_get_functiondef(oid)) = 0
             AND NOT EXISTS (
                 SELECT 1
                 FROM pg_catalog.aclexplode(
                     coalesce(proacl, pg_catalog.acldefault('f', proowner))
                 )
                 WHERE grantee = 0 AND privilege_type = 'EXECUTE'
             )
       )
       OR NOT pg_catalog.has_function_privilege(
           'shop_app_runtime', 'ledger.apply_inventory_movement()', 'EXECUTE'
       )
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_trigger
           WHERE tgrelid = 'ledger.inventory_movements'::regclass
             AND tgname = 'trg_inventory_apply_balance'
             AND NOT tgisinternal
             AND tgenabled = 'O'
             AND tgfoid = 'ledger.apply_inventory_movement()'::regprocedure
       )
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_indexes
           WHERE schemaname = 'ledger'
             AND tablename = 'inventory_movements'
             AND indexname = 'uq_inventory_movement_reversal'
             AND indexdef LIKE 'CREATE UNIQUE INDEX%WHERE (reversal_of_id IS NOT NULL)'
       ) THEN
        RAISE EXCEPTION '0013 encountered unexpected inventory security or lifecycle state';
    END IF;
END;
$preconditions$;

CREATE OR REPLACE FUNCTION ledger.apply_inventory_movement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    b ledger.stock_balances%ROWTYPE;
    p ledger.products%ROWTYPE;
    u ledger.product_units%ROWTYPE;
    original ledger.inventory_movements%ROWTYPE;
    allow_negative boolean;
    zero_establishment boolean := NEW.quantity_fact_kind = 'count_zero_establishment';
    exact_historical_reversal boolean := false;
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

    -- Preserve the Product -> Unit lock order used by all inventory and catalog
    -- workflows. The original movement is locked before accepting its sole child.
    SELECT * INTO p FROM ledger.products
        WHERE store_id = NEW.store_id AND id = NEW.product_id FOR UPDATE;
    IF NOT FOUND OR NOT p.track_inventory THEN
        RAISE EXCEPTION 'Inventory Product is unavailable' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO u FROM ledger.product_units
        WHERE store_id = NEW.store_id AND product_id = NEW.product_id
          AND id = NEW.product_unit_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Inventory ProductUnit is unavailable or stale' USING ERRCODE = '23514';
    END IF;

    IF NEW.reversal_of_id IS NOT NULL THEN
        SELECT * INTO original FROM ledger.inventory_movements
            WHERE store_id = NEW.store_id AND id = NEW.reversal_of_id FOR UPDATE;
        IF NOT FOUND
           OR NEW.movement_type <> 'correction'
           OR NEW.quantity_fact_kind <> 'movement'
           OR original.quantity_fact_kind <> 'movement'
           OR NEW.product_id IS DISTINCT FROM original.product_id
           OR NOT (
               (NEW.product_unit_id IS NOT DISTINCT FROM original.product_unit_id
                AND NEW.selected_quantity_milli IS NOT DISTINCT FROM original.selected_quantity_milli
                AND NEW.factor_num IS NOT DISTINCT FROM original.factor_num
                AND NEW.factor_den IS NOT DISTINCT FROM original.factor_den)
               OR
               (u.status = 'active'
                AND u.is_base
                AND u.measurement_type = p.measurement_type
                AND u.factor_num = 1
                AND u.factor_den = 1
                AND NEW.factor_num = 1
                AND NEW.factor_den = 1
                AND NEW.selected_quantity_milli::numeric =
                    abs(original.quantity_delta_milli::numeric))
           )
           OR NEW.quantity_delta_milli::numeric <> -original.quantity_delta_milli::numeric
           OR NEW.value_delta_minor::numeric <> -original.value_delta_minor::numeric
           OR EXISTS (
               SELECT 1 FROM ledger.inventory_movements AS prior_reversal
               WHERE prior_reversal.store_id = original.store_id
                 AND prior_reversal.reversal_of_id = original.id
           ) THEN
            RAISE EXCEPTION 'Inventory reversal lineage is inconsistent'
                USING ERRCODE = '23514';
        END IF;
        exact_historical_reversal := true;
    END IF;

    IF p.status <> 'active' AND NOT exact_historical_reversal THEN
        RAISE EXCEPTION 'Inventory Product is unavailable' USING ERRCODE = '23514';
    END IF;
    IF NOT exact_historical_reversal AND
           (u.status <> 'active' OR u.measurement_type <> p.measurement_type
            OR u.factor_num <> NEW.factor_num OR u.factor_den <> NEW.factor_den) THEN
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

ALTER FUNCTION ledger.apply_inventory_movement() OWNER TO shop_app_migrator;
REVOKE ALL ON FUNCTION ledger.apply_inventory_movement() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger.apply_inventory_movement() TO shop_app_runtime;
REVOKE ALL ON FUNCTION ledger.apply_inventory_movement() FROM shop_app_readonly;

DO $postconditions$
BEGIN
    IF (SELECT count(*) FROM pg_catalog.pg_class
        WHERE oid IN (
            'ledger.products'::regclass,
            'ledger.product_units'::regclass,
            'ledger.inventory_movements'::regclass,
            'ledger.stock_balances'::regclass,
            'ledger.accounting_periods'::regclass
        )
          AND relowner = current_user::regrole
          AND relrowsecurity
          AND relforcerowsecurity) <> 5
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_proc
           WHERE oid = 'ledger.apply_inventory_movement()'::regprocedure
             AND proowner = current_user::regrole
             AND prosecdef
             AND proconfig = ARRAY['search_path=pg_catalog, pg_temp']
             AND position('exact_historical_reversal'
                 IN pg_catalog.pg_get_functiondef(oid)) > 0
             AND position('NEW.quantity_delta_milli::numeric <> -original.quantity_delta_milli::numeric'
                 IN pg_catalog.pg_get_functiondef(oid)) > 0
             AND position('NEW.value_delta_minor::numeric <> -original.value_delta_minor::numeric'
                 IN pg_catalog.pg_get_functiondef(oid)) > 0
             AND NOT EXISTS (
                 SELECT 1
                 FROM pg_catalog.aclexplode(
                     coalesce(proacl, pg_catalog.acldefault('f', proowner))
                 )
                 WHERE grantee IN (0, 'shop_app_readonly'::regrole)
                   AND privilege_type = 'EXECUTE'
             )
       )
       OR NOT pg_catalog.has_function_privilege(
           'shop_app_runtime', 'ledger.apply_inventory_movement()', 'EXECUTE'
       )
       OR pg_catalog.has_table_privilege(
           'shop_app_runtime', 'ledger.stock_balances', 'INSERT,UPDATE,DELETE'
       )
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_trigger
           WHERE tgrelid = 'ledger.inventory_movements'::regclass
             AND tgname = 'trg_inventory_apply_balance'
             AND NOT tgisinternal
             AND tgenabled = 'O'
             AND tgfoid = 'ledger.apply_inventory_movement()'::regprocedure
       ) THEN
        RAISE EXCEPTION '0013 inventory security or lifecycle postconditions failed';
    END IF;
END;
$postconditions$;
