import type { HookResult, PlatformAdapter } from "../types.js";

export const claudeCodeAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;
    return {
      sessionId: r.session_id || "unknown",
      cwd: r.cwd ?? process.cwd(),
      prompt: r.prompt,
      toolName: r.tool_name,
      toolInput: r.tool_input,
      toolResponse: r.tool_response,
      transcriptPath: r.transcript_path
    };
  },
  formatOutput(result: HookResult) {
    return {
      continue: result.continue ?? true,
      suppressOutput: result.suppressOutput ?? true
    };
  }
};
