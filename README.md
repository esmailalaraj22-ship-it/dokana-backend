# Dokana Backend

NestJS infrastructure for the Dokana offline-first SaaS backend. Station 2
provides configuration, PostgreSQL/Drizzle connectivity, health checks,
structured logging, request tracing, security defaults, and test tooling. It
does not implement business modules.

## Prerequisites

- Node.js 22 or newer.
- An existing PostgreSQL database with the approved baseline already applied.
- A non-owner, non-superuser login that is a member of `shop_app_runtime`.
- A separate administrative login associated with `shop_app_migrator` for
  future approved migrations.

The baseline is read-only at
`database/reference/backend_database_reference/`. Do not run the all-in-one
baseline against an existing database.

## Setup

```powershell
npm.cmd install
Copy-Item .env.example .env
npm.cmd run dev
```

Replace the example URLs in `.env` with locally managed credentials. Never
commit `.env`.

`DATABASE_URL` is required by the application and must use a least-privilege
runtime login. `DATABASE_ADMIN_URL` is optional at runtime and is required only
for explicitly approved administrative or migration commands.

`DATABASE_SSL_MODE` must be explicit:

- `disable` for a trusted local development connection.
- `verify-full` for certificate-verified TLS.

CORS is disabled when `CORS_ORIGINS` is empty. When enabled, it accepts only the
comma-separated exact HTTP(S) origins configured there.

## Commands

| Command                        | Purpose                                               |
| ------------------------------ | ----------------------------------------------------- |
| `npm.cmd run dev`              | Start NestJS in watch mode                            |
| `npm.cmd run build`            | Build production JavaScript and source maps           |
| `npm.cmd run start:prod`       | Run the compiled application                          |
| `npm.cmd run typecheck`        | Run strict TypeScript checks                          |
| `npm.cmd run lint`             | Run ESLint                                            |
| `npm.cmd run format:check`     | Verify Prettier formatting                            |
| `npm.cmd run test:unit`        | Run deterministic unit tests                          |
| `npm.cmd run test:integration` | Run health and optional database integration tests    |
| `npm.cmd run test:cov`         | Run unit tests with coverage                          |
| `npm.cmd run db:check`         | Verify the runtime connection using read-only queries |
| `npm.cmd run db:check:admin`   | Verify the separate administrative connection         |

The database integration suite is skipped unless `TEST_DATABASE_URL` is set.
Its current checks are read-only except for transaction-local PostgreSQL
settings; it does not create, alter, or delete database objects.

## Database Access

The NestJS dependency graph constructs only a runtime pool from `DATABASE_URL`.
The pool has bounded connection, statement, lock, idle, and idle-transaction
timeouts and is closed during graceful shutdown.

Startup and readiness verify that the effective runtime role:

- is a member of the baseline `shop_app_runtime` role;
- is not a superuser and does not have `BYPASSRLS`;
- cannot create databases or roles, replicate, or enter `shop_app_migrator`;
- has row security enabled and runtime schema access;
- has no direct `platform` or `audit` schema access;
- does not own protected application tables.

Store-owned work must use `DatabaseService.withTenantTransaction()`. It validates
UUID context and sets `app.store_id`, `app.user_id`, `app.device_id`, and
`app.request_id` with transaction-local scope before invoking business work.

`drizzle.config.ts` reads only `DATABASE_ADMIN_URL`. No Drizzle-generated
migrations or business-table mappings are included. Migration generation and
push scripts are intentionally unavailable until the existing baseline has
been mapped and independently reviewed.

Versioned migrations live in `database/migrations/` as hand-authored SQL and
are applied only through the administrative connection, for example:

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" $env:DATABASE_ADMIN_URL -v ON_ERROR_STOP=1 -f database/migrations/0001_rls_context_function_privileges.sql
```

Migration `0001_rls_context_function_privileges.sql` makes the four
`platform.current_*` context functions `SECURITY DEFINER` with a pinned
`search_path` so the runtime role can evaluate tenant RLS policies. It grants
nothing to the runtime role and leaves the baseline reference files untouched.

## Health

- `GET /health/live` checks only the NestJS process and returns `200`.
- `GET /health/ready` checks PostgreSQL and runtime-role safety; it returns
  `200` when ready or `503` otherwise.
- `GET /health` returns the combined readiness response.

Health responses contain status, time, uptime, environment, and check latency.
They never expose connection strings or raw database errors.

Future business APIs use URI versioning with the configured `API_VERSION`
(default `v1`). Health endpoints are version-neutral.

## Security and Observability

The bootstrap enables secure response headers, allowlisted CORS, strict DTO
validation, unknown-field rejection, a bounded request body, and consistent
error responses. Logs are structured JSON with request duration and UUID
request IDs. Common credentials, tokens, license keys, and database connection
fields are redacted.

Incoming request IDs are ignored by default. When
`REQUEST_ID_TRUST_INCOMING=true`, only valid UUIDs are accepted; all other
values are replaced.

## Current Limitations

- No authentication, users, stores, subscriptions, devices, sync, accounting,
  inventory, backup, or restoration behavior is implemented.
- The approved PostgreSQL tables are not yet mapped into Drizzle TypeScript
  schemas.
- One migration exists and was applied to the local development database:
  `database/migrations/0001_rls_context_function_privileges.sql`. Without it,
  every tenant-table query fails for the runtime role with `42501` because the
  baseline grants no path to the RLS context functions.
- Runtime connectivity cannot be verified without owner-provided local
  credentials.
- The baseline `shop_app_migrator` grants object privileges but does not grant
  schema `CREATE` or object ownership. The backend owner must approve the
  effective migration-login ownership and privilege model before the first
  migration.
- `06_runtime_tests.sql` was executed on 2026-08-05 against the local
  development database after migration 0001 (fully rolled back): 19 of 20
  tests passed, including the runtime-role RLS isolation test. Two known
  reference-package defects remain and need a versioned test-artifact
  correction: the script seeds no `platform.users` row for its fixed
  `app.user_id` although `audit.central_audit_logs.user_id` enforces a foreign
  key (worked around by an external wrapper seed; the reference file was not
  modified), and the test `Posted sale items cannot be changed` expects
  SQLSTATE `55000` while the amount-consistency guard rejects the update first
  with `23514` (the mutation is still blocked).
- Backup/restore and full production approval remain outside Station 2.
