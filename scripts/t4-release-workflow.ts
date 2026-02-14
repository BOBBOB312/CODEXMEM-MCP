import fs from "node:fs";
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
      "  bun run scripts/t4-release-workflow.ts --baseline-observations <file> --candidate-observations <file>",
      "                                        --baseline-search <file> --candidate-search <file>",
      "                                        [--reports-root ./artifacts/p5/reports]",
      "                                        [--run-tests true|false] [--skip-soak true|false]",
      "                                        [--min-recall 0.95] [--search-p95-max 300] [--batch-p95-max 500]"
    ].join("\n")
  );
}

function timestampForPath(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
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

function boolArg(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return defaultValue;
}

function writeText(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf-8");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === "true") {
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

  const reportsRoot = path.resolve(args["reports-root"] || "./artifacts/p5/reports");
  const runDir = path.join(reportsRoot, timestampForPath());
  fs.mkdirSync(runDir, { recursive: true });

  const runTests = boolArg(args["run-tests"], true);
  const skipSoak = boolArg(args["skip-soak"], false);
  const minRecall = Number(args["min-recall"] || 0.95);
  const searchP95Max = Number(args["search-p95-max"] || 300);
  const batchP95Max = Number(args["batch-p95-max"] || 500);
  const cwd = path.resolve(path.join(import.meta.dir, ".."));

  const summaryPath = path.join(runDir, "summary.json");
  const gateReportPath = path.join(runDir, "release-gate-report.json");
  const testLogPath = path.join(runDir, "test.log");
  const gateLogPath = path.join(runDir, "release-gate.log");
  const remediationPath = path.join(runDir, "remediation.md");

  const summary: any = {
    generatedAt: new Date().toISOString(),
    runDir,
    inputs: {
      baselineObservations: path.resolve(baselineObs),
      candidateObservations: path.resolve(candidateObs),
      baselineSearch: path.resolve(baselineSearch),
      candidateSearch: path.resolve(candidateSearch)
    },
    thresholds: {
      minRecall,
      searchP95Max,
      batchP95Max,
      skipSoak
    },
    steps: []
  };

  let allPassed = true;

  if (runTests) {
    const testRun = await runCommand([process.execPath, "test"], cwd);
    writeText(testLogPath, `${testRun.stdout}\n\n${testRun.stderr}`);
    summary.steps.push({
      name: "bun test",
      exitCode: testRun.exitCode,
      log: path.relative(runDir, testLogPath)
    });
    if (testRun.exitCode !== 0) {
      allPassed = false;
    }
  } else {
    summary.steps.push({
      name: "bun test",
      skipped: true
    });
  }

  const gateArgs = [
    process.execPath,
    "run",
    "scripts/release-gate.ts",
    "--baseline-observations",
    path.resolve(baselineObs),
    "--candidate-observations",
    path.resolve(candidateObs),
    "--baseline-search",
    path.resolve(baselineSearch),
    "--candidate-search",
    path.resolve(candidateSearch),
    "--min-recall",
    String(minRecall),
    "--search-p95-max",
    String(searchP95Max),
    "--batch-p95-max",
    String(batchP95Max),
    "--output",
    gateReportPath
  ];
  if (skipSoak) {
    gateArgs.push("--skip-soak");
  }

  const gateRun = await runCommand(gateArgs, cwd);
  writeText(gateLogPath, `${gateRun.stdout}\n\n${gateRun.stderr}`);
  summary.steps.push({
    name: "release-gate",
    exitCode: gateRun.exitCode,
    report: path.relative(runDir, gateReportPath),
    log: path.relative(runDir, gateLogPath)
  });
  if (gateRun.exitCode !== 0) {
    allPassed = false;
  }

  if (!allPassed) {
    writeText(
      remediationPath,
      [
        "# 发布失败修复记录",
        "",
        `- 运行目录：${runDir}`,
        `- 失败时间：${new Date().toISOString()}`,
        "",
        "## 失败项",
        "- [ ] bun test",
        "- [ ] release-gate",
        "",
        "## 根因分析",
        "- ",
        "",
        "## 修复动作",
        "1. ",
        "",
        "## 复测结果",
        "1. 命令：",
        "2. 结果：",
        "",
        "## 结论",
        "- [ ] 可以发布",
        "- [ ] 继续修复"
      ].join("\n")
    );
    summary.remediation = path.relative(runDir, remediationPath);
  }

  summary.passed = allPassed;
  writeText(summaryPath, JSON.stringify(summary, null, 2));

  console.log(JSON.stringify(summary, null, 2));
  if (!allPassed) {
    console.error(`Release workflow failed. See: ${runDir}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});

