# apps/api

Opportunity Engine backend — orchestrator, agents, and the DB migration
tooling for both databases the platform talks to.

## Databases

The platform has **two** Postgres databases with different roles:

| Database | Purpose | Migrations live in | Runner |
|---|---|---|---|
| App DB (local dev = `oe_test`, prod = Neon) | The pipeline's data model — founders, evidence, hypotheses, pipeline runs, agent execution logs, etc. Accessed via Prisma. | `src/db/migrations/*.sql` (files 001–016) | Applied manually today — see the follow-up note below. |
| Supabase (`xshwfylebgapbevstniq`) | Auth (`auth.users`) plus a thin set of auth-adjacent tables the web frontend writes to directly via PostgREST (currently `waitlist_signups`). | `supabase/migrations/<timestamp>_<name>.sql` | `npm run db:migrate:supabase` (this repo). |

Migration 012 (`founder.auth_user_id`) is the loose bridge — a UUID column
on the app DB's `founder` table that references a Supabase Auth user's ID,
with no enforced FK. Application code owns the invariant.

## Supabase migrations

### Adding a new migration

1. Write the SQL as `supabase/migrations/<YYYYMMDDHHMMSS>_<slug>.sql`
   (Supabase CLI convention — timestamped and sortable). Example:
   `20260720094500_add_feature_flags.sql`.
2. Test it locally against the Supabase project by running
   `npm run db:migrate:supabase`.
3. Commit the file together with the code that depends on it.
4. **After the PR merges**, run `npm run db:migrate:supabase` against the
   production project. There is no auto-apply step yet — this is the
   manual gate that would have caught the missing-017 incident (see the
   CI follow-up note below).

### Available commands

```
npm run db:migrate:supabase          # apply pending migrations
npm run db:migrate:supabase:list     # show local/remote sync state
```

Both read `SUPABASE_DB_URL` from `apps/api/.env` (see `.env.example`).

### Requirements

- `SUPABASE_DB_URL` — Supabase session-pooler URL. Get it from Supabase
  Dashboard → Project Settings → Database → **Session pooler** (not the
  direct-connect URL; that resolves IPv6-only on many networks). Never
  commit this.

### Compatibility with the Supabase CLI

The runner writes into `supabase_migrations.schema_migrations` — the same
table the Supabase CLI uses — so if anyone sets up an access token
(`supabase login`), `supabase migration list --linked` and `supabase db
diff` will still see the correct applied state. The reason we ship our
own runner instead of `supabase db push`: the upstream CLI's connection
layer fails opaquely on the Windows dev environments used for this repo
regardless of URL/port/SSL variant (see the commit that landed this
tooling). Node's `pg` client connects fine, so we use that.

## App DB migrations (`src/db/migrations/`)

Files `001` through `016` land the pipeline schema onto whatever Postgres
`DATABASE_URL` points at (local `oe_test` in dev, Neon in prod). Prisma
introspects the resulting schema; there is currently **no runner** for
this stream — pending follow-up. To apply manually today:

```
psql "$DATABASE_URL" -f src/db/migrations/NNN_*.sql
```

Do not mix these files into `supabase/migrations/` — they reference
`gen_random_uuid()` and other extensions that assume the app DB, not
Supabase, and putting them in the Supabase stream would duplicate the
whole schema in a database that doesn't own it.

## Follow-ups

- **CI check** — no `.github/workflows/` exists yet in this repo. When
  CI is added, the smallest useful step is
  `npm run db:migrate:supabase:list` on the release branch (exit code 1
  means "someone merged a migration file without applying it, block the
  build"). Auto-applying migrations from CI is deliberately not done
  here — there is no established pattern in this repo for unattended
  prod-DB writes, and the risk profile is higher than the ergonomic
  win.
- **App DB runner** — the `src/db/migrations/` stream still has no
  automated applier. A follow-up should mirror the Supabase runner
  (`applyAppDbMigrations.ts` writing into a dedicated tracking table)
  once the app DB has a stable production home (Neon vs. Supabase-hosted
  Postgres is unresolved).
