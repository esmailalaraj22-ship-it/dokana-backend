# Station 3 Architecture and Operations

## Scope

Station 3 establishes migration ownership, the migration ledger, controlled
migration execution, identity mappings, the authentication database boundary,
session/token behavior, membership authorization, first-device bootstrap, and
real PostgreSQL security tests.

It does not implement business modules, public registration, password reset,
MFA, subscriptions, synchronization processing, backup, restore, or Station 4.

## Role Model

The approved role chain is:

```text
dokana_migration_login (LOGIN, NOINHERIT)
    SET ROLE -> shop_app_migrator (NOLOGIN, application object owner)
        SET LOCAL ROLE -> shop_app_auth_owner
        only in allow-listed managed auth-object migrations

dokana_auth_login (LOGIN, INHERIT)
    inherits -> shop_app_auth (NOLOGIN, auth_api execution only)

dokana_runtime_login
    inherits -> shop_app_runtime (store-scoped runtime privileges)
```

All Station 3 roles are non-superuser, cannot create databases or roles, cannot
replicate, and do not have `BYPASSRLS`.

`dokana_migration_login` is directly assigned only to `shop_app_migrator`.
Neither the login nor `shop_app_migrator` can assume runtime, authentication
execution, application login, superuser, or `BYPASSRLS` roles.

`shop_app_auth_owner` is `NOLOGIN` and `NOINHERIT`. It owns only the `auth_api`
schema and its approved functions. It does not own baseline tables, tenant
tables, runtime objects, or unrelated functions. Its direct platform/ledger
privileges are limited to the columns needed by those functions.

The full role-chain rollback is an administrative operation:

```sql
REVOKE shop_app_auth_owner FROM shop_app_migrator;
```

Do not execute that rollback while managed auth functions still depend on the
owner role.

## Ownership and Migration Foundation

The exact baseline inventory is maintained in:

```text
scripts/migrations/application-object-inventory.ts
```

It enumerates the four application schemas and every table, sequence, view, and
routine that was eligible for the one-time ownership transition. Verification
fails on missing, additional, or unexpectedly owned application objects.
Extensions, system schemas, the database itself, and unrelated objects are not
transferred.

Migration `0002` transferred that explicit inventory from `postgres` to
`shop_app_migrator`, created `platform.schema_migrations`, revoked public
defaults, and left runtime grants and RLS intact. It did not use
`REASSIGN OWNED`.

`platform.schema_migrations` records:

- filename;
- SHA-256 checksum;
- application and registration timestamps;
- effective applying role;
- execution time;
- non-secret JSON metadata.

Migration `0001` was already applied before the ledger existed. The bootstrap
verified its repository checksum and all four live `platform.current_*`
functions, then registered it with `replayed: false`. It was not executed again.

## Migration Inventory

| Migration                                    | Execution boundary               | Result                                          |
| -------------------------------------------- | -------------------------------- | ----------------------------------------------- |
| `0001_rls_context_function_privileges.sql`   | Pre-existing Station 2 migration | Verified and registered, never replayed         |
| `0002_migration_ownership_foundation.sql`    | One-time admin bootstrap         | Exact ownership transition and ledger           |
| `0003_authentication_api_schema.sql`         | One-time admin bootstrap         | Empty `auth_api` schema owned by auth owner     |
| `0004_authentication_database_api.sql`       | Limited migration runner         | Auth functions, grants, and narrow RLS policies |
| `0005_refresh_rotation_session_boundary.sql` | Limited migration runner         | Fixed-boundary refresh rotation entry point     |

The approved local database currently has five applied migrations and no
pending file.

## Controlled Migration Runner

`scripts/migrate.ts` uses only `DATABASE_MIGRATION_URL`.

It:

- requires `session_user = dokana_migration_login`;
- rejects superuser and `BYPASSRLS` execution;
- verifies the login can assume only the approved migration boundary;
- executes `SET ROLE shop_app_migrator`;
- takes a PostgreSQL advisory lock;
- verifies every applied checksum;
- rejects incomplete one-time bootstrap state;
- applies pending files in deterministic filename order;
- wraps each routine migration and ledger insert in one transaction;
- permits `SET LOCAL ROLE shop_app_auth_owner` only in the hard-coded managed
  authentication migration allow-list;
- verifies the effective role after migration SQL;
- does not record a failed transaction;
- releases the advisory lock and pool on exit.

Routine commands:

```powershell
npm.cmd run db:migrate:status
npm.cmd run db:migrate:verify
npm.cmd run db:migrate
```

Do not pass runtime, authentication, or administrative URLs to the runner.
There is no user-controlled role-switch option.

### One-Time Bootstrap Sequence

This sequence applies only to an approved baseline database before Station 3
bootstrap. It must not be rerun after the ledger exists:

```powershell
npm.cmd run db:migrate:bootstrap:check
npm.cmd run db:migrate:bootstrap
npm.cmd run db:migrate:bootstrap:auth-schema:check
npm.cmd run db:migrate:bootstrap:auth-schema
npm.cmd run db:migrate
```

The dry-run commands execute their SQL inside rolled-back transactions. The
bootstrap commands require the approved administrative connection because the
routine migration login does not receive database-level schema creation or
broad ownership powers.

## Authentication Database Boundary

NestJS creates a separate bounded pool from `AUTH_DATABASE_URL`. The login has:

- database connection;
- inherited `USAGE` on `auth_api`;
- execution of exactly six public authentication entry points;
- no schema `CREATE`;
- no direct protected-table or column privilege;
- no runtime or migration membership;
- no application object ownership.

The runtime role has no `auth_api` usage or execution and no global platform
identity-table access.

### SECURITY DEFINER Functions

All functions are owned by `shop_app_auth_owner`, revoke `PUBLIC` execution,
and pin `search_path` to `pg_catalog`, approved explicit schemas, and `pg_temp`
last.

Approved execution entry points:

```text
auth_api.lookup_credentials(text)
auth_api.list_authorized_stores(uuid)
auth_api.issue_session(uuid,uuid,uuid,text,text,uuid,uuid,uuid,text,uuid,timestamptz,timestamptz,text,text)
auth_api.validate_session(uuid,uuid,uuid,uuid,uuid)
auth_api.rotate_refresh_token(text,uuid,text,uuid,integer)
auth_api.revoke_session(uuid,uuid,text)
```

The timestamp overload of `rotate_refresh_token` remains as the immutable
`0004` implementation detail. `shop_app_auth` cannot execute it directly; the
integer-TTL wrapper from `0005` clamps expiry to the fixed session boundary.

### Narrow RLS Additions

Migration `0004` adds only:

```text
auth_membership_self_permissive
auth_membership_self_restrictive
auth_store_membership_permissive
auth_store_membership_restrictive
auth_device_membership_restrictive
```

They apply only to `shop_app_auth_owner`, require the transaction-local user or
store context, and compose with the existing forced baseline RLS. Existing
runtime tenant policies remain present. Missing context fails closed.

## Authentication Lifecycle

### Passwords

Passwords use Argon2id through `argon2` with:

```text
memoryCost: 19456 KiB
timeCost: 2
parallelism: 1
hashLength: 32 bytes
```

Unknown identities perform a dummy Argon2 verification. Plaintext passwords and
password hashes are never returned by HTTP responses or written to request
logs. Parameter constants permit a future explicit rehash policy.

### Access Tokens

Access tokens use HS256 for the current single-backend deployment:

- default lifetime: 900 seconds;
- required issuer and audience;
- protected `kid` and `typ`;
- payload type, subject, JTI, session, store, and device UUID validation;
- active signing key plus explicitly configured previous verification keys;
- five-second clock tolerance.

Key rotation procedure:

1. Add the current key ID and secret to
   `AUTH_ACCESS_TOKEN_PREVIOUS_KEYS`.
2. Configure a new `AUTH_ACCESS_TOKEN_ACTIVE_KID` and strong active secret.
3. Restart all instances consistently.
4. Keep the previous key until every token it signed has expired.
5. Remove retired keys and restart consistently.

Do not place the active key ID in the previous-key object.

### Refresh Tokens and Sessions

Refresh tokens are opaque 32-byte random values. Only SHA-256 hashes are stored.
The default refresh and session lifetime is 30 days.

Rotation locks the current refresh token and session in PostgreSQL, inserts the
replacement, marks the parent used, and changes the access-token JTI in one
transaction. Confirmed reuse revokes the complete token family and session.
Unknown, malformed, expired, or revoked tokens return the same generic
authentication failure.

Every protected request validates current server state: user, session, access
JTI, membership, store, and device. Logout revokes the authoritative session
and its refresh tokens.

### Membership, Store, and Device Rules

- Only active memberships authorize a store.
- `active` and `read_only` stores can log in, refresh, and use authenticated
  identity reads.
- `suspended` and `archived` stores fail login, refresh, and access validation.
- A first device is created only after credential, user, membership, and store
  validation.
- The supplied valid UUID is preserved.
- Repeated or concurrent first login is idempotent.
- Cross-store UUID reuse and revoked/replaced devices fail generically.

After session validation, `AuthenticationGuard` attaches a
`TenantTransactionContext` derived from the principal plus the server-generated
request ID. Request-body identifiers cannot replace those authoritative values.

## API Contracts

All error responses use the common envelope with `statusCode`, stable `code`,
generic `message`, `requestId`, `timestamp`, and `path`. Validation errors may
add field details. Internal SQL errors and stack traces are not returned.

### POST /v1/auth/login

Authentication: none.

Request:

```json
{
  "email": "string",
  "password": "string",
  "storeId": "uuid",
  "deviceId": "uuid",
  "deviceName": "string",
  "devicePlatform": "android | ios"
}
```

Success: `200`.

```json
{
  "tokenType": "Bearer",
  "accessToken": "string",
  "accessTokenExpiresInSeconds": 900,
  "refreshToken": "string",
  "sessionExpiresAt": "UTC timestamp",
  "identity": {
    "id": "uuid",
    "email": "string",
    "fullName": "string"
  },
  "store": {
    "id": "uuid",
    "name": "string",
    "status": "active | read_only"
  },
  "membership": {
    "role": "owner | manager | viewer | support",
    "version": "decimal string"
  },
  "deviceId": "uuid",
  "sessionId": "uuid"
}
```

Invalid credentials, user state, membership, store, or device returns the same
`401 AUTHENTICATION_FAILED` response. Invalid fields return
`400 VALIDATION_ERROR`.

### POST /v1/auth/refresh

Authentication: opaque refresh token in the request body.

```json
{
  "refreshToken": "string"
}
```

Success: `200` with the authentication response and a newly rotated refresh
token. Invalid, expired, revoked, or reused tokens return generic `401`.

### POST /v1/auth/logout

Authentication: Bearer access token. Success: `204` with no body. The current
server-side session and refresh tokens are revoked.

### GET /v1/auth/me

Authentication: Bearer access token. Success: `200` with the verified principal,
including user, store, membership, device, session, and session expiry.

### GET /v1/auth/stores

Authentication: Bearer access token. Success: `200` with only the user's active
memberships whose stores are `active` or `read_only`.

## Environment Names

Required application values:

```text
DATABASE_URL
AUTH_DATABASE_URL
DATABASE_SSL_MODE
AUTH_ACCESS_TOKEN_ACTIVE_KID
AUTH_ACCESS_TOKEN_ACTIVE_SECRET
```

Authentication values with validated defaults:

```text
AUTH_DB_POOL_MAX
AUTH_TOKEN_ISSUER
AUTH_TOKEN_AUDIENCE
AUTH_ACCESS_TOKEN_PREVIOUS_KEYS
AUTH_ACCESS_TOKEN_TTL_SECONDS
AUTH_REFRESH_TOKEN_TTL_SECONDS
AUTH_SESSION_TTL_SECONDS
```

Operational values:

```text
DATABASE_MIGRATION_URL
DATABASE_ADMIN_URL
TEST_DATABASE_URL
TEST_DATABASE_SSL_MODE
```

The migration and administrative values are not consumed by ordinary NestJS
runtime modules. `.env` is ignored by Git.

## Rollback and Recovery

Applied migration files are immutable. Prefer a new forward remediation
migration. Rollback requires backend-owner approval and a verified backup.

- `0005`: grant the timestamp rotation overload back to `shop_app_auth`, then
  drop the integer overload.
- `0004`: revoke auth execution and schema usage, drop the seven auth functions
  in dependency order, drop the five `auth_*` policies, revoke the listed
  owner-column and schema grants, then remove the empty `auth_api` schema.
- `0003`: drop `auth_api` only after all managed functions are removed.
- `0002`: transfer only the explicit inventory back to the prior owner and then
  remove the ledger. Never use `REASSIGN OWNED`.
- `0001`: is not rolled back or replayed as part of Station 3.

After auth objects are removed, the role-chain rollback is:

```sql
REVOKE shop_app_auth_owner FROM shop_app_migrator;
```

Unexpected checksums, owners, roles, policies, or ledger state are fail-closed
conditions. Do not force ledger rows or edit migration files to bypass them.

## PostgreSQL Test Fixtures

Integration tests accept only local PostgreSQL URLs, reject `APP_ENV=production`,
and require runtime, admin, auth, and migration connections to target the same
database.

A dedicated test-only administrative fixture pool uses:

```text
session_replication_role=replica
app.suppress_change_events=on
```

This is limited to deterministic creation and cleanup of random local fixtures
around immutable-device and change-event triggers. Authentication behavior uses
the normal auth pool. RLS, cross-tenant, and context-isolation assertions use
the normal runtime pool. Security tests assert final fixture cleanliness.

## Dependency Audit

The current audit has four moderate findings on one development-only path:

```text
drizzle-kit
  -> @esbuild-kit/esm-loader
  -> @esbuild-kit/core-utils
  -> esbuild 0.18.x
```

The advisory concerns an esbuild development server accepting cross-origin
requests. Dokana does not run that server, and the path is not in production
runtime dependencies. The installed `drizzle-kit` is the current compatible
release; npm proposes only an older incompatible downgrade. No override is
applied because compatibility is unverified. Monitor Drizzle Kit for removal or
upgrade of the legacy loader. `npm audit --omit=dev` reports zero production
dependency vulnerabilities.

## Known Reference Condition

The read-only reference package is unchanged. Its PostgreSQL runtime test remains
`19/20`, not a full pass:

- a blocked mutation returns SQLSTATE `23514` before the script's expected
  `55000`;
- the script omits a required `platform.users` fixture for an audit foreign key.

This condition does not establish complete production database readiness.
