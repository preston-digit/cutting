// Postgres access — REUSABLE CORE.
//
// Postgres stores ONLY this app's local data (references to Digit entities +
// cached display fields), never copies of Digit-owned records. Each feature
// owns its tables via a migration file in backend/db/migrations/.
import pkg from "pg";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pkg;

// Heroku Postgres requires SSL but signs with a cert chain the pg client
// won't validate by default; DATABASE_SSL=true opts into
// `rejectUnauthorized: false` for that case. Leave unset for local
// docker-compose Postgres, which doesn't use SSL at all. See DEPLOY.md.
const useSsl = process.env.DATABASE_SSL === "true";

export const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
    })
  : null;

export function assertDb() {
  if (!pool) throw new Error("DATABASE_URL is not configured.");
  return pool;
}

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations"
);

// Apply any not-yet-applied .sql migrations in lexical order, each in its own
// transaction. Tracked in the _migrations table. Run once on startup.
export async function runMigrations() {
  if (!pool) return;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS _migrations (
       name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const { rowCount } = await pool.query(
      "SELECT 1 FROM _migrations WHERE name = $1",
      [file]
    );
    if (rowCount) continue;

    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`migration applied: ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
