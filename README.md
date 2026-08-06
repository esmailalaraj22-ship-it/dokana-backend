# Dokana Backend

NestJS, TypeScript, Drizzle ORM, and PostgreSQL backend infrastructure for the
Dokana offline-first SaaS application. The current Station 3 scope provides the
migration ownership model, identity mappings, authentication database boundary,
session/token lifecycle, membership authorization, and device bootstrap.

Business modules, synchronization processing, subscriptions, accounting,
inventory, backup, and restore are not implemented yet.

## Prerequisites

- Node.js 22 or newer.
- An existing PostgreSQL database with the approved baseline already applied.
- The least-privileged runtime, migration, and authentication logins described
  in [the Station 3 architecture guide](docs/station-3-architecture.md).
- A local `.env` created from `.env.example`. Never commit `.env`.

The baseline reference package under
`database/reference/backend_database_reference/` is read-only. Never replay its
all-in-one SQL against a non-empty database.

## Local Setup

```powershell
npm.cmd ci
Copy-Item .env.example .env
```

Configure the existing runtime and approved administrative connection values in
the ignored `.env`, then run the one-time Station 3 local provisioning:

```powershell
npm.cmd run db:provision:station3
npm.cmd run auth:configure:local
```

`db:provision:station3` is a manual, first-time local provisioning command. It
prompts locally for only the limited migration and authentication login
passwords, updates only the ignored `.env`, and does not print credentials. Do
not rerun it after successful provisioning merely to start the application.

Replace any remaining `change-me` values. `auth:configure:local` generates a
strong local signing secret when the configured value is missing or invalid; it
preserves an existing valid secret.

For the already provisioned Station 3 database, verify state and start:

```powershell
npm.cmd run db:migrate:status
npm.cmd run db:migrate:verify
npm.cmd run db:check
npm.cmd run db:check:auth
npm.cmd run dev
```

The one-time `db:migrate:bootstrap*` commands are only for an approved database
that has the baseline and migration `0001` effects but no Station 3 migration
ledger. They intentionally fail after bootstrap and must not be rerun on the
current database. See the architecture guide for the exact sequence.

## Database Connections

The application keeps four database responsibilities separate:

| Variable                 | Purpose                                                    |
| ------------------------ | ---------------------------------------------------------- |
| `DATABASE_URL`           | Normal store-scoped runtime pool                           |
| `AUTH_DATABASE_URL`      | Function-only identity and authentication pool             |
| `DATABASE_MIGRATION_URL` | Controlled routine migrations as the limited login         |
| `DATABASE_ADMIN_URL`     | Optional one-time bootstrap and break-glass administration |

The runtime pool cannot access `auth_api` or global identity tables. The
authentication login has no direct protected-table privileges and can execute
only approved `auth_api` functions. Administrative and migration connections
are not injectable into ordinary NestJS modules.

Store-owned runtime work uses
`DatabaseService.withTenantTransaction()`. It sets transaction-local
`app.store_id`, `app.user_id`, `app.device_id`, and `app.request_id` on the same
connection used by the operation. The authentication guard derives this context
from the verified server-side session, not from request-body tenant values.

## Authentication API

All routes use the configured URI version, currently `v1`.

| Method | Route              | Authentication | Purpose                                      |
| ------ | ------------------ | -------------- | -------------------------------------------- |
| POST   | `/v1/auth/login`   | No             | Verify credentials, membership, store/device |
| POST   | `/v1/auth/refresh` | Refresh token  | Rotate refresh token and issue access token  |
| POST   | `/v1/auth/logout`  | Bearer token   | Revoke the current session                   |
| GET    | `/v1/auth/me`      | Bearer token   | Return the current verified principal        |
| GET    | `/v1/auth/stores`  | Bearer token   | List active authorized memberships           |

Passwords use Argon2id. Access tokens use HS256 with issuer, audience, type,
expiry, session, store, device, token ID, and key-ID validation. Access tokens
default to 15 minutes. Opaque refresh tokens contain 32 random bytes, are stored
only as SHA-256 hashes, rotate transactionally, and default to a fixed 30-day
session boundary. Confirmed refresh-token reuse revokes the token family and
session immediately.

`active` and `read_only` stores may authenticate. `suspended` and `archived`
stores fail login, refresh, and authenticated-session validation. First-device
registration occurs only after credential, membership, and store verification;
it preserves the supplied UUID and rejects incompatible existing bindings.

Full request/response contracts and key-rotation instructions are documented in
[docs/station-3-architecture.md](docs/station-3-architecture.md).

## Commands

| Command                                              | Purpose                                      |
| ---------------------------------------------------- | -------------------------------------------- |
| `npm.cmd run dev`                                    | Start NestJS in watch mode                   |
| `npm.cmd run build`                                  | Build production JavaScript                  |
| `npm.cmd run typecheck`                              | Run strict TypeScript checks                 |
| `npm.cmd run lint`                                   | Run ESLint                                   |
| `npm.cmd run format:check`                           | Verify Prettier formatting                   |
| `npm.cmd run test:unit`                              | Run unit tests                               |
| `npm.cmd run test:integration`                       | Run all real integration suites              |
| `npm.cmd run test:security`                          | Run Station 3 PostgreSQL security tests      |
| `npm.cmd run db:migrate:status`                      | Report applied and pending migrations        |
| `npm.cmd run db:migrate:verify`                      | Verify ledger checksums and no pending files |
| `npm.cmd run db:migrate`                             | Apply approved pending routine migrations    |
| `npm.cmd run db:check`                               | Verify the runtime connection and role       |
| `npm.cmd run db:check:auth`                          | Verify the authentication connection/role    |
| `npm.cmd run db:check:migration`                     | Verify the limited migration login           |
| `npm.cmd run db:check:admin`                         | Verify optional administrative connectivity  |
| `npm.cmd run db:migrate:bootstrap:check`             | Dry-run the one-time ownership bootstrap     |
| `npm.cmd run db:migrate:bootstrap:auth-schema:check` | Dry-run the one-time auth-schema bootstrap   |

Integration suites require all approved local test connection variables and
skip when the guarded local PostgreSQL environment is unavailable. A skipped
suite is not a passing runtime verification.

## Health

- `GET /health/live` checks only the NestJS process.
- `GET /health/ready` checks PostgreSQL runtime connectivity and runtime-role
  safety.
- `GET /health` returns the combined readiness response.

Responses never expose connection strings, credentials, tokens, or raw
PostgreSQL errors.

## Current Limitations

- Station 3 does not implement registration, password reset, email verification,
  MFA, device management, business modules, subscription enforcement,
  synchronization processing, backup, or restore.
- The selected Drizzle mappings reflect existing identity and migration-ledger
  objects. Drizzle generation and push commands remain intentionally unavailable;
  schema changes use reviewed hand-authored versioned migrations.
- PostgreSQL reference runtime tests remain `19/20`, not a full pass. The blocked
  mutation returns valid SQLSTATE `23514` before the reference expectation of
  `55000`, and the reference fixture omits a required `platform.users` row. The
  reference package remains unchanged.
- `npm audit` reports four moderate, development-only findings in the
  `drizzle-kit -> @esbuild-kit -> esbuild` toolchain. The affected esbuild
  development-server behavior is not used by this backend, and npm currently
  offers only an incompatible Drizzle Kit downgrade. This is deferred for an
  upstream compatible fix. `npm audit --omit=dev` reports zero production
  dependency vulnerabilities.
- Passing Station 3 tests does not constitute independent review or full
  production database approval.

The approved supplier rule remains unchanged: supplier invoices affect payable
and supplier balance only; manual inventory entry is a separate operation.
