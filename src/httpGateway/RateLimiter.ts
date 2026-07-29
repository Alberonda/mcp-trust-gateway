/**
 * Basic per-identity rate limiting — viable now that HTTP mode is a long-lived process
 * with in-memory state, unlike stdio mode (a fresh, one-shot process per session, where
 * there's nothing to rate-limit against across calls). Token-bucket: each identity gets a
 * bucket that refills continuously up to a cap, and every request consumes one token.
 */
export interface RateLimiter {
  /** True if identityId may proceed right now; also consumes one token if so. */
  tryConsume(identityId: string): boolean;
}

interface Bucket {
  tokens: number;
  lastRefillAt: number;
}

export class InMemoryTokenBucketRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly maxTokens: number,
    private readonly refillPerMs: number,
    /** Injectable so tests get deterministic timing instead of depending on real time. */
    private readonly now: () => number = Date.now,
  ) {
    if (maxTokens <= 0) throw new Error("maxTokens must be positive.");
    if (refillPerMs <= 0) throw new Error("refillPerMs must be positive.");
  }

  tryConsume(identityId: string): boolean {
    const nowMs = this.now();
    const bucket = this.buckets.get(identityId) ?? { tokens: this.maxTokens, lastRefillAt: nowMs };

    const elapsedMs = Math.max(0, nowMs - bucket.lastRefillAt);
    bucket.tokens = Math.min(this.maxTokens, bucket.tokens + elapsedMs * this.refillPerMs);
    bucket.lastRefillAt = nowMs;

    if (bucket.tokens < 1) {
      this.buckets.set(identityId, bucket);
      return false;
    }

    bucket.tokens -= 1;
    this.buckets.set(identityId, bucket);
    return true;
  }
}
