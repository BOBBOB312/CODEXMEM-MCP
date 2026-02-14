import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export const APP_NAME = "codexmem";
export const APP_VERSION = "0.1.0";

export const DATA_DIR = process.env.CODEXMEM_DATA_DIR || path.join(os.homedir(), ".codexmem");
export const DB_PATH = process.env.CODEXMEM_DB_PATH || path.join(DATA_DIR, "codexmem.db");
export const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

export const DEFAULT_SETTINGS = {
  CODEXMEM_WORKER_HOST: "127.0.0.1",
  CODEXMEM_WORKER_PORT: "37777",
  CODEXMEM_MCP_ENABLED: "true",
  CODEXMEM_VECTOR_BACKEND: "sqlite",
  CODEXMEM_CHROMA_URL: "http://127.0.0.1:8000",
  CODEXMEM_CHROMA_COLLECTION: "codexmem_memory",
  CODEXMEM_PROVIDER: "openai",
  CODEXMEM_OPENAI_MODEL: "gpt-4o-mini",
  CODEXMEM_OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
  CODEXMEM_OPENAI_BASE_URL: "https://api.openai.com/v1",
  CODEXMEM_OPENAI_EMBEDDING_BASE_URL: "",
  CODEXMEM_OPENAI_API_KEY: "",
  CODEXMEM_OPENAI_EMBEDDING_API_KEY: "",
  CODEXMEM_OPENAI_REPAIR_ENABLED: "true",
  CODEXMEM_OPENAI_MAX_REPAIRS: "1",
  CODEXMEM_LOG_LEVEL: "INFO",
  CODEXMEM_SKIP_TOOLS: "ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",
  CODEXMEM_STALE_PROCESSING_MS: "300000",
  CODEXMEM_AUTO_RECOVER_ON_BOOT: "false",
  CODEXMEM_RETENTION_ENABLED: "true",
  CODEXMEM_RETENTION_TTL_DAYS: "30",
  CODEXMEM_RETENTION_SOFT_DELETE_DAYS: "7",
  CODEXMEM_RETENTION_SWEEP_INTERVAL_MIN: "1440"
};

export function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadSettings(): Record<string, string> {
  ensureDataDir();
  if (!fs.existsSync(SETTINGS_PATH)) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(DEFAULT_SETTINGS, null, 2), "utf-8");
    return { ...DEFAULT_SETTINGS };
  }

  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(nextSettings: Record<string, string>): void {
  ensureDataDir();
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(nextSettings, null, 2), "utf-8");
}

export function getWorkerHost(): string {
  return loadSettings().CODEXMEM_WORKER_HOST || "127.0.0.1";
}

export function getWorkerPort(): number {
  const port = Number(loadSettings().CODEXMEM_WORKER_PORT || "37777");
  return Number.isFinite(port) ? port : 37777;
}
