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

async function waitForHealth(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      // worker not ready yet
    }
    await Bun.sleep(200);
  }
  throw new Error("Worker health check timeout");
}

function readRssKb(pid: number): number {
  try {
    const out = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" });
    if (out.exitCode !== 0) return -1;
    const text = out.stdout.toString().trim();
    const rss = Number(text);
    return Number.isFinite(rss) ? rss : -1;
  } catch {
    return -1;
  }
}

function usage(): void {
  console.log(
    [
      "Usage:",
      "  bun run scripts/soak.ts [--duration-sec 86400] [--interval-sec 10] [--seed-rows 2000]",
      "                          [--max-rss-growth-kb 262144] [--output ./soak-report.json]",
      "",
      "Notes:",
      "  - 默认 24 小时（86400 秒）",
      "  - max-rss-growth-kb 默认 256MB（262144 KB）"
    ].join("\n")
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args["help"] === "true") {
    usage();
    return;
  }

  const durationSec = Math.max(10, Number(args["duration-sec"] || 86400));
  const intervalSec = Math.max(1, Number(args["interval-sec"] || 10));
  const seedRows = Math.max(100, Number(args["seed-rows"] || 2000));
  const maxGrowthKb = Math.max(1, Number(args["max-rss-growth-kb"] || 262144));
  const output = args["output"] ? path.resolve(args["output"]) : "";

  const port = 41000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexmem-soak-"));
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

  const store = new Store(dbPath);
  const sid = store.createSDKSession("soak-sess", "soak-project", "soak");
  const mid = `cmem-${sid}`;
  store.ensureMemorySessionIdRegistered(sid, mid);
  for (let i = 0; i < seedRows; i++) {
    store.storeObservation(
      mid,
      "soak-project",
      {
        type: i % 2 === 0 ? "execution" : "bugfix",
        title: `Soak #${i}`,
        subtitle: null,
        facts: [`f${i}`],
        narrative: `soak narrative ${i} keyword-${i % 50}`,
        concepts: [`c${i % 20}`],
        files_read: [`src/read-${i % 80}.ts`],
        files_modified: [`src/mod-${i % 40}.ts`]
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

  const samples: Array<{
    ts: string;
    rssKb: number;
    healthUptimeMs: number;
    searchLatencyMs: number;
    searchOk: boolean;
    statsOk: boolean;
  }> = [];

  try {
    await waitForHealth(baseUrl);
    const start = Date.now();
    const endAt = start + durationSec * 1000;

    while (Date.now() < endAt) {
      const ts = new Date().toISOString();
      const rssKb = readRssKb(worker.pid);

      let healthUptimeMs = -1;
      let searchLatencyMs = -1;
      let searchOk = false;
      let statsOk = false;

      try {
        const healthRes = await fetch(`${baseUrl}/api/health`);
        if (healthRes.ok) {
          const body = (await healthRes.json()) as any;
          healthUptimeMs = Number(body?.uptime ?? -1);
        }
      } catch {
        // ignore per-sample errors
      }

      try {
        const t0 = performance.now();
        const searchRes = await fetch(`${baseUrl}/api/search?query=keyword-1&project=soak-project&limit=20`);
        searchLatencyMs = performance.now() - t0;
        searchOk = searchRes.ok;
        await searchRes.text();
      } catch {
        // ignore per-sample errors
      }

      try {
        const statsRes = await fetch(`${baseUrl}/api/stats`);
        statsOk = statsRes.ok;
        await statsRes.text();
      } catch {
        // ignore per-sample errors
      }

      samples.push({
        ts,
        rssKb,
        healthUptimeMs,
        searchLatencyMs: Number(searchLatencyMs.toFixed(2)),
        searchOk,
        statsOk
      });

      await Bun.sleep(intervalSec * 1000);
    }

    const validRss = samples.map((x) => x.rssKb).filter((x) => x > 0);
    const firstRss = validRss.length > 0 ? validRss[0] : -1;
    const lastRss = validRss.length > 0 ? validRss[validRss.length - 1] : -1;
    const rssGrowthKb = firstRss > 0 && lastRss > 0 ? lastRss - firstRss : -1;
    const searchLatencies = samples.map((x) => x.searchLatencyMs).filter((x) => x >= 0);
    const failedSamples = samples.filter((x) => !x.searchOk || !x.statsOk).length;
    const searchP95 = percentile(searchLatencies, 95);

    const passed = rssGrowthKb >= 0 && rssGrowthKb <= maxGrowthKb && failedSamples === 0;
    const report = {
      config: {
        durationSec,
        intervalSec,
        seedRows,
        maxGrowthKb
      },
      summary: {
        sampleCount: samples.length,
        failedSamples,
        firstRssKb: firstRss,
        lastRssKb: lastRss,
        rssGrowthKb,
        searchP95Ms: Number(searchP95.toFixed(2)),
        passed
      },
      samples
    };

    const text = JSON.stringify(report, null, 2);
    if (output) {
      fs.writeFileSync(output, text, "utf-8");
      console.log(`Report written: ${output}`);
    }
    console.log(text);
    process.exit(passed ? 0 : 1);
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
