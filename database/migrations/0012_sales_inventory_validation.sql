-- S14.2: make Sale posting validation honor the authoritative Product inventory
-- mode. The runner owns the transaction. This migration changes no tables or
-- existing rows; the PostgreSQL reference and SQLite contract remain frozen.
-- Rollback/remediation: restore the prior validator body through a later forward
-- migration. Never edit this migration after it has been applied.

DO $preconditions$
BEGIN
    IF session_user <> 'dokana_migration_login' OR current_user <> 'shop_app_migrator'
       OR EXISTS (
           SELECT 1 FROM pg_catalog.pg_roles
           WHERE rolname = current_user AND (rolsuper OR rolbypassrls OR rolcanlogin)
       ) THEN
        RAISE EXCEPTION '0012 requires the approved migration session and owner';
    END IF;

    IF (SELECT count(*) FROM pg_catalog.pg_class
        WHERE oid IN (
            'ledger.sales'::regclass,
            'ledger.sale_items'::regclass,
            'ledger.sale_payments'::regclass,
            'ledger.customer_ledger_entries'::regclass,
            'ledger.products'::regclass,
            'ledger.inventory_movements'::regclass,
            'ledger.money_movements'::regclass
        )
          AND relowner = current_user::regrole
          AND relrowsecurity
          AND relforcerowsecurity) <> 7 THEN
        RAISE EXCEPTION '0012 encountered unexpected ownership or RLS state';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc
        WHERE oid = 'ledger.validate_sale_post()'::regprocedure
          AND proowner = current_user::regrole
          AND NOT prosecdef
          AND proconfig IS NULL
          AND position('Tracked sale items require inventory movements'
              IN pg_catalog.pg_get_functiondef(oid)) > 0
          AND position('track_inventory' IN pg_catalog.pg_get_functiondef(oid)) = 0
          AND NOT EXISTS (
              SELECT 1
              FROM pg_catalog.aclexplode(
                  coalesce(proacl, pg_catalog.acldefault('f', proowner))
              )
              WHERE grantee = 0 AND privilege_type = 'EXECUTE'
          )
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_trigger
        WHERE tgrelid = 'ledger.sales'::regclass
          AND tgname = 'trg_sales_post_validate'
          AND NOT tgisinternal
          AND tgenabled = 'O'
          AND tgfoid = 'ledger.validate_sale_post()'::regprocedure
    ) THEN
        RAISE EXCEPTION '0012 encountered unexpected Sale validator state';
    END IF;
END;
$preconditions$;

CREATE OR REPLACE FUNCTION ledger.validate_sale_post()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    item_count bigint;
    subtotal bigint;
    discounts bigint;
    total bigint;
    payments bigint;
    invalid_tracked_movement bigint;
    forbidden_inventory_movement bigint;
    unlinked_sale_movement bigint;
    current_due bigint;
    existing_sale_receivable bigint;
    sale_receivable bigint;
    invalid_payment_links bigint;
    limit_minor bigint;
    policy text;
BEGIN
    IF NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted' THEN
        PERFORM ledger.assert_period_open(NEW.store_id, NEW.accounting_period_id, NEW.sale_at);

        SELECT count(*), COALESCE(sum(line_gross_minor), 0),
               COALESCE(sum(line_discount_minor), 0), COALESCE(sum(line_total_minor), 0)
        INTO item_count, subtotal, discounts, total
        FROM ledger.sale_items
        WHERE store_id = NEW.store_id AND sale_id = NEW.id;

        IF item_count = 0 THEN
            RAISE EXCEPTION 'Posted sale must have at least one item' USING ERRCODE = '23514';
        END IF;
        IF subtotal <> NEW.items_subtotal_minor OR discounts <> NEW.line_discount_total_minor
           OR total - NEW.invoice_discount_minor <> NEW.total_minor - NEW.rounding_minor THEN
            RAISE EXCEPTION 'Sale header totals do not match sale items' USING ERRCODE = '23514';
        END IF;

        SELECT
            count(*) FILTER (
                WHERE NOT sale_item.is_manual_line
                  AND product_state.track_inventory
                  AND (
                      movement.id IS NULL
                      OR movement.product_id IS DISTINCT FROM sale_item.product_id
                      OR movement.product_unit_id IS DISTINCT FROM sale_item.product_unit_id
                      OR movement.movement_type IS DISTINCT FROM 'sale'
                      OR movement.selected_quantity_milli IS DISTINCT FROM sale_item.quantity_milli
                      OR movement.factor_num IS DISTINCT FROM sale_item.conversion_factor_num
                      OR movement.factor_den IS DISTINCT FROM sale_item.conversion_factor_den
                      OR movement.quantity_delta_milli IS DISTINCT FROM -sale_item.base_quantity_milli
                      OR movement.reference_type IS DISTINCT FROM 'sale'
                      OR movement.reference_id IS DISTINCT FROM NEW.id
                      OR movement.accounting_period_id IS DISTINCT FROM NEW.accounting_period_id
                      OR (
                          sale_item.line_cost_minor IS NOT NULL
                          AND movement.value_delta_minor IS DISTINCT FROM -sale_item.line_cost_minor
                      )
                  )
            ),
            count(*) FILTER (
                WHERE sale_item.inventory_movement_id IS NOT NULL
                  AND (
                      sale_item.is_manual_line
                      OR NOT COALESCE(product_state.track_inventory, false)
                  )
            )
        INTO invalid_tracked_movement, forbidden_inventory_movement
        FROM ledger.sale_items AS sale_item
        LEFT JOIN ledger.products AS product_state
          ON product_state.store_id = sale_item.store_id
         AND product_state.id = sale_item.product_id
        LEFT JOIN ledger.inventory_movements AS movement
          ON movement.store_id = sale_item.store_id
         AND movement.id = sale_item.inventory_movement_id
        WHERE sale_item.store_id = NEW.store_id
          AND sale_item.sale_id = NEW.id;

        SELECT count(*)
        INTO unlinked_sale_movement
        FROM ledger.inventory_movements AS movement
        WHERE movement.store_id = NEW.store_id
          AND movement.reference_type = 'sale'
          AND movement.reference_id = NEW.id
          AND NOT EXISTS (
              SELECT 1
              FROM ledger.sale_items AS sale_item
              JOIN ledger.products AS product_state
                ON product_state.store_id = sale_item.store_id
               AND product_state.id = sale_item.product_id
              WHERE sale_item.store_id = NEW.store_id
                AND sale_item.sale_id = NEW.id
                AND sale_item.inventory_movement_id = movement.id
                AND NOT sale_item.is_manual_line
                AND product_state.track_inventory
          );

        IF invalid_tracked_movement > 0 THEN
            RAISE EXCEPTION 'Tracked sale item inventory movement is invalid'
                USING ERRCODE = '23514';
        END IF;
        IF forbidden_inventory_movement > 0 OR unlinked_sale_movement > 0 THEN
            RAISE EXCEPTION 'Untracked or manual sale item cannot have an inventory movement'
                USING ERRCODE = '23514';
        END IF;

        SELECT COALESCE(sum(sp.amount_minor), 0),
               count(*) FILTER (
                   WHERE mm.id IS NULL
                      OR mm.account_id <> sp.money_account_id
                      OR mm.amount_delta_minor <> sp.amount_minor
               )
        INTO payments, invalid_payment_links
        FROM ledger.sale_payments AS sp
        LEFT JOIN ledger.money_movements AS mm
          ON mm.store_id = sp.store_id AND mm.id = sp.money_movement_id
        WHERE sp.store_id = NEW.store_id AND sp.sale_id = NEW.id;
        IF payments <> NEW.paid_total_minor OR invalid_payment_links > 0 THEN
            RAISE EXCEPTION 'Sale payments or money movements do not match header'
                USING ERRCODE = '23514';
        END IF;

        SELECT COALESCE(sum(receivable_delta_minor), 0) INTO sale_receivable
        FROM ledger.customer_ledger_entries
        WHERE store_id = NEW.store_id
          AND source_sale_id = NEW.id
          AND entry_type = 'sale_credit';
        IF sale_receivable <> NEW.credit_total_minor THEN
            RAISE EXCEPTION 'Sale customer receivable does not match credit total'
                USING ERRCODE = '23514';
        END IF;

        IF NEW.credit_total_minor > 0 THEN
            SELECT COALESCE(customer_state.credit_policy, settings.default_credit_policy),
                   COALESCE(customer_state.credit_limit_minor, settings.default_credit_limit_minor)
            INTO policy, limit_minor
            FROM ledger.customers AS customer_state
            JOIN ledger.app_settings AS settings
              ON settings.store_id = customer_state.store_id
            WHERE customer_state.store_id = NEW.store_id
              AND customer_state.id = NEW.customer_id;

            IF policy = 'block' AND limit_minor IS NOT NULL THEN
                SELECT COALESCE(sum(receivable_delta_minor - credit_delta_minor), 0),
                       COALESCE(
                           sum(receivable_delta_minor) FILTER (WHERE source_sale_id = NEW.id),
                           0
                       )
                INTO current_due, existing_sale_receivable
                FROM ledger.customer_ledger_entries
                WHERE store_id = NEW.store_id AND customer_id = NEW.customer_id;

                IF current_due
                   + GREATEST(NEW.credit_total_minor - existing_sale_receivable, 0)
                   > limit_minor THEN
                    RAISE EXCEPTION 'Customer credit limit would be exceeded'
                        USING ERRCODE = '23514';
                END IF;
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;

ALTER FUNCTION ledger.validate_sale_post() OWNER TO shop_app_migrator;
REVOKE ALL ON FUNCTION ledger.validate_sale_post() FROM PUBLIC;
REVOKE ALL ON FUNCTION ledger.validate_sale_post() FROM shop_app_runtime, shop_app_readonly;

DO $postconditions$
BEGIN
    IF (SELECT count(*) FROM pg_catalog.pg_class
        WHERE oid IN (
            'ledger.sales'::regclass,
            'ledger.sale_items'::regclass,
            'ledger.sale_payments'::regclass,
            'ledger.customer_ledger_entries'::regclass,
            'ledger.products'::regclass,
            'ledger.inventory_movements'::regclass,
            'ledger.money_movements'::regclass
        )
          AND relowner = current_user::regrole
          AND relrowsecurity
          AND relforcerowsecurity) <> 7
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_proc
           WHERE oid = 'ledger.validate_sale_post()'::regprocedure
             AND proowner = current_user::regrole
             AND NOT prosecdef
             AND proconfig = ARRAY['search_path=pg_catalog, pg_temp']
             AND position('product_state.track_inventory'
                 IN pg_catalog.pg_get_functiondef(oid)) > 0
             AND position('movement.product_id IS DISTINCT FROM sale_item.product_id'
                 IN pg_catalog.pg_get_functiondef(oid)) > 0
             AND position('NOT COALESCE(product_state.track_inventory, false)'
                 IN pg_catalog.pg_get_functiondef(oid)) > 0
             AND position('unlinked_sale_movement'
                 IN pg_catalog.pg_get_functiondef(oid)) > 0
             AND NOT EXISTS (
                 SELECT 1
                 FROM pg_catalog.aclexplode(
                     coalesce(proacl, pg_catalog.acldefault('f', proowner))
                 )
                 WHERE grantee IN (
                     0,
                     'shop_app_runtime'::regrole,
                     'shop_app_readonly'::regrole
                 )
                   AND privilege_type = 'EXECUTE'
             )
       )
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_trigger
           WHERE tgrelid = 'ledger.sales'::regclass
             AND tgname = 'trg_sales_post_validate'
             AND NOT tgisinternal
             AND tgenabled = 'O'
             AND tgfoid = 'ledger.validate_sale_post()'::regprocedure
       )
       OR NOT pg_catalog.has_table_privilege(
           'shop_app_runtime', 'ledger.sales', 'SELECT,INSERT,UPDATE,DELETE'
       )
       OR NOT pg_catalog.has_table_privilege(
           'shop_app_runtime', 'ledger.sale_items', 'SELECT,INSERT,UPDATE,DELETE'
       )
       OR NOT pg_catalog.has_table_privilege(
           'shop_app_runtime', 'ledger.customer_ledger_entries', 'SELECT,INSERT'
       ) THEN
        RAISE EXCEPTION '0012 Sale inventory validation postconditions failed';
    END IF;
END;
$postconditions$;
