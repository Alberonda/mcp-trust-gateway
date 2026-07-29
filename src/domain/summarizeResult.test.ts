import assert from "node:assert/strict";
import { test } from "node:test";
import { RESULT_SUMMARY_MAX_LENGTH } from "./constants.js";
import { summarizeResult } from "./summarizeResult.js";

test("returns the text content as-is when short", () => {
  assert.equal(summarizeResult({ content: [{ type: "text", text: "all good" }] }), "all good");
});

test("truncates long text content with an ellipsis", () => {
  const longText = "x".repeat(RESULT_SUMMARY_MAX_LENGTH + 50);

  const summary = summarizeResult({ content: [{ type: "text", text: longText }] });

  assert.equal(summary.length, RESULT_SUMMARY_MAX_LENGTH + 1); // +1 for the ellipsis char
  assert.ok(summary.endsWith("…"));
});

test("falls back to a placeholder when there is no text block", () => {
  assert.equal(summarizeResult({ content: [{ type: "image", text: undefined }] }), "(no text content)");
  assert.equal(summarizeResult({}), "(no text content)");
});

test("picks the first text block when multiple content blocks are present", () => {
  const result = { content: [{ type: "image" }, { type: "text", text: "found me" }] };

  assert.equal(summarizeResult(result), "found me");
});
