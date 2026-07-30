import { encode } from "gpt-tokenizer";

/** Tokenizes with gpt-tokenizer's o200k_base encoding (GPT-4o class models) — the same
 *  real encoding scripts/measure_context_overhead.ts already uses, not an estimate. */
export function countTokens(value: unknown): number {
  return encode(typeof value === "string" ? value : JSON.stringify(value)).length;
}

export interface StepMetric {
  readonly step: string;
  readonly requestTokens: number;
  readonly responseTokens: number;
  readonly latencyMs: number;
  /** Only meaningful for find_tool steps — whether the tool the session actually needed
   *  showed up in the results at all. Absent for steps where "did it match" doesn't apply
   *  (call_tool, tools/list). */
  readonly foundIntendedTool?: boolean;
}

export interface SessionResult {
  readonly scenario: string;
  readonly serverCount: 1 | 2;
  readonly language: "es" | "en" | "n/a";
  readonly steps: StepMetric[];
  readonly totalTokens: number;
  readonly totalLatencyMs: number;
}

export function summarizeSession(scenario: string, serverCount: 1 | 2, language: "es" | "en" | "n/a", steps: StepMetric[]): SessionResult {
  return {
    scenario,
    serverCount,
    language,
    steps,
    totalTokens: steps.reduce((sum, s) => sum + s.requestTokens + s.responseTokens, 0),
    totalLatencyMs: steps.reduce((sum, s) => sum + s.latencyMs, 0),
  };
}

/** Times a real async operation and tokenizes its request/response payloads — every
 *  measurement in this benchmark goes through this one function so every session is
 *  measured the exact same way. */
export async function measureStep<T>(
  step: string,
  request: unknown,
  fn: () => Promise<T>,
  extractResponseForTokenCount: (result: T) => unknown = (r) => r,
): Promise<{ result: T; metric: StepMetric }> {
  const startedAt = Date.now();
  const result = await fn();
  const latencyMs = Date.now() - startedAt;
  return {
    result,
    metric: {
      step,
      requestTokens: countTokens(request),
      responseTokens: countTokens(extractResponseForTokenCount(result)),
      latencyMs,
    },
  };
}
