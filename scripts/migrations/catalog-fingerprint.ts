import { createHash } from 'node:crypto';

import type { QueryResultRow } from 'pg';

import type { MigrationStateQuery } from './effective-migration-state';

const applicationSchemas = ['audit', 'auth_api', 'ledger', 'platform', 'sync'] as const;

export interface CatalogFingerprint {
  formatVersion: 1;
  sha256: string;
  canonicalJson: string;
}

export async function readCatalogFingerprint(
  client: MigrationStateQuery,
): Promise<CatalogFingerprint> {
  const schemaFilter = [...applicationSchemas];
  const catalog = {
    formatVersion: 1,
    extensions: await rows(
      client,
      `
      select extname as name, extversion as version
      from pg_extension
      where extname in ('btree_gist', 'pgcrypto')
      order by extname
    `,
    ),
    schemas: await rows(
      client,
      `
      select n.nspname as schema, pg_get_userbyid(n.nspowner) as owner
      from pg_namespace n
      where n.nspname = any($1::text[])
      order by n.nspname
    `,
      [schemaFilter],
    ),
    relations: await rows(
      client,
      `
      select n.nspname as schema, c.relname as name, c.relkind as kind,
             pg_get_userbyid(c.relowner) as owner, c.relpersistence as persistence,
             c.relrowsecurity as "rowSecurity", c.relforcerowsecurity as "forceRowSecurity"
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1::text[]) and c.relkind in ('r', 'p', 'v', 'm', 'S')
      order by n.nspname, c.relname, c.relkind
    `,
      [schemaFilter],
    ),
    columns: await rows(
      client,
      `
      select n.nspname as schema, c.relname as relation, a.attnum as position,
             a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
             a.attnotnull as "notNull", a.attidentity as identity,
             a.attgenerated as generated,
             coalesce(pg_get_expr(d.adbin, d.adrelid), '') as "default"
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where n.nspname = any($1::text[]) and c.relkind in ('r', 'p', 'v', 'm')
        and a.attnum > 0 and not a.attisdropped
      order by n.nspname, c.relname, a.attnum
    `,
      [schemaFilter],
    ),
    constraints: await rows(
      client,
      `
      select n.nspname as schema, c.relname as relation, con.conname as name,
             con.contype as type, pg_get_constraintdef(con.oid, true) as definition,
             con.condeferrable as deferrable, con.condeferred as deferred,
             con.convalidated as validated
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1::text[])
      order by n.nspname, c.relname, con.conname
    `,
      [schemaFilter],
    ),
    indexes: await rows(
      client,
      `
      select n.nspname as schema, table_state.relname as relation,
             index_state.relname as name, pg_get_indexdef(index_state.oid) as definition,
             i.indisunique as unique, i.indisprimary as primary, i.indisvalid as valid
      from pg_index i
      join pg_class index_state on index_state.oid = i.indexrelid
      join pg_class table_state on table_state.oid = i.indrelid
      join pg_namespace n on n.oid = table_state.relnamespace
      where n.nspname = any($1::text[])
      order by n.nspname, table_state.relname, index_state.relname
    `,
      [schemaFilter],
    ),
    views: await rows(
      client,
      `
      select n.nspname as schema, c.relname as name, pg_get_viewdef(c.oid, true) as definition
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1::text[]) and c.relkind in ('v', 'm')
      order by n.nspname, c.relname
    `,
      [schemaFilter],
    ),
    routines: await rows(
      client,
      `
      select n.nspname as schema, p.proname as name,
             pg_get_function_identity_arguments(p.oid) as arguments,
             pg_get_function_result(p.oid) as result, p.prokind as kind,
             pg_get_userbyid(p.proowner) as owner, l.lanname as language,
             p.prosecdef as "securityDefiner", p.provolatile as volatility,
             p.proisstrict as strict, p.proparallel as parallel,
             coalesce(array_to_string(p.proconfig, ','), '') as configuration,
             pg_get_functiondef(p.oid) as definition
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
      where n.nspname = any($1::text[]) and p.prokind in ('f', 'p')
      order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)
    `,
      [schemaFilter],
    ),
    triggers: await rows(
      client,
      `
      select n.nspname as schema, c.relname as relation, t.tgname as name,
             t.tgenabled as enabled, pg_get_triggerdef(t.oid, true) as definition
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1::text[]) and not t.tgisinternal
      order by n.nspname, c.relname, t.tgname
    `,
      [schemaFilter],
    ),
    policies: await rows(
      client,
      `
      select schemaname as schema, tablename as relation, policyname as name,
             permissive, roles::text as roles, cmd,
             coalesce(qual, '') as using, coalesce(with_check, '') as "withCheck"
      from pg_policies
      where schemaname = any($1::text[])
      order by schemaname, tablename, policyname
    `,
      [schemaFilter],
    ),
    privileges: await rows(
      client,
      `
      select *
      from (
        select 'schema'::text as kind, n.nspname as schema, n.nspname as object,
               case when privilege.grantee=0 then 'PUBLIC'
                    else pg_get_userbyid(privilege.grantee) end as grantee,
               pg_get_userbyid(privilege.grantor) as grantor,
               privilege.privilege_type as privilege, privilege.is_grantable as "grantable"
        from pg_namespace n
        cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) privilege
        where n.nspname = any($1::text[])

        union all

        select case when c.relkind='S' then 'sequence' else 'relation' end,
               n.nspname, c.relname,
               case when privilege.grantee=0 then 'PUBLIC'
                    else pg_get_userbyid(privilege.grantee) end,
               pg_get_userbyid(privilege.grantor), privilege.privilege_type,
               privilege.is_grantable
        from pg_class c
        join pg_namespace n on n.oid=c.relnamespace
        cross join lateral aclexplode(
          coalesce(c.relacl, acldefault(case when c.relkind='S' then 's'::"char" else 'r'::"char" end, c.relowner))
        ) privilege
        where n.nspname = any($1::text[]) and c.relkind in ('r', 'p', 'v', 'm', 'S')

        union all

        select 'routine', n.nspname,
               p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
               case when privilege.grantee=0 then 'PUBLIC'
                    else pg_get_userbyid(privilege.grantee) end,
               pg_get_userbyid(privilege.grantor), privilege.privilege_type,
               privilege.is_grantable
        from pg_proc p
        join pg_namespace n on n.oid=p.pronamespace
        cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
        where n.nspname = any($1::text[]) and p.prokind in ('f', 'p')
      ) normalized
      order by kind, schema, object, grantee, grantor, privilege, "grantable"
    `,
      [schemaFilter],
    ),
    defaultPrivileges: await rows(
      client,
      `
      select pg_get_userbyid(d.defaclrole) as owner, coalesce(n.nspname, '') as schema,
             d.defaclobjtype as type,
             case when privilege.grantee=0 then 'PUBLIC'
                  else pg_get_userbyid(privilege.grantee) end as grantee,
             pg_get_userbyid(privilege.grantor) as grantor,
             privilege.privilege_type as privilege, privilege.is_grantable as "grantable"
      from pg_default_acl d
      left join pg_namespace n on n.oid = d.defaclnamespace
      cross join lateral aclexplode(d.defaclacl) privilege
      where n.nspname = any($1::text[])
         or (d.defaclnamespace = 0 and d.defaclobjtype = 'f'
             and pg_get_userbyid(d.defaclrole) in ('shop_app_migrator', 'shop_app_auth_owner'))
      order by owner, schema, type, grantee, grantor, privilege, "grantable"
    `,
      [schemaFilter],
    ),
  };
  const canonicalJson = JSON.stringify(catalog);
  return {
    formatVersion: 1,
    sha256: createHash('sha256').update(canonicalJson).digest('hex'),
    canonicalJson,
  };
}

async function rows(
  client: MigrationStateQuery,
  text: string,
  values: unknown[] = [],
): Promise<QueryResultRow[]> {
  return (await client.query<QueryResultRow>(text, values)).rows;
}
