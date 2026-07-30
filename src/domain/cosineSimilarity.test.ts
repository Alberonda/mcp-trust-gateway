import assert from "node:assert/strict";
import { test } from "node:test";
import { cosineSimilarity } from "./cosineSimilarity.js";

test("identical vectors have similarity 1", () => {
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
});

test("orthogonal vectors have similarity 0", () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test("opposite vectors have similarity -1", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 2], [-1, -2]) - -1) < 1e-9);
});

test("magnitude doesn't affect similarity, only direction", () => {
  const a = [1, 2, 3];
  const scaled = [10, 20, 30];
  assert.ok(Math.abs(cosineSimilarity(a, scaled) - 1) < 1e-9);
});

test("a zero vector never divides by zero — returns 0 instead of NaN", () => {
  assert.equal(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
});
