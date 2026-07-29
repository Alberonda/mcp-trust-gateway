import type pg from "pg";
import { PostgresUpstreamServerRepository } from "../../src/db/UpstreamServerRepository.js";
import type { UpstreamServer } from "../../src/db/types.js";
import { CredentialVault } from "../../src/security/vault.js";

export interface ServerToRegister {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Plaintext env vars — encrypted here before ever touching the database. Omit for a
   *  server that needs none (e.g. the filesystem server). */
  readonly env?: Readonly<Record<string, string>>;
}

/** Encrypts `env` (if given) and registers the server via the same
 *  {command, args, env} shape every MCP client config already uses — the one place every
 *  provisioning script in scripts/ goes through, instead of each hand-rolling its own
 *  INSERT + encryption. */
export async function registerServer(client: pg.Client, encryptionKey: Buffer, server: ServerToRegister): Promise<UpstreamServer> {
  const vault = new CredentialVault(encryptionKey);
  const encryptedEnv = server.env ? vault.encrypt(JSON.stringify(server.env)) : undefined;

  return new PostgresUpstreamServerRepository(client).create({
    name: server.name,
    command: server.command,
    args: server.args,
    encryptedEnv,
  });
}
