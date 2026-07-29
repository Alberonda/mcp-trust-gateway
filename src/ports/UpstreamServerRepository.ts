import type { UpstreamServer } from "../domain/types.js";

/** What registering a new server needs — the same {command, args} shape every MCP client
 *  config uses to describe how to spawn one, minus the `env` part of that shape: a server
 *  never carries its own credential (see domain/types.ts's UpstreamServer doc) — every user
 *  who needs one registers it for themselves via UserCredentialRepository instead. */
export interface NewUpstreamServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Defaults to false — see domain/types.ts's UpstreamServer.requiresRelay doc. */
  readonly requiresRelay?: boolean;
}

export interface UpstreamServerRepository {
  findByName(name: string): Promise<UpstreamServer | null>;
  /** Used by the composition root to resolve every server an identity has any permission
   *  on (see PermissionRepository.findAccessibleServerIds) into the details needed to
   *  actually connect to each one. Empty input returns an empty array without a query. */
  findManyByIds(ids: readonly string[]): Promise<UpstreamServer[]>;
  /** Every registered server, permitted or not — the whitelist itself. Used by
   *  SelfServiceHandler.listServices to show a user what exists even for servers they
   *  don't (yet) have permission on, so they know what to ask an admin for. */
  findAll(): Promise<UpstreamServer[]>;

  /** Registers a new upstream server — see NewUpstreamServer for why this mirrors
   *  standard MCP client config shape directly, minus any credential. */
  create(server: NewUpstreamServer): Promise<UpstreamServer>;
}
