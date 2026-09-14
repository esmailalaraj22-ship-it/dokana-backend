-- S15.2: allow one Customer Payment allocation to target either a posted Sale
-- Receivable or an original Customer Opening Receivable. Collection posting and
-- outstanding-balance validation remain application concerns for S15.3.

DO $preconditions$
BEGIN
    IF session_user <> 'dokana_migration_login' OR current_user <> 'shop_app_migrator'
       OR EXISTS (
           SELECT 1 FROM pg_catalog.pg_roles
           WHERE rolname = current_user AND (rolsuper OR rolbypassrls OR rolcanlogin)
       ) THEN
        RAISE EXCEPTION '0014 requires the approved migration session and owner';
    END IF;

    IF (SELECT count(*) FROM pg_catalog.pg_class
        WHERE oid IN (
            'ledger.customer_payments'::regclass,
            'ledger.customer_payment_allocations'::regclass,
            'ledger.customer_ledger_entries'::regclass,
            'ledger.sales'::regclass
        )
          AND relowner = current_user::regrole
          AND relrowsecurity
          AND relforcerowsecurity) <> 4
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_attribute
           WHERE attrelid = 'ledger.customer_payment_allocations'::regclass
             AND attname = 'sale_id'
             AND attnotnull
             AND NOT attisdropped
       )
       OR EXISTS (
           SELECT 1 FROM pg_catalog.pg_attribute
           WHERE attrelid = 'ledger.customer_payment_allocations'::regclass
             AND attname = 'opening_receivable_ledger_entry_id'
             AND NOT attisdropped
       )
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_constraint
           WHERE conrelid = 'ledger.customer_payment_allocations'::regclass
             AND conname = 'customer_payment_allocations_store_id_sale_id_fkey'
             AND contype = 'f'
             AND convalidated
       )
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_constraint
           WHERE conrelid = 'ledger.customer_payment_allocations'::regclass
             AND conname = 'customer_payment_allocations_customer_payment_id_sale_id_key'
             AND contype = 'u'
             AND convalidated
       )
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_trigger
           WHERE tgrelid = 'ledger.customer_payment_allocations'::regclass
             AND tgname = 'trg_customer_allocations_parent_draft'
             AND NOT tgisinternal
       )
       OR to_regprocedure('ledger.validate_customer_payment_allocation_target()') IS NOT NULL THEN
        RAISE EXCEPTION '0014 encountered unexpected Customer Payment allocation state';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM ledger.customer_payment_allocations AS allocation
        LEFT JOIN ledger.customer_payments AS payment
          ON payment.store_id = allocation.store_id
         AND payment.id = allocation.customer_payment_id
        LEFT JOIN ledger.sales AS sale
          ON sale.store_id = allocation.store_id
         AND sale.id = allocation.sale_id
        LEFT JOIN ledger.customer_ledger_entries AS origin
          ON origin.store_id = sale.store_id
         AND origin.customer_id = sale.customer_id
         AND origin.source_sale_id = sale.id
         AND origin.entry_type = 'sale_credit'
         AND origin.receivable_delta_minor > 0
         AND origin.credit_delta_minor = 0
         AND origin.reference_type = 'sale'
         AND origin.reference_id = sale.id
         AND origin.reversal_of_id IS NULL
         AND NOT EXISTS (
             SELECT 1
             FROM ledger.customer_ledger_entries AS reversal
             WHERE reversal.store_id = origin.store_id
               AND reversal.reversal_of_id = origin.id
         )
        LEFT JOIN ledger.customer_ledger_entries AS payment_effect
          ON payment_effect.store_id = allocation.store_id
         AND payment_effect.id = allocation.customer_ledger_entry_id
        WHERE payment.id IS NULL
           OR sale.id IS NULL
           OR sale.status <> 'posted'
           OR sale.customer_id IS NULL
           OR sale.customer_id <> payment.customer_id
           OR origin.id IS NULL
           OR (
               allocation.customer_ledger_entry_id IS NOT NULL
               AND (
                   payment_effect.id IS NULL
                   OR payment_effect.customer_id <> payment.customer_id
                   OR payment_effect.entry_type <> 'payment'
                   OR payment_effect.receivable_delta_minor <> -allocation.amount_minor
                   OR payment_effect.credit_delta_minor <> 0
                   OR payment_effect.source_sale_id <> allocation.sale_id
                   OR payment_effect.reference_type <> 'customer_payment'
                   OR payment_effect.reference_id <> payment.id
                   OR payment_effect.accounting_period_id IS DISTINCT FROM payment.accounting_period_id
               )
           )
    ) THEN
        RAISE EXCEPTION '0014 found invalid existing Customer Payment allocation history';
    END IF;
END;
$preconditions$;

ALTER TABLE ledger.customer_payment_allocations
    ADD COLUMN opening_receivable_ledger_entry_id uuid,
    ADD CONSTRAINT customer_payment_allocations_target_xor_check CHECK (
        (sale_id IS NOT NULL)::integer
        + (opening_receivable_ledger_entry_id IS NOT NULL)::integer = 1
    ),
    ADD CONSTRAINT customer_payment_allocations_store_opening_receivable_fkey
        FOREIGN KEY (store_id, opening_receivable_ledger_entry_id)
        REFERENCES ledger.customer_ledger_entries(store_id, id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    ADD CONSTRAINT customer_payment_allocations_payment_opening_key
        UNIQUE (customer_payment_id, opening_receivable_ledger_entry_id),
    ALTER COLUMN sale_id DROP NOT NULL;

CREATE INDEX idx_customer_allocations_opening_receivable
    ON ledger.customer_payment_allocations(store_id, opening_receivable_ledger_entry_id);

CREATE FUNCTION ledger.validate_customer_payment_allocation_target()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    payment_customer_id uuid;
    target_customer_id uuid;
BEGIN
    SELECT payment.customer_id
    INTO payment_customer_id
    FROM ledger.customer_payments AS payment
    WHERE payment.store_id = NEW.store_id
      AND payment.id = NEW.customer_payment_id;

    IF payment_customer_id IS NULL THEN
        RAISE EXCEPTION 'Customer Payment allocation parent is unavailable'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.sale_id IS NOT NULL
       AND NEW.opening_receivable_ledger_entry_id IS NULL THEN
        SELECT sale.customer_id
        INTO target_customer_id
        FROM ledger.sales AS sale
        WHERE sale.store_id = NEW.store_id
          AND sale.id = NEW.sale_id
          AND sale.status = 'posted'
          AND sale.customer_id IS NOT NULL
          AND EXISTS (
              SELECT 1
              FROM ledger.customer_ledger_entries AS origin
              WHERE origin.store_id = sale.store_id
                AND origin.customer_id = sale.customer_id
                AND origin.source_sale_id = sale.id
                AND origin.entry_type = 'sale_credit'
                AND origin.receivable_delta_minor > 0
                AND origin.credit_delta_minor = 0
                AND origin.reference_type = 'sale'
                AND origin.reference_id = sale.id
                AND origin.reversal_of_id IS NULL
                AND NOT EXISTS (
                    SELECT 1
                    FROM ledger.customer_ledger_entries AS reversal
                    WHERE reversal.store_id = origin.store_id
                      AND reversal.reversal_of_id = origin.id
                )
          );
    ELSIF NEW.sale_id IS NULL
          AND NEW.opening_receivable_ledger_entry_id IS NOT NULL THEN
        SELECT opening.customer_id
        INTO target_customer_id
        FROM ledger.customer_ledger_entries AS opening
        WHERE opening.store_id = NEW.store_id
          AND opening.id = NEW.opening_receivable_ledger_entry_id
          AND opening.entry_type = 'opening_balance'
          AND opening.receivable_delta_minor > 0
          AND opening.credit_delta_minor = 0
          AND opening.source_sale_id IS NULL
          AND opening.reference_type = 'customer_opening_receivable'
          AND opening.reference_id = opening.id
          AND opening.reversal_of_id IS NULL
          AND NOT EXISTS (
              SELECT 1
              FROM ledger.customer_ledger_entries AS reversal
              WHERE reversal.store_id = opening.store_id
                AND reversal.reversal_of_id = opening.id
          );
    ELSE
        RAISE EXCEPTION 'Customer Payment allocation requires exactly one receivable origin'
            USING ERRCODE = '23514';
    END IF;

    IF target_customer_id IS NULL THEN
        RAISE EXCEPTION 'Customer Payment allocation target is unavailable or invalid'
            USING ERRCODE = '23514';
    END IF;

    IF target_customer_id <> payment_customer_id THEN
        RAISE EXCEPTION 'Customer Payment and receivable Customers must match'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION ledger.validate_customer_payment_allocation_target() FROM PUBLIC;

CREATE TRIGGER trg_customer_allocations_target_validate
BEFORE INSERT OR UPDATE OF
    store_id,
    customer_payment_id,
    sale_id,
    opening_receivable_ledger_entry_id
ON ledger.customer_payment_allocations
FOR EACH ROW EXECUTE FUNCTION ledger.validate_customer_payment_allocation_target();

DO $postconditions$
BEGIN
    IF (SELECT count(*) FROM pg_catalog.pg_class
        WHERE oid IN (
            'ledger.customer_payments'::regclass,
            'ledger.customer_payment_allocations'::regclass,
            'ledger.customer_ledger_entries'::regclass,
            'ledger.sales'::regclass
        )
          AND relowner = current_user::regrole
          AND relrowsecurity
          AND relforcerowsecurity) <> 4
       OR EXISTS (
           SELECT 1 FROM pg_catalog.pg_attribute
           WHERE attrelid = 'ledger.customer_payment_allocations'::regclass
             AND attname = 'sale_id'
             AND attnotnull
             AND NOT attisdropped
       )
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_attribute
           WHERE attrelid = 'ledger.customer_payment_allocations'::regclass
             AND attname = 'opening_receivable_ledger_entry_id'
             AND NOT attnotnull
             AND NOT attisdropped
       )
       OR (SELECT count(*) FROM pg_catalog.pg_constraint
           WHERE conrelid = 'ledger.customer_payment_allocations'::regclass
             AND conname IN (
                 'customer_payment_allocations_target_xor_check',
                 'customer_payment_allocations_store_opening_receivable_fkey',
                 'customer_payment_allocations_payment_opening_key'
             )
             AND convalidated) <> 3
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_constraint
           WHERE conrelid = 'ledger.customer_payment_allocations'::regclass
             AND conname = 'customer_payment_allocations_customer_payment_id_sale_id_key'
             AND contype = 'u'
             AND convalidated
       )
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_indexes
           WHERE schemaname = 'ledger'
             AND tablename = 'customer_payment_allocations'
             AND indexname = 'idx_customer_allocations_opening_receivable'
       )
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_trigger
           WHERE tgrelid = 'ledger.customer_payment_allocations'::regclass
             AND tgname = 'trg_customer_allocations_target_validate'
             AND NOT tgisinternal
       )
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_proc
           WHERE oid = 'ledger.validate_customer_payment_allocation_target()'::regprocedure
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
       OR NOT pg_catalog.has_table_privilege(
           'shop_app_runtime', 'ledger.customer_payment_allocations',
           'SELECT,INSERT,UPDATE,DELETE'
       )
       OR NOT pg_catalog.has_table_privilege(
           'shop_app_runtime', 'ledger.customer_payments', 'SELECT'
       )
       OR NOT pg_catalog.has_table_privilege(
           'shop_app_runtime', 'ledger.customer_ledger_entries', 'SELECT'
       )
       OR NOT pg_catalog.has_table_privilege(
           'shop_app_runtime', 'ledger.sales', 'SELECT'
       )
       OR EXISTS (
           SELECT 1
           FROM ledger.customer_payment_allocations
           WHERE sale_id IS NULL
              OR opening_receivable_ledger_entry_id IS NOT NULL
       ) THEN
        RAISE EXCEPTION '0014 Customer Payment allocation postconditions failed';
    END IF;
END;
$postconditions$;

-- Rollback requires first removing every Opening Receivable allocation, then:
-- DROP TRIGGER trg_customer_allocations_target_validate ON ledger.customer_payment_allocations;
-- DROP FUNCTION ledger.validate_customer_payment_allocation_target();
-- DROP INDEX ledger.idx_customer_allocations_opening_receivable;
-- ALTER TABLE ledger.customer_payment_allocations
--   DROP CONSTRAINT customer_payment_allocations_payment_opening_key,
--   DROP CONSTRAINT customer_payment_allocations_store_opening_receivable_fkey,
--   DROP CONSTRAINT customer_payment_allocations_target_xor_check,
--   DROP COLUMN opening_receivable_ledger_entry_id,
--   ALTER COLUMN sale_id SET NOT NULL;
