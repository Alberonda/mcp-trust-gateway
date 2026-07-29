import pg from "pg";
import type { Queryable } from "../../src/db/Queryable.js";

/**
 * Every integration test runs inside its own transaction that's rolled back afterwards —
 * so tests can freely INSERT into identities/upstream_servers/permissions/audit_log
 * without leaving data behind or needing manual cleanup, and without tests interfering
 * with each other. Requires a real, migrated Postgres reachable via DATABASE_URL (see
 * README.md's Docker setup) — these are integration tests, not unit tests, and are
 * intentionally kept out of `npm test`'s fast unit suite (see package.json).
 */

/**
 * Deliberately a separate database (TEST_DATABASE_URL) from the one the gateway itself
 * runs against (DATABASE_URL) — running integration tests against the same database used
 * for manual smoke-testing (scripts/seed_test_setup.ts) causes real collisions (unique
 * constraint violations on rows the manual setup already committed). See README.md for
 * how to create it alongside the dev database in the same Postgres container.
 */
function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Integration tests need their own migrated Postgres " +
        "database, separate from DATABASE_URL — see README.md's Docker setup, then re-run with: " +
        "set -a; source .env; set +a; npm run test:integration",
    );
  }
  return url;
}

export interface TransactionalTestContext {
  /** Pass this to any Postgres*Repository under test instead of a real pool. */
  readonly db: Queryable;
}

/**
 * Wraps a node:test test function so it runs inside a transaction that's always rolled
 * back, whether the test passes, fails, or throws. Usage:
 *
 *   test("finds an identity by hash", withTransaction(async ({ db }) => {
 *     const repo = new PostgresIdentityRepository(db);
 *     ...
 *   }));
 */
export function withTransaction(
  fn: (ctx: TransactionalTestContext) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const pool = new pg.Pool({ connectionString: requireTestDatabaseUrl() });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await fn({ db: client });
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  };
}
