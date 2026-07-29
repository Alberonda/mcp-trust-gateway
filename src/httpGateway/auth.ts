import type { IdentityRepository } from "../db/IdentityRepository.js";
import type { SessionRepository } from "../db/SessionRepository.js";
import type { Identity } from "../db/types.js";
import { hashApiKey } from "../security/apiKeys.js";

const BEARER_PREFIX = "Bearer ";

export type AuthResult = { readonly identity: Identity } | { readonly error: string };

function extractBearerToken(authHeader: string | undefined): { readonly token: string } | { readonly error: string } {
  if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
    return { error: 'Missing or malformed Authorization header — expected "Bearer <token>".' };
  }
  const token = authHeader.slice(BEARER_PREFIX.length).trim();
  if (!token) {
    return { error: "Empty bearer token." };
  }
  return { token };
}

/** Extracts an API key from a standard `Authorization: Bearer <key>` header and resolves
 *  it to an identity. Every failure mode (missing header, wrong scheme, unknown/inactive
 *  key) returns the same shape of result with a caller-safe message — never throws, so an
 *  HTTP handler can turn this straight into a 401 without its own try/catch.
 *
 *  Used only by /login — regular /mcp requests authenticate via a short-lived session
 *  token instead (see resolveIdentityFromSessionToken below), so the long-lived API key
 *  itself is transmitted as rarely as possible. */
export async function resolveIdentityFromAuthHeader(
  authHeader: string | undefined,
  identities: IdentityRepository,
): Promise<AuthResult> {
  const extracted = extractBearerToken(authHeader);
  if ("error" in extracted) return extracted;

  const identity = await identities.findByApiKeyHash(hashApiKey(extracted.token));
  if (!identity) {
    return { error: "Invalid or inactive API key." };
  }
  return { identity };
}

/** Extracts a session token from `Authorization: Bearer <token>` and resolves it to the
 *  identity that logged in to create that session (see SessionRepository — a session
 *  remembers which identity created it, not just which user, so audit attribution stays
 *  as precise as it is for API-key auth). Same never-throws contract as the function
 *  above. */
export async function resolveIdentityFromSessionToken(
  authHeader: string | undefined,
  sessions: SessionRepository,
  identities: IdentityRepository,
): Promise<AuthResult> {
  const extracted = extractBearerToken(authHeader);
  if ("error" in extracted) return extracted;

  const session = await sessions.findByToken(extracted.token);
  if (!session) {
    return { error: "Invalid or expired session token. Log in again via POST /login." };
  }

  const identity = await identities.findById(session.identityId);
  if (!identity) {
    return { error: "The identity behind this session is no longer active." };
  }
  return { identity };
}
