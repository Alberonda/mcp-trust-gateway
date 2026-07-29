import { REDACTED_PLACEHOLDER } from "./constants.js";

const SECRET_KEY_PATTERN = /token|key|secret|password|credential|authorization/i;

/**
 * Returns a deep copy of value with any object key that looks like a secret replaced by
 * a fixed placeholder — used before writing tool-call params into audit_log.params_redacted.
 *
 * Matches by key name, not by value shape: this is intentionally conservative (it may
 * redact a field that wasn't actually sensitive) because the cost of under-redacting a
 * real secret into a permanent audit trail is far higher than the cost of an
 * over-redacted, less useful log line.
 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, v]) => [
        key,
        SECRET_KEY_PATTERN.test(key) ? REDACTED_PLACEHOLDER : redact(v),
      ]),
    );
  }
  return value;
}
