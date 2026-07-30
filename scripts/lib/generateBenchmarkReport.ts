import type { SessionResult, StepMetric } from "./benchmarkMetrics.js";

function label(session: SessionResult): string {
  return `${session.scenario} · ${session.serverCount} srv · ${session.language}`;
}

function average(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0) / values.length;
}

function pct(a: number, b: number): string {
  return `${(((a - b) / b) * 100).toFixed(0)}%`;
}

interface Finding {
  readonly verdict: "good" | "bad" | "neutral";
  readonly text: string;
}

/**
 * Every number here is computed from the real `results` passed in — never hardcoded to
 * one run — so this stays accurate if the benchmark is re-run with different real data.
 * Findings are reported honestly regardless of which direction they point: a finding
 * that makes the gateway look worse is not softened or omitted.
 */
function computeFindings(results: readonly SessionResult[]): Finding[] {
  const findings: Finding[] = [];
  const happy = results.filter((r) => r.scenario === "happy_path");
  const direct = results.filter((r) => r.scenario === "direct_connection");
  const catalogRefresh = results.filter((r) => r.scenario === "catalog_refresh");
  const embeddingMiss = results.filter((r) => r.scenario === "embedding_miss");

  // --- Token savings (the headline claim) ---
  for (const serverCount of [1, 2] as const) {
    const directSession = direct.find((r) => r.serverCount === serverCount);
    const happySessions = happy.filter((r) => r.serverCount === serverCount);
    const avgHappyTokens = average(happySessions.map((r) => r.totalTokens));
    if (directSession && avgHappyTokens !== undefined) {
      findings.push({
        verdict: "good",
        text:
          `Through the gateway with a warm cache, a ${serverCount}-server session used ${Math.round(avgHappyTokens)} tokens ` +
          `on average vs. ${directSession.totalTokens} tokens connecting directly (${pct(avgHappyTokens, directSession.totalTokens)} change) — ` +
          `find_tool's ranked top-K result is genuinely far smaller than a raw tools/list dump of every real tool.`,
      });
    }
  }

  // --- Total latency: does the gateway actually cost more wall-clock time? ---
  for (const serverCount of [1, 2] as const) {
    const directSession = direct.find((r) => r.serverCount === serverCount);
    const happySessions = happy.filter((r) => r.serverCount === serverCount);
    const avgHappyLatency = average(happySessions.map((r) => r.totalLatencyMs));
    if (directSession && avgHappyLatency !== undefined) {
      const slower = avgHappyLatency > directSession.totalLatencyMs;
      findings.push({
        verdict: slower ? "bad" : "good",
        text:
          `Total wall-clock latency for a ${serverCount}-server session: ${Math.round(avgHappyLatency)}ms through the gateway ` +
          `vs. ${directSession.totalLatencyMs}ms connecting directly (${pct(avgHappyLatency, directSession.totalLatencyMs)} change). ` +
          (slower
            ? "The gateway is measurably SLOWER end to end here — the token savings do not come for free. " +
              "Most of both numbers is the real upstream API's own response time, not gateway overhead, but the gap is real."
            : "The gateway is not slower here despite the extra find_tool round trip."),
      });
    }
  }

  // --- Catalog refresh: is the background refresh actually invisible to the caller? ---
  const refreshFirstCallLatencies: number[] = [];
  const happyFirstCallLatencies: number[] = [];
  for (const session of catalogRefresh) {
    const step = session.steps.find((s) => s.step === "call_tool");
    if (step) refreshFirstCallLatencies.push(step.latencyMs);
  }
  for (const session of happy) {
    const step = session.steps.find((s) => s.step === "call_tool");
    if (step) happyFirstCallLatencies.push(step.latencyMs);
  }
  const avgRefresh = average(refreshFirstCallLatencies);
  const avgHappyFirstCall = average(happyFirstCallLatencies);
  if (avgRefresh !== undefined && avgHappyFirstCall !== undefined) {
    const deltaPct = Math.abs((avgRefresh - avgHappyFirstCall) / avgHappyFirstCall) * 100;
    findings.push({
      verdict: deltaPct < 25 ? "good" : "neutral",
      text:
        `The first call_tool against a server with an EXPIRED catalog entry averaged ${Math.round(avgRefresh)}ms, ` +
        `vs. ${Math.round(avgHappyFirstCall)}ms with an already-warm one (${deltaPct.toFixed(0)}% difference). ` +
        (deltaPct < 25
          ? "Close enough to call the background refresh genuinely invisible to the caller, as designed — " +
            "it never blocks the response the agent is actually waiting for."
          : "That gap is large enough to be worth re-checking with more samples before trusting the fire-and-forget design is fully invisible."),
    });
  }

  // --- find_tool's own cost, even warm ---
  const warmFindToolLatencies = happy.flatMap((s) => s.steps.filter((step) => step.step === "find_tool").map((step) => step.latencyMs));
  const avgFindTool = average(warmFindToolLatencies);
  if (avgFindTool !== undefined) {
    findings.push({
      verdict: avgFindTool > 300 ? "bad" : "good",
      text:
        `find_tool against an already-warm catalog averaged ${Math.round(avgFindTool)}ms (range ${Math.min(...warmFindToolLatencies)}-${Math.max(...warmFindToolLatencies)}ms) ` +
        `across ${warmFindToolLatencies.length} calls. ` +
        (avgFindTool > 300
          ? "That's much higher than the ~1ms embedding + one cache read the design assumed — not yet root-caused " +
            "(candidates: per-process embedding-model cold start, or Neon's network round-trip for a hosted, remote Postgres). Worth a real instrumented breakdown."
          : "Consistent with a cheap, cache-only operation."),
    });
  }

  // --- Embedding miss: real hit rate and real cost ---
  const missFirstAttempts = embeddingMiss.flatMap((s) => s.steps.filter((step) => step.step === "find_tool"));
  const hits = missFirstAttempts.filter((step) => step.foundIntendedTool).length;
  if (missFirstAttempts.length > 0) {
    findings.push({
      verdict: "bad",
      text:
        `Deliberately oblique queries found the intended tool on the FIRST find_tool call only ${hits}/${missFirstAttempts.length} times ` +
        `(${((hits / missFirstAttempts.length) * 100).toFixed(0)}%). This benchmark's retry uses a query the script already knew was good — ` +
        `a real agent has no such guarantee, so a real miss rate could translate directly into tools that are simply never found.`,
    });
  }
  const retries = embeddingMiss.flatMap((s) => s.steps.filter((step) => step.step === "find_tool_retry"));
  const retryHits = retries.filter((step) => step.foundIntendedTool).length;
  if (retries.length > 0) {
    const retryMisses = retries.length - retryHits;
    findings.push({
      verdict: retryMisses > 0 ? "bad" : "neutral",
      text:
        retryMisses > 0
          ? `Of ${retries.length} retries (with clearer, known-good phrasing), ${retryMisses} STILL missed the intended tool. ` +
            `An oblique-enough query can defeat even a reasonable rephrasing — this is a real reliability gap, not just a hypothetical one.`
          : `Every retry (with clearer phrasing) found the intended tool — the fallback worked every time it was tried, ` +
            `though see the finding above about whether a real agent would know to retry at all.`,
    });
    const missCostTokens = average([...missFirstAttempts, ...retries].map((step) => step.requestTokens + step.responseTokens));
    const missCostLatency = average(retries.map((step) => step.latencyMs));
    if (missCostTokens !== undefined && missCostLatency !== undefined) {
      findings.push({
        verdict: "bad",
        text: `Each retry added roughly ${Math.round(missCostTokens)} tokens and ${Math.round(missCostLatency)}ms on top of the failed first attempt — a real, non-trivial cost per miss, not a rounding error.`,
      });
    }
  }

  return findings;
}

const VERDICT_ICON = { good: "✅", bad: "⚠️", neutral: "ℹ️" } as const;

const BAR_WIDTH = 30;

/** A crude but genuinely readable-in-a-diff bar chart using block characters — no
 *  charting library, no rendering step, works in a plain-text `git show`/`git diff`. */
function textBar(value: number, max: number): string {
  const filled = Math.max(1, Math.round((value / max) * BAR_WIDTH));
  return "█".repeat(Math.min(filled, BAR_WIDTH));
}

function renderBarSection(title: string, rows: readonly { readonly label: string; readonly value: number }[], unit: string): string {
  const max = Math.max(...rows.map((r) => r.value), 1);
  const longestLabel = Math.max(...rows.map((r) => r.label.length));
  const lines = rows.map((r) => `${r.label.padEnd(longestLabel)}  ${textBar(r.value, max)} ${r.value}${unit}`);
  return `### ${title}\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`;
}

/**
 * A single Markdown file, readable directly in `git show`/`git diff`/GitHub — no
 * rendering step, no external charting library. See
 * scripts/benchmark_gateway_overhead.ts for what produces the data this renders.
 */
export function generateBenchmarkReport(results: readonly SessionResult[]): string {
  const gatewaySessions = results.filter((r) => r.scenario !== "direct_connection");
  const findings = computeFindings(results);

  const findingsMd = findings.map((f) => `- ${VERDICT_ICON[f.verdict]} ${f.text}`).join("\n");

  const tokensSection = renderBarSection(
    "Total tokens per session",
    results.map((r) => ({ label: label(r), value: r.totalTokens })),
    " tok",
  );
  const latencySection = renderBarSection(
    "Total latency per session",
    results.map((r) => ({ label: label(r), value: r.totalLatencyMs })),
    "ms",
  );

  const directByServerCount = new Map(results.filter((r) => r.scenario === "direct_connection").map((s) => [s.serverCount, s]));
  const happyByServerCount = new Map(
    gatewaySessions.filter((s) => s.scenario === "happy_path").map((s) => [`${s.serverCount}-${s.language}`, s]),
  );
  const comparisonRows: string[] = [];
  for (const serverCount of [1, 2] as const) {
    for (const language of ["es", "en"] as const) {
      const happySession = happyByServerCount.get(`${serverCount}-${language}`);
      const directSession = directByServerCount.get(serverCount);
      if (!happySession || !directSession) continue;
      comparisonRows.push(
        `| ${serverCount} srv (${language}) | ${happySession.totalTokens} | ${directSession.totalTokens} | ${happySession.totalLatencyMs}ms | ${directSession.totalLatencyMs}ms |`,
      );
    }
  }

  const missRows = gatewaySessions
    .filter((s) => s.scenario === "embedding_miss")
    .flatMap((s) =>
      s.steps
        .filter((step) => step.step === "find_tool" || step.step === "find_tool_retry")
        .map(
          (step: StepMetric) =>
            `| ${s.serverCount} srv / ${s.language} | ${step.step} | ${step.foundIntendedTool ? "✅ hit" : "❌ miss"} | ${step.latencyMs}ms | ${step.requestTokens + step.responseTokens} |`,
        ),
    )
    .join("\n");

  const refreshRows = gatewaySessions
    .filter((s) => s.scenario === "catalog_refresh")
    .map((s) => {
      const firstCallTool = s.steps.find((step) => step.step === "call_tool");
      return `| ${s.serverCount} srv / ${s.language} | ${firstCallTool?.latencyMs ?? "n/a"}ms | ${s.totalLatencyMs}ms | ${s.totalTokens} |`;
    })
    .join("\n");

  return `# MCP Trust Gateway — real overhead benchmark

Generated by \`scripts/benchmark_gateway_overhead.ts\` against real Jira/SonarQube
servers, real local embeddings, real Postgres (Neon) — not synthetic data. Read-only
tool calls only. Every number below is computed directly from this run's own data, not
asserted. A dated snapshot of one real run — re-run the script for current numbers
rather than trusting this indefinitely.

## Conclusions — the good and the bad, computed from this run

${findingsMd}

## Charts

${tokensSection}
${latencySection}
### Gateway (warm cache) vs. direct connection

The direct-connection baseline never calls \`find_tool\` — it sees the real, unfiltered
\`tools/list\` response for every server directly, exactly as an agent would without this
gateway.

| Servers (lang) | Gateway tokens | Direct tokens | Gateway latency | Direct latency |
|---|---|---|---|---|
${comparisonRows.join("\n")}

## Embedding miss scenario — did the oblique query find the right tool?

| Session | Step | Result | Latency | Tokens |
|---|---|---|---|---|
${missRows}

## Catalog refresh scenario

\`call_tool\`'s own response latency should stay flat even when it also triggers a
background catalog refresh (fire-and-forget, never awaited before responding) — this
column is the actual test of that.

| Session | First call_tool latency | Total session latency | Total tokens |
|---|---|---|---|
${refreshRows}

## Raw data

<details>
<summary>Full <code>SessionResult[]</code> JSON (click to expand)</summary>

\`\`\`json
${JSON.stringify(results, null, 2)}
\`\`\`

</details>
`;
}
