import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let worker: ReturnType<typeof Bun.spawn> | null = null;
let baseUrl = "";
let dataDir = "";

setDefaultTimeout(30_000);

function randomPort(): number {
  return 38000 + Math.floor(Math.random() * 2000);
}

async function waitForHealth(url: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
      // worker not ready yet
    }
    await Bun.sleep(150);
  }
  throw new Error("Worker health check timeout");
}

beforeAll(async () => {
  const port = randomPort();
  baseUrl = `http://127.0.0.1:${port}`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexmem-contract-"));
  fs.writeFileSync(
    path.join(dataDir, "settings.json"),
    JSON.stringify(
      {
        CODEXMEM_WORKER_HOST: "127.0.0.1",
        CODEXMEM_WORKER_PORT: String(port),
        CODEXMEM_PROVIDER: "openai",
        CODEXMEM_OPENAI_API_KEY: ""
      },
      null,
      2
    ),
    "utf-8"
  );

  worker = Bun.spawn([process.execPath, "run", "src/worker/server.ts"], {
    cwd: path.resolve(path.join(import.meta.dir, "..")),
    env: {
      ...process.env,
      CODEXMEM_DATA_DIR: dataDir
    },
    stdout: "pipe",
    stderr: "pipe"
  });

  await waitForHealth(baseUrl);
});

afterAll(async () => {
  if (worker) {
    worker.kill();
    await worker.exited;
  }
  if (dataDir) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

describe("api contract", () => {
  test("health/readiness/version", async () => {
    const health = await fetch(`${baseUrl}/api/health`);
    const healthBody = await health.json();
    expect(health.status).toBe(200);
    expect(healthBody.status).toBe("ok");
    expect(typeof healthBody.initialized).toBe("boolean");

    const readiness = await fetch(`${baseUrl}/api/readiness`);
    const readinessBody = await readiness.json();
    expect(readiness.status).toBe(200);
    expect(readinessBody.status).toBe("ready");

    const version = await fetch(`${baseUrl}/api/version`);
    const versionBody = await version.json();
    expect(version.status).toBe(200);
    expect(typeof versionBody.version).toBe("string");
  });

  test("session init idempotent", async () => {
    const payload = {
      contentSessionId: "contract-sess-1",
      project: "contract-project",
      prompt: "hello world"
    };
    const r1 = await fetch(`${baseUrl}/api/sessions/init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const b1 = await r1.json();
    const r2 = await fetch(`${baseUrl}/api/sessions/init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const b2 = await r2.json();

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(b1.sessionDbId).toBe(b2.sessionDbId);
  });

  test("session end endpoint performs cleanup and completes session", async () => {
    const contentSessionId = "contract-sess-end-1";
    const init = await fetch(`${baseUrl}/api/sessions/init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contentSessionId,
        project: "contract-project",
        prompt: "end session test"
      })
    });
    expect(init.status).toBe(200);

    const endRes = await fetch(`${baseUrl}/api/sessions/end`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contentSessionId, cleanup: true })
    });
    const endBody = await endRes.json();
    expect(endRes.status).toBe(200);
    expect(endBody.status).toBe("ended");
    expect(endBody.cleanup?.enabled).toBe(true);
  });

  test("observations/batch validation errors", async () => {
    const badType = await fetch(`${baseUrl}/api/observations/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ["1"] })
    });
    expect(badType.status).toBe(400);

    const nonArray = await fetch(`${baseUrl}/api/observations/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: 1 })
    });
    expect(nonArray.status).toBe(400);
  });

  test("observation skips low-value tools by default list", async () => {
    const contentSessionId = "contract-sess-skiptool-1";
    const project = "contract-project-skiptool";
    const init = await fetch(`${baseUrl}/api/sessions/init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contentSessionId, project, prompt: "skip tool test" })
    });
    expect(init.status).toBe(200);

    const obs = await fetch(`${baseUrl}/api/sessions/observations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contentSessionId,
        tool_name: "ListMcpResourcesTool",
        tool_input: {},
        tool_response: { ok: true },
        cwd: "/tmp/skiptool"
      })
    });
    const body = await obs.json();
    expect(obs.status).toBe(200);
    expect(body.status).toBe("skipped");
    expect(body.reason).toBe("tool_excluded");
  });

  test("observation skips session-memory meta operations", async () => {
    const contentSessionId = "contract-sess-session-memory-1";
    const project = "contract-project-session-memory";
    const init = await fetch(`${baseUrl}/api/sessions/init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contentSessionId, project, prompt: "session memory meta test" })
    });
    expect(init.status).toBe(200);

    const obs = await fetch(`${baseUrl}/api/sessions/observations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contentSessionId,
        tool_name: "Read",
        tool_input: { file_path: "/tmp/project/.session-memory/meta.json" },
        tool_response: { output: "{}" },
        cwd: "/tmp/project"
      })
    });
    const body = await obs.json();
    expect(obs.status).toBe(200);
    expect(body.status).toBe("skipped");
    expect(body.reason).toBe("session_memory_meta");
  });

  test("search supports format=json and filters", async () => {
    const url = `${baseUrl}/api/search?format=json&query=hello&type=observations,bugfix&obs_type=decision&dateStart=2020-01-01&dateEnd=2100-01-01`;
    const res = await fetch(url);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(typeof body.searchMode).toBe("string");
    expect(Array.isArray(body.observations)).toBe(true);
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(Array.isArray(body.prompts)).toBe(true);
  });

  test("pending queue process endpoint is available", async () => {
    const res = await fetch(`${baseUrl}/api/pending-queue/process`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(typeof body.resetCount).toBe("number");
    expect(typeof body.processedSessions).toBe("number");
  });

  test("retention cleanup supports dry-run and execution", async () => {
    const project = "contract-retention-project";
    const save = await fetch(`${baseUrl}/api/memory/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project,
        title: "old memory",
        text: "this should be expired by retention"
      })
    });
    expect(save.status).toBe(200);

    const now = Date.now();
    const oldEpoch = now - 40 * 24 * 60 * 60 * 1000;
    const db = new Database(path.join(dataDir, "codexmem.db"), { create: false, readwrite: true });
    db.query("UPDATE observations SET created_at_epoch = ?, last_accessed_at_epoch = ? WHERE project = ?").run(oldEpoch, oldEpoch, project);
    db.query("INSERT OR REPLACE INTO project_memory_activity (project, last_accessed_at_epoch, updated_at_epoch) VALUES (?, ?, ?)")
      .run(project, oldEpoch, oldEpoch);
    db.close();

    const dryRunRes = await fetch(`${baseUrl}/api/ops/retention/cleanup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dryRun: true })
    });
    const dryRunBody = await dryRunRes.json();
    expect(dryRunRes.status).toBe(200);
    expect(dryRunBody.success).toBe(true);
    expect(dryRunBody.report?.dryRun).toBe(true);
    expect(dryRunBody.report?.softDeleted?.projects >= 1).toBe(true);

    const execRes = await fetch(`${baseUrl}/api/ops/retention/cleanup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dryRun: false })
    });
    const execBody = await execRes.json();
    expect(execRes.status).toBe(200);
    expect(execBody.success).toBe(true);
    expect(execBody.report?.dryRun).toBe(false);

    const obsList = await fetch(`${baseUrl}/api/observations?project=${encodeURIComponent(project)}&limit=20&offset=0`);
    const obsListBody = await obsList.json();
    expect(obsList.status).toBe(200);
    expect(Array.isArray(obsListBody.observations)).toBe(true);
    expect(obsListBody.observations.length).toBe(0);
  });

  test("chroma backend unavailable degrades without 5xx", async () => {
    const setRes = await fetch(`${baseUrl}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        CODEXMEM_VECTOR_BACKEND: "chroma",
        CODEXMEM_CHROMA_URL: "http://127.0.0.1:65530",
        CODEXMEM_CHROMA_COLLECTION: "contract_test"
      })
    });
    expect(setRes.status).toBe(200);

    const res = await fetch(`${baseUrl}/api/search?format=json&query=anything&project=contract-project`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(Array.isArray(body.observations)).toBe(true);
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(Array.isArray(body.prompts)).toBe(true);
  });

  test("mcp toggle and status", async () => {
    const s1 = await fetch(`${baseUrl}/api/mcp/status`);
    const b1 = await s1.json();
    expect(s1.status).toBe(200);
    expect(typeof b1.enabled).toBe("boolean");

    const toggle = await fetch(`${baseUrl}/api/mcp/toggle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false })
    });
    const tb = await toggle.json();
    expect(toggle.status).toBe(200);
    expect(tb.enabled).toBe(false);

    const s2 = await fetch(`${baseUrl}/api/mcp/status`);
    const b2 = await s2.json();
    expect(s2.status).toBe(200);
    expect(b2.enabled).toBe(false);
  });

  test("agent metrics endpoints are available", async () => {
    const reset = await fetch(`${baseUrl}/api/ops/agent-metrics/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(reset.status).toBe(200);

    const init = await fetch(`${baseUrl}/api/sessions/init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contentSessionId: "contract-sess-metrics-1",
        project: "contract-project-metrics",
        prompt: "metrics prompt"
      })
    });
    expect(init.status).toBe(200);

    const obs = await fetch(`${baseUrl}/api/sessions/observations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contentSessionId: "contract-sess-metrics-1",
        tool_name: "Read",
        tool_input: { file: "a.ts" },
        tool_response: { ok: true },
        cwd: "/tmp/metrics"
      })
    });
    expect(obs.status).toBe(200);

    const metricsRes = await fetch(`${baseUrl}/api/ops/agent-metrics`);
    const metricsBody = await metricsRes.json();
    expect(metricsRes.status).toBe(200);
    expect(typeof metricsBody.metrics?.observation?.fallback_used).toBe("number");
    expect(typeof metricsBody.metrics?.summary?.fallback_used).toBe("number");
  });

  test("duplicate observation/summarize payloads are deduped", async () => {
    const contentSessionId = "contract-sess-dedupe-1";
    const project = "contract-project-dedupe";
    const init = await fetch(`${baseUrl}/api/sessions/init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contentSessionId,
        project,
        prompt: "dedupe test prompt"
      })
    });
    expect(init.status).toBe(200);

    const obsPayload = {
      contentSessionId,
      tool_name: "Read",
      tool_input: { file: "a.ts" },
      tool_response: { ok: true },
      cwd: "/tmp/dedupe"
    };

    const obs1 = await fetch(`${baseUrl}/api/sessions/observations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(obsPayload)
    });
    const obs1Body = await obs1.json();
    expect(obs1.status).toBe(200);
    expect(obs1Body.status).toBe("queued");

    const obs2 = await fetch(`${baseUrl}/api/sessions/observations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(obsPayload)
    });
    const obs2Body = await obs2.json();
    expect(obs2.status).toBe(200);
    expect(obs2Body.status).toBe("deduped");

    const obsList = await fetch(`${baseUrl}/api/observations?project=${encodeURIComponent(project)}&limit=20&offset=0`);
    const obsListBody = await obsList.json();
    expect(obsList.status).toBe(200);
    expect(Array.isArray(obsListBody.observations)).toBe(true);
    expect(obsListBody.observations.length).toBe(1);

    const sumPayload = {
      contentSessionId,
      last_assistant_message: "done"
    };
    const sum1 = await fetch(`${baseUrl}/api/sessions/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sumPayload)
    });
    const sum1Body = await sum1.json();
    expect(sum1.status).toBe(200);
    expect(sum1Body.status).toBe("queued");

    const sum2 = await fetch(`${baseUrl}/api/sessions/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sumPayload)
    });
    const sum2Body = await sum2.json();
    expect(sum2.status).toBe(200);
    expect(sum2Body.status).toBe("deduped");

    const sumList = await fetch(`${baseUrl}/api/summaries?project=${encodeURIComponent(project)}&limit=20&offset=0`);
    const sumListBody = await sumList.json();
    expect(sumList.status).toBe(200);
    expect(Array.isArray(sumListBody.summaries)).toBe(true);
    expect(sumListBody.summaries.length).toBe(1);
  });
});
