import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadBaseConfig, requireEnv } from "../src/config.js";
import { createPool } from "../src/adapters/postgres/pool.js";
import { PostgresIdentityRepository } from "../src/adapters/postgres/IdentityRepository.js";
import { PostgresUpstreamServerRepository } from "../src/adapters/postgres/UpstreamServerRepository.js";
import { PostgresUserCredentialRepository } from "../src/adapters/postgres/UserCredentialRepository.js";
import { AesGcmCredentialVault } from "../src/adapters/security/CredentialVault.js";
import { hashApiKey } from "../src/adapters/security/apiKeys.js";
import { measureStep, summarizeSession } from "./lib/benchmarkMetrics.js";
import type { SessionResult, StepMetric } from "./lib/benchmarkMetrics.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { generateBenchmarkReport } from "./lib/generateBenchmarkReport.js";

/**
 * Real, end-to-end measurement of the gateway's overhead — not an estimate. Every session
 * below spawns the REAL built gateway (or, for the "direct connection" baseline, the REAL
 * upstream servers directly with no gateway at all) and drives it over the real MCP
 * protocol against this operator's own real Jira/SonarQube servers, using only read-only
 * tools verified beforehand (jira_get_agile_boards, jira_search_projects, system_ping,
 * metrics, list_languages — nothing that creates, updates, or deletes anything).
 *
 * Four scenarios × {1, 2} servers × {es, en} query language, plus a language-independent
 * direct-connection baseline. See DESIGN.md's backlog entry for why this exists and what
 * each scenario is meant to isolate.
 *
 * Requires GATEWAY_API_KEY, DATABASE_URL, GATEWAY_ENCRYPTION_KEY for an identity already
 * permitted on real "jira" and "sonarqube" upstream_servers rows.
 */

const GATEWAY_ENTRYPOINT = "dist/entrypoints/stdio/index.js";
const JIRA = "jira";
const SONARQUBE = "sonarqube";

interface ToolCallPlan {
  readonly server: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly query: { readonly es: string; readonly en: string };
  /** A deliberately oblique phrasing of the same intent, for the embedding_miss
   *  scenario — real user language that shares little vocabulary with the tool's own
   *  name/description. */
  readonly obliqueQuery: { readonly es: string; readonly en: string };
}

const JIRA_PLAN: ToolCallPlan[] = [
  {
    server: JIRA,
    tool: "jira_get_agile_boards",
    args: {},
    query: { es: "listar los tableros ágiles de jira", en: "list jira agile boards" },
    obliqueQuery: { es: "dónde veo el trabajo en curso de mi equipo", en: "where can I see my team's ongoing work" },
  },
  {
    server: JIRA,
    tool: "jira_search_projects",
    args: { query: "a" },
    query: { es: "buscar proyectos de jira", en: "search for jira projects" },
    obliqueQuery: { es: "qué cosas tenemos organizadas en jira", en: "what things do we have organized in jira" },
  },
];

const SONARQUBE_PLAN: ToolCallPlan[] = [
  {
    server: SONARQUBE,
    tool: "system_ping",
    args: {},
    query: { es: "comprobar si sonarqube está disponible", en: "check if sonarqube is reachable" },
    obliqueQuery: { es: "¿va todo bien hoy?", en: "is everything okay today" },
  },
  {
    server: SONARQUBE,
    tool: "metrics",
    args: {},
    query: { es: "listar las métricas disponibles de sonarqube", en: "list available sonarqube metrics" },
    obliqueQuery: { es: "qué números podemos consultar", en: "what numbers can we look at" },
  },
  {
    server: SONARQUBE,
    tool: "list_languages",
    args: {},
    query: { es: "listar los lenguajes de programación soportados", en: "list supported programming languages" },
    obliqueQuery: { es: "con qué tecnologías trabaja esto", en: "what technologies does this work with" },
  },
];

function planFor(serverCount: 1 | 2): ToolCallPlan[] {
  // 1 server = Jira alone (richer catalog, ~60 tools, more realistic for embedding_miss).
  // 2 servers = Jira + SonarQube combined, 3 calls spanning both.
  return serverCount === 1 ? JIRA_PLAN : [JIRA_PLAN[0], SONARQUBE_PLAN[0], SONARQUBE_PLAN[1]];
}

async function connectGateway(apiKey: string, databaseUrl: string, encryptionKeyHex: string): Promise<Client> {
  const client = new Client({ name: "benchmark", version: "0.0.1" });
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: [GATEWAY_ENTRYPOINT],
      env: { ...getDefaultEnvironment(), GATEWAY_API_KEY: apiKey, DATABASE_URL: databaseUrl, GATEWAY_ENCRYPTION_KEY: encryptionKeyHex },
    }),
  );
  return client;
}

async function findTool(client: Client, query: string): Promise<{ result: unknown; metric: StepMetric; foundServers: string[] }> {
  const { result, metric } = await measureStep(
    "find_tool",
    { query },
    () => client.callTool({ name: "find_tool", arguments: { query } }),
    (r) => (r as { content: { text: string }[] }).content?.[0]?.text,
  );
  const text = (result as { content: { text: string }[] }).content?.[0]?.text ?? "[]";
  const found = JSON.parse(text) as { server: string; name: string }[];
  return { result, metric, foundServers: found.map((f) => `${f.server}/${f.name}`) };
}

async function callTool(client: Client, plan: ToolCallPlan): Promise<StepMetric> {
  const { metric } = await measureStep(
    "call_tool",
    { server: plan.server, tool: plan.tool, arguments: plan.args },
    () => client.callTool({ name: "call_tool", arguments: { server: plan.server, tool: plan.tool, arguments: plan.args } }),
    (r) => (r as { content: { text: string }[] }).content?.[0]?.text,
  );
  return metric;
}

/** happy_path and embedding_miss both need a warm catalog before the measured session
 *  starts — this throwaway session builds it, discarded before any measurement begins. */
async function warmCatalog(config: { apiKey: string; databaseUrl: string; encryptionKeyHex: string }, plans: ToolCallPlan[]): Promise<void> {
  const gw = await connectGateway(config.apiKey, config.databaseUrl, config.encryptionKeyHex);
  for (const plan of plans) await gw.callTool({ name: "find_tool", arguments: { query: plan.query.en } });
  await gw.close();
}

async function expireCatalog(databaseUrl: string, serverNames: string[]): Promise<void> {
  const pool = createPool(databaseUrl);
  const servers = new PostgresUpstreamServerRepository(pool);
  for (const name of serverNames) {
    const server = await servers.findByName(name);
    if (!server) throw new Error(`Server "${name}" not found — benchmark needs it registered and permitted.`);
    // 8 days ago -- one day past TOOL_CATALOG_TTL_MS (a week), guaranteed stale.
    await pool.query(`UPDATE tool_catalog SET refreshed_at = now() - interval '8 days' WHERE server_id = $1`, [server.id]);
  }
  await pool.end();
}

async function runGatewaySession(
  scenario: string,
  serverCount: 1 | 2,
  language: "es" | "en",
  config: { apiKey: string; databaseUrl: string; encryptionKeyHex: string },
  useObliqueQueries: boolean,
): Promise<SessionResult> {
  const plans = planFor(serverCount);
  const gw = await connectGateway(config.apiKey, config.databaseUrl, config.encryptionKeyHex);

  const steps: StepMetric[] = [];
  try {
    for (const plan of plans) {
      const queryText = (useObliqueQueries ? plan.obliqueQuery : plan.query)[language];
      const { metric, foundServers } = await findTool(gw, queryText);
      const found = foundServers.includes(`${plan.server}/${plan.tool}`);
      steps.push({ ...metric, foundIntendedTool: found });

      if (!found && useObliqueQueries) {
        // Simulate a real agent's fallback: the first (oblique) phrasing missed, so it
        // retries with clearer wording -- this retry's own cost IS the real cost of a miss.
        const retry = await findTool(gw, plan.query[language]);
        steps.push({ ...retry.metric, step: "find_tool_retry", foundIntendedTool: retry.foundServers.includes(`${plan.server}/${plan.tool}`) });
      }

      steps.push(await callTool(gw, plan));
    }
  } finally {
    await gw.close();
  }

  return summarizeSession(scenario, serverCount, language, steps);
}

interface DirectServerSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
}

async function runDirectConnectionBaseline(
  serverCount: 1 | 2,
  jiraCommand: DirectServerSpec,
  sonarqubeCommand: DirectServerSpec,
): Promise<SessionResult> {
  const plans = planFor(serverCount);
  const steps: StepMetric[] = [];
  const clients = new Map<string, Client>();

  const connectDirect = async (server: string): Promise<Client> => {
    const existing = clients.get(server);
    if (existing) return existing;
    const client = new Client({ name: "benchmark-direct", version: "0.0.1" });
    const spec = server === JIRA ? jiraCommand : sonarqubeCommand;
    await client.connect(new StdioClientTransport({ command: spec.command, args: [...spec.args], env: { ...getDefaultEnvironment(), ...spec.env } }));
    clients.set(server, client);
    return client;
  };

  try {
    const seenServers = new Set<string>();
    for (const plan of plans) {
      const client = await connectDirect(plan.server);
      if (!seenServers.has(plan.server)) {
        seenServers.add(plan.server);
        // No find_tool here -- a direct connection means the agent sees the REAL,
        // un-filtered tools/list response for this server, exactly as it would
        // without this gateway at all. This is the actual cost being compared against.
        const { metric } = await measureStep("tools/list (direct)", {}, () => client.listTools());
        steps.push(metric);
      }
      const { metric } = await measureStep(
        "call_tool (direct)",
        { tool: plan.tool, arguments: plan.args },
        () => client.callTool({ name: plan.tool, arguments: plan.args }),
        (r) => (r as { content: { text: string }[] }).content?.[0]?.text,
      );
      steps.push(metric);
    }
  } finally {
    await Promise.all([...clients.values()].map((c) => c.close()));
  }

  return summarizeSession("direct_connection", serverCount, "n/a", steps);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Real infra flakiness observed running this against a real hosted Postgres (Neon) and
 *  real third-party APIs (Jira): a pooled Postgres proxy can take a moment to recognize a
 *  just-closed connection as free, and a real upstream API can genuinely time out once in
 *  a while. Neither should cost the whole multi-scenario run — retry once after a pause,
 *  and if that also fails, record it as a failed session and move on rather than crash. */
async function withRetryOrSkip(label: string, fn: () => Promise<SessionResult>): Promise<SessionResult | undefined> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await fn();
    } catch (error) {
      console.error(`  [${label}] attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (attempt === 2) return undefined;
      await sleep(5000);
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const apiKey = requireEnv("GATEWAY_API_KEY");
  const { databaseUrl } = loadBaseConfig();
  const encryptionKeyHex = requireEnv("GATEWAY_ENCRYPTION_KEY");

  const pool = createPool(databaseUrl);
  const servers = new PostgresUpstreamServerRepository(pool);
  const userCredentials = new PostgresUserCredentialRepository(pool);
  const identities = new PostgresIdentityRepository(pool);
  const vault = new AesGcmCredentialVault(Buffer.from(encryptionKeyHex, "hex"));

  const identity = await identities.findByApiKeyHash(hashApiKey(apiKey));
  if (!identity) throw new Error("GATEWAY_API_KEY does not match any active identity.");

  const jiraServer = await servers.findByName(JIRA);
  const sonarqubeServer = await servers.findByName(SONARQUBE);
  if (!jiraServer || !sonarqubeServer) throw new Error('Benchmark requires both "jira" and "sonarqube" registered as upstream_servers.');

  const sonarqubeCredential = await userCredentials.find(identity.userId, sonarqubeServer.id);
  if (!sonarqubeCredential) throw new Error("This identity has no stored credential for sonarqube -- needed for the direct-connection baseline.");
  const sonarqubeEnv = JSON.parse(vault.decrypt(sonarqubeCredential)) as Record<string, string>;
  await pool.end();

  const config = { apiKey, databaseUrl, encryptionKeyHex };
  const results: SessionResult[] = [];

  const SESSION_COOLDOWN_MS = 2000; // lets Neon's pooler recognize the previous session's closed connection

  console.log("Running direct-connection baselines (no gateway)...");
  for (const serverCount of [1, 2] as const) {
    const result = await withRetryOrSkip(`direct_connection ${serverCount}srv`, () =>
      runDirectConnectionBaseline(
        serverCount,
        { command: jiraServer.command, args: jiraServer.args, env: {} },
        { command: sonarqubeServer.command, args: sonarqubeServer.args, env: sonarqubeEnv },
      ),
    );
    if (result) results.push(result);
    await sleep(SESSION_COOLDOWN_MS);
  }

  for (const serverCount of [1, 2] as const) {
    console.log(`\nExpiring catalog for ${serverCount === 1 ? "jira" : "jira+sonarqube"} (catalog_refresh scenario)...`);
    await expireCatalog(databaseUrl, serverCount === 1 ? [JIRA] : [JIRA, SONARQUBE]);
    for (const language of ["es", "en"] as const) {
      console.log(`  catalog_refresh, ${serverCount} server(s), ${language}`);
      const result = await withRetryOrSkip(`catalog_refresh ${serverCount}srv ${language}`, () =>
        runGatewaySession("catalog_refresh", serverCount, language, config, false),
      );
      if (result) results.push(result);
      await sleep(SESSION_COOLDOWN_MS);
    }

    console.log(`Warming catalog for ${serverCount} server(s) (happy_path / embedding_miss)...`);
    await warmCatalog(config, planFor(serverCount));
    await sleep(SESSION_COOLDOWN_MS);
    for (const language of ["es", "en"] as const) {
      console.log(`  happy_path, ${serverCount} server(s), ${language}`);
      const happy = await withRetryOrSkip(`happy_path ${serverCount}srv ${language}`, () =>
        runGatewaySession("happy_path", serverCount, language, config, false),
      );
      if (happy) results.push(happy);
      await sleep(SESSION_COOLDOWN_MS);

      console.log(`  embedding_miss, ${serverCount} server(s), ${language}`);
      const miss = await withRetryOrSkip(`embedding_miss ${serverCount}srv ${language}`, () =>
        runGatewaySession("embedding_miss", serverCount, language, config, true),
      );
      if (miss) results.push(miss);
      await sleep(SESSION_COOLDOWN_MS);
    }
  }

  mkdirSync("benchmarks", { recursive: true });
  writeFileSync("benchmarks/benchmark-results.json", JSON.stringify(results, null, 2));
  console.log("\nWrote benchmarks/benchmark-results.json");

  const report = generateBenchmarkReport(results);
  writeFileSync("benchmarks/benchmark-report.md", report);
  console.log("Wrote benchmarks/benchmark-report.md -- readable directly in git/GitHub, no rendering step needed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
