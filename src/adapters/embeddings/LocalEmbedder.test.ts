import assert from "node:assert/strict";
import { test } from "node:test";
import { cosineSimilarity } from "../../domain/cosineSimilarity.js";
import { LocalEmbedder } from "./LocalEmbedder.js";

// The real model, not a fake — see DESIGN.md's backlog entry on why this project chose a
// small local model over an external embeddings API or a full LLM. First run downloads
// ~90MB; cached afterward. Generous timeout for a cold cache (e.g. a fresh CI runner).
const TIMEOUT_MS = 60_000;

test(
  "embed() returns a vector, and the SAME text embeds to the SAME vector",
  { timeout: TIMEOUT_MS },
  async () => {
    const embedder = new LocalEmbedder();

    const a = await embedder.embed("create a jira ticket");
    const b = await embedder.embed("create a jira ticket");

    assert.ok(a.length > 0);
    assert.deepEqual(a, b);
  },
);

test(
  "a query embeds closer to a genuinely related tool description than an unrelated one",
  { timeout: TIMEOUT_MS },
  async () => {
    const embedder = new LocalEmbedder();

    const query = await embedder.embed("crear un ticket en jira con prioridad alta");
    const relevant = await embedder.embed("jira_create_issue: Create a new Jira issue with summary and description");
    const irrelevant = await embedder.embed("read_text_file: Read the contents of a file from the filesystem");

    assert.ok(
      cosineSimilarity(query, relevant) > cosineSimilarity(query, irrelevant),
      "the Jira-related tool must score higher than the unrelated filesystem tool for a Jira-related query",
    );
  },
);
