import type { ObservationInput, PendingMessage, SummaryInput } from "../types/models.js";
import type { MemoryAgent } from "./types.js";

function safeJsonParse(input: string | null): any {
  if (!input) return null;
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

export class RuleBasedAgent implements MemoryAgent {
  readonly name: string = "rule-based";

  async processObservation(message: PendingMessage): Promise<ObservationInput> {
    const toolName = message.tool_name || "Unknown";
    const input = safeJsonParse(message.tool_input);
    const response = safeJsonParse(message.tool_response);

    const candidatePath =
      (input && (input.file_path || input.path || input.notebook_path)) ||
      (response && (response.file_path || response.path));

    const toolLower = toolName.toLowerCase();
    const type =
      toolLower.includes("edit") || toolLower.includes("write") || toolLower.includes("patch")
        ? "change"
        : toolLower.includes("bash")
          ? "execution"
          : "discovery";

    const files_read = toolLower.includes("read") && candidatePath ? [String(candidatePath)] : [];
    const files_modified =
      (toolLower.includes("write") || toolLower.includes("edit") || toolLower.includes("patch")) && candidatePath
        ? [String(candidatePath)]
        : [];

    return {
      type,
      title: `${toolName} operation`,
      subtitle: candidatePath ? `file: ${String(candidatePath)}` : "tool event",
      narrative: `Tool ${toolName} executed with captured input/response in session.`,
      facts: [
        `tool_name=${toolName}`,
        `has_input=${message.tool_input ? "true" : "false"}`,
        `has_response=${message.tool_response ? "true" : "false"}`
      ],
      concepts: [toolName.toLowerCase()],
      files_read,
      files_modified
    };
  }

  async processSummary(message: PendingMessage): Promise<SummaryInput> {
    const last = String(message.last_assistant_message || "").trim();
    return {
      request: "Session summary",
      investigated: "Processed queued tool observations and session context.",
      learned: last || "No assistant message available.",
      completed: "Stored summary snapshot for this session.",
      next_steps: "Continue next session from stored observations.",
      notes: null
    };
  }
}
