import { readFileSync, writeFileSync } from "node:fs";
import { generateBenchmarkReport } from "./lib/generateBenchmarkReport.js";
import type { SessionResult } from "./lib/benchmarkMetrics.js";

// Regenerates benchmark-report.md from an existing benchmark-results.json without
// re-running the real sessions against Jira/SonarQube -- useful after only changing the
// report's own rendering/analysis logic, not the measurements themselves.
const results = JSON.parse(readFileSync("benchmark-results.json", "utf8")) as SessionResult[];
writeFileSync("benchmark-report.md", generateBenchmarkReport(results));
console.log("Regenerated benchmark-report.md");
