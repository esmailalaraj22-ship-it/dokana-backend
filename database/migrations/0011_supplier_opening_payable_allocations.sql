-- S13.2: allow one Supplier Payment allocation to target either a Purchase
-- Invoice or an original Opening Supplier Payable. Payment posting remains an
-- application concern for S13.3. The runner owns the transaction; the frozen
-- PostgreSQL reference and SQLite contract are unchanged.

DO $preconditions$
BEGIN
    IF session_user <> 'dokana_migration_login' OR current_user <> 'shop_app_migrator'
       OR EXISTS (
           SELECT 1 FROM pg_catalog.pg_roles
           WHERE rolname = current_user AND (rolsuper OR rolbypassrls OR rolcanlogin)
       ) THEN
        RAISE EXCEPTION '0011 requires the approved migration session and owner';
    END IF;

    IF (SELECT count(*) FROM pg_catalog.pg_class
        WHERE oid IN (
            'ledger.supplier_payments'::regclass,
            'ledger.supplier_payment_allocations'::regclass,
            'ledger.supplier_ledger_entries'::regclass,
            'ledger.purchase_invoices'::regclass
        )
          AND relowner = current_user::regrole
          AND relrowsecurity
          AND relforcerowsecurity) <> 4
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_attribute
           WHERE attrelid = 'ledger.supplier_payment_allocations'::regclass
             AND attname = 'purchase_invoice_id'
             AND attnotnull
             AND NOT attisdropped
       )
       OR EXISTS (
           SELECT 1 FROM pg_catalog.pg_attribute
           WHERE attrelid = 'ledger.supplier_payment_allocations'::regclass
             AND attname = 'opening_payable_ledger_entry_id'
             AND NOT attisdropped
       )
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_constraint
           WHERE conrelid = 'ledger.supplier_payment_allocations'::regclass
             AND conname = 'supplier_payment_allocations_store_id_purchase_invoice_id_fkey'
             AND contype = 'f'
             AND convalidated
       )
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_trigger
           WHERE tgrelid = 'ledger.supplier_payment_allocations'::regclass
             AND tgname = 'trg_supplier_allocations_parent_draft'
             AND NOT tgisinternal
       )
       OR to_regprocedure('ledger.validate_supplier_payment_allocation_target()') IS NOT NULL THEN
        RAISE EXCEPTION '0011 encountered unexpected Supplier Payment allocation state';
    END IF;
END;
$preconditions$;

ALTER TABLE ledger.supplier_payment_allocations
    ALTER COLUMN purchase_invoice_id DROP NOT NULL,
    ADD COLUMN opening_payable_ledger_entry_id uuid,
    ADD CONSTRAINT supplier_payment_allocations_target_xor_check CHECK (
        (purchase_invoice_id IS NOT NULL)::integer
        + (opening_payable_ledger_entry_id IS NOT NULL)::integer = 1
    ),
    ADD CONSTRAINT supplier_payment_allocations_store_opening_payable_fkey
        FOREIGN KEY (store_id, opening_payable_ledger_entry_id)
        REFERENCES ledger.supplier_ledger_entries(store_id, id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    ADD CONSTRAINT supplier_payment_allocations_payment_opening_key
        UNIQUE (supplier_payment_id, opening_payable_ledger_entry_id);

CREATE INDEX idx_supplier_allocations_opening_payable
    ON ledger.supplier_payment_allocations(store_id, opening_payable_ledger_entry_id);

CREATE FUNCTION ledger.validate_supplier_payment_allocation_target()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    payment_supplier_id uuid;
    target_supplier_id uuid;
BEGIN
    SELECT payment.supplier_id
    INTO payment_supplier_id
    FROM ledger.supplier_payments AS payment
    WHERE payment.store_id = NEW.store_id
      AND payment.id = NEW.supplier_payment_id;

    IF payment_supplier_id IS NULL THEN
        RAISE EXCEPTION 'Supplier Payment allocation parent is unavailable'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.purchase_invoice_id IS NOT NULL
       AND NEW.opening_payable_ledger_entry_id IS NULL THEN
        SELECT invoice.supplier_id
        INTO target_supplier_id
        FROM ledger.purchase_invoices AS invoice
        WHERE invoice.store_id = NEW.store_id
          AND invoice.id = NEW.purchase_invoice_id;
    ELSIF NEW.purchase_invoice_id IS NULL
          AND NEW.opening_payable_ledger_entry_id IS NOT NULL THEN
        SELECT opening.supplier_id
        INTO target_supplier_id
        FROM ledger.supplier_ledger_entries AS opening
        WHERE opening.store_id = NEW.store_id
          AND opening.id = NEW.opening_payable_ledger_entry_id
          AND opening.entry_type = 'opening_balance'
          AND opening.payable_delta_minor > 0
          AND opening.credit_delta_minor = 0
          AND opening.source_purchase_invoice_id IS NULL
          AND opening.reversal_of_id IS NULL
          AND opening.reference_type = 'opening_balance'
          AND opening.reference_id = opening.id
          AND NOT EXISTS (
              SELECT 1
              FROM ledger.supplier_ledger_entries AS reversal
              WHERE reversal.store_id = opening.store_id
                AND reversal.reversal_of_id = opening.id
          );
    ELSE
        RAISE EXCEPTION 'Supplier Payment allocation requires exactly one obligation target'
            USING ERRCODE = '23514';
    END IF;

    IF target_supplier_id IS NULL THEN
        RAISE EXCEPTION 'Supplier Payment allocation target is unavailable or invalid'
            USING ERRCODE = '23514';
    END IF;

    IF target_supplier_id <> payment_supplier_id THEN
        RAISE EXCEPTION 'Supplier Payment and obligation suppliers must match'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION ledger.validate_supplier_payment_allocation_target() FROM PUBLIC;

CREATE TRIGGER trg_supplier_allocations_target_validate
BEFORE INSERT OR UPDATE OF
    store_id,
    supplier_payment_id,
    purchase_invoice_id,
    opening_payable_ledger_entry_id
ON ledger.supplier_payment_allocations
FOR EACH ROW EXECUTE FUNCTION ledger.validate_supplier_payment_allocation_target();

DO $postconditions$
BEGIN
    IF (SELECT count(*) FROM pg_catalog.pg_class
        WHERE oid IN (
            'ledger.supplier_payments'::regclass,
            'ledger.supplier_payment_allocations'::regclass,
            'ledger.supplier_ledger_entries'::regclass,
            'ledger.purchase_invoices'::regclass
        )
          AND relowner = current_user::regrole
          AND relrowsecurity
          AND relforcerowsecurity) <> 4
       OR EXISTS (
           SELECT 1 FROM pg_catalog.pg_attribute
           WHERE attrelid = 'ledger.supplier_payment_allocations'::regclass
             AND attname = 'purchase_invoice_id'
             AND attnotnull
             AND NOT attisdropped
       )
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_attribute
           WHERE attrelid = 'ledger.supplier_payment_allocations'::regclass
             AND attname = 'opening_payable_ledger_entry_id'
             AND NOT attnotnull
             AND NOT attisdropped
       )
       OR (SELECT count(*) FROM pg_catalog.pg_constraint
           WHERE conrelid = 'ledger.supplier_payment_allocations'::regclass
             AND conname IN (
                 'supplier_payment_allocations_target_xor_check',
                 'supplier_payment_allocations_store_opening_payable_fkey',
                 'supplier_payment_allocations_payment_opening_key'
             )
             AND convalidated) <> 3
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_indexes
           WHERE schemaname = 'ledger'
             AND tablename = 'supplier_payment_allocations'
             AND indexname = 'idx_supplier_allocations_opening_payable'
       )
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_trigger
           WHERE tgrelid = 'ledger.supplier_payment_allocations'::regclass
             AND tgname = 'trg_supplier_allocations_target_validate'
             AND NOT tgisinternal
       )
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_proc
           WHERE oid = 'ledger.validate_supplier_payment_allocation_target()'::regprocedure
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
           'shop_app_runtime', 'ledger.supplier_payment_allocations',
           'SELECT,INSERT,UPDATE,DELETE'
       )
       OR NOT pg_catalog.has_table_privilege(
           'shop_app_runtime', 'ledger.supplier_payments', 'SELECT'
       )
       OR NOT pg_catalog.has_table_privilege(
           'shop_app_runtime', 'ledger.supplier_ledger_entries', 'SELECT'
       )
       OR NOT pg_catalog.has_table_privilege(
           'shop_app_runtime', 'ledger.purchase_invoices', 'SELECT'
       ) THEN
        RAISE EXCEPTION '0011 Supplier Payment allocation postconditions failed';
    END IF;
END;
$postconditions$;
