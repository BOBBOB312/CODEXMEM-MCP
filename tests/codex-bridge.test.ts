import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let dataDir = "";
let sessionsDir = "";
let stateFile = "";
let workerPort = 0;
let stopServer: (() => void) | null = null;
const recorded: Array<{ pathname: string; body: any }> = [];

function randomPort(): number {
  return 41000 + Math.floor(Math.random() * 2000);
}

function writeSettings(dir: string, port: number): void {
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify(
      {
        CODEXMEM_WORKER_HOST: "127.0.0.1",
        CODEXMEM_WORKER_PORT: String(port),
        CODEXMEM_PROVIDER: "rule-based"
      },
      null,
      2
    ),
    "utf-8"
  );
}

function writeSessionFile(root: string): string {
  const d = path.join(root, "2026", "02", "14");
  fs.mkdirSync(d, { recursive: true });
  const sessionId = "11111111-2222-4333-8444-555555555555";
  const file = path.join(d, `rollout-2026-02-14T00-00-00-${sessionId}.jsonl`);
  const lines = [
    {
      timestamp: "2026-02-14T00:00:00.000Z",
      type: "session_meta",
      payload: { id: sessionId, cwd: "/tmp/codex-bridge-project" }
    },
    {
      timestamp: "2026-02-14T00:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "请检查认证模块并修复" }]
      }
    },
    {
      timestamp: "2026-02-14T00:00:02.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: "{\"cmd\":\"rg -n auth src\"}",
        call_id: "call-a"
      }
    },
    {
      timestamp: "2026-02-14T00:00:03.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-a",
        output: "src/auth.ts:12: missing null guard"
      }
    },
    {
      timestamp: "2026-02-14T00:00:04.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "已修复 null guard 并建议回归测试。" }]
      }
    }
  ];
  fs.writeFileSync(file, lines.map((x) => JSON.stringify(x)).join("\n") + "\n", "utf-8");
  return file;
}

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexmem-codex-bridge-data-"));
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexmem-codex-bridge-sessions-"));
  stateFile = path.join(dataDir, "bridge-state.json");
  workerPort = randomPort();
  writeSettings(dataDir, workerPort);
  writeSessionFile(sessionsDir);

  const server = Bun.serve({
    port: workerPort,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/health") {
        return Response.json({ status: "ok" }, { status: 200 });
      }
      if (req.method === "POST") {
        let body: any = {};
        try {
          body = await req.json();
        } catch {
          // ignore
        }
        recorded.push({ pathname: url.pathname, body });
        return Response.json({ ok: true }, { status: 200 });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    }
  });
  stopServer = () => server.stop();
});

afterAll(() => {
  if (stopServer) stopServer();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  if (sessionsDir) fs.rmSync(sessionsDir, { recursive: true, force: true });
});

describe("codex bridge", () => {
  test("one-shot bridge emits init/observation/summarize/session-end", async () => {
    recorded.length = 0;

    const proc = Bun.spawn([process.execPath, "run", "src/cli/codex-bridge.ts", "--once", "--idle-sec", "5", "--sessions-dir", sessionsDir, "--state-file", stateFile], {
      cwd: path.resolve(path.join(import.meta.dir, "..")),
      env: {
        ...process.env,
        CODEXMEM_DATA_DIR: dataDir
      },
      stdout: "pipe",
      stderr: "pipe"
    });

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    expect(code).toBe(0);
    expect(stderr.includes("worker unavailable")).toBe(false);
    expect(stdout.length >= 0).toBe(true);

    const paths = recorded.map((x) => x.pathname);
    expect(paths.includes("/api/sessions/init")).toBe(true);
    expect(paths.includes("/api/sessions/observations")).toBe(true);
    expect(paths.includes("/api/sessions/summarize")).toBe(true);
    expect(paths.includes("/api/sessions/end")).toBe(true);
  });
});
