-- Migration 0003: create the dedicated authentication API schema.
--
-- This is a one-time bootstrap migration executed transactionally by
-- scripts/bootstrap-authentication-schema.ts through DATABASE_ADMIN_URL.
-- The administrative role is needed only because routine migration roles do
-- not receive broad database-level CREATE privilege.
--
-- Preconditions:
-- - migration 0001 and 0002 are present in the verified migration ledger;
-- - session_user and current_user are the approved postgres administrator;
-- - auth_api does not already exist;
-- - shop_app_auth_owner has the approved non-login, non-elevated attributes.
--
-- Rollback (backend-owner approval required):
-- DROP SCHEMA auth_api after all managed functions have first been removed.

DO $preconditions$
BEGIN
    IF session_user <> 'postgres' OR current_user <> 'postgres' THEN
        RAISE EXCEPTION '0003 requires the approved postgres bootstrap session';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = 'postgres' AND rolsuper
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = 'shop_app_auth_owner'
          AND NOT rolcanlogin
          AND NOT rolinherit
          AND NOT rolsuper
          AND NOT rolcreatedb
          AND NOT rolcreaterole
          AND NOT rolreplication
          AND NOT rolbypassrls
    ) THEN
        RAISE EXCEPTION '0003 role attributes do not match the approved state';
    END IF;

    IF to_regnamespace('auth_api') IS NOT NULL THEN
        RAISE EXCEPTION 'auth_api schema already exists';
    END IF;
END
$preconditions$;

CREATE SCHEMA auth_api AUTHORIZATION shop_app_auth_owner;
REVOKE ALL ON SCHEMA auth_api FROM PUBLIC;
REVOKE ALL ON SCHEMA auth_api FROM shop_app_runtime;
REVOKE ALL ON SCHEMA auth_api FROM shop_app_auth;

DO $postconditions$
BEGIN
    IF (
        SELECT pg_get_userbyid(namespace.nspowner)
        FROM pg_namespace AS namespace
        WHERE namespace.nspname = 'auth_api'
    ) <> 'shop_app_auth_owner' THEN
        RAISE EXCEPTION 'auth_api schema ownership is unexpected';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_namespace AS namespace
        CROSS JOIN LATERAL aclexplode(
            COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
        ) AS privilege
        WHERE namespace.nspname = 'auth_api'
          AND privilege.grantee = 0
          AND privilege.privilege_type IN ('USAGE', 'CREATE')
    ) OR has_schema_privilege('shop_app_runtime', 'auth_api', 'USAGE')
       OR has_schema_privilege('shop_app_auth', 'auth_api', 'USAGE') THEN
        RAISE EXCEPTION 'auth_api schema privileges are unexpected';
    END IF;
END
$postconditions$;
