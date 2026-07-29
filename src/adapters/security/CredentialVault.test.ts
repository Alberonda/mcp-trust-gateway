import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { AesGcmCredentialVault } from "./CredentialVault.js";

function testKey(): Buffer {
  return randomBytes(32);
}

test("encrypt then decrypt returns the original plaintext", () => {
  const vault = new AesGcmCredentialVault(testKey());
  const plaintext = "ghp_super_secret_upstream_token";

  const payload = vault.encrypt(plaintext);
  assert.equal(vault.decrypt(payload), plaintext);
});

test("ciphertext never contains the plaintext in the clear", () => {
  const vault = new AesGcmCredentialVault(testKey());
  const plaintext = "a-recognizable-secret-value";

  const { ciphertext } = vault.encrypt(plaintext);
  assert.ok(!ciphertext.toString("latin1").includes(plaintext));
});

test("decrypting with the wrong key throws instead of returning garbage", () => {
  const payload = new AesGcmCredentialVault(testKey()).encrypt("secret");
  const wrongVault = new AesGcmCredentialVault(testKey());

  assert.throws(() => wrongVault.decrypt(payload));
});

test("a tampered auth tag is rejected (GCM's integrity check doing its job)", () => {
  const vault = new AesGcmCredentialVault(testKey());
  const payload = vault.encrypt("secret");

  const tamperedAuthTag = Buffer.from(payload.authTag);
  tamperedAuthTag[0] ^= 0xff;

  assert.throws(() => vault.decrypt({ ...payload, authTag: tamperedAuthTag }));
});

test("empty string round-trips correctly", () => {
  const vault = new AesGcmCredentialVault(testKey());

  assert.equal(vault.decrypt(vault.encrypt("")), "");
});
