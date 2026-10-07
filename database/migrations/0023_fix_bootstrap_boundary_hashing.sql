-- Migration 0023: correct bootstrap snapshot hashing without broadening search_path.
--
-- Migration 0022 intentionally pins the SECURITY DEFINER search path, but its unqualified
-- pgcrypto digest call is therefore not resolvable. PostgreSQL's trusted pg_catalog SHA-256
-- primitive is used explicitly here. No synchronization semantics or grants are changed.

DO $preconditions$
BEGIN
    IF session_user <> 'dokana_migration_login'
       OR current_user <> 'shop_app_migrator' THEN
        RAISE EXCEPTION '0023 requires the approved migration login and effective role';
    END IF;

    IF to_regprocedure('sync.read_bootstrap_boundary_v1(uuid,uuid)') IS NULL
       OR to_regprocedure('pg_catalog.sha256(bytea)') IS NULL
       OR to_regprocedure('pg_catalog.convert_to(text,name)') IS NULL
       OR to_regprocedure('pg_catalog.encode(bytea,text)') IS NULL THEN
        RAISE EXCEPTION '0023 requires the verified bootstrap boundary and pg_catalog hashing functions';
    END IF;

    IF (
        SELECT pg_get_userbyid(proowner)
        FROM pg_proc
        WHERE oid = 'sync.read_bootstrap_boundary_v1(uuid,uuid)'::regprocedure
    ) <> 'shop_app_migrator' THEN
        RAISE EXCEPTION '0023 found unexpected bootstrap boundary ownership';
    END IF;

    IF (
        SELECT pg_get_userbyid(proowner)
        FROM pg_proc
        WHERE oid = 'pg_catalog.sha256(bytea)'::regprocedure
    ) <> 'postgres'
       OR (
            SELECT prosecdef
            FROM pg_proc
            WHERE oid = 'pg_catalog.sha256(bytea)'::regprocedure
       ) THEN
        RAISE EXCEPTION '0023 found an untrusted pg_catalog SHA-256 implementation';
    END IF;
END
$preconditions$;

CREATE OR REPLACE FUNCTION sync.read_bootstrap_boundary_v1(
    p_store_id uuid,
    p_device_id uuid
)
RETURNS TABLE (
    contract_version smallint,
    base_watermark bigint,
    snapshot_id text,
    server_time timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_snapshot pg_snapshot;
BEGIN
    IF current_setting('transaction_isolation') <> 'repeatable read'
       OR current_setting('transaction_read_only') <> 'on' THEN
        RAISE EXCEPTION '0022 bootstrap boundary requires a read-only REPEATABLE READ transaction'
            USING ERRCODE = '25001';
    END IF;
    IF p_store_id IS NULL
       OR p_store_id IS DISTINCT FROM platform.current_store_id()
       OR p_device_id IS NULL
       OR p_device_id IS DISTINCT FROM platform.current_device_id()
       OR platform.current_user_id() IS NULL THEN
        RAISE EXCEPTION '0022 bootstrap context is invalid'
            USING ERRCODE = '42501';
    END IF;

    PERFORM 1
    FROM ledger.stores AS store_record
    JOIN ledger.devices AS device_record
      ON device_record.store_id = store_record.id
     AND device_record.id = p_device_id
    JOIN platform.store_memberships AS membership
      ON membership.store_id = store_record.id
     AND membership.user_id = platform.current_user_id()
     AND membership.status = 'active'
    WHERE store_record.id = p_store_id
      AND store_record.status IN ('active', 'read_only')
      AND device_record.status = 'active';
    IF NOT FOUND THEN
        RAISE EXCEPTION '0022 bootstrap is unavailable'
            USING ERRCODE = '42501';
    END IF;

    v_snapshot := pg_current_snapshot();
    RETURN QUERY SELECT
        1::smallint,
        COALESCE(watermark.last_sequence, 0),
        pg_catalog.encode(
            pg_catalog.sha256(pg_catalog.convert_to(v_snapshot::text, 'UTF8')),
            'hex'
        ),
        transaction_timestamp()
    FROM (SELECT 1) AS singleton
    LEFT JOIN sync.store_change_watermarks_v1 AS watermark
      ON watermark.store_id = p_store_id;
END
$function$;

DO $postconditions$
DECLARE
    function_acl aclitem[];
BEGIN
    SELECT proacl
    INTO function_acl
    FROM pg_proc
    WHERE oid = 'sync.read_bootstrap_boundary_v1(uuid,uuid)'::regprocedure;

    IF (
        SELECT pg_get_userbyid(proowner)
        FROM pg_proc
        WHERE oid = 'sync.read_bootstrap_boundary_v1(uuid,uuid)'::regprocedure
    ) <> 'shop_app_migrator'
       OR NOT (
            SELECT prosecdef
            FROM pg_proc
            WHERE oid = 'sync.read_bootstrap_boundary_v1(uuid,uuid)'::regprocedure
       )
       OR (
            SELECT proconfig
            FROM pg_proc
            WHERE oid = 'sync.read_bootstrap_boundary_v1(uuid,uuid)'::regprocedure
       ) IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[] THEN
        RAISE EXCEPTION '0023 changed bootstrap boundary ownership or security configuration';
    END IF;

    IF NOT has_function_privilege(
            'shop_app_runtime',
            'sync.read_bootstrap_boundary_v1(uuid,uuid)',
            'EXECUTE'
       )
       OR has_function_privilege(
            'public',
            'sync.read_bootstrap_boundary_v1(uuid,uuid)',
            'EXECUTE'
       )
       OR has_function_privilege(
            'shop_app_auth',
            'sync.read_bootstrap_boundary_v1(uuid,uuid)',
            'EXECUTE'
       )
       OR has_function_privilege(
            'shop_app_auth_owner',
            'sync.read_bootstrap_boundary_v1(uuid,uuid)',
            'EXECUTE'
       ) THEN
        RAISE EXCEPTION '0023 changed bootstrap boundary execution privileges';
    END IF;

    IF function_acl IS NULL THEN
        RAISE EXCEPTION '0023 unexpectedly removed the explicit bootstrap boundary ACL';
    END IF;
END
$postconditions$;
