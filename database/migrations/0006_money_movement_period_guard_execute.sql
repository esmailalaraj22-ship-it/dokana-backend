-- Migration 0006: allow the runtime role to invoke the accounting-period guard.
--
-- ledger.money_movements (and the owner/customer/supplier ledger tables) carry a
-- BEFORE INSERT trigger `enforce_period_open` that PERFORMs ledger.assert_period_open.
-- That function is SECURITY INVOKER, so the inserting role (shop_app_runtime) must hold
-- EXECUTE on it. The reference package REVOKEd EXECUTE on ledger functions from PUBLIC and
-- never granted it to shop_app_runtime, so runtime money posting failed with
-- "permission denied for function assert_period_open". This grants exactly that one
-- EXECUTE privilege, matching the approved manual live-database fix. It is state-setting
-- and idempotent (re-granting an existing privilege is a no-op).
--
-- Rollback (backend-owner approval required):
-- revoke execute on function ledger.assert_period_open(uuid, uuid, timestamptz)
-- from shop_app_runtime;

DO $preconditions$
BEGIN
    IF current_user <> 'shop_app_migrator' THEN
        RAISE EXCEPTION '0006 requires the approved migration role';
    END IF;

    IF to_regprocedure('ledger.assert_period_open(uuid, uuid, timestamptz)') IS NULL THEN
        RAISE EXCEPTION '0006 requires ledger.assert_period_open(uuid, uuid, timestamptz)';
    END IF;
END;
$preconditions$;

GRANT EXECUTE ON FUNCTION ledger.assert_period_open(uuid, uuid, timestamptz) TO shop_app_runtime;
