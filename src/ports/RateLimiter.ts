/**
 * Basic per-identity rate limiting — viable now that HTTP mode is a long-lived process
 * with in-memory state, unlike stdio mode (a fresh, one-shot process per session, where
 * there's nothing to rate-limit against across calls).
 */
export interface RateLimiter {
  /** True if identityId may proceed right now; also consumes one token if so. */
  tryConsume(identityId: string): boolean;
}
