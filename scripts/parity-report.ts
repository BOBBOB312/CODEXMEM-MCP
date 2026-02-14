import fs from "node:fs";
import path from "node:path";

type ObservationRow = {
  id?: number;
  project?: string;
  type?: string;
};

type SearchEntry = {
  query: string;
  ids: number[];
};

function readJson(filePath: string): any {
  const abs = path.resolve(filePath);
  return JSON.parse(fs.readFileSync(abs, "utf-8"));
}

function toObservations(raw: any): ObservationRow[] {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.observations)) return raw.observations;
  if (Array.isArray(raw?.items)) return raw.items;
  return [];
}

function toDistribution(rows: ObservationRow[], key: "project" | "type"): Record<string, number> {
  const map: Record<string, number> = {};
  for (const row of rows) {
    const k = String((row as any)?.[key] || "(empty)");
    map[k] = (map[k] || 0) + 1;
  }
  return map;
}

function compareDistribution(
  baseline: Record<string, number>,
  candidate: Record<string, number>
): Array<{ key: string; baseline: number; candidate: number; delta: number }> {
  const keys = Array.from(new Set([...Object.keys(baseline), ...Object.keys(candidate)])).sort();
  return keys.map((k) => ({
    key: k,
    baseline: baseline[k] || 0,
    candidate: candidate[k] || 0,
    delta: (candidate[k] || 0) - (baseline[k] || 0)
  }));
}

function parseSearchEntries(raw: any): SearchEntry[] {
  if (!raw) return [];
  if (Array.isArray(raw?.searches)) {
    return raw.searches
      .map((x: any) => ({
        query: String(x?.query || "").trim(),
        ids: Array.isArray(x?.ids) ? x.ids.filter((id: any) => Number.isInteger(id)) : []
      }))
      .filter((x) => x.query);
  }

  // 支持 { "query text": [1,2,3] } 结构
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const entries: SearchEntry[] = [];
    for (const [query, ids] of Object.entries(raw)) {
      if (!Array.isArray(ids)) continue;
      entries.push({
        query: String(query).trim(),
        ids: ids.filter((id) => Number.isInteger(id)) as number[]
      });
    }
    return entries.filter((x) => x.query);
  }
  return [];
}

function recallAtN(baselineIds: number[], candidateIds: number[], n: number): number {
  const b = baselineIds.slice(0, n);
  if (b.length === 0) return 1;
  const cset = new Set(candidateIds.slice(0, n));
  let hit = 0;
  for (const id of b) {
    if (cset.has(id)) hit++;
  }
  return hit / b.length;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      out[key] = "true";
      continue;
    }
    out[key] = value;
    i++;
  }
  return out;
}

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  bun run scripts/parity-report.ts --baseline <file> --candidate <file> [--baseline-search <file> --candidate-search <file>] [--topn 10] [--min-recall 0.95] [--output ./parity-report.json]",
      "",
      "Input observation file formats:",
      "  1) Observation[]",
      "  2) { observations: Observation[] }",
      "  3) { items: Observation[] }",
      "",
      "Input search file formats:",
      "  1) { searches: [{ query: string, ids: number[] }] }",
      "  2) { \"query\": number[] }"
    ].join("\n")
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const baselinePath = args["baseline"];
  const candidatePath = args["candidate"];
  if (!baselinePath || !candidatePath) {
    printUsage();
    process.exit(2);
  }

  const topn = Math.max(1, Number(args["topn"] || 10));
  const minRecall = Number(args["min-recall"] || 0.95);

  const baselineObs = toObservations(readJson(baselinePath));
  const candidateObs = toObservations(readJson(candidatePath));

  const countBaseline = baselineObs.length;
  const countCandidate = candidateObs.length;
  const countDelta = countCandidate - countBaseline;

  const projectDist = compareDistribution(
    toDistribution(baselineObs, "project"),
    toDistribution(candidateObs, "project")
  );
  const typeDist = compareDistribution(
    toDistribution(baselineObs, "type"),
    toDistribution(candidateObs, "type")
  );

  let avgRecall = 1;
  let recallRows: Array<{ query: string; recall: number; baselineTopN: number; candidateTopN: number }> = [];

  const baselineSearchPath = args["baseline-search"];
  const candidateSearchPath = args["candidate-search"];
  if (baselineSearchPath && candidateSearchPath) {
    const baselineSearchEntries = parseSearchEntries(readJson(baselineSearchPath));
    const candidateSearchEntries = parseSearchEntries(readJson(candidateSearchPath));
    const candidateMap = new Map(candidateSearchEntries.map((x) => [x.query, x.ids]));

    recallRows = baselineSearchEntries.map((entry) => {
      const cids = candidateMap.get(entry.query) || [];
      return {
        query: entry.query,
        recall: recallAtN(entry.ids, cids, topn),
        baselineTopN: entry.ids.slice(0, topn).length,
        candidateTopN: cids.slice(0, topn).length
      };
    });

    if (recallRows.length > 0) {
      avgRecall = recallRows.reduce((acc, x) => acc + x.recall, 0) / recallRows.length;
    }
  }

  const report = {
    summary: {
      observationCount: {
        baseline: countBaseline,
        candidate: countCandidate,
        delta: countDelta
      },
      topN: topn,
      minRecall,
      avgRecallAtN: Number(avgRecall.toFixed(4)),
      passed: avgRecall >= minRecall
    },
    distributions: {
      project: projectDist,
      type: typeDist
    },
    recall: recallRows
  };

  const text = JSON.stringify(report, null, 2);
  if (args["output"]) {
    const outputPath = path.resolve(args["output"]);
    fs.writeFileSync(outputPath, text, "utf-8");
    console.log(`Report written: ${outputPath}`);
  }
  console.log(text);
  process.exit(report.summary.passed ? 0 : 1);
}

main();
