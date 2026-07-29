/**
 * The only place in the codebase allowed to read process.env directly. Every other module
 * receives what it needs as a constructor/function argument instead — that's what makes
 * them testable without env vars, and what makes "what does this process need to run"
 * answerable by reading one file instead of grepping for process.env everywhere.
 */

const ENCRYPTION_KEY_LENGTH_BYTES = 32;

export interface GatewayConfig {
  readonly databaseUrl: string;
  readonly encryptionKey: Buffer;
  readonly gatewayApiKey: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseEncryptionKey(hex: string): Buffer {
  const key = Buffer.from(hex, "hex");
  if (key.length !== ENCRYPTION_KEY_LENGTH_BYTES) {
    throw new Error(
      `GATEWAY_ENCRYPTION_KEY must decode to ${ENCRYPTION_KEY_LENGTH_BYTES} bytes ` +
        `(${ENCRYPTION_KEY_LENGTH_BYTES * 2} hex characters); got ${key.length} bytes. Generate one with: ` +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  return key;
}

/** Reads and validates every environment variable the gateway needs, once, at startup.
 *  Fails fast with a clear message instead of surfacing a confusing error deep inside
 *  some unrelated code path later.
 *
 *  Note: as of Phase 2, which upstream servers to connect to is no longer configured via
 *  an env var (there used to be an UPSTREAM_SERVER_NAME here) — it's derived from
 *  PermissionRepository.findAccessibleServerIds() for the authenticated identity, so a
 *  gateway process can reach every server that identity has any grant on, not just one. */
export function loadConfig(): GatewayConfig {
  return Object.freeze({
    databaseUrl: requireEnv("DATABASE_URL"),
    encryptionKey: parseEncryptionKey(requireEnv("GATEWAY_ENCRYPTION_KEY")),
    gatewayApiKey: requireEnv("GATEWAY_API_KEY"),
  });
}
