import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

setDefaultTimeout(30_000);

type HookEvent = "session-init" | "observation" | "summarize" | "session-complete" | "session-end";
type Platform = "claude-code" | "cursor" | "codex" | "raw";

type RecordedRequest = {
  method: string;
  pathname: string;
  body: any;
};

let dataDir = "";
let workerPort = 0;
let stopServer: (() => void) | null = null;
const recorded: RecordedRequest[] = [];

function randomPort(): number {
  return 39000 + Math.floor(Math.random() * 2000);
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

async function runHook(platform: Platform, event: HookEvent, input: unknown, customDataDir?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "run", "src/cli/index.ts", "hook", platform, event], {
    cwd: path.resolve(path.join(import.meta.dir, "..")),
    env: {
      ...process.env,
      CODEXMEM_DATA_DIR: customDataDir ?? dataDir
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe"
  });

  proc.stdin.write(`${JSON.stringify(input)}\n`);
  proc.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);

  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

function buildInput(platform: Platform, event: HookEvent): any {
  if (platform === "claude-code") {
    return {
      session_id: "sess-claude-1",
      cwd: "/tmp/project-a",
      prompt: event === "session-init" ? "hello claude" : undefined,
      tool_name: event === "observation" ? "Read" : undefined,
      tool_input: event === "observation" ? { file: "a.ts" } : undefined,
      tool_response: event === "observation" ? { ok: true } : undefined,
      transcript_path: event === "summarize" ? "/tmp/not-exist.ndjson" : undefined
    };
  }

  if (platform === "cursor") {
    if (event === "observation") {
      return {
        conversation_id: "sess-cursor-1",
        workspace_roots: ["/tmp/project-b"],
        command: "ls -la",
        output: "file1\nfile2"
      };
    }

    return {
      conversation_id: "sess-cursor-1",
      workspace_roots: ["/tmp/project-b"],
      prompt: event === "session-init" ? "hello cursor" : undefined
    };
  }

  if (platform === "codex") {
    if (event === "observation") {
      return {
        session_id: "sess-codex-1",
        cwd: "/tmp/project-d",
        command: "rg -n hello src",
        output: "src/a.ts:1:hello"
      };
    }
    if (event === "summarize") {
      return {
        session_id: "sess-codex-1",
        cwd: "/tmp/project-d",
        output: "已完成代码检查并给出修复建议。"
      };
    }
    return {
      session_id: "sess-codex-1",
      cwd: "/tmp/project-d",
      prompt: event === "session-init" ? "hello codex" : undefined
    };
  }

  return {
    sessionId: "sess-raw-1",
    cwd: "/tmp/project-c",
    prompt: event === "session-init" ? "hello raw" : undefined,
    toolName: event === "observation" ? "Edit" : undefined,
    toolInput: event === "observation" ? { file: "b.ts" } : undefined,
    toolResponse: event === "observation" ? { changed: true } : undefined,
    transcriptPath: event === "summarize" ? "/tmp/not-exist.ndjson" : undefined
  };
}

function expectedPath(event: HookEvent): string {
  switch (event) {
    case "session-init":
      return "/api/sessions/init";
    case "observation":
      return "/api/sessions/observations";
    case "summarize":
      return "/api/sessions/summarize";
    case "session-complete":
      return "/api/sessions/complete";
    case "session-end":
      return "/api/sessions/end";
  }
}

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexmem-hook-matrix-"));
  workerPort = randomPort();
  writeSettings(dataDir, workerPort);

  const server = Bun.serve({
    port: workerPort,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/health") {
        return Response.json({ status: "ok" }, { status: 200 });
      }

      if (req.method === "POST") {
        const body = await req.json();
        recorded.push({
          method: req.method,
          pathname: url.pathname,
          body
        });
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
});

describe("hook matrix", () => {
  const events: HookEvent[] = ["session-init", "observation", "summarize", "session-complete", "session-end"];
  const platforms: Platform[] = ["claude-code", "cursor", "codex", "raw"];

  for (const platform of platforms) {
    for (const event of events) {
      test(`${platform} x ${event}`, async () => {
        recorded.length = 0;
        const input = buildInput(platform, event);
        const result = await runHook(platform, event, input);

        expect(result.exitCode).toBe(0);
        expect(recorded.length).toBe(1);
        expect(recorded[0].pathname).toBe(expectedPath(event));

        if (event === "session-init") {
          expect(typeof recorded[0].body.contentSessionId).toBe("string");
          expect(typeof recorded[0].body.project).toBe("string");
          expect(typeof recorded[0].body.prompt).toBe("string");
        }
        if (event === "observation") {
          expect(typeof recorded[0].body.contentSessionId).toBe("string");
          expect(typeof recorded[0].body.tool_name).toBe("string");
          expect(recorded[0].body.cwd).toBeTruthy();
        }
        if (event === "summarize") {
          expect(typeof recorded[0].body.contentSessionId).toBe("string");
          expect(typeof recorded[0].body.last_assistant_message).toBe("string");
        }
        if (event === "session-complete") {
          expect(typeof recorded[0].body.contentSessionId).toBe("string");
        }
        if (event === "session-end") {
          expect(typeof recorded[0].body.contentSessionId).toBe("string");
          expect(recorded[0].body.cleanup).toBe(true);
        }
      });
    }
  }

  test("worker unavailable still exits 0", async () => {
    const unavailableDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexmem-hook-unavailable-"));
    const unavailablePort = randomPort();
    writeSettings(unavailableDir, unavailablePort);

    const result = await runHook("raw", "observation", buildInput("raw", "observation"), unavailableDir);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.includes("hook error")).toBe(false);

    fs.rmSync(unavailableDir, { recursive: true, force: true });
  });
});
