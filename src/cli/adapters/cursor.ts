import type { HookResult, PlatformAdapter } from "../types.js";

export const cursorAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;
    const isShellCommand = !!r.command && !r.tool_name;
    return {
      sessionId: r.conversation_id || r.generation_id || "unknown",
      cwd: r.workspace_roots?.[0] ?? process.cwd(),
      prompt: r.prompt,
      toolName: isShellCommand ? "Bash" : r.tool_name,
      toolInput: isShellCommand ? { command: r.command } : r.tool_input,
      toolResponse: isShellCommand ? { output: r.output } : r.result_json,
      transcriptPath: undefined,
      command: r.command,
      output: r.output
    };
  },
  formatOutput(result: HookResult) {
    return { continue: result.continue ?? true };
  }
};
