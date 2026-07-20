/**
 * Prints local vs. remote Supabase migration state — the same signal
 * `supabase migration list --linked` provides, without relying on the
 * upstream CLI's Windows-broken connection layer.
 *
 * Exit codes:
 *   0 — local and remote are in sync
 *   1 — there are pending (local-not-applied) or extra (remote-only) rows
 *
 * Intended for CI: `npm run db:migrate:supabase:check` fails a build
 * whose branch adds a migration file without applying it, or points at
 * a project whose remote has drifted.
 */

import { Client } from "pg";
import * as fs from "node:fs";
import * as path from "node:path";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");

async function main(): Promise<void> {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error(
      "SUPABASE_DB_URL not set. Expected the Supabase pooler URL " +
        "(Project Settings → Database → Session pooler)."
    );
  }

  const localVersions = fs.existsSync(MIGRATIONS_DIR)
    ? fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .map((f) => f.replace(/_.*/, ""))
        .sort()
    : [];

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  let remoteVersions: string[] = [];
  try {
    const { rows } = await client.query<{ version: string }>(
      "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version"
    );
    remoteVersions = rows.map((r) => r.version);
  } catch (err) {
    if (err instanceof Error && /does not exist/i.test(err.message)) {
      remoteVersions = [];
    } else {
      throw err;
    }
  } finally {
    await client.end();
  }

  const localSet = new Set(localVersions);
  const remoteSet = new Set(remoteVersions);
  const pending = localVersions.filter((v) => !remoteSet.has(v));
  const extra = remoteVersions.filter((v) => !localSet.has(v));

  console.log("Local  Remote  Version");
  const allVersions = [...new Set([...localVersions, ...remoteVersions])].sort();
  for (const v of allVersions) {
    const localMark = localSet.has(v) ? "  ✓  " : "     ";
    const remoteMark = remoteSet.has(v) ? "  ✓  " : "     ";
    console.log(`${localMark}  ${remoteMark}  ${v}`);
  }

  if (pending.length > 0) {
    console.log(`\n${pending.length} pending: ${pending.join(", ")}`);
  }
  if (extra.length > 0) {
    console.log(
      `\n${extra.length} remote-only (drift or externally applied): ${extra.join(", ")}`
    );
  }
  if (pending.length === 0 && extra.length === 0) {
    console.log("\nIn sync.");
    return;
  }
  process.exit(1);
}

main().catch((err) => {
  console.error("[migrate] error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
