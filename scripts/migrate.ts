import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/** Runs every .sql file in migrations/, in filename order, tracking which ones have
 *  already been applied in a schema_migrations table — so re-running this script (e.g.
 *  after adding a new migration file) only applies what's new, instead of re-running
 *  already-applied files and failing on "relation already exists". Each migration runs in
 *  its own transaction: either the whole file applies and gets recorded, or neither does. */

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

async function ensureMigrationsTableExists(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function alreadyApplied(client: pg.Client): Promise<Set<string>> {
  const { rows } = await client.query<{ filename: string }>(`SELECT filename FROM schema_migrations`);
  return new Set(rows.map((row) => row.filename));
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set.");
  }

  const client = new pg.Client({ connectionString });
  await client.connect();
  await ensureMigrationsTableExists(client);
  const applied = await alreadyApplied(client);

  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  let appliedCount = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`Skipping ${file} (already applied).`);
      continue;
    }
    console.log(`Applying ${file}...`);
    await client.query("BEGIN");
    try {
      await client.query(readFileSync(join(migrationsDir, file), "utf8"));
      await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [file]);
      await client.query("COMMIT");
      appliedCount++;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  await client.end();
  console.log(`Applied ${appliedCount} new migration(s) (${files.length - appliedCount} already up to date).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
