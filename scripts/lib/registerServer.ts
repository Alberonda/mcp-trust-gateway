import { PostgresUpstreamServerRepository } from "../../src/adapters/postgres/UpstreamServerRepository.js";
import type { UpstreamServer } from "../../src/domain/types.js";
import type { Queryable } from "../../src/ports/Queryable.js";

export interface ServerToRegister {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
}

/** Registers a server via the same {command, args} shape any MCP client config already
 *  uses. Deliberately takes no credential/env — a server never carries one of its own
 *  (see db/types.ts's UpstreamServer doc); use scripts/set_user_credential.ts afterward
 *  for each user who needs one. Takes a Queryable (a pg.Client or pg.Pool both satisfy
 *  it), not a specific pg.Client, so callers using a pool aren't forced into a raw Client
 *  just to call this. */
export async function registerServer(db: Queryable, server: ServerToRegister): Promise<UpstreamServer> {
  return new PostgresUpstreamServerRepository(db).create({ name: server.name, command: server.command, args: server.args });
}
