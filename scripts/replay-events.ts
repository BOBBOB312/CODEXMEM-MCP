import fs from "node:fs";
import path from "node:path";

type Args = Record<string, string>;

type ReplayEvent =
  | { event: "session-init"; contentSessionId: string; project: string; prompt: string }
  | { event: "observation"; contentSessionId: string; tool_name: string; tool_input?: unknown; tool_response?: unknown; cwd: string }
  | { event: "summarize"; contentSessionId: string; last_assistant_message?: string }
  | { event: "session-complete"; contentSessionId: string };

type SearchQuery = { query: string; project?: string; limit?: number };

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
      "  bun run scripts/replay-events.ts --events <events.json> --queries <queries.json> --out-dir <dir>",
      "                                  [--base-url http://127.0.0.1:37777] [--observations-limit 2000] [--wait-ms 20]",
      "",
      "events.json format: ReplayEvent[]",
      "queries.json format: SearchQuery[] or string[]"
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

async function getJson(baseUrl: string, p: string): Promise<any> {
  const res = await fetch(`${baseUrl}${p}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${p} failed (${res.status}): ${text}`);
  return JSON.parse(text);
}

async function waitForHealth(baseUrl: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      // not ready
    }
    await Bun.sleep(150);
  }
  throw new Error("worker health timeout");
}

function toQueries(raw: any): SearchQuery[] {
  if (Array.isArray(raw)) {
    return raw
      .map((x) =>
        typeof x === "string"
          ? { query: x }
          : {
              query: String(x?.query || "").trim(),
              project: x?.project ? String(x.project) : undefined,
              limit: Number.isInteger(x?.limit) ? x.limit : undefined
            }
      )
      .filter((x) => x.query);
  }
  return [];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args["help"] === "true") {
    usage();
    return;
  }

  const eventsPath = args["events"];
  const queriesPath = args["queries"];
  const outDir = args["out-dir"];
  if (!eventsPath || !queriesPath || !outDir) {
    usage();
    process.exit(2);
  }

  const baseUrl = args["base-url"] || "http://127.0.0.1:37777";
  const observationsLimit = Math.max(1, Number(args["observations-limit"] || 2000));
  const waitMs = Math.max(0, Number(args["wait-ms"] || 20));

  const events = readJson(eventsPath) as ReplayEvent[];
  const queries = toQueries(readJson(queriesPath));
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error("events file must be a non-empty array");
  }

  await waitForHealth(baseUrl);

  const eventResults: Array<{ index: number; event: string; result: any }> = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i] as ReplayEvent;
    if (e.event === "session-init") {
      const result = await postJson(baseUrl, "/api/sessions/init", {
        contentSessionId: e.contentSessionId,
        project: e.project,
        prompt: e.prompt
      });
      eventResults.push({ index: i, event: e.event, result });
    } else if (e.event === "observation") {
      const result = await postJson(baseUrl, "/api/sessions/observations", {
        contentSessionId: e.contentSessionId,
        tool_name: e.tool_name,
        tool_input: e.tool_input ?? {},
        tool_response: e.tool_response ?? {},
        cwd: e.cwd
      });
      eventResults.push({ index: i, event: e.event, result });
    } else if (e.event === "summarize") {
      const result = await postJson(baseUrl, "/api/sessions/summarize", {
        contentSessionId: e.contentSessionId,
        last_assistant_message: e.last_assistant_message ?? ""
      });
      eventResults.push({ index: i, event: e.event, result });
    } else if (e.event === "session-complete") {
      const result = await postJson(baseUrl, "/api/sessions/complete", { contentSessionId: e.contentSessionId });
      eventResults.push({ index: i, event: e.event, result });
    } else {
      throw new Error(`unsupported event: ${(e as any).event}`);
    }

    if (waitMs > 0) await Bun.sleep(waitMs);
  }

  const observationsBody = await getJson(baseUrl, `/api/observations?limit=${observationsLimit}&offset=0`);
  const observations = Array.isArray(observationsBody?.observations) ? observationsBody.observations : [];

  const searches: Array<{ query: string; project?: string; ids: number[] }> = [];
  for (const q of queries) {
    const params = new URLSearchParams({
      format: "json",
      query: q.query,
      limit: String(q.limit || 20)
    });
    if (q.project) params.set("project", q.project);
    const body = await getJson(baseUrl, `/api/search?${params.toString()}`);
    const ids = Array.isArray(body?.observations) ? body.observations.map((x: any) => Number(x?.id)).filter(Number.isInteger) : [];
    searches.push({ query: q.query, project: q.project, ids });
  }

  const out = path.resolve(outDir);
  fs.mkdirSync(out, { recursive: true });
  const observationsPath = path.join(out, "candidate-observations.json");
  const searchPath = path.join(out, "candidate-search.json");
  const eventsResultPath = path.join(out, "event-results.json");
  fs.writeFileSync(observationsPath, JSON.stringify({ observations }, null, 2), "utf-8");
  fs.writeFileSync(searchPath, JSON.stringify({ searches }, null, 2), "utf-8");
  fs.writeFileSync(eventsResultPath, JSON.stringify({ eventResults }, null, 2), "utf-8");

  console.log(
    JSON.stringify(
      {
        success: true,
        baseUrl,
        outDir: out,
        files: {
          observations: observationsPath,
          search: searchPath,
          eventResults: eventsResultPath
        },
        counts: {
          events: events.length,
          observations: observations.length,
          searches: searches.length
        }
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
