import pg from "pg";

/** Thin factory, not a hidden module-level singleton — the composition root (index.ts)
 *  owns the one Pool instance for the process lifetime and hands it to each repository
 *  that needs it. Nothing below this layer reaches out and creates its own connection. */
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}
