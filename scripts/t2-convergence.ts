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
      "  bun run scripts/t2-convergence.ts --events <events.json> --queries <queries.json>",
      "                                  --baseline-observations <file> --baseline-search <file>",
      "                                  [--base-url http://127.0.0.1:37777]",
      "                                  [--rounds 3] [--required-consecutive-pass 3]",
      "                                  [--max-recall-regression 0.01]",
      "                                  [--max-search-p95-regression 50] [--max-batch-p95-regression 50]",
      "                                  [--skip-soak] [--output ./t2-convergence-report.json]",
      "",
      "Notes:",
      "  - Each round runs replay:events first, then test:release-gate.",
      "  - Default requires 3 consecutive gate passes with no significant regression trend."
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

function toNum(value: unknown, dft = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : dft;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args["help"] === "true") {
    usage();
    return;
  }

  const events = args["events"];
  const queries = args["queries"];
  const baselineObs = args["baseline-observations"];
  const baselineSearch = args["baseline-search"];
  if (!events || !queries || !baselineObs || !baselineSearch) {
    usage();
    process.exit(2);
  }

  const baseUrl = args["base-url"] || "http://127.0.0.1:37777";
  const rounds = Math.max(1, Number(args["rounds"] || 3));
  const requiredConsecutivePass = Math.max(1, Number(args["required-consecutive-pass"] || 3));
  const maxRecallRegression = Math.max(0, Number(args["max-recall-regression"] || 0.01));
  const maxSearchP95Regression = Math.max(0, Number(args["max-search-p95-regression"] || 50));
  const maxBatchP95Regression = Math.max(0, Number(args["max-batch-p95-regression"] || 50));
  const skipSoak = args["skip-soak"] === "true";
  const output = args["output"] ? path.resolve(args["output"]) : "";

  const cwd = path.resolve(path.join(import.meta.dir, ".."));
  const workspaceTmp = fs.mkdtempSync(path.join(os.tmpdir(), "codexmem-t2-"));
  const candidateDir = path.join(workspaceTmp, "candidate");
  fs.mkdirSync(candidateDir, { recursive: true });

  let consecutivePass = 0;
  const roundReports: Array<any> = [];
  let firstRecall = -1;
  let firstSearchP95 = -1;
  let firstBatchP95 = -1;

  try {
    for (let i = 1; i <= rounds; i++) {
      const replay = await runCommand(
        [
          process.execPath,
          "run",
          "scripts/replay-events.ts",
          "--events",
          path.resolve(events),
          "--queries",
          path.resolve(queries),
          "--base-url",
          baseUrl,
          "--out-dir",
          candidateDir
        ],
        cwd
      );
      if (replay.exitCode !== 0) {
        throw new Error(`round ${i} replay failed: ${replay.stderr || replay.stdout}`);
      }

      const gateOut = path.join(workspaceTmp, `release-gate-round-${i}.json`);
      const gateArgs = [
        process.execPath,
        "run",
        "scripts/release-gate.ts",
        "--baseline-observations",
        path.resolve(baselineObs),
        "--candidate-observations",
        path.join(candidateDir, "candidate-observations.json"),
        "--baseline-search",
        path.resolve(baselineSearch),
        "--candidate-search",
        path.join(candidateDir, "candidate-search.json"),
        "--output",
        gateOut
      ];
      if (skipSoak) gateArgs.push("--skip-soak");

      const gate = await runCommand(gateArgs, cwd);
      if (!fs.existsSync(gateOut)) {
        throw new Error(`round ${i} release-gate report missing: ${gate.stderr || gate.stdout}`);
      }
      const report = JSON.parse(fs.readFileSync(gateOut, "utf-8"));

      const recall = toNum(report?.parity?.avgRecallAtN);
      const searchP95 = toNum(report?.benchmark?.metrics?.searchP95);
      const batchP95 = toNum(report?.benchmark?.metrics?.batchP95);

      if (i === 1) {
        firstRecall = recall;
        firstSearchP95 = searchP95;
        firstBatchP95 = batchP95;
      }

      const recallRegression = firstRecall >= 0 ? Math.max(0, firstRecall - recall) : 0;
      const searchP95Regression = firstSearchP95 >= 0 ? Math.max(0, searchP95 - firstSearchP95) : 0;
      const batchP95Regression = firstBatchP95 >= 0 ? Math.max(0, batchP95 - firstBatchP95) : 0;
      const trendPass =
        recallRegression <= maxRecallRegression &&
        searchP95Regression <= maxSearchP95Regression &&
        batchP95Regression <= maxBatchP95Regression;

      const gatePass = report?.passed === true && gate.exitCode === 0;
      const roundPass = gatePass && trendPass;
      consecutivePass = roundPass ? consecutivePass + 1 : 0;

      roundReports.push({
        round: i,
        gatePass,
        trendPass,
        roundPass,
        consecutivePass,
        recall,
        searchP95,
        batchP95,
        recallRegression: Number(recallRegression.toFixed(4)),
        searchP95Regression: Number(searchP95Regression.toFixed(2)),
        batchP95Regression: Number(batchP95Regression.toFixed(2)),
        gateReport: report
      });
    }

    const passed = consecutivePass >= requiredConsecutivePass;
    const finalReport = {
      generatedAt: new Date().toISOString(),
      config: {
        baseUrl,
        rounds,
        requiredConsecutivePass,
        skipSoak,
        thresholds: {
          maxRecallRegression,
          maxSearchP95Regression,
          maxBatchP95Regression
        }
      },
      summary: {
        consecutivePass,
        passed
      },
      rounds: roundReports
    };

    const text = JSON.stringify(finalReport, null, 2);
    if (output) {
      fs.writeFileSync(output, text, "utf-8");
      console.log(`Report written: ${output}`);
    }
    console.log(text);
    process.exit(passed ? 0 : 1);
  } finally {
    fs.rmSync(workspaceTmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
