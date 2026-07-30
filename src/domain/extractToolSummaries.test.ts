import assert from "node:assert/strict";
import { test } from "node:test";
import { extractToolSummaries } from "./extractToolSummaries.js";

test("extracts name and description from a well-formed tools/list result", () => {
  const result = { tools: [{ name: "read_file", description: "Reads a file" }] };
  assert.deepEqual(extractToolSummaries(result), [{ name: "read_file", description: "Reads a file" }]);
});

test("defaults a missing description to an empty string", () => {
  const result = { tools: [{ name: "read_file" }] };
  assert.deepEqual(extractToolSummaries(result), [{ name: "read_file", description: "" }]);
});

test("drops entries with no name", () => {
  const result = { tools: [{ description: "no name here" }, { name: "valid_tool", description: "ok" }] };
  assert.deepEqual(extractToolSummaries(result), [{ name: "valid_tool", description: "ok" }]);
});

test("returns an empty array for a malformed or missing tools field", () => {
  assert.deepEqual(extractToolSummaries({}), []);
  assert.deepEqual(extractToolSummaries(null), []);
  assert.deepEqual(extractToolSummaries({ tools: "not an array" }), []);
});
