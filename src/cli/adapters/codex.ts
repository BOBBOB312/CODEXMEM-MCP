import type { HookResult, PlatformAdapter } from "../types.js";

export const codexAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;
    const isShellCommand = !!r.command && !r.tool_name && !r.toolName;
    return {
      sessionId: r.session_id || r.sessionId || r.conversation_id || "unknown",
      cwd: r.cwd || process.cwd(),
      prompt: r.prompt,
      toolName: r.tool_name || r.toolName || (isShellCommand ? "exec_command" : undefined),
      toolInput: r.tool_input || r.toolInput || (isShellCommand ? { command: r.command } : undefined),
      toolResponse: r.tool_response || r.toolResponse || (isShellCommand ? { output: r.output } : undefined),
      transcriptPath: r.transcript_path || r.transcriptPath,
      command: r.command,
      output: r.output
    };
  },
  formatOutput(result: HookResult) {
    return {
      continue: result.continue ?? true,
      suppressOutput: result.suppressOutput ?? true
    };
  }
};

