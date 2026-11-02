-- Migration 0035: distinguish executed migration history from release-baseline provenance.
--
-- platform.schema_migrations remains the history of migrations that actually executed.
-- A future approved schema baseline is registered separately and immutably through the
-- narrowly granted function below. Runtime and authentication roles receive no access.

CREATE TABLE platform.release_baseline_provenance (
    singleton_key smallint PRIMARY KEY DEFAULT 1 CHECK (singleton_key = 1),
    format_version integer NOT NULL CHECK (format_version = 1),
    baseline_identifier text NOT NULL CHECK (
        baseline_identifier ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
    ),
    source_git_head text NOT NULL CHECK (source_git_head ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
    catalog_fingerprint_sha256 text NOT NULL CHECK (
        catalog_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
    ),
    migration_ceiling text NOT NULL CHECK (
        migration_ceiling ~ '^[0-9]{4}_[a-z0-9_]+[.]sql$'
    ),
    migration_checksum_manifest jsonb NOT NULL CHECK (
        jsonb_typeof(migration_checksum_manifest) = 'array'
        AND jsonb_array_length(migration_checksum_manifest) > 0
    ),
    registered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE platform.release_baseline_provenance IS
    'Immutable provenance for a schema supplied by an approved release baseline; not executed migration history.';

ALTER TABLE platform.release_baseline_provenance OWNER TO shop_app_migrator;
REVOKE ALL ON TABLE platform.release_baseline_provenance FROM PUBLIC;
REVOKE ALL ON TABLE platform.release_baseline_provenance
    FROM shop_app_runtime, shop_app_readonly, shop_app_auth;

CREATE FUNCTION platform.reject_release_baseline_provenance_mutation_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, platform, pg_temp
AS $function$
BEGIN
    RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'Release baseline provenance is immutable';
END;
$function$;

ALTER FUNCTION platform.reject_release_baseline_provenance_mutation_v1()
    OWNER TO shop_app_migrator;
REVOKE ALL ON FUNCTION platform.reject_release_baseline_provenance_mutation_v1() FROM PUBLIC;

CREATE TRIGGER release_baseline_provenance_immutable
BEFORE UPDATE OR DELETE ON platform.release_baseline_provenance
FOR EACH ROW EXECUTE FUNCTION platform.reject_release_baseline_provenance_mutation_v1();

CREATE FUNCTION platform.register_release_baseline_provenance_v1(
    p_format_version integer,
    p_baseline_identifier text,
    p_source_git_head text,
    p_artifact_sha256 text,
    p_catalog_fingerprint_sha256 text,
    p_migration_ceiling text,
    p_migration_checksum_manifest jsonb
)
RETURNS TABLE(registered_at timestamptz, replayed boolean)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, platform, pg_temp
AS $function$
DECLARE
    existing platform.release_baseline_provenance%ROWTYPE;
    last_manifest_filename text;
BEGIN
    IF session_user <> 'dokana_migration_login' OR current_user <> 'shop_app_migrator' THEN
        RAISE EXCEPTION USING
            ERRCODE = '42501',
            MESSAGE = 'Release baseline registration requires the approved migration authority';
    END IF;

    IF p_format_version <> 1
       OR p_baseline_identifier !~ '^[a-z0-9][a-z0-9._-]{0,127}$'
       OR p_source_git_head !~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
       OR p_artifact_sha256 !~ '^[0-9a-f]{64}$'
       OR p_catalog_fingerprint_sha256 !~ '^[0-9a-f]{64}$'
       OR p_migration_ceiling !~ '^[0-9]{4}_[a-z0-9_]+[.]sql$'
       OR jsonb_typeof(p_migration_checksum_manifest) <> 'array'
       OR jsonb_array_length(p_migration_checksum_manifest) = 0 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Release baseline provenance is invalid';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_migration_checksum_manifest) WITH ORDINALITY AS entry(value, position)
        WHERE jsonb_typeof(value) <> 'object'
           OR value->>'filename' !~ '^[0-9]{4}_[a-z0-9_]+[.]sql$'
           OR value->>'checksumSha256' !~ '^[0-9a-f]{64}$'
           OR (SELECT count(*) FROM jsonb_object_keys(value)) <> 2
    ) OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_migration_checksum_manifest) AS entry(value)
        GROUP BY value->>'filename'
        HAVING count(*) <> 1
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Migration checksum manifest is invalid';
    END IF;

    SELECT value->>'filename'
    INTO last_manifest_filename
    FROM jsonb_array_elements(p_migration_checksum_manifest) WITH ORDINALITY AS entry(value, position)
    ORDER BY position DESC
    LIMIT 1;

    IF last_manifest_filename <> p_migration_ceiling THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Migration ceiling does not match the manifest';
    END IF;

    LOCK TABLE platform.release_baseline_provenance IN EXCLUSIVE MODE;

    SELECT * INTO existing
    FROM platform.release_baseline_provenance
    WHERE singleton_key = 1;

    IF FOUND THEN
        IF existing.format_version = p_format_version
           AND existing.baseline_identifier = p_baseline_identifier
           AND existing.source_git_head = p_source_git_head
           AND existing.artifact_sha256 = p_artifact_sha256
           AND existing.catalog_fingerprint_sha256 = p_catalog_fingerprint_sha256
           AND existing.migration_ceiling = p_migration_ceiling
           AND existing.migration_checksum_manifest = p_migration_checksum_manifest THEN
            RETURN QUERY SELECT existing.registered_at, true;
            RETURN;
        END IF;
        RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'Conflicting release baseline provenance exists';
    END IF;

    IF EXISTS (SELECT 1 FROM platform.schema_migrations) THEN
        RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'Baseline registration requires empty executed migration history';
    END IF;

    INSERT INTO platform.release_baseline_provenance (
        singleton_key,
        format_version,
        baseline_identifier,
        source_git_head,
        artifact_sha256,
        catalog_fingerprint_sha256,
        migration_ceiling,
        migration_checksum_manifest
    ) VALUES (
        1,
        p_format_version,
        p_baseline_identifier,
        p_source_git_head,
        p_artifact_sha256,
        p_catalog_fingerprint_sha256,
        p_migration_ceiling,
        p_migration_checksum_manifest
    )
    RETURNING platform.release_baseline_provenance.registered_at
    INTO registered_at;

    replayed := false;
    RETURN NEXT;
END;
$function$;

ALTER FUNCTION platform.register_release_baseline_provenance_v1(
    integer, text, text, text, text, text, jsonb
) OWNER TO shop_app_migrator;
REVOKE ALL ON FUNCTION platform.register_release_baseline_provenance_v1(
    integer, text, text, text, text, text, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.register_release_baseline_provenance_v1(
    integer, text, text, text, text, text, jsonb
) TO shop_app_migrator;
