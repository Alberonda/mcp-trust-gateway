import assert from "node:assert/strict";
import { test } from "node:test";
import { API_KEY_PREFIX, SESSION_TOKEN_PREFIX } from "../constants.js";
import { generateSessionToken, hashSessionToken } from "./sessionTokens.js";

test("generateSessionToken produces a prefixed token and a matching hash", () => {
  const { plaintext, hash } = generateSessionToken();

  assert.ok(plaintext.startsWith(SESSION_TOKEN_PREFIX), `expected "${plaintext}" to start with "${SESSION_TOKEN_PREFIX}"`);
  assert.equal(hash, hashSessionToken(plaintext), "the returned hash must verify the returned plaintext");
});

test("session tokens use a different prefix than API keys, so the two are visually distinguishable", () => {
  assert.notEqual(SESSION_TOKEN_PREFIX, API_KEY_PREFIX);
});

test("generateSessionToken never produces the same token twice", () => {
  const a = generateSessionToken();
  const b = generateSessionToken();

  assert.notEqual(a.plaintext, b.plaintext);
  assert.notEqual(a.hash, b.hash);
});

test("hashSessionToken is deterministic", () => {
  const token = generateSessionToken().plaintext;

  assert.equal(hashSessionToken(token), hashSessionToken(token));
});

test("hashSessionToken distinguishes tokens that differ by one character", () => {
  const { plaintext } = generateSessionToken();
  const tampered = plaintext.slice(0, -1) + (plaintext.at(-1) === "a" ? "b" : "a");

  assert.notEqual(hashSessionToken(plaintext), hashSessionToken(tampered));
});
