import fs from "node:fs";
import path from "node:path";

type Args = Record<string, string>;

type EndpointCheck = {
  name: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
};

type ServiceResult = {
  baseUrl: string;
  project: string;
  checks: Array<{ name: string; ok: boolean; status: number; detail?: string }>;
  observationIds: number[];
  searchHitCount: number;
  passed: boolean;
};

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
      "  bun run scripts/claudemem-live-parity.ts",
      "      [--claude-url http://127.0.0.1:37888]",
      "      [--codex-url http://127.0.0.1:37777]",
      "      [--project live-parity]",
      "      [--output ./artifacts/parity/live-parity-report.json]"
    ].join("\n")
  );
}

async function requestJson(baseUrl: string, method: "GET" | "POST", pathWithQuery: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${baseUrl}${pathWithQuery}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // keep text as-is
  }
  return { status: res.status, json, text };
}

async function waitHealth(baseUrl: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await Bun.sleep(150);
  }
  throw new Error(`health timeout: ${baseUrl}`);
}

function extractObservationItems(payload: any): any[] {
  if (Array.isArray(payload?.observations)) return payload.observations;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function extractSearchObservations(payload: any): any[] {
  if (Array.isArray(payload?.observations)) return payload.observations;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function extractTimelineText(payload: any): string {
  if (typeof payload?.timeline === "string") return payload.timeline;
  const content = payload?.content;
  if (Array.isArray(content) && typeof content[0]?.text === "string") return content[0].text;
  if (typeof payload?.text === "string") return payload.text;
  return "";
}

async function runServiceChecks(baseUrl: string, project: string): Promise<ServiceResult> {
  await waitHealth(baseUrl);

  const checks: ServiceResult["checks"] = [];
  const memoryPayloads = [
    { text: "修复登录空指针，增加 guard", title: "Login Guard Fix", project },
    { text: "新增鉴权回归测试，覆盖 token 缺失分支", title: "Auth Regression Test", project },
    { text: "发布前执行 release-gate 和 soak", title: "Release Gate Rule", project }
  ];

  const baseChecks: EndpointCheck[] = [
    { name: "health", method: "GET", path: "/api/health" },
    { name: "readiness", method: "GET", path: "/api/readiness" },
    { name: "version", method: "GET", path: "/api/version" },
    { name: "projects", method: "GET", path: "/api/projects" },
    { name: "stats", method: "GET", path: "/api/stats" }
  ];

  for (const c of baseChecks) {
    const res = await requestJson(baseUrl, c.method, c.path, c.body);
    checks.push({ name: c.name, ok: res.status >= 200 && res.status < 300, status: res.status });
  }

  for (let i = 0; i < memoryPayloads.length; i++) {
    const res = await requestJson(baseUrl, "POST", "/api/memory/save", memoryPayloads[i]);
    const ok = res.status >= 200 && res.status < 300 && Boolean(res.json?.success);
    checks.push({ name: `memory.save.${i + 1}`, ok, status: res.status });
  }

  const observationsRes = await requestJson(baseUrl, "GET", `/api/observations?project=${encodeURIComponent(project)}&limit=50&offset=0`);
  const observationItems = extractObservationItems(observationsRes.json);
  const observationIds = observationItems.map((x) => Number(x?.id)).filter(Number.isInteger);
  checks.push({
    name: "observations.list",
    ok: observationsRes.status === 200 && observationItems.length >= 3,
    status: observationsRes.status,
    detail: `count=${observationItems.length}`
  });

  if (observationIds.length > 0) {
    const detailRes = await requestJson(baseUrl, "GET", `/api/observation/${observationIds[0]}`);
    checks.push({
      name: "observation.detail",
      ok: detailRes.status === 200 && Boolean(detailRes.json?.observation || detailRes.json?.id),
      status: detailRes.status
    });
  } else {
    checks.push({ name: "observation.detail", ok: false, status: 0, detail: "no observation id" });
  }

  async function searchWithRetry(query: string, retries = 8, sleepMs = 250): Promise<{ status: number; obs: any[] }> {
    let lastStatus = 0;
    let lastObs: any[] = [];
    for (let i = 0; i < retries; i++) {
      const res = await requestJson(
        baseUrl,
        "GET",
        `/api/search?format=json&query=${encodeURIComponent(query)}&project=${encodeURIComponent(project)}&limit=20`
      );
      lastStatus = res.status;
      lastObs = extractSearchObservations(res.json);
      if (res.status === 200 && lastObs.length > 0) {
        return { status: res.status, obs: lastObs };
      }
      await Bun.sleep(sleepMs);
    }
    return { status: lastStatus, obs: lastObs };
  }

  const searchResult = await searchWithRetry("guard");
  const searchObs = searchResult.obs;
  checks.push({
    name: "search",
    ok: searchResult.status === 200 && searchObs.length > 0,
    status: searchResult.status,
    detail: `hits=${searchObs.length}`
  });

  const contextRes = await requestJson(baseUrl, "GET", `/api/context/inject?project=${encodeURIComponent(project)}`);
  checks.push({
    name: "context.inject",
    ok: contextRes.status === 200 && contextRes.text.length > 0,
    status: contextRes.status
  });

  const timelineRes = await requestJson(
    baseUrl,
    "GET",
    `/api/timeline?project=${encodeURIComponent(project)}&query=${encodeURIComponent("guard")}&depth_before=1&depth_after=1`
  );
  const timelineText = extractTimelineText(timelineRes.json);
  checks.push({
    name: "timeline",
    ok: timelineRes.status === 200 && timelineText.length > 0,
    status: timelineRes.status
  });

  const passed = checks.every((c) => c.ok);
  return {
    baseUrl,
    project,
    checks,
    observationIds,
    searchHitCount: searchObs.length,
    passed
  };
}

function compareServices(a: ServiceResult, b: ServiceResult): { passed: boolean; notes: string[] } {
  const notes: string[] = [];
  const diffObs = Math.abs(a.observationIds.length - b.observationIds.length);
  if (diffObs > 0) {
    notes.push(`observation count mismatch: ${a.observationIds.length} vs ${b.observationIds.length}`);
  }

  const diffSearchHits = Math.abs(a.searchHitCount - b.searchHitCount);
  if (diffSearchHits > 2) {
    notes.push(`search hit mismatch too large: ${a.searchHitCount} vs ${b.searchHitCount}`);
  }

  const passed = a.passed && b.passed && diffObs <= 1 && diffSearchHits <= 2;
  return { passed, notes };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === "true") {
    usage();
    return;
  }

  const claudeUrl = args["claude-url"] || "http://127.0.0.1:37888";
  const codexUrl = args["codex-url"] || "http://127.0.0.1:37777";
  const projectBase = args.project || "live-parity";
  const output = args.output ? path.resolve(args.output) : "";
  const stamp = Date.now();

  const claudeProject = `${projectBase}-claude-${stamp}`;
  const codexProject = `${projectBase}-codex-${stamp}`;

  const [claude, codex] = await Promise.all([runServiceChecks(claudeUrl, claudeProject), runServiceChecks(codexUrl, codexProject)]);
  const compare = compareServices(claude, codex);

  const report = {
    generatedAt: new Date().toISOString(),
    inputs: {
      claudeUrl,
      codexUrl
    },
    claude,
    codex,
    compare,
    passed: compare.passed
  };

  const text = JSON.stringify(report, null, 2);
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, text, "utf-8");
    console.log(`Report written: ${output}`);
  }
  console.log(text);
  process.exit(report.passed ? 0 : 1);
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
