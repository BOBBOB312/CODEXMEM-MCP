import { Store } from "../src/db/store.js";
import { ChromaSearchService } from "../src/worker/chroma-search.js";

async function main(): Promise<void> {
  const projectArg = process.argv[2];
  const store = new Store();
  const chroma = new ChromaSearchService();

  if (!chroma.isConfigured()) {
    console.error("Chroma is not configured. Set CODEXMEM_CHROMA_URL/CODEXMEM_CHROMA_COLLECTION and embedding key.");
    process.exit(2);
  }

  const observations = store.db
    .query(`SELECT id, project, title, subtitle, narrative, facts, concepts, created_at_epoch FROM observations ${projectArg ? "WHERE project = ?" : ""}`)
    .all(...(projectArg ? [projectArg] : [])) as any[];
  const summaries = store.db
    .query(
      `SELECT id, project, request, investigated, learned, completed, next_steps, notes, created_at_epoch FROM session_summaries ${projectArg ? "WHERE project = ?" : ""}`
    )
    .all(...(projectArg ? [projectArg] : [])) as any[];
  const prompts = store.db
    .query(
      `SELECT up.id AS id, s.project AS project, up.prompt_text AS prompt_text, up.created_at_epoch AS created_at_epoch
       FROM user_prompts up
       JOIN sdk_sessions s ON s.content_session_id = up.content_session_id
       ${projectArg ? "WHERE s.project = ?" : ""}`
    )
    .all(...(projectArg ? [projectArg] : [])) as any[];

  let obsCount = 0;
  let sumCount = 0;
  let promptCount = 0;

  for (const row of observations) {
    let facts: string[] = [];
    let concepts: string[] = [];
    try {
      const f = JSON.parse(row.facts || "[]");
      if (Array.isArray(f)) facts = f.map((x) => String(x));
    } catch {
      facts = [];
    }
    try {
      const c = JSON.parse(row.concepts || "[]");
      if (Array.isArray(c)) concepts = c.map((x) => String(x));
    } catch {
      concepts = [];
    }
    const text = [
      row.title || "",
      row.subtitle || "",
      row.narrative || "",
      ...facts,
      ...concepts
    ]
      .filter(Boolean)
      .join("\n");
    await chroma.indexObservation(row.id, row.project || "unknown", text, Number(row.created_at_epoch) || Date.now());
    obsCount++;
  }

  for (const row of summaries) {
    const text = [row.request, row.investigated, row.learned, row.completed, row.next_steps, row.notes].filter(Boolean).join("\n");
    await chroma.indexSummary(row.id, row.project || "unknown", text, Number(row.created_at_epoch) || Date.now());
    sumCount++;
  }

  for (const row of prompts) {
    const text = String(row.prompt_text || "");
    if (!text.trim()) continue;
    await chroma.indexPrompt(row.id, row.project || "unknown", text, Number(row.created_at_epoch) || Date.now());
    promptCount++;
  }

  store.close();
  console.log(
    JSON.stringify(
      {
        project: projectArg || null,
        indexed: {
          observations: obsCount,
          summaries: sumCount,
          prompts: promptCount
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
