import fs from "node:fs";
import path from "node:path";

type Args = Record<string, string>;

type ReplayEvent =
  | { event: "session-init"; contentSessionId: string; project: string; prompt: string }
  | { event: "observation"; contentSessionId: string; tool_name: string; tool_input?: unknown; tool_response?: unknown; cwd: string }
  | { event: "summarize"; contentSessionId: string; last_assistant_message?: string }
  | { event: "session-complete"; contentSessionId: string };

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith("--")) continue;
    const key = t.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      out[key] = "true";
    } else {
      out[key] = value;
      i++;
    }
  }
  return out;
}

function usage(): void {
  console.log(
    [
      "Usage:",
      "  bun run scripts/quality-replay.ts --events <events.json> [--base-url http://127.0.0.1:37777]",
      "                                    [--output ./quality-report.json] [--min-success-rate 0.99]",
      "",
      "events.json format: ReplayEvent[]",
      "requirement: at least 50 events"
    ].join("\n")
  );
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf-8"));
}

async function postJson(baseUrl: string, p: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${baseUrl}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${p} failed (${res.status}): ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function waitForHealth(baseUrl: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      // ignore until ready
    }
    await Bun.sleep(150);
  }
  throw new Error("worker health timeout");
}

function ratio(n: number, d: number): number {
  if (d <= 0) return 1;
  return Number((n / d).toFixed(4));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args["help"] === "true") {
    usage();
    return;
  }

  const eventsPath = args["events"];
  if (!eventsPath) {
    usage();
    process.exit(2);
  }
  const baseUrl = args["base-url"] || "http://127.0.0.1:37777";
  const output = args["output"] ? path.resolve(args["output"]) : "";
  const minSuccessRate = Number(args["min-success-rate"] || 0.99);
  const waitMs = Math.max(0, Number(args["wait-ms"] || 15));

  const events = readJson(eventsPath) as ReplayEvent[];
  if (!Array.isArray(events) || events.length < 50) {
    throw new Error("quality replay requires at least 50 events");
  }

  await waitForHealth(baseUrl);
  await postJson(baseUrl, "/api/ops/agent-metrics/reset", {});

  for (const e of events) {
    if (e.event === "session-init") {
      await postJson(baseUrl, "/api/sessions/init", {
        contentSessionId: e.contentSessionId,
        project: e.project,
        prompt: e.prompt
      });
    } else if (e.event === "observation") {
      await postJson(baseUrl, "/api/sessions/observations", {
        contentSessionId: e.contentSessionId,
        tool_name: e.tool_name,
        tool_input: e.tool_input ?? {},
        tool_response: e.tool_response ?? {},
        cwd: e.cwd
      });
    } else if (e.event === "summarize") {
      await postJson(baseUrl, "/api/sessions/summarize", {
        contentSessionId: e.contentSessionId,
        last_assistant_message: e.last_assistant_message ?? ""
      });
    } else if (e.event === "session-complete") {
      await postJson(baseUrl, "/api/sessions/complete", { contentSessionId: e.contentSessionId });
    }
    if (waitMs > 0) await Bun.sleep(waitMs);
  }

  const metricsRes = await fetch(`${baseUrl}/api/ops/agent-metrics`);
  if (!metricsRes.ok) {
    throw new Error(`get agent metrics failed (${metricsRes.status})`);
  }
  const metrics = (await metricsRes.json())?.metrics as any;

  const obs = metrics?.observation || {};
  const sum = metrics?.summary || {};
  const obsTotal = Number(obs.success || 0) + Number(obs.fallback_used || 0);
  const sumTotal = Number(sum.success || 0) + Number(sum.fallback_used || 0);
  const obsSuccessRate = ratio(Number(obs.success || 0), obsTotal);
  const sumSuccessRate = ratio(Number(sum.success || 0), sumTotal);

  const passed = obsSuccessRate >= minSuccessRate && sumSuccessRate >= minSuccessRate;
  const report = {
    generatedAt: new Date().toISOString(),
    events: events.length,
    minSuccessRate,
    metrics,
    derived: {
      observation: {
        total: obsTotal,
        successRate: obsSuccessRate
      },
      summary: {
        total: sumTotal,
        successRate: sumSuccessRate
      }
    },
    passed
  };

  const text = JSON.stringify(report, null, 2);
  if (output) {
    fs.writeFileSync(output, text, "utf-8");
    console.log(`Report written: ${output}`);
  }
  console.log(text);
  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
