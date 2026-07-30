import { pipeline } from "@huggingface/transformers";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import { EMBEDDING_MODEL } from "../../domain/constants.js";
import type { Embedder } from "../../ports/Embedder.js";

/**
 * Runs a small (~90MB) sentence-embedding model locally via @huggingface/transformers —
 * CPU-only (WASM/ONNX runtime, no GPU needed), no external API call, no data ever
 * leaving the machine. Measured, not estimated: ~85ms one-time model load (from local
 * cache), ~1ms per embedding after that — see DESIGN.md's backlog entry for the
 * reasoning behind choosing this over an external embeddings API or a full LLM.
 *
 * The pipeline is loaded lazily and memoized (module-level model downloads/loads are
 * slow; every real caller wants exactly one loaded model shared across every embed()
 * call in the process, not one per instance).
 */
export class LocalEmbedder implements Embedder {
  private pipelinePromise: Promise<FeatureExtractionPipeline> | undefined;

  async embed(text: string): Promise<readonly number[]> {
    const extractor = await this.getPipeline();
    const output = await extractor(text, { pooling: "mean", normalize: true });
    return Array.from(output.data as Float32Array);
  }

  private getPipeline(): Promise<FeatureExtractionPipeline> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = pipeline("feature-extraction", EMBEDDING_MODEL);
    }
    return this.pipelinePromise;
  }
}
