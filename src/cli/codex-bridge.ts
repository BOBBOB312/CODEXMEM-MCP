import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getWorkerPort } from "../lib/config.js";

type Args = Record<string, string>;

type BridgeFileState = {
  offset: number;
  sessionId?: string;
  cwd?: string;
};

type PendingCall = {
  name?: string;
  args?: string;
};

type BridgeSessionState = {
  initialized: boolean;
  completed: boolean;
  lastActivityEpoch: number;
  lastAssistantMessage?: string;
  pendingCalls: Record<string, PendingCall>;
};

type BridgeState = {
  files: Record<string, BridgeFileState>;
  sessions: Record<string, BridgeSessionState>;
};

const DEFAULT_POLL_MS = 1500;
const DEFAULT_IDLE_SEC = 45;
const DEFAULT_LOOKBACK_HOURS = 48;

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
      "  bun run src/cli/codex-bridge.ts [--once] [--poll-ms 1500] [--idle-sec 45]",
      "                                 [--sessions-dir ~/.codex/sessions]",
      "                                 [--state-file ~/.codexmem/codex-bridge-state.json]",
      "                                 [--lookback-hours 48]"
    ].join("\n")
  );
}

function nowEpoch(): number {
  return Date.now();
}

function parseIsoEpoch(text: unknown): number {
  if (typeof text !== "string" || !text) return nowEpoch();
  const t = Date.parse(text);
  return Number.isFinite(t) ? t : nowEpoch();
}

function toBool(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function trimText(value: unknown, max = 12_000): string {
  const t = String(value ?? "");
  return t.length <= max ? t : `${t.slice(0, max)}\n...[truncated]`;
}

function shouldSkipBootstrapPrompt(prompt: string): boolean {
  const t = prompt.trim();
  if (!t) return true;
  if (t.includes("AGENTS.md instructions")) return true;
  if (t.includes("<environment_context>")) return true;
  if (t.includes("<permissions instructions>")) return true;
  return false;
}

function extractMessageText(payload: any, role: "user" | "assistant"): string {
  if (!payload || payload.type !== "message" || payload.role !== role) return "";
  const content = Array.isArray(payload.content) ? payload.content : [];
  const texts: string[] = [];
  for (const part of content) {
    if (part?.type === "input_text" || part?.type === "output_text") {
      texts.push(String(part?.text || ""));
    }
  }
  return texts.join("\n").trim();
}

function parseCallArgs(argsRaw: string | undefined): unknown {
  if (!argsRaw || !argsRaw.trim()) return {};
  try {
    return JSON.parse(argsRaw);
  } catch {
    return { raw: argsRaw };
  }
}

function getProjectFromCwd(cwd: string): string {
  const base = path.basename(cwd || "");
  return base || "unknown";
}

function parseSessionIdFromFile(filePath: string): string {
  const name = path.basename(filePath);
  const m = name.match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i);
  return m?.[1] || `codex-${name}`;
}

function collectSessionFiles(root: string, lookbackHours: number): string[] {
  const files: string[] = [];
  const cutoff = nowEpoch() - lookbackHours * 3600_000;

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!e.isFile() || !full.endsWith(".jsonl")) continue;
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs >= cutoff) files.push(full);
      } catch {
        // ignore
      }
    }
  }

  walk(root);
  files.sort();
  return files;
}

async function postWorker(pathname: string, body: Record<string, unknown>): Promise<boolean> {
  const port = getWorkerPort();
  const url = `http://127.0.0.1:${port}${pathname}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function workerHealthy(): Promise<boolean> {
  const port = getWorkerPort();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

function ensureSessionState(state: BridgeState, sessionId: string): BridgeSessionState {
  if (!state.sessions[sessionId]) {
    state.sessions[sessionId] = {
      initialized: false,
      completed: false,
      lastActivityEpoch: 0,
      pendingCalls: {}
    };
  }
  return state.sessions[sessionId];
}

async function processLine(
  state: BridgeState,
  filePath: string,
  fileState: BridgeFileState,
  line: string
): Promise<void> {
  let item: any;
  try {
    item = JSON.parse(line);
  } catch {
    return;
  }

  const topType = item?.type;
  const payload = item?.payload;
  if (!payload || typeof payload !== "object") return;

  if (topType === "session_meta") {
    fileState.sessionId = String(payload.id || fileState.sessionId || parseSessionIdFromFile(filePath));
    fileState.cwd = String(payload.cwd || fileState.cwd || process.cwd());
    ensureSessionState(state, fileState.sessionId);
    return;
  }

  const sessionId = fileState.sessionId || parseSessionIdFromFile(filePath);
  const cwd = fileState.cwd || process.cwd();
  const session = ensureSessionState(state, sessionId);
  const eventTs = parseIsoEpoch(item?.timestamp);
  session.lastActivityEpoch = Math.max(session.lastActivityEpoch, eventTs);
  if (session.completed) {
    session.completed = false;
  }

  if (topType !== "response_item") return;

  if (payload.type === "message" && payload.role === "user") {
    const prompt = extractMessageText(payload, "user");
    if (!session.initialized && !shouldSkipBootstrapPrompt(prompt)) {
      const ok = await postWorker("/api/sessions/init", {
        contentSessionId: sessionId,
        project: getProjectFromCwd(cwd),
        prompt: prompt || "[codex prompt]"
      });
      if (ok) session.initialized = true;
    }
    return;
  }

  if (!session.initialized) return;

  if (payload.type === "function_call") {
    const callId = String(payload.call_id || "");
    if (callId) {
      session.pendingCalls[callId] = {
        name: payload.name ? String(payload.name) : undefined,
        args: payload.arguments ? String(payload.arguments) : undefined
      };
    }
    return;
  }

  if (payload.type === "function_call_output") {
    const callId = String(payload.call_id || "");
    const call = callId ? session.pendingCalls[callId] : undefined;
    const toolName = call?.name || "ToolCall";
    const toolInput = parseCallArgs(call?.args);
    const toolResponse = { output: trimText(payload.output) };
    await postWorker("/api/sessions/observations", {
      contentSessionId: sessionId,
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: toolResponse,
      cwd
    });
    if (callId) delete session.pendingCalls[callId];
    return;
  }

  if (payload.type === "message" && payload.role === "assistant" && payload.phase === "final_answer") {
    const text = extractMessageText(payload, "assistant");
    if (text) {
      session.lastAssistantMessage = trimText(text, 16_000);
    }
  }
}

async function processFile(state: BridgeState, filePath: string): Promise<void> {
  const stat = fs.statSync(filePath);
  const prev = state.files[filePath] || { offset: 0 };
  if (prev.offset > stat.size) prev.offset = 0;
  const len = stat.size - prev.offset;
  if (len <= 0) {
    state.files[filePath] = prev;
    return;
  }

  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, prev.offset);
  fs.closeSync(fd);

  const chunk = buf.toString("utf-8");
  const lines = chunk.split("\n").filter((x) => x.trim().length > 0);
  for (const line of lines) {
    await processLine(state, filePath, prev, line);
  }

  prev.offset = stat.size;
  state.files[filePath] = prev;
}

async function flushIdleSessions(state: BridgeState, idleSec: number): Promise<void> {
  const now = nowEpoch();
  for (const [sessionId, s] of Object.entries(state.sessions)) {
    if (!s.initialized || s.completed) continue;
    if (now - s.lastActivityEpoch < idleSec * 1000) continue;

    const summaryText = s.lastAssistantMessage || "Codex session reached idle timeout; summarize recent progress.";
    await postWorker("/api/sessions/summarize", {
      contentSessionId: sessionId,
      last_assistant_message: summaryText
    });
    await postWorker("/api/sessions/end", {
      contentSessionId: sessionId,
      cleanup: true
    });
    s.completed = true;
  }
}

export async function runCodexBridge(args: Args): Promise<number> {
  const once = toBool(args.once);
  const pollMs = Math.max(500, Number(args["poll-ms"] || DEFAULT_POLL_MS));
  const idleSec = Math.max(5, Number(args["idle-sec"] || DEFAULT_IDLE_SEC));
  const lookbackHours = Math.max(1, Number(args["lookback-hours"] || DEFAULT_LOOKBACK_HOURS));
  const sessionsDir = args["sessions-dir"] || path.join(os.homedir(), ".codex", "sessions");
  const stateFile = args["state-file"] || path.join(os.homedir(), ".codexmem", "codex-bridge-state.json");
  const verbose = toBool(args.verbose);

  if (!(await workerHealthy())) {
    console.error("[codexmem] worker unavailable, codex bridge will not start");
    return 1;
  }

  const state = readJsonFile<BridgeState>(stateFile, { files: {}, sessions: {} });

  async function tick(): Promise<void> {
    const files = collectSessionFiles(sessionsDir, lookbackHours);
    for (const f of files) {
      await processFile(state, f);
    }
    await flushIdleSessions(state, idleSec);
    writeJsonFile(stateFile, state);
    if (verbose) {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          files: files.length,
          sessions: Object.keys(state.sessions).length
        })
      );
    }
  }

  if (once) {
    await tick();
    return 0;
  }

  console.log(`[codexmem] codex bridge started (sessions=${sessionsDir}, pollMs=${pollMs}, idleSec=${idleSec})`);
  for (;;) {
    try {
      await tick();
    } catch (error) {
      console.error(`[codexmem] codex bridge tick error: ${String(error)}`);
    }
    await Bun.sleep(pollMs);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (toBool(args.help)) {
    usage();
    process.exit(0);
  }
  const code = await runCodexBridge(args);
  process.exit(code);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`[codexmem] codex bridge fatal: ${String(error)}`);
    process.exit(2);
  });
}
