import assert from "node:assert/strict";
import { test } from "node:test";
import { API_KEY_PREFIX } from "../../domain/constants.js";
import { generateApiKey, hashApiKey } from "./apiKeys.js";

test("generateApiKey produces a prefixed key and a matching hash", () => {
  const { plaintext, hash } = generateApiKey();

  assert.ok(plaintext.startsWith(API_KEY_PREFIX), `expected "${plaintext}" to start with "${API_KEY_PREFIX}"`);
  assert.equal(hash, hashApiKey(plaintext), "the returned hash must verify the returned plaintext");
});

test("generateApiKey never produces the same key twice", () => {
  const a = generateApiKey();
  const b = generateApiKey();

  assert.notEqual(a.plaintext, b.plaintext);
  assert.notEqual(a.hash, b.hash);
});

test("hashApiKey is deterministic", () => {
  const key = generateApiKey().plaintext;

  assert.equal(hashApiKey(key), hashApiKey(key));
});

test("hashApiKey distinguishes keys that differ by one character", () => {
  const { plaintext } = generateApiKey();
  const tampered = plaintext.slice(0, -1) + (plaintext.at(-1) === "a" ? "b" : "a");

  assert.notEqual(hashApiKey(plaintext), hashApiKey(tampered));
});
