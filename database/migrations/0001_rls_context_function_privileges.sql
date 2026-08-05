-- Migration 0001: restore runtime evaluation of tenant RLS policies
-- Date: 2026-08-05
-- Apply with the administrative connection (DATABASE_ADMIN_URL), never the
-- runtime login. This migration alters deployed objects only; the approved
-- baseline reference file remains untouched.
--
-- Problem (Station 2 independent review, finding H-1, empirically confirmed):
-- Every tenant policy evaluates platform.current_store_id(). That SQL wrapper
-- resolves platform.setting_uuid() with the caller's privileges, but
-- shop_app_runtime has no USAGE on schema platform and no EXECUTE on
-- setting_uuid (revoked from PUBLIC by the baseline). Result: every query on
-- every RLS-protected table fails for the runtime role with SQLSTATE 42501
-- ("permission denied for schema platform"). Fail-closed, but the entire
-- tenant data path is inoperable.
--
-- Fix: make the four context wrappers SECURITY DEFINER with a pinned
-- search_path, mirroring the baseline's existing pattern for
-- sync.capture_change_event and audit.capture_row_change. The wrappers then
-- resolve and call platform.setting_uuid with the owner's privileges.
--
-- Security notes:
-- - No privilege is granted to shop_app_runtime; its EXECUTE on these four
--   wrappers already exists in the baseline. Schema USAGE on platform remains
--   revoked, so the application's hasRestrictedSchemaAccess safety check is
--   unaffected.
-- - The wrappers only read transaction-local GUCs (session state is
--   unaffected by the definer switch) and take no arguments, so there is no
--   injection surface; search_path is pinned with pg_temp last per the
--   SECURITY DEFINER guidance.
-- - Missing context still fails closed: setting_uuid returns NULL, so
--   policies match no rows and WITH CHECK rejects writes.
-- - Direct by-name invocation of platform.current_store_id() by the runtime
--   role remains blocked (no schema USAGE); policies work because they
--   reference the function by pre-resolved OID.
--
-- Revert (requires backend-owner approval):
--   ALTER FUNCTION platform.current_store_id()   SECURITY INVOKER; ALTER FUNCTION platform.current_store_id()   RESET search_path;
--   ALTER FUNCTION platform.current_user_id()    SECURITY INVOKER; ALTER FUNCTION platform.current_user_id()    RESET search_path;
--   ALTER FUNCTION platform.current_device_id()  SECURITY INVOKER; ALTER FUNCTION platform.current_device_id()  RESET search_path;
--   ALTER FUNCTION platform.current_request_id() SECURITY INVOKER; ALTER FUNCTION platform.current_request_id() RESET search_path;
--
-- Verification after applying:
--   database/reference/backend_database_reference/06_runtime_tests.sql
--   (administrative user, fully rolled back) plus runtime-login checks that
--   tenant reads work with context, missing context hides rows and blocks
--   writes, and cross-tenant reads/writes stay blocked.

BEGIN;

ALTER FUNCTION platform.current_store_id()
    SECURITY DEFINER
    SET search_path = pg_catalog, platform, pg_temp;

ALTER FUNCTION platform.current_user_id()
    SECURITY DEFINER
    SET search_path = pg_catalog, platform, pg_temp;

ALTER FUNCTION platform.current_device_id()
    SECURITY DEFINER
    SET search_path = pg_catalog, platform, pg_temp;

ALTER FUNCTION platform.current_request_id()
    SECURITY DEFINER
    SET search_path = pg_catalog, platform, pg_temp;

COMMIT;
