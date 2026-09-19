-- S15.4A: add one typed, non-money Customer Credit tender for a Sale while
-- preserving ledger.sale_payments as Money-backed tender authority. The runner
-- owns the transaction. Historical Sales require no rewrite or backfill.

DO $preconditions$
BEGIN
    IF session_user <> 'dokana_migration_login' OR current_user <> 'shop_app_migrator'
       OR EXISTS (
           SELECT 1 FROM pg_catalog.pg_roles
           WHERE rolname = current_user AND (rolsuper OR rolbypassrls OR rolcanlogin)
       ) THEN
        RAISE EXCEPTION '0015 requires the approved migration session and owner';
    END IF;

    IF to_regclass('ledger.sale_customer_credit_applications') IS NOT NULL
       OR to_regprocedure('ledger.validate_sale_customer_credit_application()') IS NOT NULL
       OR (SELECT count(*) FROM pg_catalog.pg_class
           WHERE oid IN (
               'ledger.sales'::regclass,
               'ledger.sale_payments'::regclass,
               'ledger.customer_ledger_entries'::regclass,
               'ledger.customers'::regclass
           )
             AND relowner = current_user::regrole
             AND relrowsecurity
             AND relforcerowsecurity) <> 4
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_proc
           WHERE oid = 'ledger.validate_sale_post()'::regprocedure
             AND proowner = current_user::regrole
             AND NOT prosecdef
             AND proconfig = ARRAY['search_path=pg_catalog, pg_temp']
             AND position('payments <> NEW.paid_total_minor'
                 IN pg_catalog.pg_get_functiondef(oid)) > 0
             AND position('sale_customer_credit_applications'
                 IN pg_catalog.pg_get_functiondef(oid)) = 0
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
       ) THEN
        RAISE EXCEPTION '0015 encountered unexpected Sale or Customer Credit state';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM ledger.sales AS sale
        WHERE sale.status = 'posted'
          AND (
              COALESCE((
                  SELECT sum(payment.amount_minor)
                  FROM ledger.sale_payments AS payment
                  WHERE payment.store_id = sale.store_id
                    AND payment.sale_id = sale.id
              ), 0) <> sale.paid_total_minor
              OR COALESCE((
                  SELECT sum(entry.receivable_delta_minor)
                  FROM ledger.customer_ledger_entries AS entry
                  WHERE entry.store_id = sale.store_id
                    AND entry.source_sale_id = sale.id
                    AND entry.entry_type = 'sale_credit'
              ), 0) <> sale.credit_total_minor
          )
    ) THEN
        RAISE EXCEPTION '0015 found invalid existing Sale settlement history';
    END IF;
END;
$preconditions$;

CREATE TABLE ledger.sale_customer_credit_applications (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    sale_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    customer_ledger_entry_id uuid NOT NULL,
    amount_minor bigint NOT NULL,
    applied_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sale_customer_credit_applications_store_id_id_key
        UNIQUE (store_id, id),
    CONSTRAINT sale_customer_credit_applications_store_sale_key
        UNIQUE (store_id, sale_id),
    CONSTRAINT sale_customer_credit_applications_store_ledger_entry_key
        UNIQUE (store_id, customer_ledger_entry_id),
    CONSTRAINT sale_customer_credit_applications_store_id_fkey
        FOREIGN KEY (store_id)
        REFERENCES ledger.stores(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT sale_customer_credit_applications_store_sale_fkey
        FOREIGN KEY (store_id, sale_id)
        REFERENCES ledger.sales(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT sale_customer_credit_applications_store_customer_fkey
        FOREIGN KEY (store_id, customer_id)
        REFERENCES ledger.customers(store_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT sale_customer_credit_applications_store_ledger_entry_fkey
        FOREIGN KEY (store_id, customer_ledger_entry_id)
        REFERENCES ledger.customer_ledger_entries(store_id, id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT sale_customer_credit_applications_amount_check CHECK (amount_minor > 0)
);

ALTER TABLE ledger.sale_customer_credit_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.sale_customer_credit_applications FORCE ROW LEVEL SECURITY;

CREATE POLICY sale_customer_credit_applications_store_isolation
ON ledger.sale_customer_credit_applications
USING (store_id = platform.current_store_id())
WITH CHECK (store_id = platform.current_store_id());

REVOKE ALL ON ledger.sale_customer_credit_applications FROM PUBLIC;
GRANT SELECT, INSERT ON ledger.sale_customer_credit_applications TO shop_app_runtime;
GRANT SELECT ON ledger.sale_customer_credit_applications TO shop_app_readonly;

CREATE FUNCTION ledger.validate_sale_customer_credit_application()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    sale_state ledger.sales%ROWTYPE;
    credit_state ledger.customer_ledger_entries%ROWTYPE;
BEGIN
    IF NEW.store_id IS DISTINCT FROM nullif(current_setting('app.store_id', true), '')::uuid
       OR nullif(current_setting('app.user_id', true), '')::uuid IS NULL
       OR nullif(current_setting('app.device_id', true), '')::uuid IS NULL
       OR nullif(current_setting('app.request_id', true), '')::uuid IS NULL THEN
        RAISE EXCEPTION 'Sale Customer Credit tenant context is required'
            USING ERRCODE = '42501';
    END IF;

    SELECT *
    INTO sale_state
    FROM ledger.sales
    WHERE store_id = NEW.store_id
      AND id = NEW.sale_id;

    IF NOT FOUND
       OR sale_state.status <> 'draft'
       OR sale_state.customer_id IS NULL
       OR sale_state.customer_id <> NEW.customer_id
       OR sale_state.sale_at <> NEW.applied_at THEN
        RAISE EXCEPTION 'Sale Customer Credit application Sale lineage is invalid'
            USING ERRCODE = '23514';
    END IF;

    SELECT *
    INTO credit_state
    FROM ledger.customer_ledger_entries
    WHERE store_id = NEW.store_id
      AND id = NEW.customer_ledger_entry_id;

    IF NOT FOUND
       OR credit_state.customer_id <> NEW.customer_id
       OR credit_state.entry_type <> 'credit_used'
       OR credit_state.receivable_delta_minor <> 0
       OR credit_state.credit_delta_minor <> -NEW.amount_minor
       OR credit_state.source_sale_id <> NEW.sale_id
       OR credit_state.reference_type <> 'sale'
       OR credit_state.reference_id <> NEW.sale_id
       OR credit_state.transaction_group_id <> sale_state.operation_id
       OR credit_state.occurred_at <> NEW.applied_at
       OR credit_state.device_id IS DISTINCT FROM sale_state.device_id
       OR credit_state.reversal_of_id IS NOT NULL
       OR EXISTS (
           SELECT 1
           FROM ledger.customer_ledger_entries AS reversal
           WHERE reversal.store_id = credit_state.store_id
             AND reversal.reversal_of_id = credit_state.id
       ) THEN
        RAISE EXCEPTION 'Sale Customer Credit application ledger lineage is invalid'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION ledger.validate_sale_customer_credit_application() FROM PUBLIC;

CREATE TRIGGER trg_sale_customer_credit_application_lineage
BEFORE INSERT ON ledger.sale_customer_credit_applications
FOR EACH ROW EXECUTE FUNCTION ledger.validate_sale_customer_credit_application();

CREATE TRIGGER trg_sale_customer_credit_application_no_mutation
BEFORE UPDATE OR DELETE ON ledger.sale_customer_credit_applications
FOR EACH ROW EXECUTE FUNCTION ledger.prevent_mutation();

CREATE TRIGGER trg_sale_customer_credit_application_audit
AFTER INSERT ON ledger.sale_customer_credit_applications
FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();

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
    customer_credit_tenders bigint;
    invalid_customer_credit_tenders bigint;
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

        SELECT COALESCE(sum(application.amount_minor), 0),
               count(*) FILTER (
                   WHERE NEW.customer_id IS NULL
                      OR application.customer_id <> NEW.customer_id
                      OR effect.id IS NULL
                      OR effect.customer_id <> application.customer_id
                      OR effect.entry_type <> 'credit_used'
                      OR effect.receivable_delta_minor <> 0
                      OR effect.credit_delta_minor <> -application.amount_minor
                      OR effect.source_sale_id <> NEW.id
                      OR effect.reference_type <> 'sale'
                      OR effect.reference_id <> NEW.id
                      OR effect.accounting_period_id IS DISTINCT FROM NEW.accounting_period_id
                      OR effect.transaction_group_id <> NEW.operation_id
                      OR effect.occurred_at <> NEW.sale_at
                      OR effect.device_id IS DISTINCT FROM NEW.device_id
                      OR effect.reversal_of_id IS NOT NULL
                      OR EXISTS (
                          SELECT 1
                          FROM ledger.customer_ledger_entries AS reversal
                          WHERE reversal.store_id = effect.store_id
                            AND reversal.reversal_of_id = effect.id
                      )
               )
        INTO customer_credit_tenders, invalid_customer_credit_tenders
        FROM ledger.sale_customer_credit_applications AS application
        LEFT JOIN ledger.customer_ledger_entries AS effect
          ON effect.store_id = application.store_id
         AND effect.id = application.customer_ledger_entry_id
        WHERE application.store_id = NEW.store_id
          AND application.sale_id = NEW.id;

        IF payments + customer_credit_tenders <> NEW.paid_total_minor
           OR invalid_payment_links > 0
           OR invalid_customer_credit_tenders > 0 THEN
            RAISE EXCEPTION 'Sale tenders or settlement lineage do not match header'
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
    IF NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_class
           WHERE oid = 'ledger.sale_customer_credit_applications'::regclass
             AND relowner = current_user::regrole
             AND relrowsecurity
             AND relforcerowsecurity
       )
       OR (SELECT count(*) FROM pg_catalog.pg_constraint
           WHERE conrelid = 'ledger.sale_customer_credit_applications'::regclass
             AND conname IN (
                 'sale_customer_credit_applications_store_id_id_key',
                 'sale_customer_credit_applications_store_sale_key',
                 'sale_customer_credit_applications_store_ledger_entry_key',
                 'sale_customer_credit_applications_store_id_fkey',
                 'sale_customer_credit_applications_store_sale_fkey',
                 'sale_customer_credit_applications_store_customer_fkey',
                 'sale_customer_credit_applications_store_ledger_entry_fkey',
                 'sale_customer_credit_applications_amount_check'
             )
             AND convalidated) <> 8
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_policies
           WHERE schemaname = 'ledger'
             AND tablename = 'sale_customer_credit_applications'
             AND policyname = 'sale_customer_credit_applications_store_isolation'
             AND cmd = 'ALL'
       )
       OR (SELECT count(*) FROM pg_catalog.pg_trigger
           WHERE tgrelid = 'ledger.sale_customer_credit_applications'::regclass
             AND tgname IN (
                 'trg_sale_customer_credit_application_lineage',
                 'trg_sale_customer_credit_application_no_mutation',
                 'trg_sale_customer_credit_application_audit'
             )
             AND NOT tgisinternal
             AND tgenabled = 'O') <> 3
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_proc
           WHERE oid = 'ledger.validate_sale_customer_credit_application()'::regprocedure
             AND proowner = current_user::regrole
             AND NOT prosecdef
             AND proconfig = ARRAY['search_path=pg_catalog, pg_temp']
             AND NOT EXISTS (
                 SELECT 1
                 FROM pg_catalog.aclexplode(
                     coalesce(proacl, pg_catalog.acldefault('f', proowner))
                 )
                 WHERE grantee = 0 AND privilege_type = 'EXECUTE'
             )
       )
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_proc
           WHERE oid = 'ledger.validate_sale_post()'::regprocedure
             AND proowner = current_user::regrole
             AND NOT prosecdef
             AND proconfig = ARRAY['search_path=pg_catalog, pg_temp']
             AND position('payments + customer_credit_tenders <> NEW.paid_total_minor'
                 IN pg_catalog.pg_get_functiondef(oid)) > 0
             AND position('effect.credit_delta_minor <> -application.amount_minor'
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
       OR NOT pg_catalog.has_table_privilege(
           'shop_app_runtime', 'ledger.sale_customer_credit_applications', 'SELECT,INSERT'
       )
       OR pg_catalog.has_table_privilege(
           'shop_app_runtime', 'ledger.sale_customer_credit_applications', 'UPDATE'
       )
       OR pg_catalog.has_table_privilege(
           'shop_app_runtime', 'ledger.sale_customer_credit_applications', 'DELETE'
       )
       OR NOT pg_catalog.has_table_privilege(
           'shop_app_readonly', 'ledger.sale_customer_credit_applications', 'SELECT'
       )
       OR pg_catalog.has_table_privilege(
           'shop_app_readonly', 'ledger.sale_customer_credit_applications', 'INSERT'
       )
       OR NOT pg_catalog.has_table_privilege(
           'shop_app_runtime', 'ledger.sale_payments', 'SELECT,INSERT,UPDATE,DELETE'
       ) THEN
        RAISE EXCEPTION '0015 Sale Customer Credit tender postconditions failed';
    END IF;
END;
$postconditions$;

-- Rollback/remediation requires first proving no Sale Customer Credit application
-- rows exist, then dropping the three table triggers, the lineage function, the
-- table, and restoring validate_sale_post() through a later reviewed migration.
