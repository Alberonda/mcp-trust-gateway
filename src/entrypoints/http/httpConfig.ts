import { DEFAULT_SESSION_TTL_MINUTES } from "../../domain/constants.js";
import { loadBaseConfig, requireEnv } from "../../config.js";
import type { BaseConfig } from "../../config.js";

const DEFAULT_PORT = 3443;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_RATE_LIMIT_MAX_TOKENS = 60;
const DEFAULT_RATE_LIMIT_REFILL_PER_SECOND = 1;

export interface TlsConfig {
  readonly certPath: string;
  readonly keyPath: string;
}

export interface HttpGatewayConfig extends BaseConfig {
  readonly port: number;
  readonly host: string;
  /** For DNS rebinding protection when host is bound to something other than localhost —
   *  see @modelcontextprotocol/sdk's createMcpExpressApp. Undefined means "use the SDK's
   *  default localhost-only protection", which only actually protects localhost hosts. */
  readonly allowedHosts: readonly string[] | undefined;
  /** Present only if both HTTP_TLS_CERT_PATH and HTTP_TLS_KEY_PATH are set — otherwise the
   *  server runs plain HTTP, which is fine behind a reverse proxy that terminates TLS but
   *  not otherwise. See README.md. */
  readonly tls: TlsConfig | undefined;
  readonly rateLimit: {
    readonly maxTokens: number;
    readonly refillPerSecond: number;
  };
  /** How long a session token issued via POST /login stays valid. */
  readonly sessionTtlMinutes: number;
}

function parsePositiveInt(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer; got "${raw}".`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

export function loadHttpConfig(): HttpGatewayConfig {
  const certPath = optionalEnv("HTTP_TLS_CERT_PATH");
  const keyPath = optionalEnv("HTTP_TLS_KEY_PATH");
  if ((certPath && !keyPath) || (!certPath && keyPath)) {
    throw new Error("HTTP_TLS_CERT_PATH and HTTP_TLS_KEY_PATH must be set together, or not at all.");
  }

  const allowedHostsRaw = optionalEnv("HTTP_ALLOWED_HOSTS");

  // HTTP_PORT takes precedence, but fall back to the bare PORT env var most PaaS hosts
  // (Render, Heroku, ...) inject and expect the app to bind to — without this, a
  // deployment there would listen on the wrong port and never receive traffic.
  const portSource = optionalEnv("HTTP_PORT") ?? optionalEnv("PORT");

  return Object.freeze({
    ...loadBaseConfig(),
    port: portSource ? parsePositiveInt("HTTP_PORT/PORT", portSource) : DEFAULT_PORT,
    host: optionalEnv("HTTP_HOST") ?? DEFAULT_HOST,
    allowedHosts: allowedHostsRaw ? allowedHostsRaw.split(",").map((h) => h.trim()) : undefined,
    tls: certPath && keyPath ? { certPath, keyPath } : undefined,
    rateLimit: {
      maxTokens: optionalEnv("HTTP_RATE_LIMIT_MAX_TOKENS")
        ? parsePositiveInt("HTTP_RATE_LIMIT_MAX_TOKENS", requireEnv("HTTP_RATE_LIMIT_MAX_TOKENS"))
        : DEFAULT_RATE_LIMIT_MAX_TOKENS,
      refillPerSecond: optionalEnv("HTTP_RATE_LIMIT_REFILL_PER_SECOND")
        ? parsePositiveInt("HTTP_RATE_LIMIT_REFILL_PER_SECOND", requireEnv("HTTP_RATE_LIMIT_REFILL_PER_SECOND"))
        : DEFAULT_RATE_LIMIT_REFILL_PER_SECOND,
    },
    sessionTtlMinutes: optionalEnv("HTTP_SESSION_TTL_MINUTES")
      ? parsePositiveInt("HTTP_SESSION_TTL_MINUTES", requireEnv("HTTP_SESSION_TTL_MINUTES"))
      : DEFAULT_SESSION_TTL_MINUTES,
  });
}
