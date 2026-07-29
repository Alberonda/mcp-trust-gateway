import { loadBaseConfig } from "../src/config.js";
import type { AuditStatus } from "../src/constants.js";
import { PostgresAuditLogRepository } from "../src/db/AuditLogRepository.js";
import { createPool } from "../src/db/pool.js";

/**
 * Operator tool (Phase 3d): a comfortable way to actually read the audit trail, instead of
 * hand-writing SQL against audit_log every time. Every filter is optional; combine as many
 * as needed.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/view_audit_log.ts \
 *     [--identity=<name>] [--server=<name>] [--status=allowed_success|allowed_failure|denied] \
 *     [--limit=<n>]
 */

const DEFAULT_LIMIT = 20;

function parseArgs(argv: readonly string[]): { identity?: string; server?: string; status?: AuditStatus; limit: number } {
  const args: Record<string, string> = {};
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key && value) args[key] = value;
  }
  return {
    identity: args.identity,
    server: args.server,
    status: args.status as AuditStatus | undefined,
    limit: args.limit ? Number(args.limit) : DEFAULT_LIMIT,
  };
}

function formatRow(row: { createdAt: Date; identityName: string | null; serverName: string; toolName: string; status: string; durationMs: number; resultSummary: string }): string {
  const timestamp = row.createdAt.toISOString();
  const who = (row.identityName ?? "(unknown)").padEnd(20);
  const where = `${row.serverName}/${row.toolName}`.padEnd(30);
  const status = row.status.padEnd(16);
  return `${timestamp}  ${who}  ${where}  ${status}  ${row.durationMs}ms  ${row.resultSummary.split("\n")[0]}`;
}

async function main(): Promise<void> {
  const { identity, server, status, limit } = parseArgs(process.argv.slice(2));
  const config = loadBaseConfig();
  const pool = createPool(config.databaseUrl);

  const rows = await new PostgresAuditLogRepository(pool).search({
    identityName: identity,
    serverName: server,
    status,
    limit,
  });

  if (rows.length === 0) {
    console.log("No matching audit log entries.");
  } else {
    console.log(`${rows.length} entries (most recent first):\n`);
    for (const row of rows) console.log(formatRow(row));
  }

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
