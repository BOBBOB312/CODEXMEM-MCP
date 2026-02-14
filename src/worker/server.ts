import express, { type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { APP_VERSION, getWorkerHost, getWorkerPort, loadSettings, saveSettings } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import { stripMemoryTagsFromJson, stripMemoryTagsFromPrompt } from "../lib/tag-stripping.js";
import { Store } from "../db/store.js";
import { createAgent } from "../agents/providers.js";
import { agentMetrics } from "../agents/metrics.js";
import { SemanticSearchService } from "./semantic-search.js";
import { ChromaSearchService } from "./chroma-search.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

const store = new Store();
const startAt = Date.now();
let initialized = false;
let mcpReady = false;
const activeSessions = new Set<number>();
const activeAgent = createAgent(loadSettings().CODEXMEM_PROVIDER);
const semanticSearch = new SemanticSearchService();
const chromaSearch = new ChromaSearchService();
let sseEventId = 0;
const sseClients = new Set<Response>();
const MAX_SEARCH_TRACES = 200;
const MAX_SESSION_TIMINGS = 400;
const MAX_FAILURE_RECORDS = 400;
let retentionSweepTimer: ReturnType<typeof setInterval> | null = null;

type SearchTrace = {
  ts: string;
  query: string;
  project?: string;
  limit: number;
  offset: number;
  orderBy?: "relevance" | "date_desc" | "date_asc";
  mode: "lexical-only" | "hybrid";
  lexicalCounts: { observations: number; sessions: number; prompts: number };
  vectorHits: { sqliteObservations: number; chromaObservations: number; chromaSummaries: number; chromaPrompts: number };
  resultCounts: { observations: number; sessions: number; prompts: number };
  durationMs: number;
};

type SessionTiming = {
  ts: string;
  sessionDbId: number;
  messageId: number;
  messageType: "observation" | "summarize";
  queueWaitMs: number;
  modelMs: number;
  indexMs: number;
  totalMs: number;
  success: boolean;
};

type FailureRecord = {
  ts: string;
  sessionDbId: number;
  messageId: number;
  messageType: "observation" | "summarize";
  errorClass: string;
  error: string;
};

const searchTraces: SearchTrace[] = [];
const sessionTimings: SessionTiming[] = [];
const failureRecords: FailureRecord[] = [];

type WorkerStreamEvent =
  | { type: "queue.depth"; pending: number; processing: number; failed: number; queueDepth: number }
  | { type: "session.status"; sessionDbId: number; status: "active" | "idle" | "completed" }
  | { type: "queue.failed"; sessionDbId: number; messageId: number; error: string }
  | { type: "model.result"; sessionDbId: number; messageType: "observation" | "summarize"; status: "success" | "failed"; model: string };

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

function parseLimitOffset(req: Request): { limit: number; offset: number; project?: string } {
  const limit = Math.max(1, Math.min(Number(req.query.limit ?? 20), 100));
  const offset = Math.max(0, Number(req.query.offset ?? 0));
  const project = req.query.project ? String(req.query.project) : undefined;
  return { limit, offset, project };
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v) => String(v).split(",")).map((x) => x.trim()).filter(Boolean);
  }
  if (value === undefined || value === null) return [];
  return String(value).split(",").map((x) => x.trim()).filter(Boolean);
}

function parseEpochInput(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? Math.floor(value * 1000) : Math.floor(value);
  }
  const raw = String(value).trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return undefined;
    return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getVectorBackendMode(): "sqlite" | "chroma" | "hybrid" {
  const raw = (loadSettings().CODEXMEM_VECTOR_BACKEND || "sqlite").toLowerCase();
  if (raw === "chroma" || raw === "hybrid" || raw === "sqlite") return raw;
  return "sqlite";
}

function isSqliteVectorEnabled(): boolean {
  const mode = getVectorBackendMode();
  return mode === "sqlite" || mode === "hybrid";
}

function isChromaVectorEnabled(): boolean {
  const mode = getVectorBackendMode();
  return mode === "chroma" || mode === "hybrid";
}

function composeObservationVectorText(obs: any): string {
  return [
    obs.title || "",
    obs.subtitle || "",
    obs.narrative || "",
    ...(Array.isArray(obs.facts) ? obs.facts : []),
    ...(Array.isArray(obs.concepts) ? obs.concepts : [])
  ]
    .filter(Boolean)
    .join("\n");
}

function composeSummaryVectorText(summary: any): string {
  return [
    summary.request || "",
    summary.investigated || "",
    summary.learned || "",
    summary.completed || "",
    summary.next_steps || "",
    summary.notes || ""
  ]
    .filter(Boolean)
    .join("\n");
}

function mergeRowsWithPriority(priorityRows: any[], lexicalRows: any[], limit: number): any[] {
  const seen = new Set<number>();
  const merged: any[] = [];
  for (const row of [...priorityRows, ...lexicalRows]) {
    if (!row || !Number.isInteger(row.id)) continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
    if (merged.length >= limit) break;
  }
  return merged;
}

function getSkipTools(): Set<string> {
  const settings = loadSettings();
  const raw = settings.CODEXMEM_SKIP_TOOLS || "ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion";
  return new Set(raw.split(",").map((x) => x.trim()).filter(Boolean));
}

function shouldSkipSessionMemoryMetaTool(toolName: string, toolInput: unknown, toolResponse: unknown): boolean {
  const gatedTools = new Set(["Edit", "Write", "Read", "NotebookEdit"]);
  if (!gatedTools.has(toolName)) return false;
  const payload = `${JSON.stringify(toolInput ?? {})}\n${JSON.stringify(toolResponse ?? {})}`.toLowerCase();
  return payload.includes("session-memory");
}

function toStableHash(parts: unknown[]): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(parts));
  return hash.digest("hex");
}

function queueSnapshot(): { pending: number; processing: number; failed: number; queueDepth: number } {
  const counts = store.getQueueCounts();
  return {
    pending: counts.pending,
    processing: counts.processing,
    failed: counts.failed,
    queueDepth: counts.pending + counts.processing
  };
}

function sendSse(res: Response, event: WorkerStreamEvent): void {
  sseEventId += 1;
  res.write(`id: ${sseEventId}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify({ ts: Date.now(), ...event })}\n\n`);
}

function broadcastSse(event: WorkerStreamEvent): void {
  for (const res of sseClients) {
    try {
      sendSse(res, event);
    } catch {
      sseClients.delete(res);
    }
  }
}

function emitQueueDepth(): void {
  broadcastSse({ type: "queue.depth", ...queueSnapshot() });
}

function pushBounded<T>(arr: T[], value: T, max: number): void {
  arr.unshift(value);
  if (arr.length > max) arr.length = max;
}

function classifyError(error: unknown): string {
  const msg = String(error || "").toLowerCase();
  if (!msg) return "unknown";
  if (msg.includes("timeout") || msg.includes("timed out")) return "timeout";
  if (msg.includes("429")) return "rate_limit";
  if (msg.includes("schema")) return "schema";
  if (msg.includes("json")) return "json_parse";
  if (msg.includes("econnrefused") || msg.includes("fetch failed")) return "network";
  if (msg.includes("api key") || msg.includes("unauthorized") || msg.includes("401") || msg.includes("403")) return "auth";
  return "processing";
}

function isTruthySetting(value: string | undefined): boolean {
  const raw = String(value || "").toLowerCase().trim();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

function readRetentionSettings(): {
  enabled: boolean;
  ttlDays: number;
  softDeleteDays: number;
  sweepIntervalMin: number;
} {
  const settings = loadSettings();
  return {
    enabled: isTruthySetting(settings.CODEXMEM_RETENTION_ENABLED ?? "true"),
    ttlDays: Math.max(1, Number(settings.CODEXMEM_RETENTION_TTL_DAYS || "30")),
    softDeleteDays: Math.max(1, Number(settings.CODEXMEM_RETENTION_SOFT_DELETE_DAYS || "7")),
    sweepIntervalMin: Math.max(10, Number(settings.CODEXMEM_RETENTION_SWEEP_INTERVAL_MIN || "1440"))
  };
}

async function runRetentionSweep(dryRun: boolean): Promise<void> {
  const cfg = readRetentionSettings();
  if (!cfg.enabled) return;
  const report = store.runRetentionCleanup({
    dryRun,
    defaultTtlDays: cfg.ttlDays,
    softDeleteDays: cfg.softDeleteDays
  });
  logger.info("RETENTION", dryRun ? "Retention dry-run finished" : "Retention sweep finished", {
    scannedProjects: report.scannedProjects,
    softDeletedProjects: report.softDeleted.projects,
    softDeletedObservations: report.softDeleted.observations,
    hardDeletedObservations: report.hardDeleted.observations
  });
}

function escapeCsvCell(value: unknown): string {
  const text = String(value ?? "");
  if (!/[,"\n]/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function parseBooleanInput(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const v = String(value).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return undefined;
}

function filterSearchTraces(params: {
  query?: string;
  project?: string;
  mode?: string;
  fromEpoch?: number;
  toEpoch?: number;
}): SearchTrace[] {
  return searchTraces.filter((x) => {
    if (params.query) {
      const q = params.query.toLowerCase();
      const matched = x.query.toLowerCase().includes(q) || String(x.project || "").toLowerCase().includes(q);
      if (!matched) return false;
    }
    if (params.project && String(x.project || "") !== params.project) return false;
    if (params.mode && x.mode !== params.mode) return false;
    const ts = Date.parse(x.ts);
    if (typeof params.fromEpoch === "number" && Number.isFinite(ts) && ts < params.fromEpoch) return false;
    if (typeof params.toEpoch === "number" && Number.isFinite(ts) && ts > params.toEpoch) return false;
    return true;
  });
}

function filterSessionTimings(params: {
  sessionDbId?: number;
  messageType?: string;
  success?: boolean;
  fromEpoch?: number;
  toEpoch?: number;
}): SessionTiming[] {
  return sessionTimings.filter((x) => {
    if (typeof params.sessionDbId === "number" && x.sessionDbId !== params.sessionDbId) return false;
    if (params.messageType && x.messageType !== params.messageType) return false;
    if (typeof params.success === "boolean" && x.success !== params.success) return false;
    const ts = Date.parse(x.ts);
    if (typeof params.fromEpoch === "number" && Number.isFinite(ts) && ts < params.fromEpoch) return false;
    if (typeof params.toEpoch === "number" && Number.isFinite(ts) && ts > params.toEpoch) return false;
    return true;
  });
}

function filterFailureRecords(params: {
  sessionDbId?: number;
  errorClass?: string;
  messageType?: string;
  fromEpoch?: number;
  toEpoch?: number;
}): FailureRecord[] {
  return failureRecords.filter((x) => {
    if (typeof params.sessionDbId === "number" && x.sessionDbId !== params.sessionDbId) return false;
    if (params.errorClass && x.errorClass !== params.errorClass) return false;
    if (params.messageType && x.messageType !== params.messageType) return false;
    const ts = Date.parse(x.ts);
    if (typeof params.fromEpoch === "number" && Number.isFinite(ts) && ts < params.fromEpoch) return false;
    if (typeof params.toEpoch === "number" && Number.isFinite(ts) && ts > params.toEpoch) return false;
    return true;
  });
}

function ensureSessionForProcessing(contentSessionId: string): { sessionDbId: number; memorySessionId: string; project: string } {
  const session = store.getSessionByContentSessionId(contentSessionId);
  if (!session) {
    const sid = store.createSDKSession(contentSessionId, "unknown", "");
    const memoryId = `cmem-${sid}`;
    store.ensureMemorySessionIdRegistered(sid, memoryId);
    return { sessionDbId: sid, memorySessionId: memoryId, project: "unknown" };
  }

  let memorySessionId = session.memory_session_id;
  if (!memorySessionId) {
    memorySessionId = `cmem-${session.id}`;
    store.ensureMemorySessionIdRegistered(session.id, memorySessionId);
  }

  return {
    sessionDbId: session.id,
    memorySessionId,
    project: session.project || "unknown"
  };
}

function formatSearchText(
  query: string | undefined,
  result: { observations: any[]; sessions: any[]; prompts: any[] },
  searchMode: "lexical-only" | "hybrid"
): string {
  const q = query || "(filter-only)";
  const lines: string[] = [];
  lines.push(
    `Found ${result.observations.length + result.sessions.length + result.prompts.length} result(s) matching \"${q}\" (${result.observations.length} obs, ${result.sessions.length} sessions, ${result.prompts.length} prompts)`
  );
  lines.push(`Search mode: ${searchMode}`);
  lines.push("");
  lines.push("| ID | Kind | Title | Project | Time |");
  lines.push("|---|---|---|---|---|");

  for (const row of result.observations) {
    lines.push(`| #${row.id} | observation | ${row.title || "(untitled)"} | ${row.project} | ${new Date(row.created_at_epoch).toISOString()} |`);
  }
  for (const row of result.sessions) {
    lines.push(`| #S${row.id} | summary | ${row.request || "(no request)"} | ${row.project} | ${new Date(row.created_at_epoch).toISOString()} |`);
  }
  for (const row of result.prompts) {
    const t = String(row.prompt_text || "").slice(0, 80).replace(/\n/g, " ");
    lines.push(`| #P${row.id} | prompt | ${t} | - | ${new Date(row.created_at_epoch).toISOString()} |`);
  }

  return lines.join("\n");
}

function formatTimelineText(items: any[], anchor: number | null, depthBefore: number, depthAfter: number): string {
  const lines: string[] = [];
  lines.push(`Timeline around anchor=${anchor ?? "auto"} (before=${depthBefore}, after=${depthAfter})`);
  lines.push("");

  for (const item of items) {
    lines.push(`- #${item.id} [${item.type}] ${item.title || "(untitled)"} @ ${new Date(item.created_at_epoch).toISOString()}`);
  }

  return lines.join("\n");
}

function parseMaybeStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x));
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((x) => String(x));
  } catch {
    return [];
  }
}

async function runChromaBackfill(project?: string, limit = 1000): Promise<{ observations: number; summaries: number; prompts: number; skipped: boolean }> {
  if (!isChromaVectorEnabled() || !chromaSearch.isConfigured()) {
    return { observations: 0, summaries: 0, prompts: 0, skipped: true };
  }

  const safeLimit = Math.max(1, Math.min(limit, 10_000));
  const observationRows = store.db
    .query(
      `SELECT id, project, title, subtitle, narrative, facts, concepts, created_at_epoch
       FROM observations ${project ? "WHERE project = ?" : ""}
       ORDER BY id DESC LIMIT ?`
    )
    .all(...(project ? [project] : []), safeLimit) as any[];

  const summaryRows = store.db
    .query(
      `SELECT id, project, request, investigated, learned, completed, next_steps, notes, created_at_epoch
       FROM session_summaries ${project ? "WHERE project = ?" : ""}
       ORDER BY id DESC LIMIT ?`
    )
    .all(...(project ? [project] : []), safeLimit) as any[];

  const promptRows = store.db
    .query(
      `SELECT up.id, up.prompt_text, up.created_at_epoch, s.project
       FROM user_prompts up
       JOIN sdk_sessions s ON s.content_session_id = up.content_session_id
       ${project ? "WHERE s.project = ?" : ""}
       ORDER BY up.id DESC LIMIT ?`
    )
    .all(...(project ? [project] : []), safeLimit) as any[];

  let obsCount = 0;
  let sumCount = 0;
  let promptCount = 0;

  for (const row of observationRows) {
    const vectorText = [
      row.title || "",
      row.subtitle || "",
      row.narrative || "",
      ...parseMaybeStringArray(row.facts),
      ...parseMaybeStringArray(row.concepts)
    ]
      .filter(Boolean)
      .join("\n");
    await chromaSearch.indexObservation(row.id, row.project || "unknown", vectorText, row.created_at_epoch || Date.now());
    obsCount += 1;
  }

  for (const row of summaryRows) {
    const vectorText = [row.request, row.investigated, row.learned, row.completed, row.next_steps, row.notes].filter(Boolean).join("\n");
    await chromaSearch.indexSummary(row.id, row.project || "unknown", vectorText, row.created_at_epoch || Date.now());
    sumCount += 1;
  }

  for (const row of promptRows) {
    const vectorText = String(row.prompt_text || "");
    await chromaSearch.indexPrompt(row.id, row.project || "unknown", vectorText, row.created_at_epoch || Date.now());
    promptCount += 1;
  }

  return { observations: obsCount, summaries: sumCount, prompts: promptCount, skipped: false };
}

async function processSessionQueue(sessionDbId: number): Promise<void> {
  const seen = new Set<number>();
  broadcastSse({ type: "session.status", sessionDbId, status: "active" });
  emitQueueDepth();

  while (true) {
    const msg = store.claimNextPending(sessionDbId);
    if (!msg) break;
    if (seen.has(msg.id)) break;
    seen.add(msg.id);
    const messageStartedAt = Date.now();

    try {
      const session = store.getSessionById(msg.session_db_id);
      if (!session) {
        store.markFailed(msg.id);
        continue;
      }
      const queueWaitMs = Math.max(0, messageStartedAt - (msg.created_at_epoch || messageStartedAt));
      let modelMs = 0;
      let indexMs = 0;

      const memorySessionId = session.memory_session_id || `cmem-${session.id}`;
      if (!session.memory_session_id) {
        store.ensureMemorySessionIdRegistered(session.id, memorySessionId);
      }

      if (msg.message_type === "observation") {
        const tModel = Date.now();
        const obs = await activeAgent.processObservation(msg);
        modelMs += Date.now() - tModel;
        const obsId = store.storeObservation(memorySessionId, session.project || "unknown", obs, msg.prompt_number || 0);
        broadcastSse({
          type: "model.result",
          sessionDbId,
          messageType: "observation",
          status: "success",
          model: activeAgent.name
        });
        try {
          const tIndex = Date.now();
          const payloadText = composeObservationVectorText(obs);
          if (isSqliteVectorEnabled()) {
            await semanticSearch.indexObservation(store, obsId, session.project || "unknown", payloadText);
          }
          if (isChromaVectorEnabled()) {
            await chromaSearch.indexObservation(obsId, session.project || "unknown", payloadText, Date.now());
          }
          indexMs += Date.now() - tIndex;
        } catch (error) {
          logger.warn("WORKER", "Failed to index observation vectors", {
            sessionDbId,
            observationId: obsId,
            error: String(error)
          });
        }
      } else {
        const tModel = Date.now();
        const summary = await activeAgent.processSummary(msg);
        modelMs += Date.now() - tModel;
        const summaryId = store.storeSummary(memorySessionId, session.project || "unknown", summary, msg.prompt_number || 0);
        broadcastSse({
          type: "model.result",
          sessionDbId,
          messageType: "summarize",
          status: "success",
          model: activeAgent.name
        });
        if (isChromaVectorEnabled()) {
          try {
            const tIndex = Date.now();
            await chromaSearch.indexSummary(summaryId, session.project || "unknown", composeSummaryVectorText(summary), Date.now());
            indexMs += Date.now() - tIndex;
          } catch (error) {
            logger.warn("WORKER", "Failed to index summary vectors", {
              sessionDbId,
              summaryId,
              error: String(error)
            });
          }
        }
      }

      store.confirmProcessed(msg.id);
      pushBounded(
        sessionTimings,
        {
          ts: new Date().toISOString(),
          sessionDbId,
          messageId: msg.id,
          messageType: msg.message_type,
          queueWaitMs,
          modelMs,
          indexMs,
          totalMs: Math.max(0, Date.now() - messageStartedAt),
          success: true
        },
        MAX_SESSION_TIMINGS
      );
      emitQueueDepth();
    } catch (error) {
      logger.error("QUEUE", "Failed to process pending message", { sessionDbId, messageId: msg.id, error: String(error) });
      store.markFailed(msg.id);
      pushBounded(
        sessionTimings,
        {
          ts: new Date().toISOString(),
          sessionDbId,
          messageId: msg.id,
          messageType: msg.message_type,
          queueWaitMs: Math.max(0, messageStartedAt - (msg.created_at_epoch || messageStartedAt)),
          modelMs: 0,
          indexMs: 0,
          totalMs: Math.max(0, Date.now() - messageStartedAt),
          success: false
        },
        MAX_SESSION_TIMINGS
      );
      pushBounded(
        failureRecords,
        {
          ts: new Date().toISOString(),
          sessionDbId,
          messageId: msg.id,
          messageType: msg.message_type,
          errorClass: classifyError(error),
          error: String(error)
        },
        MAX_FAILURE_RECORDS
      );
      broadcastSse({
        type: "model.result",
        sessionDbId,
        messageType: msg.message_type,
        status: "failed",
        model: activeAgent.name
      });
      broadcastSse({
        type: "queue.failed",
        sessionDbId,
        messageId: msg.id,
        error: String(error)
      });
      emitQueueDepth();
    }
  }

  broadcastSse({ type: "session.status", sessionDbId, status: "idle" });
  emitQueueDepth();
}

app.get("/api/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    version: APP_VERSION,
    pid: process.pid,
    uptime: Date.now() - startAt,
    initialized,
    mcpReady
  });
});

app.get("/api/readiness", (_req, res) => {
  if (initialized) {
    res.status(200).json({ status: "ready", mcpReady });
    return;
  }
  res.status(503).json({ status: "initializing" });
});

app.get("/api/version", (_req, res) => {
  res.status(200).json({ version: APP_VERSION });
});

app.get("/api/events", (_req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  sseClients.add(res);
  sendSse(res, { type: "queue.depth", ...queueSnapshot() });

  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      // ignore write errors on broken pipes
    }
  }, 15_000);

  res.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

app.get("/viewer", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CodexMem Viewer</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; padding: 24px; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #f5f7fa; color: #13202f; }
    h1 { margin: 0 0 12px; font-size: 18px; }
    h2 { margin: 8px 0; font-size: 14px; color: #334155; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(140px, 1fr)); gap: 10px; margin-bottom: 16px; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
    .card { background: #fff; border: 1px solid #d8e0eb; border-radius: 8px; padding: 10px 12px; }
    .label { color: #5f6f83; font-size: 12px; }
    .value { font-size: 18px; margin-top: 3px; }
    .panel { background: #fff; border: 1px solid #d8e0eb; border-radius: 8px; padding: 10px; max-height: 30vh; overflow: auto; white-space: pre-wrap; }
    .small { font-size: 12px; color: #4b5563; }
    .filters { display: grid; grid-template-columns: repeat(7, minmax(120px, 1fr)); gap: 8px; margin-bottom: 12px; }
    .filters input, .filters select { width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px; border: 1px solid #c6d2e1; background: #fff; font: inherit; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
    .actions button, .actions a { padding: 6px 8px; border-radius: 6px; border: 1px solid #c6d2e1; background: #fff; color: #13202f; font: inherit; text-decoration: none; cursor: pointer; }
    .trend-wrap { display: grid; gap: 8px; }
    .trend-svg { width: 100%; height: 180px; border: 1px solid #d8e0eb; border-radius: 6px; background: #f8fbff; }
    .legend { display: flex; gap: 10px; font-size: 12px; color: #334155; }
    .alert { border-radius: 6px; padding: 6px 8px; font-size: 12px; border: 1px solid #fca5a5; background: #fef2f2; color: #991b1b; }
    .alert.ok { border-color: #86efac; background: #f0fdf4; color: #166534; }
  </style>
</head>
<body>
  <h1>CodexMem Advanced Viewer</h1>
  <div class="filters">
    <input id="fQuery" placeholder="query/project" />
    <input id="fProject" placeholder="project exact" />
    <select id="fMode">
      <option value="">mode: all</option>
      <option value="hybrid">hybrid</option>
      <option value="lexical-only">lexical-only</option>
    </select>
    <input id="fSession" placeholder="sessionDbId" />
    <input id="fErrorClass" placeholder="errorClass" />
    <input id="fFrom" placeholder="from (ISO/epoch)" />
    <input id="fTo" placeholder="to (ISO/epoch)" />
  </div>
  <div class="actions">
    <button id="refreshBtn">Refresh</button>
    <button id="clearDrillBtn">Clear Drill-down</button>
    <a id="exportTraceCsv" href="#" target="_blank" rel="noopener">Export Trace CSV</a>
    <a id="exportTraceNdjson" href="#" target="_blank" rel="noopener">Export Trace NDJSON</a>
    <a id="exportTimingCsv" href="#" target="_blank" rel="noopener">Export Timing CSV</a>
    <a id="exportFailureCsv" href="#" target="_blank" rel="noopener">Export Failure CSV</a>
  </div>
  <div class="grid">
    <div class="card"><div class="label">pending</div><div class="value" id="pending">0</div></div>
    <div class="card"><div class="label">processing</div><div class="value" id="processing">0</div></div>
    <div class="card"><div class="label">failed</div><div class="value" id="failed">0</div></div>
    <div class="card"><div class="label">queueDepth</div><div class="value" id="queueDepth">0</div></div>
  </div>
  <div class="grid2">
    <div>
      <h2>Search Trace</h2>
      <div id="trace" class="panel small"></div>
    </div>
    <div>
      <h2>Session Timings</h2>
      <div id="timings" class="panel small"></div>
    </div>
  </div>
  <div class="grid2">
    <div>
      <h2>Failure Summary</h2>
      <div id="failures" class="panel small"></div>
    </div>
    <div>
      <h2>SSE Stream</h2>
      <div id="events" class="panel small"></div>
    </div>
  </div>
  <div class="grid2">
    <div>
      <h2>Trends (window=1h, bucket=1m)</h2>
      <div class="trend-wrap">
        <div id="trendAlert" class="alert ok">failure trend normal</div>
        <svg id="trendSvg" class="trend-svg" viewBox="0 0 800 180" preserveAspectRatio="none"></svg>
        <div id="trendLegend" class="legend"></div>
        <div id="trends" class="panel small"></div>
      </div>
    </div>
  </div>
  <script>
    const eventsEl = document.getElementById("events");
    const traceEl = document.getElementById("trace");
    const timingsEl = document.getElementById("timings");
    const failuresEl = document.getElementById("failures");
    const trendsEl = document.getElementById("trends");
    const fQueryEl = document.getElementById("fQuery");
    const fProjectEl = document.getElementById("fProject");
    const fModeEl = document.getElementById("fMode");
    const fSessionEl = document.getElementById("fSession");
    const fErrorClassEl = document.getElementById("fErrorClass");
    const fFromEl = document.getElementById("fFrom");
    const fToEl = document.getElementById("fTo");
    const exportTraceCsvEl = document.getElementById("exportTraceCsv");
    const exportTraceNdjsonEl = document.getElementById("exportTraceNdjson");
    const exportTimingCsvEl = document.getElementById("exportTimingCsv");
    const exportFailureCsvEl = document.getElementById("exportFailureCsv");
    const trendSvgEl = document.getElementById("trendSvg");
    const trendLegendEl = document.getElementById("trendLegend");
    const trendAlertEl = document.getElementById("trendAlert");
    const clearDrillBtnEl = document.getElementById("clearDrillBtn");
    const counters = {
      pending: document.getElementById("pending"),
      processing: document.getElementById("processing"),
      failed: document.getElementById("failed"),
      queueDepth: document.getElementById("queueDepth")
    };
    let selectedBucketRange = null;
    function append(line) {
      eventsEl.textContent = line + "\\n" + eventsEl.textContent;
      if (eventsEl.textContent.length > 16000) {
        eventsEl.textContent = eventsEl.textContent.slice(0, 16000);
      }
    }
    const es = new EventSource("/api/events");
    es.addEventListener("queue.depth", (ev) => {
      const data = JSON.parse(ev.data);
      counters.pending.textContent = String(data.pending);
      counters.processing.textContent = String(data.processing);
      counters.failed.textContent = String(data.failed);
      counters.queueDepth.textContent = String(data.queueDepth);
      append("queue.depth " + ev.data);
    });
    es.addEventListener("session.status", (ev) => append("session.status " + ev.data));
    es.addEventListener("queue.failed", (ev) => append("queue.failed " + ev.data));
    es.addEventListener("model.result", (ev) => append("model.result " + ev.data));

    function buildFilters() {
      return {
        query: (fQueryEl.value || "").trim(),
        project: (fProjectEl.value || "").trim(),
        mode: (fModeEl.value || "").trim(),
        sessionDbId: (fSessionEl.value || "").trim(),
        errorClass: (fErrorClassEl.value || "").trim(),
        from: (fFromEl.value || "").trim(),
        to: (fToEl.value || "").trim()
      };
    }

    function toQuery(params) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v) q.set(k, String(v));
      }
      return q.toString();
    }

    function updateExportLinks(filters) {
      const traceQuery = toQuery({ query: filters.query, project: filters.project, mode: filters.mode, from: filters.from, to: filters.to, format: "csv" });
      exportTraceCsvEl.href = "/api/ops/search-traces/export?" + traceQuery;
      const traceNd = toQuery({ query: filters.query, project: filters.project, mode: filters.mode, from: filters.from, to: filters.to, format: "ndjson" });
      exportTraceNdjsonEl.href = "/api/ops/search-traces/export?" + traceNd;
      const timingQuery = toQuery({ sessionDbId: filters.sessionDbId, from: filters.from, to: filters.to, format: "csv" });
      exportTimingCsvEl.href = "/api/ops/session-timings/export?" + timingQuery;
      const failureQuery = toQuery({ sessionDbId: filters.sessionDbId, errorClass: filters.errorClass, from: filters.from, to: filters.to, format: "csv" });
      exportFailureCsvEl.href = "/api/ops/failure-summary/export?" + failureQuery;
    }

    function toEpochMs(input) {
      if (!input) return undefined;
      if (/^\\d+$/.test(input)) {
        const n = Number(input);
        if (!Number.isFinite(n)) return undefined;
        return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
      }
      const parsed = Date.parse(input);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    function trendPath(values, color) {
      if (!Array.isArray(values) || values.length === 0) return "";
      const width = 800;
      const height = 180;
      const padX = 8;
      const padY = 10;
      const max = Math.max(1, ...values);
      let d = "";
      for (let i = 0; i < values.length; i += 1) {
        const x = padX + (i * (width - 2 * padX)) / Math.max(1, values.length - 1);
        const y = height - padY - (values[i] * (height - 2 * padY)) / max;
        d += (i === 0 ? "M" : "L") + x.toFixed(2) + " " + y.toFixed(2) + " ";
      }
      return '<path d="' + d.trim() + '" fill="none" stroke="' + color + '" stroke-width="2"/>';
    }

    function trendPoints(values, color, series, buckets) {
      if (!Array.isArray(values) || values.length === 0) return "";
      const width = 800;
      const height = 180;
      const padX = 8;
      const padY = 10;
      const max = Math.max(1, ...values);
      let out = "";
      for (let i = 0; i < values.length; i += 1) {
        const x = padX + (i * (width - 2 * padX)) / Math.max(1, values.length - 1);
        const y = height - padY - (values[i] * (height - 2 * padY)) / max;
        const row = buckets[i] || {};
        out +=
          '<circle cx="' + x.toFixed(2) +
          '" cy="' + y.toFixed(2) +
          '" r="3.2" fill="' + color +
          '" data-series="' + series +
          '" data-index="' + i +
          '" data-from="' + String(row.from || "") +
          '" data-to="' + String(row.to || "") +
          '" style="cursor:pointer" />';
      }
      return out;
    }

    function pickRowsByDrill(rows) {
      if (!selectedBucketRange || !Array.isArray(rows)) return rows;
      return rows.filter((x) => {
        const ts = Date.parse(x.ts);
        if (!Number.isFinite(ts)) return false;
        return ts >= selectedBucketRange.from && ts <= selectedBucketRange.to;
      });
    }

    function renderTrendChart(buckets) {
      const rows = Array.isArray(buckets) ? buckets : [];
      if (rows.length === 0) {
        trendSvgEl.innerHTML = "";
        trendLegendEl.textContent = "(no trend data)";
        trendAlertEl.className = "alert";
        trendAlertEl.textContent = "no trend data";
        return;
      }
      const searches = rows.map((x) => Number(x.searchCount || 0));
      const queues = rows.map((x) => Number(x.queueCount || 0));
      const failures = rows.map((x) => Number(x.failureCount || 0));
      trendSvgEl.innerHTML =
        trendPath(searches, "#2563eb") +
        trendPath(queues, "#16a34a") +
        trendPath(failures, "#dc2626") +
        trendPoints(searches, "#2563eb", "search", rows) +
        trendPoints(queues, "#16a34a", "queue", rows) +
        trendPoints(failures, "#dc2626", "failure", rows);
      trendLegendEl.innerHTML =
        '<span style="color:#2563eb">search</span>' +
        '<span style="color:#16a34a">queue</span>' +
        '<span style="color:#dc2626">failure</span>' +
        (selectedBucketRange
          ? '<span>drill=' + new Date(selectedBucketRange.from).toISOString() + ' ~ ' + new Date(selectedBucketRange.to).toISOString() + "</span>"
          : "");
      const lastFailure = failures.length > 0 ? failures[failures.length - 1] : 0;
      const avgFailure = failures.length > 0 ? failures.reduce((a, x) => a + x, 0) / failures.length : 0;
      const surge = lastFailure >= Math.max(3, avgFailure * 2);
      if (surge) {
        trendAlertEl.className = "alert";
        trendAlertEl.textContent = "failure surge detected: last=" + lastFailure + ", avg=" + avgFailure.toFixed(2);
      } else {
        trendAlertEl.className = "alert ok";
        trendAlertEl.textContent = "failure trend normal: last=" + lastFailure + ", avg=" + avgFailure.toFixed(2);
      }
    }

    async function refreshPanels() {
      try {
        const filters = buildFilters();
        updateExportLinks(filters);
        const traceQuery = toQuery({ limit: 120, query: filters.query, project: filters.project, mode: filters.mode, from: filters.from, to: filters.to });
        const timingQuery = toQuery({ limit: 120, sessionDbId: filters.sessionDbId, from: filters.from, to: filters.to });
        const failureQuery = toQuery({ limit: 120, sessionDbId: filters.sessionDbId, errorClass: filters.errorClass, from: filters.from, to: filters.to });
        const [traceRes, timingRes, failureRes] = await Promise.all([
          fetch("/api/ops/search-traces?" + traceQuery),
          fetch("/api/ops/session-timings?" + timingQuery),
          fetch("/api/ops/failure-summary?" + failureQuery)
        ]);
        const trace = await traceRes.json();
        const timing = await timingRes.json();
        const failure = await failureRes.json();
        const traceRows = pickRowsByDrill(trace.traces || []).slice(0, 10);
        const timingRows = pickRowsByDrill(timing.timings || []).slice(0, 10);
        const failureRows = pickRowsByDrill(failure.recent || []).slice(0, 10);

        traceEl.textContent = traceRows.map((x) =>
          "[" + x.ts + "] q=" + JSON.stringify(x.query) +
          " mode=" + x.mode +
          " result(o/s/p)=" + x.resultCounts.observations + "/" + x.resultCounts.sessions + "/" + x.resultCounts.prompts +
          " vector(sqlite/chromaObs/chromaSum/chromaPrompt)=" + x.vectorHits.sqliteObservations + "/" + x.vectorHits.chromaObservations + "/" + x.vectorHits.chromaSummaries + "/" + x.vectorHits.chromaPrompts +
          " durationMs=" + x.durationMs
        ).join("\\n\\n") || "(no trace yet)";

        const agg = timing.aggregate || {};
        const rows = timingRows.map((x) =>
          "[" + x.ts + "] sid=" + x.sessionDbId +
          " msg=" + x.messageId + "(" + x.messageType + ")" +
          " ok=" + x.success +
          " wait/model/index/total=" + x.queueWaitMs + "/" + x.modelMs + "/" + x.indexMs + "/" + x.totalMs
        ).join("\\n");
        timingsEl.textContent =
          "aggregate count=" + (agg.count || 0) +
          " success=" + (agg.successCount || 0) +
          " avg(wait/model/index/total)=" + (agg.avgQueueWaitMs || 0) + "/" + (agg.avgModelMs || 0) + "/" + (agg.avgIndexMs || 0) + "/" + (agg.avgTotalMs || 0) +
          "\\n\\n" + (rows || "(no timings yet)");

        const classes = (failure.summary?.classes || []).map((x) => x.errorClass + ":" + x.count).join(", ");
        const recents = failureRows.map((x) =>
          "[" + x.ts + "] sid=" + x.sessionDbId +
          " msg=" + x.messageId +
          " class=" + x.errorClass +
          " err=" + x.error
        ).join("\\n");
        failuresEl.textContent =
          "total=" + (failure.summary?.total || 0) +
          " classes={" + classes + "}" +
          "\\n\\n" + (recents || "(no failures yet)");

        const fromEpoch = toEpochMs(filters.from);
        const toEpochRaw = toEpochMs(filters.to);
        const now = Date.now();
        const endEpoch = typeof toEpochRaw === "number" ? Math.min(toEpochRaw, now) : now;
        const startEpoch = typeof fromEpoch === "number" ? Math.min(fromEpoch, endEpoch) : endEpoch - 3600 * 1000;
        const windowSec = Math.max(60, Math.min(86400, Math.floor((endEpoch - startEpoch) / 1000) || 3600));
        const trendsRes = await fetch("/api/ops/trends?" + toQuery({ windowSec, bucketSec: 60 }));
        const trends = await trendsRes.json();
        const filteredBuckets = (trends.buckets || []).filter((x) => {
          const ts = Date.parse(x.ts);
          if (!Number.isFinite(ts)) return false;
          if (typeof fromEpoch === "number" && ts < fromEpoch) return false;
          if (typeof toEpochRaw === "number" && ts > toEpochRaw) return false;
          return true;
        });
        renderTrendChart(filteredBuckets);
        const trendRows = filteredBuckets.slice(-10).map((x) =>
          "[" + x.ts + "] search=" + x.searchCount +
          " avgSearchMs=" + x.avgSearchMs +
          " queue=" + x.queueCount +
          " avgQueueTotalMs=" + x.avgQueueTotalMs +
          " failures=" + x.failureCount
        ).join("\\n");
        trendsEl.textContent = trendRows || "(no trends yet)";
      } catch (e) {
        traceEl.textContent = "panel refresh failed: " + String(e);
      }
    }
    document.getElementById("refreshBtn").addEventListener("click", refreshPanels);
    clearDrillBtnEl.addEventListener("click", () => {
      selectedBucketRange = null;
      refreshPanels();
    });
    trendSvgEl.addEventListener("click", (ev) => {
      const target = ev.target;
      if (!target || !target.getAttribute) return;
      if (target.tagName !== "circle") return;
      const from = Number(target.getAttribute("data-from") || "");
      const to = Number(target.getAttribute("data-to") || "");
      if (!Number.isFinite(from) || !Number.isFinite(to)) return;
      selectedBucketRange = { from, to };
      refreshPanels();
    });
    [fQueryEl, fProjectEl, fModeEl, fSessionEl, fErrorClassEl, fFromEl, fToEl].forEach((el) => {
      el.addEventListener("change", refreshPanels);
    });
    refreshPanels();
    setInterval(refreshPanels, 3000);
  </script>
</body>
</html>`);
});

app.get("/api/settings", (_req, res) => {
  res.json(loadSettings());
});

app.post("/api/settings", (req, res) => {
  const current = loadSettings();
  const next = { ...current, ...(req.body as Record<string, string>) };
  saveSettings(next);
  res.json({ success: true });
});

app.get("/api/mcp/status", (_req, res) => {
  const settings = loadSettings();
  res.json({ enabled: settings.CODEXMEM_MCP_ENABLED !== "false" });
});

app.post("/api/mcp/toggle", (req, res) => {
  if (typeof req.body?.enabled !== "boolean") {
    badRequest(res, "enabled must be a boolean");
    return;
  }
  const settings = loadSettings();
  settings.CODEXMEM_MCP_ENABLED = req.body.enabled ? "true" : "false";
  saveSettings(settings);
  res.json({ success: true, enabled: req.body.enabled });
});

app.post("/api/sessions/init", async (req, res) => {
  const { contentSessionId, project, prompt } = req.body as { contentSessionId?: string; project?: string; prompt?: string };
  if (!contentSessionId || !project || typeof prompt !== "string") {
    badRequest(res, "Missing contentSessionId/project/prompt");
    return;
  }

  const sessionDbId = store.createSDKSession(contentSessionId, project, prompt);
  activeSessions.add(sessionDbId);
  broadcastSse({ type: "session.status", sessionDbId, status: "active" });

  const currentCount = store.getPromptNumberFromUserPrompts(contentSessionId);
  const promptNumber = currentCount + 1;
  const cleanedPrompt = stripMemoryTagsFromPrompt(prompt);

  if (!cleanedPrompt.trim()) {
    res.json({ sessionDbId, promptNumber, skipped: true, reason: "private" });
    return;
  }

  const promptId = store.saveUserPrompt(contentSessionId, promptNumber, cleanedPrompt);
  if (isChromaVectorEnabled()) {
    try {
      await chromaSearch.indexPrompt(promptId, project, cleanedPrompt, Date.now());
    } catch (error) {
      logger.warn("WORKER", "Failed to index prompt vectors", { contentSessionId, promptId, error: String(error) });
    }
  }
  res.json({ sessionDbId, promptNumber, skipped: false });
});

app.post("/api/sessions/observations", async (req, res) => {
  const { contentSessionId, tool_name, tool_input, tool_response, cwd } = req.body as {
    contentSessionId?: string;
    tool_name?: string;
    tool_input?: unknown;
    tool_response?: unknown;
    cwd?: string;
  };

  if (!contentSessionId || !tool_name || !cwd) {
    badRequest(res, "Missing contentSessionId/tool_name/cwd");
    return;
  }

  const skipTools = getSkipTools();
  if (skipTools.has(tool_name)) {
    res.json({ status: "skipped", reason: "tool_excluded" });
    return;
  }
  if (shouldSkipSessionMemoryMetaTool(tool_name, tool_input, tool_response)) {
    res.json({ status: "skipped", reason: "session_memory_meta" });
    return;
  }

  const session = ensureSessionForProcessing(contentSessionId);
  activeSessions.add(session.sessionDbId);

  const promptNumber = store.getPromptNumberFromUserPrompts(contentSessionId);
  const prompt = store.getUserPrompt(contentSessionId, promptNumber);
  if (!prompt || !prompt.trim()) {
    res.json({ status: "skipped", reason: "private" });
    return;
  }

  const cleanedToolInput = stripMemoryTagsFromJson(JSON.stringify(tool_input ?? {}));
  const cleanedToolResponse = stripMemoryTagsFromJson(JSON.stringify(tool_response ?? {}));
  const dedupeKey = toStableHash([
    contentSessionId,
    promptNumber,
    tool_name,
    cleanedToolInput,
    cleanedToolResponse,
    cwd
  ]);

  const enqueueResult = store.enqueueObservation(session.sessionDbId, contentSessionId, {
    tool_name,
    tool_input: cleanedToolInput,
    tool_response: cleanedToolResponse,
    cwd,
    prompt_number: promptNumber,
    dedupe_key: dedupeKey
  });
  emitQueueDepth();

  await processSessionQueue(session.sessionDbId);
  res.json({ status: enqueueResult.deduped ? "deduped" : "queued" });
});

app.post("/api/sessions/summarize", async (req, res) => {
  const { contentSessionId, last_assistant_message } = req.body as {
    contentSessionId?: string;
    last_assistant_message?: string;
  };

  if (!contentSessionId) {
    badRequest(res, "Missing contentSessionId");
    return;
  }

  const session = ensureSessionForProcessing(contentSessionId);
  activeSessions.add(session.sessionDbId);

  const promptNumber = store.getPromptNumberFromUserPrompts(contentSessionId);
  const prompt = store.getUserPrompt(contentSessionId, promptNumber);
  if (!prompt || !prompt.trim()) {
    res.json({ status: "skipped", reason: "private" });
    return;
  }

  const dedupeKey = toStableHash([contentSessionId, promptNumber, last_assistant_message || ""]);
  const enqueueResult = store.enqueueSummarize(session.sessionDbId, contentSessionId, {
    last_assistant_message: last_assistant_message || "",
    prompt_number: promptNumber,
    dedupe_key: dedupeKey
  });
  emitQueueDepth();

  await processSessionQueue(session.sessionDbId);
  res.json({ status: enqueueResult.deduped ? "deduped" : "queued" });
});

app.post("/api/sessions/end", async (req, res) => {
  const { contentSessionId, cleanup } = req.body as {
    contentSessionId?: string;
    cleanup?: boolean;
  };
  if (!contentSessionId) {
    badRequest(res, "Missing contentSessionId");
    return;
  }
  if (cleanup !== undefined && typeof cleanup !== "boolean") {
    badRequest(res, "cleanup must be a boolean");
    return;
  }

  const session = store.getSessionByContentSessionId(contentSessionId);
  if (!session) {
    res.json({ status: "skipped", reason: "not_active" });
    return;
  }

  const doCleanup = cleanup !== false;
  let resetCount = 0;
  if (doCleanup) {
    const staleMs = Number(loadSettings().CODEXMEM_STALE_PROCESSING_MS || "300000");
    resetCount = store.resetStaleProcessing(staleMs);
    await processSessionQueue(session.id);
  }

  activeSessions.delete(session.id);
  broadcastSse({ type: "session.status", sessionDbId: session.id, status: "completed" });
  emitQueueDepth();
  res.json({
    status: "ended",
    sessionDbId: session.id,
    cleanup: {
      enabled: doCleanup,
      resetCount,
      pending: store.getPendingCount(session.id)
    }
  });
});

app.post("/api/sessions/complete", (req, res) => {
  const { contentSessionId } = req.body as { contentSessionId?: string };
  if (!contentSessionId) {
    badRequest(res, "Missing contentSessionId");
    return;
  }

  const session = store.getSessionByContentSessionId(contentSessionId);
  if (!session) {
    res.json({ status: "skipped", reason: "not_active" });
    return;
  }

  activeSessions.delete(session.id);
  broadcastSse({ type: "session.status", sessionDbId: session.id, status: "completed" });
  emitQueueDepth();
  res.json({ status: "completed", sessionDbId: session.id });
});

app.get("/api/observations", (req, res) => {
  const { limit, offset, project } = parseLimitOffset(req);
  const { items, total } = store.listObservations(offset, limit, project);
  store.touchMemoryAccess({ observationIds: items.map((x) => Number(x.id)).filter((x) => Number.isInteger(x)), projects: project ? [project] : [] });
  res.json({ observations: items, total, hasMore: offset + items.length < total });
});

app.get("/api/summaries", (req, res) => {
  const { limit, offset, project } = parseLimitOffset(req);
  const { items, total } = store.listSummaries(offset, limit, project);
  store.touchMemoryAccess({ summaryIds: items.map((x) => Number(x.id)).filter((x) => Number.isInteger(x)), projects: project ? [project] : [] });
  res.json({ summaries: items, total, hasMore: offset + items.length < total });
});

app.get("/api/prompts", (req, res) => {
  const { limit, offset, project } = parseLimitOffset(req);
  const { items, total } = store.listPrompts(offset, limit, project);
  store.touchMemoryAccess({ promptIds: items.map((x) => Number(x.id)).filter((x) => Number.isInteger(x)), projects: project ? [project] : [] });
  res.json({ prompts: items, total, hasMore: offset + items.length < total });
});

app.get("/api/observation/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    badRequest(res, "Invalid observation id");
    return;
  }
  const row = store.getObservationById(id);
  if (!row) {
    res.status(404).json({ error: `Observation #${id} not found` });
    return;
  }
  store.touchMemoryAccess({ observationIds: [id] });
  res.json(row);
});

app.post("/api/observations/batch", (req, res) => {
  const { ids, orderBy, limit, project } = req.body as {
    ids?: unknown;
    orderBy?: "date_desc" | "date_asc";
    limit?: number;
    project?: string;
  };

  if (!Array.isArray(ids)) {
    badRequest(res, "ids must be an array of numbers");
    return;
  }
  if (!ids.every((x) => Number.isInteger(x))) {
    badRequest(res, "All ids must be integers");
    return;
  }

  const rows = store.getObservationsByIds(ids as number[], { orderBy, limit, project });
  store.touchMemoryAccess({ observationIds: rows.map((x) => Number(x.id)).filter((x) => Number.isInteger(x)), projects: project ? [project] : [] });
  res.json(rows);
});

app.get("/api/projects", (_req, res) => {
  res.json({ projects: store.listProjects() });
});

app.get("/api/stats", (_req, res) => {
  const stats = store.getStats();
  res.json({
    worker: {
      version: APP_VERSION,
      uptime: Math.floor((Date.now() - startAt) / 1000),
      activeSessions: activeSessions.size,
      port: getWorkerPort()
    },
    database: stats,
    agentMetrics: agentMetrics.snapshot()
  });
});

app.get("/api/processing-status", (_req, res) => {
  const snapshot = queueSnapshot();
  res.json({ isProcessing: snapshot.queueDepth > 0, queueDepth: snapshot.queueDepth, pending: snapshot.pending, processing: snapshot.processing, failed: snapshot.failed });
});

app.post("/api/pending-queue/process", async (req, res) => {
  const { sessionDbId, resetStale, staleMs } = req.body as {
    sessionDbId?: number;
    resetStale?: boolean;
    staleMs?: number;
  };

  if (sessionDbId !== undefined && !Number.isInteger(sessionDbId)) {
    badRequest(res, "sessionDbId must be an integer");
    return;
  }
  if (resetStale !== undefined && typeof resetStale !== "boolean") {
    badRequest(res, "resetStale must be a boolean");
    return;
  }
  if (staleMs !== undefined && (!Number.isInteger(staleMs) || staleMs <= 0)) {
    badRequest(res, "staleMs must be a positive integer");
    return;
  }

  const appliedStaleMs = staleMs ?? Number(loadSettings().CODEXMEM_STALE_PROCESSING_MS || "300000");
  const doResetStale = resetStale !== false;
  const resetCount = doResetStale ? store.resetStaleProcessing(appliedStaleMs) : 0;

  const sessions = typeof sessionDbId === "number" ? [sessionDbId] : store.getSessionsWithPendingMessages();
  for (const sid of sessions) {
    await processSessionQueue(sid);
  }

  emitQueueDepth();
  res.json({
    success: true,
    resetStale: doResetStale,
    staleMs: appliedStaleMs,
    resetCount,
    processedSessions: sessions.length,
    queue: queueSnapshot()
  });
});

app.get("/api/ops/retention/policies", (_req, res) => {
  const settings = readRetentionSettings();
  res.json({
    default: settings,
    policies: store.listRetentionPolicies()
  });
});

app.post("/api/ops/retention/policies", (req, res) => {
  const { project, enabled, pinned, ttlDays } = req.body as {
    project?: string;
    enabled?: boolean;
    pinned?: boolean;
    ttlDays?: number | null;
  };
  if (!project || !project.trim()) {
    badRequest(res, "project is required");
    return;
  }
  if (enabled !== undefined && typeof enabled !== "boolean") {
    badRequest(res, "enabled must be a boolean");
    return;
  }
  if (pinned !== undefined && typeof pinned !== "boolean") {
    badRequest(res, "pinned must be a boolean");
    return;
  }
  if (ttlDays !== undefined && ttlDays !== null && (!Number.isInteger(ttlDays) || ttlDays <= 0)) {
    badRequest(res, "ttlDays must be a positive integer or null");
    return;
  }

  store.upsertRetentionPolicy(project.trim(), { enabled, pinned, ttlDays: ttlDays ?? null });
  res.json({ success: true, project: project.trim() });
});

app.post("/api/ops/retention/cleanup", (req, res) => {
  const { dryRun } = req.body as { dryRun?: boolean };
  if (dryRun !== undefined && typeof dryRun !== "boolean") {
    badRequest(res, "dryRun must be a boolean");
    return;
  }
  const cfg = readRetentionSettings();
  const report = store.runRetentionCleanup({
    dryRun: dryRun !== false,
    defaultTtlDays: cfg.ttlDays,
    softDeleteDays: cfg.softDeleteDays
  });
  res.json({ success: true, report });
});

app.get("/api/ops/index-status", (_req, res) => {
  const obsEmbeddingCount = (store.db.query("SELECT COUNT(*) AS c FROM observation_embeddings").get() as { c: number }).c;
  const summaryCount = (store.db.query("SELECT COUNT(*) AS c FROM session_summaries").get() as { c: number }).c;
  const promptCount = (store.db.query("SELECT COUNT(*) AS c FROM user_prompts").get() as { c: number }).c;
  const backend = getVectorBackendMode();
  res.json({
    backend,
    sqlite: {
      enabled: isSqliteVectorEnabled(),
      observationEmbeddings: obsEmbeddingCount
    },
    chroma: {
      enabled: isChromaVectorEnabled(),
      configured: chromaSearch.isConfigured()
    },
    sourceTotals: {
      observations: (store.db.query("SELECT COUNT(*) AS c FROM observations").get() as { c: number }).c,
      summaries: summaryCount,
      prompts: promptCount
    }
  });
});

app.get("/api/ops/agent-metrics", (_req, res) => {
  res.json({ metrics: agentMetrics.snapshot() });
});

app.post("/api/ops/agent-metrics/reset", (_req, res) => {
  agentMetrics.reset();
  res.json({ success: true });
});

app.get("/api/ops/search-traces", (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit ?? 20), 200));
  const query = req.query.query ? String(req.query.query) : undefined;
  const project = req.query.project ? String(req.query.project) : undefined;
  const mode = req.query.mode ? String(req.query.mode) : undefined;
  const fromEpoch = parseEpochInput(req.query.from);
  const toEpoch = parseEpochInput(req.query.to);
  const filtered = filterSearchTraces({ query, project, mode, fromEpoch, toEpoch });
  const items = filtered.slice(0, limit);
  res.json({ traces: items, total: filtered.length, filters: { query: query || "", project: project || "", mode: mode || "", fromEpoch, toEpoch } });
});

app.get("/api/ops/search-traces/export", (req, res) => {
  const format = req.query.format ? String(req.query.format).toLowerCase() : "csv";
  const query = req.query.query ? String(req.query.query) : undefined;
  const project = req.query.project ? String(req.query.project) : undefined;
  const mode = req.query.mode ? String(req.query.mode) : undefined;
  const fromEpoch = parseEpochInput(req.query.from);
  const toEpoch = parseEpochInput(req.query.to);
  const rows = filterSearchTraces({ query, project, mode, fromEpoch, toEpoch });

  if (format === "ndjson") {
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.send(rows.map((r) => JSON.stringify(r)).join("\n"));
    return;
  }

  const header = [
    "ts",
    "query",
    "project",
    "mode",
    "durationMs",
    "lexicalObservations",
    "lexicalSessions",
    "lexicalPrompts",
    "sqliteObservations",
    "chromaObservations",
    "chromaSummaries",
    "chromaPrompts",
    "resultObservations",
    "resultSessions",
    "resultPrompts"
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.ts,
        r.query,
        r.project || "",
        r.mode,
        r.durationMs,
        r.lexicalCounts.observations,
        r.lexicalCounts.sessions,
        r.lexicalCounts.prompts,
        r.vectorHits.sqliteObservations,
        r.vectorHits.chromaObservations,
        r.vectorHits.chromaSummaries,
        r.vectorHits.chromaPrompts,
        r.resultCounts.observations,
        r.resultCounts.sessions,
        r.resultCounts.prompts
      ]
        .map(escapeCsvCell)
        .join(",")
    );
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.send(lines.join("\n"));
});

app.get("/api/ops/session-timings", (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit ?? 50), 500));
  const sessionDbId = req.query.sessionDbId ? Number(req.query.sessionDbId) : undefined;
  const messageType = req.query.messageType ? String(req.query.messageType) : undefined;
  const success = parseBooleanInput(req.query.success);
  const fromEpoch = parseEpochInput(req.query.from);
  const toEpoch = parseEpochInput(req.query.to);
  const aggregateBase = filterSessionTimings({
    sessionDbId: Number.isInteger(sessionDbId) ? sessionDbId : undefined,
    messageType,
    success,
    fromEpoch,
    toEpoch
  });
  const items = aggregateBase.slice(0, limit);
  const aggregate = {
    count: aggregateBase.length,
    successCount: aggregateBase.filter((x) => x.success).length,
    avgQueueWaitMs: aggregateBase.length > 0 ? Number((aggregateBase.reduce((a, x) => a + x.queueWaitMs, 0) / aggregateBase.length).toFixed(2)) : 0,
    avgModelMs: aggregateBase.length > 0 ? Number((aggregateBase.reduce((a, x) => a + x.modelMs, 0) / aggregateBase.length).toFixed(2)) : 0,
    avgIndexMs: aggregateBase.length > 0 ? Number((aggregateBase.reduce((a, x) => a + x.indexMs, 0) / aggregateBase.length).toFixed(2)) : 0,
    avgTotalMs: aggregateBase.length > 0 ? Number((aggregateBase.reduce((a, x) => a + x.totalMs, 0) / aggregateBase.length).toFixed(2)) : 0
  };
  res.json({ timings: items, aggregate, filters: { sessionDbId: Number.isInteger(sessionDbId) ? sessionDbId : null, messageType: messageType || "", success, fromEpoch, toEpoch } });
});

app.get("/api/ops/session-timings/export", (req, res) => {
  const format = req.query.format ? String(req.query.format).toLowerCase() : "csv";
  const sessionDbId = req.query.sessionDbId ? Number(req.query.sessionDbId) : undefined;
  const messageType = req.query.messageType ? String(req.query.messageType) : undefined;
  const success = parseBooleanInput(req.query.success);
  const fromEpoch = parseEpochInput(req.query.from);
  const toEpoch = parseEpochInput(req.query.to);
  const rows = filterSessionTimings({
    sessionDbId: Number.isInteger(sessionDbId) ? sessionDbId : undefined,
    messageType,
    success,
    fromEpoch,
    toEpoch
  });

  if (format === "ndjson") {
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.send(rows.map((r) => JSON.stringify(r)).join("\n"));
    return;
  }

  const header = ["ts", "sessionDbId", "messageId", "messageType", "success", "queueWaitMs", "modelMs", "indexMs", "totalMs"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([r.ts, r.sessionDbId, r.messageId, r.messageType, r.success, r.queueWaitMs, r.modelMs, r.indexMs, r.totalMs].map(escapeCsvCell).join(","));
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.send(lines.join("\n"));
});

app.get("/api/ops/failure-summary", (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit ?? 30), 300));
  const sessionDbId = req.query.sessionDbId ? Number(req.query.sessionDbId) : undefined;
  const errorClass = req.query.errorClass ? String(req.query.errorClass) : undefined;
  const messageType = req.query.messageType ? String(req.query.messageType) : undefined;
  const fromEpoch = parseEpochInput(req.query.from);
  const toEpoch = parseEpochInput(req.query.to);
  const filtered = filterFailureRecords({
    sessionDbId: Number.isInteger(sessionDbId) ? sessionDbId : undefined,
    errorClass,
    messageType,
    fromEpoch,
    toEpoch
  });
  const recent = filtered.slice(0, limit);
  const byClass: Record<string, number> = {};
  for (const row of filtered) {
    byClass[row.errorClass] = (byClass[row.errorClass] || 0) + 1;
  }
  const classes = Object.entries(byClass)
    .sort((a, b) => b[1] - a[1])
    .map(([errorClass, count]) => ({ errorClass, count }));

  res.json({
    summary: {
      total: filtered.length,
      classes
    },
    recent,
    filters: { sessionDbId: Number.isInteger(sessionDbId) ? sessionDbId : null, errorClass: errorClass || "", messageType: messageType || "", fromEpoch, toEpoch }
  });
});

app.get("/api/ops/failure-summary/export", (req, res) => {
  const format = req.query.format ? String(req.query.format).toLowerCase() : "csv";
  const sessionDbId = req.query.sessionDbId ? Number(req.query.sessionDbId) : undefined;
  const errorClass = req.query.errorClass ? String(req.query.errorClass) : undefined;
  const messageType = req.query.messageType ? String(req.query.messageType) : undefined;
  const fromEpoch = parseEpochInput(req.query.from);
  const toEpoch = parseEpochInput(req.query.to);
  const rows = filterFailureRecords({
    sessionDbId: Number.isInteger(sessionDbId) ? sessionDbId : undefined,
    errorClass,
    messageType,
    fromEpoch,
    toEpoch
  });
  if (format === "ndjson") {
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.send(rows.map((r) => JSON.stringify(r)).join("\n"));
    return;
  }

  const header = ["ts", "sessionDbId", "messageId", "messageType", "errorClass", "error"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([r.ts, r.sessionDbId, r.messageId, r.messageType, r.errorClass, r.error].map(escapeCsvCell).join(","));
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.send(lines.join("\n"));
});

app.get("/api/ops/trends", (req, res) => {
  const windowSec = Math.max(60, Math.min(Number(req.query.windowSec ?? 3600), 86400));
  const bucketSec = Math.max(10, Math.min(Number(req.query.bucketSec ?? 60), 3600));
  const now = Date.now();
  const start = now - windowSec * 1000;
  const bucketCount = Math.ceil(windowSec / bucketSec);

  const buckets = Array.from({ length: bucketCount }, (_, i) => {
    const from = start + i * bucketSec * 1000;
    const to = Math.min(now, from + bucketSec * 1000);
    return {
      from,
      to,
      ts: new Date(from).toISOString(),
      searchCount: 0,
      avgSearchMs: 0,
      queueCount: 0,
      avgQueueTotalMs: 0,
      failureCount: 0
    };
  });

  for (const row of searchTraces) {
    const ts = Date.parse(row.ts);
    if (!Number.isFinite(ts) || ts < start || ts > now) continue;
    const idx = Math.min(buckets.length - 1, Math.max(0, Math.floor((ts - start) / (bucketSec * 1000))));
    const b = buckets[idx];
    b.searchCount += 1;
    b.avgSearchMs += row.durationMs;
  }
  for (const row of sessionTimings) {
    const ts = Date.parse(row.ts);
    if (!Number.isFinite(ts) || ts < start || ts > now) continue;
    const idx = Math.min(buckets.length - 1, Math.max(0, Math.floor((ts - start) / (bucketSec * 1000))));
    const b = buckets[idx];
    b.queueCount += 1;
    b.avgQueueTotalMs += row.totalMs;
  }
  for (const row of failureRecords) {
    const ts = Date.parse(row.ts);
    if (!Number.isFinite(ts) || ts < start || ts > now) continue;
    const idx = Math.min(buckets.length - 1, Math.max(0, Math.floor((ts - start) / (bucketSec * 1000))));
    buckets[idx].failureCount += 1;
  }

  for (const b of buckets) {
    b.avgSearchMs = b.searchCount > 0 ? Number((b.avgSearchMs / b.searchCount).toFixed(2)) : 0;
    b.avgQueueTotalMs = b.queueCount > 0 ? Number((b.avgQueueTotalMs / b.queueCount).toFixed(2)) : 0;
  }

  res.json({ windowSec, bucketSec, buckets });
});

app.post("/api/ops/retry-failed", async (req, res) => {
  const { sessionDbId } = req.body as { sessionDbId?: number };
  if (sessionDbId !== undefined && !Number.isInteger(sessionDbId)) {
    badRequest(res, "sessionDbId must be an integer");
    return;
  }

  const changed = store.retryFailed(sessionDbId);
  emitQueueDepth();
  if (changed > 0) {
    if (typeof sessionDbId === "number") {
      await processSessionQueue(sessionDbId);
    } else {
      const sessions = store.getSessionsWithPendingMessages();
      for (const sid of sessions) {
        await processSessionQueue(sid);
      }
    }
  }

  res.json({ success: true, retried: changed });
});

app.post("/api/ops/backfill/chroma", async (req, res) => {
  const { project, limit } = req.body as { project?: string; limit?: number };
  if (limit !== undefined && !Number.isInteger(limit)) {
    badRequest(res, "limit must be an integer");
    return;
  }

  try {
    const result = await runChromaBackfill(project, limit ?? 1000);
    res.json({ success: true, ...result, project: project || null });
  } catch (error) {
    logger.error("WORKER", "chroma backfill failed", { error: String(error), project, limit });
    res.status(500).json({ error: "backfill_failed", detail: String(error) });
  }
});

app.get("/api/context/inject", (req, res) => {
  const projectsParam = (req.query.projects as string) || (req.query.project as string);
  if (!projectsParam) {
    badRequest(res, "Project(s) parameter is required");
    return;
  }

  const projects = projectsParam.split(",").map((x) => x.trim()).filter(Boolean);
  const lines: string[] = [];
  lines.push("MEMORY CONTEXT");
  lines.push("============");

  for (const project of projects) {
    const { items } = store.listObservations(0, 10, project);
    store.touchMemoryAccess({ observationIds: items.map((x) => Number(x.id)).filter((x) => Number.isInteger(x)), projects: [project] });
    lines.push(`Project: ${project}`);
    if (items.length === 0) {
      lines.push("- No observations yet.");
    } else {
      for (const row of items) {
        lines.push(`- #${row.id} [${row.type}] ${row.title || "(untitled)"}`);
      }
    }
    lines.push("");
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(lines.join("\n"));
});

app.get("/api/search", async (req, res) => {
  const traceStart = Date.now();
  const query = req.query.query ? String(req.query.query) : undefined;
  const limit = Math.max(1, Math.min(Number(req.query.limit ?? 20), 100));
  const offset = Math.max(0, Number(req.query.offset ?? 0));
  const project = req.query.project ? String(req.query.project) : undefined;
  const typeTokens = toStringArray(req.query.type);
  const obsTypeTokens = toStringArray(req.query.obs_type);
  const allTypeTokens = [...typeTokens, ...obsTypeTokens].map((x) => x.toLowerCase());
  const orderBy = req.query.orderBy ? (String(req.query.orderBy) as "relevance" | "date_desc" | "date_asc") : undefined;
  const dateStartEpoch = parseEpochInput(req.query.dateStart);
  const dateEndEpoch = parseEpochInput(req.query.dateEnd);
  const format = req.query.format ? String(req.query.format).toLowerCase() : undefined;

  const kindSet = new Set<string>(["observations", "observation", "sessions", "session", "prompts", "prompt"]);
  const hasKindSpecifier = allTypeTokens.some((t) => kindSet.has(t));
  const includeObservations = hasKindSpecifier ? allTypeTokens.includes("observations") || allTypeTokens.includes("observation") : true;
  const includeSessions = hasKindSpecifier ? allTypeTokens.includes("sessions") || allTypeTokens.includes("session") : true;
  const includePrompts = hasKindSpecifier ? allTypeTokens.includes("prompts") || allTypeTokens.includes("prompt") : true;
  const obsTypes = allTypeTokens.filter((t) => !kindSet.has(t));

  const lexical = store.search({
    query,
    limit,
    offset,
    project,
    includeObservations,
    includeSessions,
    includePrompts,
    obsTypes,
    dateStartEpoch,
    dateEndEpoch,
    orderBy
  });
  let searchMode: "lexical-only" | "hybrid" = "lexical-only";
  let observations = lexical.observations;
  let sessions = lexical.sessions;
  let prompts = lexical.prompts;
  let sqliteObservationHits = 0;
  let chromaObservationHits = 0;
  let chromaSummaryHits = 0;
  let chromaPromptHits = 0;

  if (query) {
    const vectorObservationIds: number[] = [];
    const vectorSummaryIds: number[] = [];
    const vectorPromptIds: number[] = [];

    if (includeObservations && isSqliteVectorEnabled() && semanticSearch.isAvailable()) {
      const semanticIds = await semanticSearch.findObservationIds(store, query, project, limit);
      sqliteObservationHits = semanticIds.length;
      vectorObservationIds.push(...semanticIds);
    }

    if (isChromaVectorEnabled() && chromaSearch.isConfigured()) {
      const chromaIds = await chromaSearch.queryIds(query, project, limit);
      chromaObservationHits = chromaIds.observations.length;
      chromaSummaryHits = chromaIds.summaries.length;
      chromaPromptHits = chromaIds.prompts.length;
      if (includeObservations) vectorObservationIds.push(...chromaIds.observations);
      if (includeSessions) vectorSummaryIds.push(...chromaIds.summaries);
      if (includePrompts) vectorPromptIds.push(...chromaIds.prompts);
    }

    if (vectorObservationIds.length > 0) {
      const vectorRows = store.getObservationsByIds(vectorObservationIds, {
        orderBy: "date_desc",
        limit,
        project,
        obsTypes,
        dateStartEpoch,
        dateEndEpoch
      });
      observations = mergeRowsWithPriority(vectorRows, lexical.observations, limit);
      searchMode = "hybrid";
    }

    if (vectorSummaryIds.length > 0) {
      const vectorRows = store.getSummariesByIds(vectorSummaryIds, {
        orderBy: "date_desc",
        limit,
        project,
        dateStartEpoch,
        dateEndEpoch
      });
      sessions = mergeRowsWithPriority(vectorRows, lexical.sessions, limit);
      searchMode = "hybrid";
    }

    if (vectorPromptIds.length > 0) {
      const vectorRows = store.getPromptsByIds(vectorPromptIds, {
        orderBy: "date_desc",
        limit,
        project,
        dateStartEpoch,
        dateEndEpoch
      });
      prompts = mergeRowsWithPriority(vectorRows, lexical.prompts, limit);
      searchMode = "hybrid";
    }
  }

  const result = {
    observations,
    sessions,
    prompts
  };
  store.touchMemoryAccess({
    observationIds: observations.map((x) => Number(x.id)).filter((x) => Number.isInteger(x)),
    summaryIds: sessions.map((x) => Number(x.id)).filter((x) => Number.isInteger(x)),
    promptIds: prompts.map((x) => Number(x.id)).filter((x) => Number.isInteger(x)),
    projects: project ? [project] : []
  });
  pushBounded(
    searchTraces,
    {
      ts: new Date().toISOString(),
      query: query || "",
      project,
      limit,
      offset,
      orderBy,
      mode: searchMode,
      lexicalCounts: {
        observations: lexical.observations.length,
        sessions: lexical.sessions.length,
        prompts: lexical.prompts.length
      },
      vectorHits: {
        sqliteObservations: sqliteObservationHits,
        chromaObservations: chromaObservationHits,
        chromaSummaries: chromaSummaryHits,
        chromaPrompts: chromaPromptHits
      },
      resultCounts: {
        observations: observations.length,
        sessions: sessions.length,
        prompts: prompts.length
      },
      durationMs: Date.now() - traceStart
    },
    MAX_SEARCH_TRACES
  );
  if (format === "json") {
    res.json({ searchMode, ...result });
    return;
  }
  const text = formatSearchText(query, result, searchMode);
  res.json({ content: [{ type: "text", text }] });
});

app.get("/api/timeline", (req, res) => {
  const anchor = req.query.anchor ? Number(req.query.anchor) : null;
  const query = req.query.query ? String(req.query.query) : undefined;
  const depthBefore = req.query.depth_before ? Number(req.query.depth_before) : 3;
  const depthAfter = req.query.depth_after ? Number(req.query.depth_after) : 3;
  const project = req.query.project ? String(req.query.project) : undefined;

  let anchorId: number | null = anchor;
  if (!anchorId && query) {
    const searchResult = store.search({ query, project, limit: 1, offset: 0 });
    anchorId = searchResult.observations[0]?.id ?? null;
  }

  if (!anchorId) {
    res.json({ content: [{ type: "text", text: "No timeline anchor found." }] });
    return;
  }

  const anchorRow = store.getObservationById(anchorId);
  if (!anchorRow) {
    res.json({ content: [{ type: "text", text: `Anchor #${anchorId} not found.` }] });
    return;
  }

  const before = store.db
    .query(
      `SELECT * FROM observations WHERE created_at_epoch < ? ${project ? "AND project = ?" : ""} ORDER BY created_at_epoch DESC LIMIT ?`
    )
    .all(anchorRow.created_at_epoch, ...(project ? [project] : []), depthBefore) as any[];

  const after = store.db
    .query(
      `SELECT * FROM observations WHERE created_at_epoch > ? ${project ? "AND project = ?" : ""} ORDER BY created_at_epoch ASC LIMIT ?`
    )
    .all(anchorRow.created_at_epoch, ...(project ? [project] : []), depthAfter) as any[];

  const items = [...before.reverse(), anchorRow, ...after];
  store.touchMemoryAccess({
    observationIds: items.map((x) => Number(x.id)).filter((x) => Number.isInteger(x)),
    projects: project ? [project] : [anchorRow.project].filter(Boolean)
  });
  const text = formatTimelineText(items, anchorId, depthBefore, depthAfter);
  res.json({ content: [{ type: "text", text }] });
});

app.post("/api/memory/save", async (req, res) => {
  const { text, title, project } = req.body as { text?: string; title?: string; project?: string };
  if (!text || typeof text !== "string" || !text.trim()) {
    badRequest(res, "text is required and must be non-empty");
    return;
  }

  const targetProject = project || "codexmem";
  const memorySessionId = store.getOrCreateManualSession(targetProject);
  const id = store.storeObservation(memorySessionId, targetProject, {
    type: "discovery",
    title: title || text.slice(0, 60),
    subtitle: "Manual memory",
    facts: [],
    narrative: text,
    concepts: [],
    files_read: [],
    files_modified: []
  }, 0);

  try {
    const vectorText = [title || text.slice(0, 60), text].filter(Boolean).join("\n");
    if (isSqliteVectorEnabled()) {
      await semanticSearch.indexObservation(store, id, targetProject, vectorText);
    }
    if (isChromaVectorEnabled()) {
      await chromaSearch.indexObservation(id, targetProject, vectorText, Date.now());
    }
  } catch (error) {
    logger.warn("WORKER", "Failed to index manual memory vectors", { id, project: targetProject, error: String(error) });
  }

  res.json({ success: true, id, title: title || text.slice(0, 60), project: targetProject, message: `Memory saved as observation #${id}` });
});

async function bootstrap(): Promise<void> {
  initialized = false;
  const settings = loadSettings();
  const autoRecoverOnBoot = isTruthySetting(settings.CODEXMEM_AUTO_RECOVER_ON_BOOT);
  if (autoRecoverOnBoot) {
    const staleMs = Number(settings.CODEXMEM_STALE_PROCESSING_MS || "300000");
    store.resetStaleProcessing(staleMs);
    const sessions = store.getSessionsWithPendingMessages();
    for (const sid of sessions) {
      await processSessionQueue(sid);
    }
  }

  const retentionCfg = readRetentionSettings();
  if (retentionCfg.enabled) {
    try {
      await runRetentionSweep(false);
    } catch (error) {
      logger.error("RETENTION", "Initial retention sweep failed", { error: String(error) });
    }
    const intervalMs = retentionCfg.sweepIntervalMin * 60 * 1000;
    retentionSweepTimer = setInterval(() => {
      runRetentionSweep(false).catch((error) => {
        logger.error("RETENTION", "Scheduled retention sweep failed", { error: String(error) });
      });
    }, intervalMs);
    retentionSweepTimer.unref();
  }

  initialized = true;
  const host = getWorkerHost();
  const port = getWorkerPort();
  app.listen(port, host, () => {
    logger.info("WORKER", "codexmem worker started", {
      host,
      port,
      pid: process.pid,
      provider: activeAgent.name
    });
  });
}

bootstrap().catch((error) => {
  logger.error("WORKER", "Bootstrap failed", String(error));
  process.exit(1);
});

process.on("SIGINT", () => {
  if (retentionSweepTimer) clearInterval(retentionSweepTimer);
  store.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  if (retentionSweepTimer) clearInterval(retentionSweepTimer);
  store.close();
  process.exit(0);
});

export function setMcpReady(ready: boolean): void {
  mcpReady = ready;
}
