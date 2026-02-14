import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

setDefaultTimeout(30_000);

let worker: ReturnType<typeof Bun.spawn> | null = null;
let mcpTransport: StdioClientTransport | null = null;
let mcpClient: Client | null = null;
let baseUrl = "";
let dataDir = "";

function randomPort(): number {
  return 39000 + Math.floor(Math.random() * 2000);
}

async function waitForHealth(url: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await Bun.sleep(150);
  }
  throw new Error("Worker health check timeout");
}

function extractText(result: any): string {
  const first = result?.content?.[0];
  if (!first) return "";
  if (typeof first.text === "string") return first.text;
  return "";
}

beforeAll(async () => {
  const port = randomPort();
  baseUrl = `http://127.0.0.1:${port}`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexmem-mcp-e2e-"));
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

  worker = Bun.spawn([process.execPath, "run", "src/worker/server.ts"], {
    cwd: path.resolve(path.join(import.meta.dir, "..")),
    env: { ...process.env, CODEXMEM_DATA_DIR: dataDir },
    stdout: "pipe",
    stderr: "pipe"
  });

  await waitForHealth(baseUrl);

  mcpClient = new Client({
    name: "codexmem-mcp-e2e-client",
    version: "1.0.0"
  });
  mcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", "src/mcp/server.ts"],
    cwd: path.resolve(path.join(import.meta.dir, "..")),
    env: { ...process.env, CODEXMEM_DATA_DIR: dataDir },
    stderr: "pipe"
  });
  await mcpClient.connect(mcpTransport);
});

afterAll(async () => {
  if (mcpTransport) {
    await mcpTransport.close();
  }
  if (worker) {
    worker.kill();
    await worker.exited;
  }
  if (dataDir) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

describe("mcp e2e", () => {
  test("tools/list contains exact 5 tools", async () => {
    const result = await mcpClient!.listTools();
    const names = result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(["__IMPORTANT", "get_observations", "save_memory", "search", "timeline"].sort());
  });

  test("5 tools full workflow", async () => {
    const important = await mcpClient!.callTool({ name: "__IMPORTANT", arguments: {} });
    const importantText = extractText(important);
    expect(importantText.includes("search")).toBe(true);
    expect(importantText.includes("timeline")).toBe(true);
    expect(importantText.includes("get_observations")).toBe(true);

    const save = await mcpClient!.callTool({
      name: "save_memory",
      arguments: { text: "mcp-e2e memory text", title: "MCP E2E Title", project: "mcp-e2e" }
    });
    const savePayload = JSON.parse(extractText(save));
    expect(savePayload.success).toBe(true);
    expect(Number.isInteger(savePayload.id)).toBe(true);
    const obsId = savePayload.id as number;

    const search = await mcpClient!.callTool({
      name: "search",
      arguments: { query: "MCP E2E Title", project: "mcp-e2e", limit: 10 }
    });
    const searchText = extractText(search);
    expect(searchText.includes("Found")).toBe(true);

    const timeline = await mcpClient!.callTool({
      name: "timeline",
      arguments: { anchor: obsId, project: "mcp-e2e", depth_before: 1, depth_after: 1 }
    });
    const timelineText = extractText(timeline);
    expect(timelineText.includes("Timeline")).toBe(true);

    const details = await mcpClient!.callTool({
      name: "get_observations",
      arguments: { ids: [obsId] }
    });
    const rows = JSON.parse(extractText(details));
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(obsId);
  });
});
