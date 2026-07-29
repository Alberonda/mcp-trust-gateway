import assert from "node:assert/strict";
import { test } from "node:test";
import { REDACTED_PLACEHOLDER } from "./constants.js";
import { redact } from "./redact.js";

test("redacts a top-level key that looks like a secret", () => {
  assert.deepEqual(redact({ apiKey: "abc123", username: "alberto" }), {
    apiKey: REDACTED_PLACEHOLDER,
    username: "alberto",
  });
});

test("redacts nested secret-shaped keys at any depth", () => {
  const input = { config: { auth: { password: "hunter2" }, retries: 3 } };

  assert.deepEqual(redact(input), {
    config: { auth: { password: REDACTED_PLACEHOLDER }, retries: 3 },
  });
});

test("redacts secret-shaped keys inside arrays of objects", () => {
  const input = [{ token: "t1" }, { token: "t2", note: "keep me" }];

  assert.deepEqual(redact(input), [
    { token: REDACTED_PLACEHOLDER },
    { token: REDACTED_PLACEHOLDER, note: "keep me" },
  ]);
});

test("matches case-insensitively and on partial key names", () => {
  assert.deepEqual(redact({ GITHUB_TOKEN: "x", SecretValue: "y", Password1: "z" }), {
    GITHUB_TOKEN: REDACTED_PLACEHOLDER,
    SecretValue: REDACTED_PLACEHOLDER,
    Password1: REDACTED_PLACEHOLDER,
  });
});

test("leaves primitives and non-secret-shaped keys untouched", () => {
  assert.equal(redact("hello"), "hello");
  assert.equal(redact(42), 42);
  assert.equal(redact(null), null);
  assert.deepEqual(redact({ path: "/tmp/file.txt", count: 3 }), { path: "/tmp/file.txt", count: 3 });
});
