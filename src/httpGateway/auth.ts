import type { IdentityRepository } from "../db/IdentityRepository.js";
import type { Identity } from "../db/types.js";
import { hashApiKey } from "../security/apiKeys.js";

const BEARER_PREFIX = "Bearer ";

export type AuthResult = { readonly identity: Identity } | { readonly error: string };

/** Extracts an API key from a standard `Authorization: Bearer <key>` header and resolves
 *  it to an identity. Every failure mode (missing header, wrong scheme, unknown/inactive
 *  key) returns the same shape of result with a caller-safe message — never throws, so an
 *  HTTP handler can turn this straight into a 401 without its own try/catch. */
export async function resolveIdentityFromAuthHeader(
  authHeader: string | undefined,
  identities: IdentityRepository,
): Promise<AuthResult> {
  if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
    return { error: 'Missing or malformed Authorization header — expected "Bearer <api-key>".' };
  }

  const apiKey = authHeader.slice(BEARER_PREFIX.length).trim();
  if (!apiKey) {
    return { error: "Empty API key." };
  }

  const identity = await identities.findByApiKeyHash(hashApiKey(apiKey));
  if (!identity) {
    return { error: "Invalid or inactive API key." };
  }

  return { identity };
}
