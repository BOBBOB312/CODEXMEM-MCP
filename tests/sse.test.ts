import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let worker: ReturnType<typeof Bun.spawn> | null = null;
let baseUrl = "";
let dataDir = "";

setDefaultTimeout(30_000);

function randomPort(): number {
  return 40000 + Math.floor(Math.random() * 2000);
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
    await Bun.sleep(120);
  }
  throw new Error("Worker health check timeout");
}

type SseEvent = { event: string; data: any };

function createSseReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  async function readEvent(timeoutMs = 8_000): Promise<SseEvent> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE stream ended unexpectedly");
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const idx = buffer.indexOf("\n\n");
        if (idx < 0) break;

        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const lines = block.split("\n");
        let event = "";
        let dataRaw = "";
        for (const line of lines) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) event = line.slice(6).trim();
          if (line.startsWith("data:")) dataRaw += line.slice(5).trim();
        }

        if (!event) continue;
        let data: any = null;
        if (dataRaw) {
          try {
            data = JSON.parse(dataRaw);
          } catch {
            data = dataRaw;
          }
        }
        return { event, data };
      }
    }
    throw new Error("SSE read timeout");
  }

  return { readEvent };
}

beforeAll(async () => {
  const port = randomPort();
  baseUrl = `http://127.0.0.1:${port}`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexmem-sse-"));
  fs.writeFileSync(
    path.join(dataDir, "settings.json"),
    JSON.stringify(
      {
        CODEXMEM_WORKER_HOST: "127.0.0.1",
        CODEXMEM_WORKER_PORT: String(port),
        CODEXMEM_PROVIDER: "rule-based",
        CODEXMEM_VECTOR_BACKEND: "sqlite",
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

describe("sse + ops", () => {
  test("sse emits queue.depth and session.status", async () => {
    const response = await fetch(`${baseUrl}/api/events`);
    expect(response.status).toBe(200);
    expect(response.body).toBeTruthy();
    const reader = createSseReader(response.body!);

    const first = await reader.readEvent();
    expect(first.event).toBe("queue.depth");
    expect(typeof first.data.queueDepth).toBe("number");

    const initRes = await fetch(`${baseUrl}/api/sessions/init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contentSessionId: "sse-sess-1",
        project: "sse-project",
        prompt: "hello"
      })
    });
    expect(initRes.status).toBe(200);

    let sawSessionEvent = false;
    for (let i = 0; i < 4; i++) {
      const evt = await reader.readEvent();
      if (evt.event === "session.status" && evt.data?.sessionDbId) {
        sawSessionEvent = true;
        break;
      }
    }
    expect(sawSessionEvent).toBe(true);
  });

  test("ops endpoints available", async () => {
    const init = await fetch(`${baseUrl}/api/sessions/init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contentSessionId: "sse-timing-sess-1",
        project: "sse-project",
        prompt: "hello trace"
      })
    });
    expect(init.status).toBe(200);
    const obs = await fetch(`${baseUrl}/api/sessions/observations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contentSessionId: "sse-timing-sess-1",
        tool_name: "Read",
        tool_input: { file: "x.ts" },
        tool_response: { ok: true },
        cwd: "/tmp/sse"
      })
    });
    expect(obs.status).toBe(200);
    const search = await fetch(`${baseUrl}/api/search?format=json&query=hello&project=sse-project`);
    expect(search.status).toBe(200);

    const indexStatus = await fetch(`${baseUrl}/api/ops/index-status`);
    const indexBody = await indexStatus.json();
    expect(indexStatus.status).toBe(200);
    expect(typeof indexBody.backend).toBe("string");
    expect(typeof indexBody.sqlite?.enabled).toBe("boolean");
    expect(typeof indexBody.chroma?.enabled).toBe("boolean");

    const backfill = await fetch(`${baseUrl}/api/ops/backfill/chroma`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 20 })
    });
    const backfillBody = await backfill.json();
    expect(backfill.status).toBe(200);
    expect(backfillBody.success).toBe(true);
    expect(typeof backfillBody.skipped).toBe("boolean");

    const traces = await fetch(`${baseUrl}/api/ops/search-traces?limit=5`);
    const tracesBody = await traces.json();
    expect(traces.status).toBe(200);
    expect(Array.isArray(tracesBody.traces)).toBe(true);
    expect(typeof tracesBody.total).toBe("number");

    const timings = await fetch(`${baseUrl}/api/ops/session-timings?limit=10`);
    const timingsBody = await timings.json();
    expect(timings.status).toBe(200);
    expect(Array.isArray(timingsBody.timings)).toBe(true);
    expect(typeof timingsBody.aggregate?.avgTotalMs).toBe("number");

    const failures = await fetch(`${baseUrl}/api/ops/failure-summary?limit=5`);
    const failuresBody = await failures.json();
    expect(failures.status).toBe(200);
    expect(typeof failuresBody.summary?.total).toBe("number");
    expect(Array.isArray(failuresBody.recent)).toBe(true);

    const traceExport = await fetch(`${baseUrl}/api/ops/search-traces/export?format=ndjson&query=hello`);
    expect(traceExport.status).toBe(200);
    expect((traceExport.headers.get("content-type") || "").includes("application/x-ndjson")).toBe(true);

    const timingExport = await fetch(`${baseUrl}/api/ops/session-timings/export?format=csv&sessionDbId=1`);
    expect(timingExport.status).toBe(200);
    expect((timingExport.headers.get("content-type") || "").includes("text/csv")).toBe(true);

    const failureExport = await fetch(`${baseUrl}/api/ops/failure-summary/export?format=ndjson`);
    expect(failureExport.status).toBe(200);
    expect((failureExport.headers.get("content-type") || "").includes("application/x-ndjson")).toBe(true);

    const trends = await fetch(`${baseUrl}/api/ops/trends?windowSec=600&bucketSec=60`);
    const trendsBody = await trends.json();
    expect(trends.status).toBe(200);
    expect(Array.isArray(trendsBody.buckets)).toBe(true);
  });
});
