import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/** Runs every .sql file in migrations/, in filename order. No migration-tracking table yet
 *  (Phase 1 has exactly one migration) — revisit if/when there's more than a couple of these. */

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set.");
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    console.log(`Applying ${file}...`);
    await client.query(readFileSync(join(migrationsDir, file), "utf8"));
  }

  await client.end();
  console.log(`Applied ${files.length} migration(s).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
