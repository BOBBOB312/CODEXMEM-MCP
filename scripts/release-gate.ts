import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

function usage(): void {
  console.log(
    [
      "Usage:",
      "  bun run scripts/release-gate.ts --baseline-observations <file> --candidate-observations <file>",
      "                                  --baseline-search <file> --candidate-search <file>",
      "                                  [--topn 10] [--min-recall 0.95]",
      "                                  [--max-count-delta-ratio 0.05]",
      "                                  [--max-project-dist-delta-ratio 0.2] [--max-type-dist-delta-ratio 0.2]",
      "                                  [--bench-rows 10000] [--bench-runs 60] [--bench-batch-size 50]",
      "                                  [--search-p95-max 300] [--batch-p95-max 500]",
      "                                  [--soak-duration-sec 86400] [--soak-interval-sec 10] [--soak-seed-rows 2000]",
      "                                  [--soak-max-rss-growth-kb 262144] [--skip-soak]",
      "                                  [--output ./release-gate-report.json]"
    ].join("\n")
  );
}

async function runCommand(cmd: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  return { exitCode, stdout, stderr };
}

function distMaxDeltaRatio(rows: Array<{ baseline: number; candidate: number; delta: number }>): number {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  let max = 0;
  for (const row of rows) {
    const baseline = Number(row.baseline || 0);
    const candidate = Number(row.candidate || 0);
    const delta = Math.abs(Number(row.delta || 0));
    let ratio = 0;
    if (baseline <= 0) {
      ratio = candidate > 0 ? 1 : 0;
    } else {
      ratio = delta / baseline;
    }
    if (ratio > max) max = ratio;
  }
  return Number(max.toFixed(4));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args["help"] === "true") {
    usage();
    return;
  }

  const baselineObs = args["baseline-observations"];
  const candidateObs = args["candidate-observations"];
  const baselineSearch = args["baseline-search"];
  const candidateSearch = args["candidate-search"];
  if (!baselineObs || !candidateObs || !baselineSearch || !candidateSearch) {
    usage();
    process.exit(2);
  }

  const topn = Number(args["topn"] || 10);
  const minRecall = Number(args["min-recall"] || 0.95);
  const maxCountDeltaRatio = Number(args["max-count-delta-ratio"] || 0.05);
  const maxProjectDistDeltaRatio = Number(args["max-project-dist-delta-ratio"] || 0.2);
  const maxTypeDistDeltaRatio = Number(args["max-type-dist-delta-ratio"] || 0.2);
  const searchP95Max = Number(args["search-p95-max"] || 300);
  const batchP95Max = Number(args["batch-p95-max"] || 500);
  const soakDurationSec = Number(args["soak-duration-sec"] || 86400);
  const soakIntervalSec = Number(args["soak-interval-sec"] || 10);
  const soakSeedRows = Number(args["soak-seed-rows"] || 2000);
  const soakMaxRssGrowthKb = Number(args["soak-max-rss-growth-kb"] || 262144);
  const skipSoak = args["skip-soak"] === "true";
  const outputPath = args["output"] ? path.resolve(args["output"]) : "";

  const cwd = path.resolve(path.join(import.meta.dir, ".."));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexmem-gate-"));
  const parityOut = path.join(tmpDir, "parity.json");
  const benchmarkOut = path.join(tmpDir, "benchmark.json");
  const soakOut = path.join(tmpDir, "soak.json");

  try {
    const parityRun = await runCommand(
      [
        process.execPath,
        "run",
        "scripts/parity-report.ts",
        "--baseline",
        path.resolve(baselineObs),
        "--candidate",
        path.resolve(candidateObs),
        "--baseline-search",
        path.resolve(baselineSearch),
        "--candidate-search",
        path.resolve(candidateSearch),
        "--topn",
        String(topn),
        "--min-recall",
        String(minRecall),
        "--output",
        parityOut
      ],
      cwd
    );
    if (!fs.existsSync(parityOut)) {
      throw new Error(`parity report missing: ${parityRun.stderr || parityRun.stdout}`);
    }
    const parityReport = JSON.parse(fs.readFileSync(parityOut, "utf-8")) as any;
    const countBaseline = Number(parityReport?.summary?.observationCount?.baseline || 0);
    const countDelta = Math.abs(Number(parityReport?.summary?.observationCount?.delta || 0));
    const countDeltaRatio = countBaseline > 0 ? countDelta / countBaseline : 0;
    const projectDistDeltaRatio = distMaxDeltaRatio(parityReport?.distributions?.project || []);
    const typeDistDeltaRatio = distMaxDeltaRatio(parityReport?.distributions?.type || []);
    const parityPass =
      parityReport?.summary?.passed === true &&
      countDeltaRatio <= maxCountDeltaRatio &&
      projectDistDeltaRatio <= maxProjectDistDeltaRatio &&
      typeDistDeltaRatio <= maxTypeDistDeltaRatio;

    const benchRun = await runCommand(
      [
        process.execPath,
        "run",
        "scripts/benchmark.ts",
        "--rows",
        String(Math.max(100, Number(args["bench-rows"] || 10000))),
        "--runs",
        String(Math.max(10, Number(args["bench-runs"] || 60))),
        "--batch-size",
        String(Math.max(1, Number(args["bench-batch-size"] || 50))),
        "--search-p95-max",
        String(searchP95Max),
        "--batch-p95-max",
        String(batchP95Max),
        "--output",
        benchmarkOut
      ],
      cwd
    );
    if (!fs.existsSync(benchmarkOut)) {
      throw new Error(`benchmark report missing: ${benchRun.stderr || benchRun.stdout}`);
    }
    const benchmarkReport = JSON.parse(fs.readFileSync(benchmarkOut, "utf-8")) as any;

    let soakReport: any = null;
    let soakPass = true;
    if (!skipSoak) {
      const soakRun = await runCommand(
        [
          process.execPath,
          "run",
          "scripts/soak.ts",
          "--duration-sec",
          String(soakDurationSec),
          "--interval-sec",
          String(soakIntervalSec),
          "--seed-rows",
          String(soakSeedRows),
          "--max-rss-growth-kb",
          String(soakMaxRssGrowthKb),
          "--output",
          soakOut
        ],
        cwd
      );
      if (!fs.existsSync(soakOut)) {
        throw new Error(`soak report missing: ${soakRun.stderr || soakRun.stdout}`);
      }
      soakReport = JSON.parse(fs.readFileSync(soakOut, "utf-8"));
      soakPass = soakReport?.summary?.passed === true;
    }

    const passed = parityPass && benchmarkReport?.pass === true && soakPass;
    const finalReport = {
      generatedAt: new Date().toISOString(),
      thresholds: {
        minRecall,
        maxCountDeltaRatio,
        maxProjectDistDeltaRatio,
        maxTypeDistDeltaRatio,
        searchP95Max,
        batchP95Max,
        soakDurationSec: skipSoak ? 0 : soakDurationSec,
        soakIntervalSec: skipSoak ? 0 : soakIntervalSec,
        soakSeedRows: skipSoak ? 0 : soakSeedRows,
        soakMaxRssGrowthKb: skipSoak ? 0 : soakMaxRssGrowthKb
      },
      parity: {
        pass: parityPass,
        avgRecallAtN: Number(parityReport?.summary?.avgRecallAtN || 0),
        countDeltaRatio: Number(countDeltaRatio.toFixed(4)),
        projectDistDeltaRatio,
        typeDistDeltaRatio,
        raw: parityReport
      },
      benchmark: benchmarkReport,
      soak: skipSoak ? { skipped: true } : soakReport,
      passed
    };

    const text = JSON.stringify(finalReport, null, 2);
    if (outputPath) {
      fs.writeFileSync(outputPath, text, "utf-8");
      console.log(`Report written: ${outputPath}`);
    }
    console.log(text);
    process.exit(passed ? 0 : 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
