import type pg from "pg";
import { PostgresUpstreamServerRepository } from "../../src/db/UpstreamServerRepository.js";
import type { UpstreamServer } from "../../src/db/types.js";

export interface ServerToRegister {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
}

/** Registers a server via the same {command, args} shape any MCP client config already
 *  uses. Deliberately takes no credential/env — a server never carries one of its own
 *  (see db/types.ts's UpstreamServer doc); use scripts/set_user_credential.ts afterward
 *  for each user who needs one. */
export async function registerServer(client: pg.Client, server: ServerToRegister): Promise<UpstreamServer> {
  return new PostgresUpstreamServerRepository(client).create({ name: server.name, command: server.command, args: server.args });
}
