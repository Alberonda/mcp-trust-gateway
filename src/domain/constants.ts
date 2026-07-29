/**
 * Every named value that would otherwise be a magic number/string scattered across the
 * codebase. If a value has meaning beyond "just what this one line needs", it belongs here.
 */

/** AES-GCM's recommended IV size. Do not change without re-encrypting every stored secret. */
export const GCM_IV_LENGTH_BYTES = 12;

/** Entropy for a generated gateway API key. 24 random bytes, base64url-encoded, is
 *  comfortably beyond brute-force range for a secret compared only via a fast hash. */
export const API_KEY_RANDOM_BYTES = 24;

/** Prefix on every generated API key — lets you recognize one at a glance (in logs,
 *  config files, etc.) the same way "sk_" or "ghp_" identify other providers' keys. */
export const API_KEY_PREFIX = "mtg_";

/** Entropy for a generated session token — same size as an API key; both are
 *  server-generated high-entropy secrets, not user-chosen passwords (see
 *  security/sessionTokens.ts for why that means the same fast-hash approach applies). */
export const SESSION_TOKEN_RANDOM_BYTES = 24;

/** Distinct prefix from API_KEY_PREFIX so a session token is visually distinguishable
 *  from a long-lived API key at a glance (e.g. in logs, if one ever leaked there). */
export const SESSION_TOKEN_PREFIX = "mtgs_";

/** Default time-to-live for a session token issued via HTTP mode's /login — short enough
 *  that a leaked session token matters far less than a leaked long-lived API key. */
export const DEFAULT_SESSION_TTL_MINUTES = 60;

/** Single source of truth for audit_log.status — the Postgres CHECK constraint in
 *  migrations/001_init.sql must be kept in sync with these exact values. */
export const AuditStatus = {
  AllowedSuccess: "allowed_success",
  AllowedFailure: "allowed_failure",
  Denied: "denied",
} as const;

export type AuditStatus = (typeof AuditStatus)[keyof typeof AuditStatus];

/** audit_log.result_summary is a human-readable line, not a payload dump — truncate
 *  anything longer than this so one verbose tool result can't bloat the audit trail. */
export const RESULT_SUMMARY_MAX_LENGTH = 200;

/** Placeholder written over any field redact() identifies as secret-shaped. */
export const REDACTED_PLACEHOLDER = "[REDACTED]";
