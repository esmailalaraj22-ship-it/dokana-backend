-- S21.2: user-scoped notification presentation state and debt-alert configuration.
--
-- Canonical notification cause state remains in ledger.notifications. This migration
-- adds only user presentation state, the approved customer-debt amount type, and the
-- Store setting required to evaluate that cause.

DO $preconditions$
BEGIN
    IF session_user <> 'dokana_migration_login'
       OR current_user <> 'shop_app_migrator' THEN
        RAISE EXCEPTION '0029 requires the approved migration login and effective role';
    END IF;

    IF to_regclass('ledger.notifications') IS NULL
       OR to_regclass('ledger.app_settings') IS NULL
       OR to_regclass('platform.store_memberships') IS NULL
       OR to_regclass('ledger.notification_user_states') IS NOT NULL THEN
        RAISE EXCEPTION '0029 found an unexpected notification foundation';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'ledger'
          AND table_name = 'app_settings'
          AND column_name = 'customer_debt_amount_alert_minor'
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'ledger.notifications'::regclass
          AND conname = 'notifications_notification_type_check'
          AND pg_get_constraintdef(oid) LIKE '%customer_debt_age%'
          AND pg_get_constraintdef(oid) NOT LIKE '%customer_debt_amount%'
    ) THEN
        RAISE EXCEPTION '0029 found an unexpected notification type or settings state';
    END IF;

    IF NOT (
        SELECT relrowsecurity AND relforcerowsecurity
        FROM pg_class
        WHERE oid = 'ledger.notifications'::regclass
    ) OR NOT (
        SELECT relrowsecurity AND relforcerowsecurity
        FROM pg_class
        WHERE oid = 'ledger.app_settings'::regclass
    ) THEN
        RAISE EXCEPTION '0029 requires forced RLS on existing notification settings';
    END IF;
END
$preconditions$;

ALTER TABLE ledger.notifications
    DROP CONSTRAINT notifications_notification_type_check;

ALTER TABLE ledger.notifications
    ADD CONSTRAINT notifications_notification_type_check CHECK (notification_type IN (
        'customer_debt_amount',
        'customer_debt_age',
        'customer_credit_limit',
        'low_stock',
        'negative_stock',
        'supplier_due',
        'expense_due',
        'subscription_expiry',
        'backup_failure',
        'sync_failure',
        'daily_report',
        'review_required'
    ));

ALTER TABLE ledger.app_settings
    ADD COLUMN customer_debt_amount_alert_minor bigint NOT NULL DEFAULT 50000,
    ADD CONSTRAINT app_settings_customer_debt_amount_alert_minor_check
        CHECK (customer_debt_amount_alert_minor >= 0);

CREATE TABLE ledger.notification_user_states (
    store_id uuid NOT NULL,
    notification_id uuid NOT NULL,
    user_id uuid NOT NULL,
    read_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    PRIMARY KEY (store_id, notification_id, user_id),
    FOREIGN KEY (store_id, notification_id)
        REFERENCES ledger.notifications(store_id, id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (store_id, user_id)
        REFERENCES platform.store_memberships(store_id, user_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE INDEX idx_notification_user_states_user
ON ledger.notification_user_states(store_id, user_id, notification_id);

CREATE TRIGGER trg_notification_user_states_touch
BEFORE UPDATE ON ledger.notification_user_states
FOR EACH ROW EXECUTE FUNCTION ledger.touch_mutable_row();

ALTER TABLE ledger.notification_user_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.notification_user_states FORCE ROW LEVEL SECURITY;

CREATE POLICY notification_user_states_identity_isolation
ON ledger.notification_user_states
USING (
    store_id = platform.current_store_id()
    AND user_id = platform.current_user_id()
)
WITH CHECK (
    store_id = platform.current_store_id()
    AND user_id = platform.current_user_id()
);

REVOKE ALL ON TABLE ledger.notification_user_states
FROM PUBLIC, shop_app_runtime, shop_app_auth, shop_app_auth_owner;

GRANT SELECT, INSERT, UPDATE ON TABLE ledger.notification_user_states
TO shop_app_runtime;

DO $postconditions$
DECLARE
    notification_type_constraint text;
BEGIN
    SELECT pg_get_constraintdef(oid)
    INTO notification_type_constraint
    FROM pg_constraint
    WHERE conrelid = 'ledger.notifications'::regclass
      AND conname = 'notifications_notification_type_check';

    IF notification_type_constraint NOT LIKE '%customer_debt_amount%'
       OR NOT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'ledger'
              AND table_name = 'app_settings'
              AND column_name = 'customer_debt_amount_alert_minor'
              AND data_type = 'bigint'
              AND is_nullable = 'NO'
              AND column_default = '50000'
       ) THEN
        RAISE EXCEPTION '0029 did not install the approved notification contract';
    END IF;

    IF (SELECT pg_get_userbyid(relowner)
        FROM pg_class
        WHERE oid = 'ledger.notification_user_states'::regclass)
            <> 'shop_app_migrator'
       OR NOT (
            SELECT relrowsecurity AND relforcerowsecurity
            FROM pg_class
            WHERE oid = 'ledger.notification_user_states'::regclass
       )
       OR NOT has_table_privilege(
            'shop_app_runtime', 'ledger.notification_user_states', 'SELECT'
       )
       OR NOT has_table_privilege(
            'shop_app_runtime', 'ledger.notification_user_states', 'INSERT'
       )
       OR NOT has_table_privilege(
            'shop_app_runtime', 'ledger.notification_user_states', 'UPDATE'
       )
       OR has_table_privilege(
            'shop_app_runtime', 'ledger.notification_user_states', 'DELETE'
       )
       OR has_table_privilege(
            'public', 'ledger.notification_user_states', 'SELECT'
       )
       OR has_table_privilege(
            'shop_app_auth', 'ledger.notification_user_states', 'SELECT'
       )
       OR has_schema_privilege('shop_app_runtime', 'platform', 'USAGE') THEN
        RAISE EXCEPTION '0029 created an unsafe notification presentation boundary';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid = 'ledger.notification_user_states'::regclass
          AND polname = 'notification_user_states_identity_isolation'
          AND polcmd = '*'
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'ledger.notification_user_states'::regclass
          AND tgname = 'trg_notification_user_states_touch'
          AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION '0029 notification RLS policy or version trigger is missing';
    END IF;
END
$postconditions$;
