-- S12.1: decouple Supplier Invoice payable recognition from legacy Goods Receipt
-- semantics and persist the S9 posting context required by future invoice posting.
-- The runner owns the transaction. Existing finalized invoices without an explicit
-- period fail the posting-context constraint atomically; their accounting history is
-- never inferred or rewritten. The PostgreSQL reference and SQLite remain frozen.

DO $preconditions$
BEGIN
    IF session_user <> 'dokana_migration_login' OR current_user <> 'shop_app_migrator'
       OR EXISTS (
           SELECT 1 FROM pg_catalog.pg_roles
           WHERE rolname = current_user AND (rolsuper OR rolbypassrls OR rolcanlogin)
       ) THEN
        RAISE EXCEPTION '0009 requires the approved migration session and owner';
    END IF;

    IF (SELECT count(*) FROM pg_catalog.pg_class
        WHERE oid IN (
            'ledger.accounting_periods'::regclass,
            'ledger.purchase_invoices'::regclass,
            'ledger.purchase_items'::regclass,
            'ledger.supplier_ledger_entries'::regclass,
            'ledger.goods_receipts'::regclass
        )
          AND relowner = current_user::regrole
          AND relrowsecurity
          AND relforcerowsecurity) <> 5 THEN
        RAISE EXCEPTION '0009 encountered unexpected ownership or RLS state';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid = 'ledger.purchase_invoices'::regclass
          AND attname IN ('accounting_period_id', 'posting_date')
          AND NOT attisdropped
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint
        WHERE conrelid = 'ledger.supplier_ledger_entries'::regclass
          AND conname = 'supplier_ledger_entries_entry_type_check'
          AND pg_catalog.pg_get_constraintdef(oid) LIKE '%goods_receipt%'
          AND pg_catalog.pg_get_constraintdef(oid) NOT LIKE '%supplier_invoice%'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc
        WHERE oid = 'ledger.validate_purchase_status()'::regprocedure
          AND proowner = current_user::regrole
          AND NOT prosecdef
          AND position(
              'Purchase invoice cannot close before full receipt'
              IN pg_catalog.pg_get_functiondef(oid)
          ) > 0
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc
        WHERE oid = 'ledger.validate_goods_receipt_post()'::regprocedure
          AND proowner = current_user::regrole
          AND NOT prosecdef
          AND position(
              'Supplier payable entry does not match receipt total'
              IN pg_catalog.pg_get_functiondef(oid)
          ) > 0
    ) THEN
        RAISE EXCEPTION '0009 encountered unexpected Supplier Invoice physical state';
    END IF;
END;
$preconditions$;

ALTER TABLE ledger.purchase_invoices
    ADD COLUMN accounting_period_id uuid,
    ADD COLUMN posting_date date,
    ADD CONSTRAINT purchase_invoices_store_id_accounting_period_id_fkey
        FOREIGN KEY (store_id, accounting_period_id)
        REFERENCES ledger.accounting_periods(store_id, id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    ADD CONSTRAINT purchase_invoices_posting_context_check CHECK (
        (accounting_period_id IS NULL) = (posting_date IS NULL)
        AND (status NOT IN ('open', 'closed') OR accounting_period_id IS NOT NULL)
    );

ALTER TABLE ledger.supplier_ledger_entries
    DROP CONSTRAINT supplier_ledger_entries_entry_type_check,
    ADD CONSTRAINT supplier_ledger_entries_entry_type_check CHECK (entry_type IN (
        'supplier_invoice',
        'goods_receipt',
        'payment',
        'return',
        'opening_balance',
        'credit_created',
        'credit_used',
        'refund',
        'correction'
    ));

CREATE OR REPLACE FUNCTION ledger.validate_purchase_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    item_count bigint;
    subtotal bigint;
    discounts bigint;
    total bigint;
    initial_finalization boolean := false;
BEGIN
    IF NEW.status IN ('open', 'closed') THEN
        IF TG_OP = 'INSERT' THEN
            initial_finalization := true;
        ELSIF TG_OP = 'UPDATE' THEN
            initial_finalization := OLD.status = 'draft';
        END IF;

        IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
            SELECT count(*), COALESCE(sum(line_gross_minor), 0),
                   COALESCE(sum(line_discount_minor), 0), COALESCE(sum(line_total_minor), 0)
            INTO item_count, subtotal, discounts, total
            FROM ledger.purchase_items
            WHERE store_id = NEW.store_id AND purchase_invoice_id = NEW.id;

            IF item_count = 0 THEN
                RAISE EXCEPTION 'Purchase invoice must have at least one item'
                    USING ERRCODE = '23514';
            END IF;
            IF subtotal <> NEW.items_subtotal_minor
               OR discounts <> NEW.line_discount_total_minor
               OR total - NEW.invoice_discount_minor <> NEW.total_minor - NEW.rounding_minor THEN
                RAISE EXCEPTION 'Purchase header totals do not match items'
                    USING ERRCODE = '23514';
            END IF;
        END IF;

        IF initial_finalization THEN
            IF NEW.accounting_period_id IS NULL OR NEW.posting_date IS NULL THEN
                RAISE EXCEPTION 'Supplier Invoice posting context is required'
                    USING ERRCODE = '23514';
            END IF;
            PERFORM ledger.assert_period_open(
                NEW.store_id,
                NEW.accounting_period_id,
                NEW.posting_date::timestamp AT TIME ZONE 'Asia/Hebron'
            );
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;

DROP TRIGGER trg_purchase_status_validate ON ledger.purchase_invoices;
CREATE TRIGGER trg_purchase_status_validate
BEFORE INSERT OR UPDATE OF status ON ledger.purchase_invoices
FOR EACH ROW EXECUTE FUNCTION ledger.validate_purchase_status();

CREATE OR REPLACE FUNCTION ledger.validate_goods_receipt_post()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    item_count bigint;
    calc_total bigint;
    r record;
    already_received bigint;
BEGIN
    IF NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted' THEN
        PERFORM ledger.assert_period_open(NEW.store_id, NEW.accounting_period_id, NEW.received_at);
        SELECT count(*), COALESCE(sum(line_total_minor), 0)
        INTO item_count, calc_total
        FROM ledger.goods_receipt_items
        WHERE store_id = NEW.store_id AND goods_receipt_id = NEW.id;

        IF item_count = 0 OR calc_total <> NEW.total_cost_minor THEN
            RAISE EXCEPTION 'Goods receipt items/total are invalid' USING ERRCODE = '23514';
        END IF;

        FOR r IN
            SELECT gri.purchase_item_id, sum(gri.base_quantity_milli) current_qty
            FROM ledger.goods_receipt_items gri
            WHERE gri.store_id = NEW.store_id AND gri.goods_receipt_id = NEW.id
            GROUP BY gri.purchase_item_id
        LOOP
            IF r.purchase_item_id IS NOT NULL THEN
                SELECT COALESCE(sum(other_i.base_quantity_milli), 0)
                INTO already_received
                FROM ledger.goods_receipt_items other_i
                JOIN ledger.goods_receipts other_r
                  ON other_r.store_id = other_i.store_id
                 AND other_r.id = other_i.goods_receipt_id
                WHERE other_i.store_id = NEW.store_id
                  AND other_i.purchase_item_id = r.purchase_item_id
                  AND other_r.status = 'posted'
                  AND other_r.id <> NEW.id;

                IF already_received + r.current_qty > (
                    SELECT base_quantity_milli
                    FROM ledger.purchase_items
                    WHERE store_id = NEW.store_id AND id = r.purchase_item_id
                ) THEN
                    RAISE EXCEPTION 'Received quantity exceeds ordered quantity'
                        USING ERRCODE = '23514';
                END IF;
            END IF;
        END LOOP;
    END IF;
    RETURN NEW;
END;
$function$;

DO $postconditions$
BEGIN
    IF (SELECT count(*) FROM pg_catalog.pg_class
        WHERE oid IN (
            'ledger.accounting_periods'::regclass,
            'ledger.purchase_invoices'::regclass,
            'ledger.purchase_items'::regclass,
            'ledger.supplier_ledger_entries'::regclass,
            'ledger.goods_receipts'::regclass
        )
          AND relowner = current_user::regrole
          AND relrowsecurity
          AND relforcerowsecurity) <> 5
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_constraint
           WHERE conrelid = 'ledger.purchase_invoices'::regclass
             AND conname = 'purchase_invoices_store_id_accounting_period_id_fkey'
       )
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_constraint
           WHERE conrelid = 'ledger.purchase_invoices'::regclass
             AND conname = 'purchase_invoices_posting_context_check'
       )
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_constraint
           WHERE conrelid = 'ledger.supplier_ledger_entries'::regclass
             AND conname = 'supplier_ledger_entries_entry_type_check'
             AND pg_catalog.pg_get_constraintdef(oid) LIKE '%supplier_invoice%'
       )
       OR EXISTS (
           SELECT 1 FROM pg_catalog.pg_proc
           WHERE oid IN (
               'ledger.validate_purchase_status()'::regprocedure,
               'ledger.validate_goods_receipt_post()'::regprocedure
           )
             AND (proowner <> current_user::regrole
                  OR prosecdef
                  OR proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp'])
       )
       OR position(
           'Purchase invoice cannot close before full receipt'
           IN pg_catalog.pg_get_functiondef('ledger.validate_purchase_status()'::regprocedure)
       ) > 0
       OR position(
           'Supplier payable entry does not match receipt total'
           IN pg_catalog.pg_get_functiondef('ledger.validate_goods_receipt_post()'::regprocedure)
       ) > 0
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_trigger
           WHERE tgrelid = 'ledger.purchase_invoices'::regclass
             AND tgname = 'trg_purchase_status_validate'
             AND NOT tgisinternal
             AND pg_catalog.pg_get_triggerdef(oid) LIKE '%BEFORE INSERT OR UPDATE OF status%'
       )
       OR NOT pg_catalog.has_table_privilege(
           'shop_app_runtime', 'ledger.purchase_invoices', 'SELECT')
       OR NOT pg_catalog.has_table_privilege(
           'shop_app_runtime', 'ledger.purchase_invoices', 'INSERT')
       OR NOT pg_catalog.has_table_privilege(
           'shop_app_runtime', 'ledger.purchase_invoices', 'UPDATE')
       OR NOT pg_catalog.has_table_privilege(
           'shop_app_runtime', 'ledger.supplier_ledger_entries', 'INSERT') THEN
        RAISE EXCEPTION '0009 Supplier Invoice foundation postconditions failed';
    END IF;
END;
$postconditions$;
