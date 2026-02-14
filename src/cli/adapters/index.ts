import type { PlatformAdapter } from "../types.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";
import { rawAdapter } from "./raw.js";

export function getPlatformAdapter(platform: string): PlatformAdapter {
  switch (platform) {
    case "claude-code":
      return claudeCodeAdapter;
    case "cursor":
      return cursorAdapter;
    case "codex":
      return codexAdapter;
    case "raw":
      return rawAdapter;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}
