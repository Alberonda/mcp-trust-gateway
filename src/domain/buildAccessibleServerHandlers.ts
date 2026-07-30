import type { AuditLogRepository } from "../ports/AuditLogRepository.js";
import type { PermissionRepository } from "../ports/PermissionRepository.js";
import type { UserCredentialRepository } from "../ports/UserCredentialRepository.js";
import type { ConnectedUpstream, UpstreamConnectionProvider } from "../ports/UpstreamConnectionProvider.js";
import type { UpstreamToolClient } from "../ports/UpstreamToolClient.js";
import type { Identity, UpstreamServer } from "./types.js";
import { ToolCallHandler } from "./ToolCallHandler.js";

export interface AccessibleServerHandlers {
  readonly handlers: readonly ToolCallHandler[];
  /** Closes every connection actually opened during this session — a server whose
   *  handler never got used (denied, or simply never called) was never connected in
   *  the first place, so there's nothing to close for it. */
  closeAll(): Promise<void>;
}

/**
 * Builds one ToolCallHandler per accessible server WITHOUT connecting to any of them —
 * each handler's connection is deferred to its own first real use (see
 * ToolCallHandler's connectClient parameter). This replaced an eager
 * connectAccessibleServers() that spawned every accessible server's subprocess at
 * session start regardless of whether that session ever used it — see DESIGN.md's
 * backlog entry on this for the full reasoning (the same change that let find_tool
 * search a cached catalog instead of a live connection made this possible).
 *
 * Failure isolation is now implicit rather than an explicit Promise.allSettled: a
 * server that fails to connect only ever fails the ONE call that triggered it (surfaced
 * as that call's own error/audit entry), never blocks building handlers for every other
 * accessible server, since building a handler here never connects at all.
 */
export function buildAccessibleServerHandlers(
  servers: readonly UpstreamServer[],
  identity: Identity,
  userCredentials: UserCredentialRepository,
  connectionProvider: UpstreamConnectionProvider,
  permissions: PermissionRepository,
  auditLog: AuditLogRepository,
  now: () => number = Date.now,
): AccessibleServerHandlers {
  const openConnections: ConnectedUpstream[] = [];

  const handlers = servers.map((server) => {
    let cached: Promise<UpstreamToolClient> | undefined;
    const connectClient = (): Promise<UpstreamToolClient> => {
      if (!cached) {
        cached = (async () => {
          const credential = await userCredentials.find(identity.userId, server.id);
          const connected = await connectionProvider.connect(server, credential);
          openConnections.push(connected);
          return connected.client;
        })();
      }
      return cached;
    };
    return new ToolCallHandler(identity, server, permissions, auditLog, connectClient, now);
  });

  return {
    handlers,
    closeAll: async () => {
      await Promise.all(openConnections.map((connected) => connected.close()));
    },
  };
}
