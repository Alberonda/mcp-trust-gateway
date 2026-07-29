import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryTokenBucketRateLimiter } from "./RateLimiter.js";

test("allows up to maxTokens requests immediately, then denies", () => {
  const limiter = new InMemoryTokenBucketRateLimiter(3, 0.001, () => 0);

  assert.equal(limiter.tryConsume("id-1"), true);
  assert.equal(limiter.tryConsume("id-1"), true);
  assert.equal(limiter.tryConsume("id-1"), true);
  assert.equal(limiter.tryConsume("id-1"), false, "the 4th request within the same instant must be denied");
});

test("refills over time, at the configured rate", () => {
  let now = 0;
  const limiter = new InMemoryTokenBucketRateLimiter(1, 0.01, () => now); // 1 token / 100ms

  assert.equal(limiter.tryConsume("id-1"), true);
  assert.equal(limiter.tryConsume("id-1"), false, "bucket is empty immediately after");

  now += 50;
  assert.equal(limiter.tryConsume("id-1"), false, "not enough time has passed to refill a full token");

  now += 50; // total 100ms elapsed -> exactly 1 token refilled
  assert.equal(limiter.tryConsume("id-1"), true);
});

test("never refills past maxTokens, even after a long idle period", () => {
  let now = 0;
  const limiter = new InMemoryTokenBucketRateLimiter(2, 1, () => now); // fast refill

  now += 1_000_000; // huge gap before the first call
  assert.equal(limiter.tryConsume("id-1"), true);
  assert.equal(limiter.tryConsume("id-1"), true);
  assert.equal(limiter.tryConsume("id-1"), false, "must still cap at maxTokens, not accumulate indefinitely");
});

test("tracks separate buckets per identity — one identity's usage never affects another's", () => {
  const limiter = new InMemoryTokenBucketRateLimiter(1, 0.0001, () => 0);

  assert.equal(limiter.tryConsume("id-1"), true);
  assert.equal(limiter.tryConsume("id-1"), false);
  assert.equal(limiter.tryConsume("id-2"), true, "a different identity must have its own untouched bucket");
});

test("rejects non-positive configuration up front instead of behaving unpredictably later", () => {
  assert.throws(() => new InMemoryTokenBucketRateLimiter(0, 1));
  assert.throws(() => new InMemoryTokenBucketRateLimiter(1, 0));
  assert.throws(() => new InMemoryTokenBucketRateLimiter(-1, 1));
});
