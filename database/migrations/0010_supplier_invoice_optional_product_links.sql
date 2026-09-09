-- S12.3: allow financial Supplier Invoice lines without requiring Product linkage.
-- Product and ProductUnit references remain available as an optional validated pair.
-- The runner owns the transaction. The reference package and SQLite stay frozen.

DO $preconditions$
BEGIN
    IF session_user <> 'dokana_migration_login' OR current_user <> 'shop_app_migrator'
       OR EXISTS (
           SELECT 1 FROM pg_catalog.pg_roles
           WHERE rolname = current_user AND (rolsuper OR rolbypassrls OR rolcanlogin)
       ) THEN
        RAISE EXCEPTION '0010 requires the approved migration session and owner';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class
        WHERE oid = 'ledger.purchase_items'::regclass
          AND relowner = current_user::regrole
          AND relrowsecurity
          AND relforcerowsecurity
    ) OR (
        SELECT count(*)
        FROM pg_catalog.pg_attribute
        WHERE attrelid = 'ledger.purchase_items'::regclass
          AND attname IN ('product_id', 'product_unit_id')
          AND attnotnull
          AND NOT attisdropped
    ) <> 2 OR EXISTS (
        SELECT 1
        FROM ledger.purchase_items
        WHERE (product_id IS NULL) IS DISTINCT FROM (product_unit_id IS NULL)
    ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint
        WHERE conrelid = 'ledger.purchase_items'::regclass
          AND conname = 'purchase_items_product_link_pair_check'
    ) OR (
        SELECT count(*)
        FROM pg_catalog.pg_constraint
        WHERE conrelid = 'ledger.purchase_items'::regclass
          AND contype = 'f'
          AND conname IN (
              'purchase_items_store_id_product_id_fkey',
              'purchase_items_store_id_product_id_product_unit_id_fkey'
          )
    ) <> 2 THEN
        RAISE EXCEPTION '0010 encountered unexpected purchase item physical state';
    END IF;
END;
$preconditions$;

ALTER TABLE ledger.purchase_items
    ALTER COLUMN product_id DROP NOT NULL,
    ALTER COLUMN product_unit_id DROP NOT NULL,
    ADD CONSTRAINT purchase_items_product_link_pair_check CHECK (
        (product_id IS NULL) = (product_unit_id IS NULL)
    );

DO $postconditions$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class
        WHERE oid = 'ledger.purchase_items'::regclass
          AND relowner = current_user::regrole
          AND relrowsecurity
          AND relforcerowsecurity
    ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attribute
        WHERE attrelid = 'ledger.purchase_items'::regclass
          AND attname IN ('product_id', 'product_unit_id')
          AND attnotnull
          AND NOT attisdropped
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint
        WHERE conrelid = 'ledger.purchase_items'::regclass
          AND conname = 'purchase_items_product_link_pair_check'
          AND contype = 'c'
          AND convalidated
    ) OR (
        SELECT count(*)
        FROM pg_catalog.pg_constraint
        WHERE conrelid = 'ledger.purchase_items'::regclass
          AND contype = 'f'
          AND conname IN (
              'purchase_items_store_id_product_id_fkey',
              'purchase_items_store_id_product_id_product_unit_id_fkey'
          )
    ) <> 2 OR EXISTS (
        SELECT 1
        FROM ledger.purchase_items
        WHERE (product_id IS NULL) IS DISTINCT FROM (product_unit_id IS NULL)
    ) OR NOT pg_catalog.has_table_privilege(
        'shop_app_runtime', 'ledger.purchase_items', 'SELECT,INSERT,UPDATE'
    ) THEN
        RAISE EXCEPTION '0010 purchase item security or schema postconditions failed';
    END IF;
END;
$postconditions$;
