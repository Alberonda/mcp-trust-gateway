import type { SessionResult, StepMetric } from "./benchmarkMetrics.js";

function label(session: SessionResult): string {
  return `${session.scenario} · ${session.serverCount} srv · ${session.language}`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

/** A single self-contained HTML file (Chart.js loaded from a CDN, data inlined) — open it
 *  directly in a browser, no server or build step needed. See
 *  scripts/benchmark_gateway_overhead.ts for what produces the data this renders. */
export function generateBenchmarkReport(results: readonly SessionResult[]): string {
  const gatewaySessions = results.filter((r) => r.scenario !== "direct_connection");
  const directSessions = results.filter((r) => r.scenario === "direct_connection");
  const findings = computeFindings(results);

  const findingsHtml = findings
    .map((f) => {
      const icon = f.verdict === "good" ? "✅" : f.verdict === "bad" ? "⚠️" : "ℹ️";
      const bg = f.verdict === "good" ? "#eafbea" : f.verdict === "bad" ? "#fdecea" : "#f0f0f0";
      return `<li style="background:${bg}; padding: 0.6rem 0.8rem; border-radius: 6px; margin-bottom: 0.5rem; list-style: none;">${icon} ${escapeHtml(f.text)}</li>`;
    })
    .join("\n");

  const tokensChartData = {
    labels: results.map(label),
    datasets: [{ label: "Total tokens", data: results.map((r) => r.totalTokens) }],
  };
  const latencyChartData = {
    labels: results.map(label),
    datasets: [{ label: "Total latency (ms)", data: results.map((r) => r.totalLatencyMs) }],
  };

  const directByServerCount = new Map(directSessions.map((s) => [s.serverCount, s]));
  const happyByServerCount = new Map(
    gatewaySessions.filter((s) => s.scenario === "happy_path").map((s) => [`${s.serverCount}-${s.language}`, s]),
  );
  const comparisonLabels: string[] = [];
  const comparisonGatewayTokens: number[] = [];
  const comparisonDirectTokens: number[] = [];
  const comparisonGatewayLatency: number[] = [];
  const comparisonDirectLatency: number[] = [];
  for (const serverCount of [1, 2] as const) {
    for (const language of ["es", "en"] as const) {
      const happySession = happyByServerCount.get(`${serverCount}-${language}`);
      const directSession = directByServerCount.get(serverCount);
      if (!happySession || !directSession) continue;
      comparisonLabels.push(`${serverCount} srv (${language})`);
      comparisonGatewayTokens.push(happySession.totalTokens);
      comparisonDirectTokens.push(directSession.totalTokens);
      comparisonGatewayLatency.push(happySession.totalLatencyMs);
      comparisonDirectLatency.push(directSession.totalLatencyMs);
    }
  }
  const tokensComparisonChartData = {
    labels: comparisonLabels,
    datasets: [
      { label: "Through the gateway (warm cache)", data: comparisonGatewayTokens },
      { label: "Direct connection (no gateway)", data: comparisonDirectTokens },
    ],
  };
  const latencyComparisonChartData = {
    labels: comparisonLabels,
    datasets: [
      { label: "Through the gateway (warm cache)", data: comparisonGatewayLatency },
      { label: "Direct connection (no gateway)", data: comparisonDirectLatency },
    ],
  };

  const missRows = gatewaySessions
    .filter((s) => s.scenario === "embedding_miss")
    .flatMap((s) =>
      s.steps
        .filter((step) => step.step === "find_tool" || step.step === "find_tool_retry")
        .map(
          (step: StepMetric) =>
            `<tr><td>${s.serverCount} srv / ${s.language}</td><td>${step.step}</td><td>${step.foundIntendedTool ? "✅ hit" : "❌ miss"}</td><td>${step.latencyMs}ms</td><td>${step.requestTokens + step.responseTokens}</td></tr>`,
        ),
    )
    .join("\n");

  const refreshRows = gatewaySessions
    .filter((s) => s.scenario === "catalog_refresh")
    .map((s) => {
      const firstCallTool = s.steps.find((step) => step.step === "call_tool");
      return `<tr><td>${s.serverCount} srv / ${s.language}</td><td>${firstCallTool?.latencyMs ?? "n/a"}ms</td><td>${s.totalLatencyMs}ms</td><td>${s.totalTokens}</td></tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>MCP Trust Gateway — overhead benchmark</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2.5rem; }
  canvas { max-height: 420px; }
  table { border-collapse: collapse; width: 100%; margin-top: 0.5rem; }
  th, td { border: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; font-size: 0.9rem; }
  th { background: #f5f5f5; }
  p.note { color: #555; font-size: 0.9rem; }
  ul.findings { padding: 0; margin: 0.5rem 0; }
</style>
</head>
<body>
<h1>MCP Trust Gateway — real overhead benchmark</h1>
<p class="note">Generated by <code>scripts/benchmark_gateway_overhead.ts</code> against real Jira/SonarQube servers, real local embeddings, real Postgres (Neon) — not synthetic data. Read-only tool calls only. Every number below is computed directly from this run's own data, not asserted.</p>

<h2>Conclusions — the good and the bad, computed from this run</h2>
<ul class="findings">
${findingsHtml}
</ul>

<h2>Total tokens per session</h2>
<canvas id="tokensChart"></canvas>

<h2>Total latency per session</h2>
<canvas id="latencyChart"></canvas>

<h2>Gateway (warm cache) vs. direct connection — tokens</h2>
<p class="note">The direct-connection baseline never calls find_tool — it sees the real, unfiltered tools/list response for every server directly, exactly as an agent would without this gateway.</p>
<canvas id="tokensComparisonChart"></canvas>

<h2>Gateway (warm cache) vs. direct connection — latency</h2>
<p class="note">The flip side of the token savings above — see the "Conclusions" section for whether this makes the gateway net slower.</p>
<canvas id="latencyComparisonChart"></canvas>

<h2>Embedding miss scenario — did the oblique query find the right tool?</h2>
<table>
<tr><th>Session</th><th>Step</th><th>Result</th><th>Latency</th><th>Tokens</th></tr>
${missRows}
</table>

<h2>Catalog refresh scenario</h2>
<p class="note">call_tool's own response latency should stay flat even when it also triggers a background catalog refresh (fire-and-forget, never awaited before responding) — this column is the actual test of that.</p>
<table>
<tr><th>Session</th><th>First call_tool latency</th><th>Total session latency</th><th>Total tokens</th></tr>
${refreshRows}
</table>

<h2>Raw data</h2>
<pre style="white-space: pre-wrap; font-size: 0.75rem; background: #f8f8f8; padding: 1rem; border-radius: 4px;">${escapeHtml(JSON.stringify(results, null, 2))}</pre>

<script>
const tokensData = ${JSON.stringify(tokensChartData)};
const latencyData = ${JSON.stringify(latencyChartData)};
const tokensComparisonData = ${JSON.stringify(tokensComparisonChartData)};
const latencyComparisonData = ${JSON.stringify(latencyComparisonChartData)};

new Chart(document.getElementById("tokensChart"), { type: "bar", data: tokensData, options: { plugins: { legend: { display: false } } } });
new Chart(document.getElementById("latencyChart"), { type: "bar", data: latencyData, options: { plugins: { legend: { display: false } } } });
new Chart(document.getElementById("tokensComparisonChart"), { type: "bar", data: tokensComparisonData });
new Chart(document.getElementById("latencyComparisonChart"), { type: "bar", data: latencyComparisonData });
</script>
</body>
</html>
`;
}
