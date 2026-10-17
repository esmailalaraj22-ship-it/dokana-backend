-- S21.2: correct the legacy notifications touch trigger without adding version state.

DO $preconditions$
BEGIN
    IF session_user <> 'dokana_migration_login'
       OR current_user <> 'shop_app_migrator' THEN
        RAISE EXCEPTION '0030 requires the approved migration login and effective role';
    END IF;

    IF to_regclass('ledger.notifications') IS NULL
       OR to_regprocedure('ledger.touch_mutable_row()') IS NULL
       OR to_regprocedure('ledger.touch_notification_row()') IS NOT NULL
       OR EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'ledger'
              AND table_name = 'notifications'
              AND column_name = 'version'
       )
       OR NOT EXISTS (
            SELECT 1
            FROM pg_trigger AS trigger_state
            WHERE trigger_state.tgrelid = 'ledger.notifications'::regclass
              AND trigger_state.tgname = 'trg_notifications_touch'
              AND trigger_state.tgfoid = 'ledger.touch_mutable_row()'::regprocedure
              AND NOT trigger_state.tgisinternal
       ) THEN
        RAISE EXCEPTION '0030 found an unexpected notifications touch-trigger state';
    END IF;
END
$preconditions$;

CREATE FUNCTION ledger.touch_notification_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog, pg_temp
AS $function$
BEGIN
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION ledger.touch_notification_row()
FROM PUBLIC, shop_app_runtime, shop_app_auth, shop_app_auth_owner;

DROP TRIGGER trg_notifications_touch ON ledger.notifications;

CREATE TRIGGER trg_notifications_touch
BEFORE UPDATE ON ledger.notifications
FOR EACH ROW EXECUTE FUNCTION ledger.touch_notification_row();

DO $postconditions$
BEGIN
    IF (SELECT pg_get_userbyid(proowner)
        FROM pg_proc
        WHERE oid = 'ledger.touch_notification_row()'::regprocedure)
            <> 'shop_app_migrator'
       OR (SELECT prosecdef
           FROM pg_proc
           WHERE oid = 'ledger.touch_notification_row()'::regprocedure)
       OR (SELECT proconfig
           FROM pg_proc
           WHERE oid = 'ledger.touch_notification_row()'::regprocedure)
            IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
       OR has_function_privilege(
            'public', 'ledger.touch_notification_row()', 'EXECUTE'
       )
       OR has_function_privilege(
            'shop_app_runtime', 'ledger.touch_notification_row()', 'EXECUTE'
       )
       OR EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'ledger'
              AND table_name = 'notifications'
              AND column_name = 'version'
       )
       OR NOT EXISTS (
            SELECT 1
            FROM pg_trigger AS trigger_state
            WHERE trigger_state.tgrelid = 'ledger.notifications'::regclass
              AND trigger_state.tgname = 'trg_notifications_touch'
              AND trigger_state.tgfoid = 'ledger.touch_notification_row()'::regprocedure
              AND NOT trigger_state.tgisinternal
       )
       OR position(
            'NEW.version := OLD.version + 1' IN
            pg_get_functiondef('ledger.touch_mutable_row()'::regprocedure)
       ) = 0 THEN
        RAISE EXCEPTION '0030 did not install the approved notification touch boundary';
    END IF;
END
$postconditions$;
