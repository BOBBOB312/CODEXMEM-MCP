import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { getWorkerHost, getWorkerPort } from "../lib/config.js";
import { logger } from "../lib/logger.js";

const WORKER_BASE_URL = `http://${getWorkerHost()}:${getWorkerPort()}`;
const ROOT_DIR = path.resolve(import.meta.dir, "../..");

let workerProcess: ChildProcess | null = null;
let bridgeProcess: ChildProcess | null = null;

function isTruthy(value: string | undefined): boolean {
  const v = String(value || "").toLowerCase().trim();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

async function waitForWorkerHealthy(timeoutMs = 15_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${WORKER_BASE_URL}/api/health`);
      if (res.ok) return true;
    } catch {
      // ignore
    }
    await Bun.sleep(200);
  }
  return false;
}

function startChild(scriptPath: string, args: string[] = []): ChildProcess {
  const cp = spawn(process.execPath, ["run", scriptPath, ...args], {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: "ignore"
  });
  cp.unref();
  return cp;
}

async function bootstrapAutoMemory(): Promise<void> {
  const autoBootstrap = process.env.CODEXMEM_MCP_AUTO_BOOTSTRAP !== "false";
  if (!autoBootstrap) return;

  const healthy = await waitForWorkerHealthy(500);
  if (!healthy) {
    workerProcess = startChild("src/worker/server.ts");
    const ready = await waitForWorkerHealthy(20_000);
    if (!ready) {
      throw new Error("Worker auto-bootstrap failed: health check timeout");
    }
    logger.info("MCP", "Auto-started worker for MCP");
  }

  const autoBridge = process.env.CODEXMEM_MCP_AUTO_BRIDGE !== "false";
  if (autoBridge) {
    bridgeProcess = startChild("src/cli/codex-bridge.ts");
    logger.info("MCP", "Auto-started codex bridge for background memory");
  }
}

function cleanupChildren(): void {
  try {
    bridgeProcess?.kill("SIGTERM");
  } catch {
    // ignore
  }
  try {
    if (isTruthy(process.env.CODEXMEM_MCP_STOP_WORKER_ON_EXIT)) {
      workerProcess?.kill("SIGTERM");
    }
  } catch {
    // ignore
  }
}

async function callWorkerApiGet(endpoint: string, params: Record<string, unknown>) {
  const searchParams = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) {
      searchParams.append(k, String(v));
    }
  }

  const response = await fetch(`${WORKER_BASE_URL}${endpoint}?${searchParams.toString()}`);
  if (!response.ok) {
    const text = await response.text();
    return {
      content: [{ type: "text" as const, text: `Worker API error (${response.status}): ${text}` }],
      isError: true
    };
  }

  return (await response.json()) as { content: Array<{ type: "text"; text: string }>; isError?: boolean };
}

async function callWorkerApiPost(endpoint: string, body: Record<string, unknown>) {
  const response = await fetch(`${WORKER_BASE_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    return {
      content: [{ type: "text" as const, text: `Worker API error (${response.status}): ${text}` }],
      isError: true
    };
  }

  const data = await response.json();

  if (endpoint === "/api/observations/batch") {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }]
    };
  }

  if (endpoint === "/api/memory/save") {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }]
    };
  }

  return data;
}

const tools = [
  {
    name: "__IMPORTANT",
    description:
      "3-LAYER WORKFLOW (ALWAYS FOLLOW): 1) search 2) timeline 3) get_observations. NEVER fetch details before filtering.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({
      content: [
        {
          type: "text" as const,
          text: [
            "# Memory Search Workflow",
            "",
            "1. search(query=...) -> 获取轻量索引和 ID",
            "2. timeline(anchor=ID) -> 了解上下文",
            "3. get_observations(ids=[...]) -> 仅对筛选后 ID 拉取详情"
          ].join("\n")
        }
      ]
    })
  },
  {
    name: "search",
    description:
      "Step 1: Search memory index. Params: query, limit, project, type, obs_type, dateStart, dateEnd, offset, orderBy",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    handler: async (args: Record<string, unknown>) => callWorkerApiGet("/api/search", args)
  },
  {
    name: "timeline",
    description:
      "Step 2: Get context around results. Params: anchor OR query, depth_before, depth_after, project",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    handler: async (args: Record<string, unknown>) => callWorkerApiGet("/api/timeline", args)
  },
  {
    name: "get_observations",
    description: "Step 3: Fetch full details for filtered IDs. Params: ids (required)",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "number" }
        }
      },
      required: ["ids"],
      additionalProperties: true
    },
    handler: async (args: Record<string, unknown>) => callWorkerApiPost("/api/observations/batch", args)
  },
  {
    name: "save_memory",
    description: "Save a manual memory/observation for future search",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        title: { type: "string" },
        project: { type: "string" }
      },
      required: ["text"]
    },
    handler: async (args: Record<string, unknown>) => callWorkerApiPost("/api/memory/save", args)
  }
];

const server = new Server(
  {
    name: "codexmem-mcp",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  }))
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find((t) => t.name === request.params.name);
  if (!tool) {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  try {
    return await tool.handler((request.params.arguments || {}) as Record<string, unknown>);
  } catch (error) {
    logger.error("MCP", "Tool execution failed", { tool: request.params.name, error: String(error) });
    return {
      content: [{ type: "text" as const, text: `Tool execution failed: ${String(error)}` }],
      isError: true
    };
  }
});

async function main(): Promise<void> {
  await bootstrapAutoMemory();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP", "codexmem MCP server started", { workerBaseUrl: WORKER_BASE_URL });
}

process.on("SIGINT", () => {
  cleanupChildren();
  process.exit(0);
});

process.on("SIGTERM", () => {
  cleanupChildren();
  process.exit(0);
});

main().catch((error) => {
  logger.error("MCP", "Fatal MCP server error", String(error));
  process.exit(1);
});
