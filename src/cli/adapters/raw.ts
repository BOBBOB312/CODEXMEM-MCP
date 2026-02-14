import type { PlatformAdapter } from "../types.js";

export const rawAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;
    return {
      sessionId: r.sessionId ?? r.session_id ?? "unknown",
      cwd: r.cwd ?? process.cwd(),
      prompt: r.prompt,
      toolName: r.toolName ?? r.tool_name,
      toolInput: r.toolInput ?? r.tool_input,
      toolResponse: r.toolResponse ?? r.tool_response,
      transcriptPath: r.transcriptPath ?? r.transcript_path,
      command: r.command,
      output: r.output
    };
  },
  formatOutput(result) {
    return result;
  }
};
