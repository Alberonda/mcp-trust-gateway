import type { QueryResultRow } from "pg";

/**
 * The one method every repository actually needs — satisfied by both pg.Pool and a
 * checked-out pg.PoolClient. Depending on this instead of pg.Pool directly means a test
 * can hand a repository a client that's mid-transaction (BEGIN'd, later ROLLBACK'd) so
 * integration tests never leave data behind, without the repository code knowing or
 * caring which one it got.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}
