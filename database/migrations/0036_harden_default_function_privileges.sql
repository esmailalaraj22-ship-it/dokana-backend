-- S1A-01: remove PostgreSQL's global PUBLIC EXECUTE default for the two
-- application function creators. Per-schema REVOKE cannot subtract the global
-- default. Their CREATE authority is confined to the schemas checked below.
-- Existing routines, explicit grants, owners, data, RLS and function bodies
-- are unchanged. Future routines require explicit consumer grants.
-- The canonical runner owns the transaction and records the checksum.
-- Rollback/remediation requires owner approval and a forward migration; do not
-- edit this migration or silently restore the insecure PUBLIC default.

DO $preconditions$
BEGIN
    IF session_user <> 'dokana_migration_login'
       OR current_user <> 'shop_app_migrator' THEN
        RAISE EXCEPTION '0036 requires the approved migration login and effective role';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM platform.schema_migrations
        WHERE filename = '0035_release_baseline_provenance.sql'
    ) AND NOT EXISTS (
        SELECT 1 FROM platform.release_baseline_provenance
        WHERE migration_ceiling >= '0035_release_baseline_provenance.sql'
    ) THEN
        RAISE EXCEPTION '0036 requires the verified 0035 foundation';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_roles r CROSS JOIN pg_namespace n
        WHERE r.rolname IN ('shop_app_migrator', 'shop_app_auth_owner')
          AND has_schema_privilege(r.oid, n.oid, 'CREATE')
          AND NOT (
              (r.rolname = 'shop_app_migrator'
               AND n.nspname IN ('audit', 'ledger', 'platform', 'sync'))
              OR (r.rolname = 'shop_app_auth_owner' AND n.nspname = 'auth_api')
          )
    ) THEN
        RAISE EXCEPTION '0036 found creator authority outside the approved application schemas';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_default_acl d
        CROSS JOIN LATERAL aclexplode(d.defaclacl) privilege
        WHERE d.defaclobjtype = 'f' AND d.defaclnamespace <> 0
          AND pg_get_userbyid(d.defaclrole) IN ('shop_app_migrator', 'shop_app_auth_owner')
          AND privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
    ) THEN
        RAISE EXCEPTION '0036 found unexpected schema-specific PUBLIC function grants';
    END IF;
END
$preconditions$;

ALTER DEFAULT PRIVILEGES FOR ROLE shop_app_migrator
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

SET LOCAL ROLE shop_app_auth_owner;
ALTER DEFAULT PRIVILEGES FOR ROLE shop_app_auth_owner
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

DO $postconditions$
BEGIN
    IF (SELECT count(*) FROM pg_default_acl
        WHERE defaclnamespace = 0 AND defaclobjtype = 'f'
          AND pg_get_userbyid(defaclrole) IN ('shop_app_migrator', 'shop_app_auth_owner')) <> 2
       OR EXISTS (
        SELECT 1 FROM pg_default_acl d
        CROSS JOIN LATERAL aclexplode(d.defaclacl) privilege
        WHERE d.defaclobjtype = 'f'
          AND pg_get_userbyid(d.defaclrole) IN ('shop_app_migrator', 'shop_app_auth_owner')
          AND privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
    ) THEN
        RAISE EXCEPTION '0036 failed to remove future PUBLIC function execution';
    END IF;
END
$postconditions$;
