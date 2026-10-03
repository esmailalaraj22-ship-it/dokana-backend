-- Migration 0019: use deterministic Owner selection in the provisioning-state read.
--
-- Migration 0018 is applied and immutable. PostgreSQL does not provide min(uuid),
-- so this corrective migration replaces only the affected function definition.

DO $preconditions$
DECLARE
    function_state record;
BEGIN
    IF session_user <> 'dokana_migration_login'
       OR current_user <> 'shop_app_migrator' THEN
        RAISE EXCEPTION '0019 requires the approved migration login and effective role';
    END IF;

    IF to_regprocedure('ledger.read_store_provisioning_state(uuid)') IS NULL THEN
        RAISE EXCEPTION '0019 requires the applied 0018 provisioning-state function';
    END IF;

    SELECT
        pg_get_userbyid(routine.proowner) AS owner,
        routine.prosecdef AS security_definer,
        routine.provolatile AS volatility,
        routine.proconfig AS configuration,
        pg_get_functiondef(routine.oid) AS definition
    INTO function_state
    FROM pg_proc AS routine
    WHERE routine.oid = 'ledger.read_store_provisioning_state(uuid)'::regprocedure;

    IF function_state.owner <> 'shop_app_migrator'
       OR NOT function_state.security_definer
       OR function_state.volatility <> 's'
       OR function_state.configuration IS DISTINCT FROM
            ARRAY['search_path=pg_catalog, pg_temp']::text[]
       OR function_state.definition NOT LIKE '%min(membership.user_id)%'
       OR NOT has_function_privilege(
            'shop_app_runtime',
            'ledger.read_store_provisioning_state(uuid)',
            'EXECUTE'
       )
       OR EXISTS (
            SELECT 1
            FROM aclexplode(COALESCE(
                (SELECT proacl
                 FROM pg_proc
                 WHERE oid = 'ledger.read_store_provisioning_state(uuid)'::regprocedure),
                acldefault('f', (SELECT proowner
                                 FROM pg_proc
                                 WHERE oid = 'ledger.read_store_provisioning_state(uuid)'::regprocedure))
            )) AS privilege
            WHERE privilege.grantee = 0
              AND privilege.privilege_type = 'EXECUTE'
       ) THEN
        RAISE EXCEPTION '0019 found an unexpected provisioning-state function configuration';
    END IF;
END
$preconditions$;

CREATE OR REPLACE FUNCTION ledger.read_store_provisioning_state(p_store_id uuid)
RETURNS TABLE (
    store_id uuid,
    store_name text,
    store_status text,
    owner_count bigint,
    owner_user_id uuid,
    settings_count bigint,
    system_cash_count bigint,
    subscription_count bigint,
    current_subscription_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
    IF p_store_id IS NULL
       OR p_store_id IS DISTINCT FROM platform.current_store_id()
       OR platform.current_user_id() IS NULL
       OR NOT ledger.current_actor_is_platform_admin() THEN
        RAISE EXCEPTION 'S18.4 provisioning read requires an active Platform Admin and matching Store context'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
        store_record.id,
        store_record.name,
        store_record.status,
        (
            SELECT count(*)
            FROM platform.store_memberships AS membership
            WHERE membership.store_id = store_record.id
              AND membership.role = 'owner'
              AND membership.status = 'active'
        ),
        (
            SELECT membership.user_id
            FROM platform.store_memberships AS membership
            WHERE membership.store_id = store_record.id
              AND membership.role = 'owner'
              AND membership.status = 'active'
            ORDER BY membership.created_at, membership.id
            LIMIT 1
        ),
        (
            SELECT count(*)
            FROM ledger.app_settings AS settings
            WHERE settings.store_id = store_record.id
        ),
        (
            SELECT count(*)
            FROM ledger.money_accounts AS account
            WHERE account.store_id = store_record.id
              AND account.account_type = 'cash'
              AND account.status = 'active'
              AND account.is_default
        ),
        (
            SELECT count(*)
            FROM platform.subscriptions AS subscription_record
            WHERE subscription_record.store_id = store_record.id
        ),
        (
            SELECT subscription_record.id
            FROM platform.subscriptions AS subscription_record
            WHERE subscription_record.store_id = store_record.id
            ORDER BY
                CASE subscription_record.status
                    WHEN 'active' THEN 0
                    WHEN 'trial' THEN 1
                    WHEN 'past_due' THEN 2
                    WHEN 'suspended' THEN 3
                    WHEN 'cancelled' THEN 4
                    WHEN 'expired' THEN 5
                    ELSE 6
                END,
                subscription_record.starts_at DESC,
                subscription_record.expires_at DESC,
                subscription_record.id DESC
            LIMIT 1
        )
    FROM ledger.stores AS store_record
    WHERE store_record.id = p_store_id;
END
$function$;

DO $postconditions$
DECLARE
    function_state record;
BEGIN
    SELECT
        pg_get_userbyid(routine.proowner) AS owner,
        routine.prosecdef AS security_definer,
        routine.provolatile AS volatility,
        routine.proconfig AS configuration,
        pg_get_functiondef(routine.oid) AS definition
    INTO function_state
    FROM pg_proc AS routine
    WHERE routine.oid = 'ledger.read_store_provisioning_state(uuid)'::regprocedure;

    IF function_state.owner <> 'shop_app_migrator'
       OR NOT function_state.security_definer
       OR function_state.volatility <> 's'
       OR function_state.configuration IS DISTINCT FROM
            ARRAY['search_path=pg_catalog, pg_temp']::text[]
       OR function_state.definition LIKE '%min(membership.user_id)%'
       OR function_state.definition NOT LIKE '%ORDER BY membership.created_at, membership.id%'
       OR NOT has_function_privilege(
            'shop_app_runtime',
            'ledger.read_store_provisioning_state(uuid)',
            'EXECUTE'
       )
       OR has_function_privilege(
            'shop_app_auth',
            'ledger.read_store_provisioning_state(uuid)',
            'EXECUTE'
       )
       OR has_function_privilege(
            'shop_app_auth_owner',
            'ledger.read_store_provisioning_state(uuid)',
            'EXECUTE'
       )
       OR EXISTS (
            SELECT 1
            FROM aclexplode(COALESCE(
                (SELECT proacl
                 FROM pg_proc
                 WHERE oid = 'ledger.read_store_provisioning_state(uuid)'::regprocedure),
                acldefault('f', (SELECT proowner
                                 FROM pg_proc
                                 WHERE oid = 'ledger.read_store_provisioning_state(uuid)'::regprocedure))
            )) AS privilege
            WHERE privilege.grantee = 0
              AND privilege.privilege_type = 'EXECUTE'
       ) THEN
        RAISE EXCEPTION '0019 provisioning-state function security state is unexpected';
    END IF;

    IF has_schema_privilege('shop_app_runtime', 'platform', 'USAGE')
       OR has_table_privilege('shop_app_runtime', 'platform.subscriptions', 'SELECT')
       OR has_table_privilege('shop_app_runtime', 'platform.subscriptions', 'INSERT')
       OR has_table_privilege('shop_app_runtime', 'platform.subscriptions', 'UPDATE')
       OR has_table_privilege('shop_app_runtime', 'platform.store_memberships', 'INSERT')
       OR has_table_privilege('shop_app_runtime', 'platform.admin_actions', 'INSERT') THEN
        RAISE EXCEPTION '0019 broadened runtime platform privileges';
    END IF;
END
$postconditions$;
