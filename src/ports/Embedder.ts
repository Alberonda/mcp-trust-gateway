/**
 * Turns text into a dense vector for semantic similarity search — the vocabulary
 * ToolDiscoveryRouter's find_tool is written against, independent of which model or
 * runtime actually computes it. See adapters/embeddings/LocalEmbedder.ts for the one
 * real implementation.
 */
export interface Embedder {
  embed(text: string): Promise<readonly number[]>;
}
