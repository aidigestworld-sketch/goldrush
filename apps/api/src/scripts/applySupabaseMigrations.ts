/**
 * Applies pending SQL files in supabase/migrations/ to the linked Supabase
 * Postgres, tracked in supabase_migrations.schema_migrations — the same
 * table the Supabase CLI writes to, so `supabase migration list --linked`
 * remains an accurate audit surface for anyone with the CLI wired up.
 *
 * Why a hand-rolled runner instead of `supabase db push`:
 *   The Supabase CLI's connection layer fails on this Windows setup with
 *   an opaque "PgClient: Failed to connect" for every URL/port variant we
 *   tried (see commit history for 017). Node's pg client connects fine
 *   against the same pooler URL, so this runner ships the automation now
 *   and keeps future CLI compatibility.
 *
 * Contract:
 *   - Reads SUPABASE_DB_URL from env (pooler URL, session mode, port 5432).
 *   - Reads *.sql files from apps/api/supabase/migrations/ sorted by name
 *     (Supabase CLI naming convention: <YYYYMMDDHHMMSS>_<slug>.sql).
 *   - Applies each file's contents in a single top-level transaction.
 *   - Records the version in supabase_migrations.schema_migrations only if
 *     the SQL succeeded (all-or-nothing per file).
 *   - Skips versions already present in that table.
 */

import { Client } from "pg";
import * as fs from "node:fs";
import * as path from "node:path";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");

type MigrationFile = { version: string; name: string; sql: string; filename: string };

function loadMigrations(): MigrationFile[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`migrations directory not found: ${MIGRATIONS_DIR}`);
  }
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((filename) => {
      const match = /^(\d{14})_(.+)\.sql$/.exec(filename);
      if (!match) {
        throw new Error(
          `migration filename does not match <YYYYMMDDHHMMSS>_<name>.sql: ${filename}`
        );
      }
      return {
        version: match[1],
        name: match[2],
        filename,
        sql: fs.readFileSync(path.join(MIGRATIONS_DIR, filename), "utf8"),
      };
    });
}

async function main(): Promise<void> {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error(
      "SUPABASE_DB_URL not set. Expected the Supabase pooler URL " +
        "(Project Settings → Database → Session pooler)."
    );
  }

  const migrations = loadMigrations();
  console.log(`[migrate] discovered ${migrations.length} migration file(s)`);

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    await client.query("CREATE SCHEMA IF NOT EXISTS supabase_migrations");
    await client.query(
      "CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (" +
        "version text PRIMARY KEY, statements text[], name text)"
    );

    const { rows: applied } = await client.query<{ version: string }>(
      "SELECT version FROM supabase_migrations.schema_migrations"
    );
    const appliedSet = new Set(applied.map((r) => r.version));
    console.log(`[migrate] ${appliedSet.size} migration(s) already applied`);

    const pending = migrations.filter((m) => !appliedSet.has(m.version));
    if (pending.length === 0) {
      console.log("[migrate] nothing to apply — schema is up to date");
      return;
    }

    console.log(
      `[migrate] pending: ${pending.map((m) => m.filename).join(", ")}`
    );

    for (const m of pending) {
      console.log(`[migrate] applying ${m.filename} …`);
      try {
        await client.query("BEGIN");
        await client.query(m.sql);
        await client.query(
          "INSERT INTO supabase_migrations.schema_migrations (version, statements, name) VALUES ($1, $2, $3)",
          [m.version, [m.sql], m.name]
        );
        await client.query("COMMIT");
        console.log(`[migrate]   ok — ${m.filename}`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`[migrate]   FAILED — ${m.filename}`);
        throw err;
      }
    }

    console.log(`[migrate] applied ${pending.length} migration(s)`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[migrate] error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
