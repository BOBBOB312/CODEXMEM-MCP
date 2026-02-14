import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/db/store.js";

type Args = Record<string, string>;

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

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function waitForHealth(baseUrl: string, timeoutMs = 25_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await Bun.sleep(150);
  }
  throw new Error("Worker health check timeout");
}

async function measureGet(url: string, runs: number): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Request failed (${res.status}): ${url}`);
    }
    await res.text();
    samples.push(performance.now() - t0);
  }
  return samples;
}

function usage(): void {
  console.log(
    [
      "Usage:",
      "  bun run scripts/benchmark.ts [--rows 10000] [--runs 60] [--batch-size 50]",
      "                              [--search-p95-max 300] [--batch-p95-max 500] [--output ./benchmark-report.json]",
      "",
      "Exit code:",
      "  0 if all thresholds pass, 1 otherwise"
    ].join("\n")
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args["help"] === "true") {
    usage();
    return;
  }

  const rows = Math.max(100, Number(args["rows"] || 10000));
  const runs = Math.max(10, Number(args["runs"] || 60));
  const batchSize = Math.max(1, Number(args["batch-size"] || 50));
  const searchP95Max = Number(args["search-p95-max"] || 300);
  const batchP95Max = Number(args["batch-p95-max"] || 500);
  const output = args["output"] ? path.resolve(args["output"]) : "";

  const port = 40000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexmem-bench-"));
  const dbPath = path.join(dataDir, "codexmem.db");
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

  // seed sqlite directly for stable benchmark data
  const store = new Store(dbPath);
  const sid = store.createSDKSession("bench-sess", "bench-project", "benchmark");
  const mid = `cmem-${sid}`;
  store.ensureMemorySessionIdRegistered(sid, mid);
  for (let i = 0; i < rows; i++) {
    store.storeObservation(
      mid,
      "bench-project",
      {
        type: i % 3 === 0 ? "bugfix" : i % 3 === 1 ? "decision" : "execution",
        title: `Bench observation #${i}`,
        subtitle: `subtitle ${i % 10}`,
        facts: [`fact-${i}`, `issue-${i % 20}`],
        narrative: `narrative for benchmark row ${i} query-keyword-${i % 25}`,
        concepts: [`concept-${i % 15}`],
        files_read: [`src/file-${i % 100}.ts`],
        files_modified: [`src/mod-${i % 50}.ts`]
      },
      1
    );
  }
  store.close();

  const worker = Bun.spawn([process.execPath, "run", "src/worker/server.ts"], {
    cwd: path.resolve(path.join(import.meta.dir, "..")),
    env: { ...process.env, CODEXMEM_DATA_DIR: dataDir },
    stdout: "pipe",
    stderr: "pipe"
  });

  try {
    await waitForHealth(baseUrl);

    // warmup
    await fetch(`${baseUrl}/api/search?query=query-keyword-1&project=bench-project&limit=20`);
    await fetch(`${baseUrl}/api/observations/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: Array.from({ length: batchSize }, (_, x) => x + 1) })
    });

    const searchSamples = await measureGet(
      `${baseUrl}/api/search?query=query-keyword-1&project=bench-project&limit=20`,
      runs
    );

    const batchSamples: number[] = [];
    const ids = Array.from({ length: batchSize }, (_, x) => x + 1);
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      const res = await fetch(`${baseUrl}/api/observations/batch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids, orderBy: "date_desc", limit: batchSize, project: "bench-project" })
      });
      if (!res.ok) {
        throw new Error(`Batch request failed (${res.status})`);
      }
      await res.text();
      batchSamples.push(performance.now() - t0);
    }

    const searchP95 = percentile(searchSamples, 95);
    const batchP95 = percentile(batchSamples, 95);
    const pass = searchP95 < searchP95Max && batchP95 < batchP95Max;

    const report = {
      rows,
      runs,
      thresholds: {
        searchP95Max,
        batchP95Max
      },
      metrics: {
        searchP95: Number(searchP95.toFixed(2)),
        batchP95: Number(batchP95.toFixed(2))
      },
      pass
    };
    const text = JSON.stringify(report, null, 2);
    if (output) {
      fs.writeFileSync(output, text, "utf-8");
      console.log(`Report written: ${output}`);
    }
    console.log(text);

    process.exit(pass ? 0 : 1);
  } finally {
    worker.kill();
    await worker.exited;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
