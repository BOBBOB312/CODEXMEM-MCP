import { logger } from "../lib/logger.js";
import type { ObservationInput, PendingMessage, SummaryInput } from "../types/models.js";
import { OpenAIClient } from "../lib/openai-client.js";
import { RuleBasedAgent } from "./rule-based-agent.js";
import { validateObservationStrict, validateSummaryStrict, type ValidationResult } from "./schema.js";
import { loadSettings } from "../lib/config.js";
import { agentMetrics, type AgentMessageKind } from "./metrics.js";

function truncate(value: string | null, max = 4000): string {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function parseJsonLoose<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    const fenced = text.match(/```json\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1]) as T;
      } catch {
        return null;
      }
    }
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export class OpenAIAgent extends RuleBasedAgent {
  readonly name = "openai";
  private readonly client = new OpenAIClient();

  private isRepairEnabled(): boolean {
    const settings = loadSettings();
    return String(settings.CODEXMEM_OPENAI_REPAIR_ENABLED || "true").toLowerCase() !== "false";
  }

  private maxRepairs(): number {
    const settings = loadSettings();
    const n = Number(settings.CODEXMEM_OPENAI_MAX_REPAIRS || "1");
    return Number.isFinite(n) ? Math.max(0, Math.min(n, 3)) : 1;
  }

  private async repairJson(rawText: string, errors: string[], schemaName: "observation" | "summary"): Promise<string | null> {
    if (!this.isRepairEnabled()) return null;
    const repairSystem = [
      "You are a strict JSON repair engine.",
      `Fix the ${schemaName} JSON so that it matches the required schema exactly.`,
      "Return ONLY one valid JSON object.",
      "Do not add markdown, explanations, or code fences."
    ].join(" ");
    const repairUser = JSON.stringify({
      schema: schemaName,
      validation_errors: errors,
      invalid_output: rawText
    });
    return this.client.chatJson(repairSystem, repairUser);
  }

  private async processWithRepair<T>(
    initialText: string,
    kind: AgentMessageKind,
    schemaName: "observation" | "summary",
    validator: (raw: unknown) => ValidationResult<T>
  ): Promise<T | null> {
    let currentText = initialText;
    let attempts = 0;
    const maxRepairs = this.maxRepairs();

    while (true) {
      const parsed = parseJsonLoose<unknown>(currentText);
      if (!parsed) {
        agentMetrics.incr(kind, "parse_fail");
      }
      const validated = validator(parsed);
      if (validated.ok) {
        agentMetrics.incr(kind, "success");
        return validated.data;
      }
      agentMetrics.incr(kind, "schema_fail");
      if (attempts >= maxRepairs) {
        agentMetrics.incr(kind, "repair_fail");
        logger.warn("AGENT", "schema validation failed after repairs", {
          schema: schemaName,
          attempts,
          errors: validated.errors.slice(0, 8)
        });
        return null;
      }
      const repaired = await this.repairJson(currentText, validated.errors, schemaName);
      if (!repaired) {
        agentMetrics.incr(kind, "repair_fail");
        return null;
      }
      attempts++;
      currentText = repaired;
    }
  }

  private observationSystemPrompt(): string {
    return [
      "Role: You are CodexMem production observation compressor.",
      "Objective: Produce one high-signal, schema-valid observation JSON from a single tool event.",
      "Hard constraints:",
      "- Return EXACTLY one JSON object. No markdown. No prose.",
      "- Allowed keys only: type,title,subtitle,facts,narrative,concepts,files_read,files_modified.",
      "- type must be one of discovery|change|execution|decision|bugfix.",
      "- title and narrative must be non-empty strings.",
      "- subtitle may be null.",
      "- facts/concepts/files_* must be arrays of strings.",
      "- Do not invent files or facts not supported by tool input/response.",
      "- If uncertain, be conservative and explicit in narrative.",
      "Few-shot positive example:",
      "{\"type\":\"bugfix\",\"title\":\"Handle null token branch\",\"subtitle\":\"auth middleware\",\"facts\":[\"null token caused 500\"],\"narrative\":\"Added null guard before token decode to prevent runtime crash.\",\"concepts\":[\"auth\",\"error-handling\"],\"files_read\":[\"src/auth/middleware.ts\"],\"files_modified\":[\"src/auth/middleware.ts\"]}",
      "Negative example (DO NOT do this):",
      "- markdown fences",
      "- keys like confidence/debug/raw",
      "- empty title/narrative",
      "- fake file paths"
    ].join("\n");
  }

  private summarySystemPrompt(): string {
    return [
      "Role: You are CodexMem production session summarizer.",
      "Objective: Produce one schema-valid summary JSON from the latest assistant message.",
      "Hard constraints:",
      "- Return EXACTLY one JSON object. No markdown. No prose.",
      "- Allowed keys only: request,investigated,learned,completed,next_steps,notes.",
      "- request/investigated/learned/completed/next_steps must be non-empty strings.",
      "- notes may be null.",
      "- Keep statements concrete and grounded in provided message.",
      "Few-shot positive example:",
      "{\"request\":\"Fix login 500\",\"investigated\":\"Reviewed auth middleware and token decode branch.\",\"learned\":\"Null token path was unguarded and triggered runtime error.\",\"completed\":\"Added guard and updated branch logic.\",\"next_steps\":\"Run login regression and monitor error rate.\",\"notes\":null}",
      "Negative example (DO NOT do this):",
      "- adding unsupported keys",
      "- generic empty sections",
      "- markdown/code fences"
    ].join("\n");
  }

  override async processObservation(message: PendingMessage): Promise<ObservationInput> {
    if (!this.client.isChatConfigured()) {
      logger.warn("AGENT", "OPENAI_API_KEY missing, fallback to rule-based agent");
      agentMetrics.incr("observation", "fallback_used");
      return await super.processObservation(message);
    }

    const system = this.observationSystemPrompt();

    const user = JSON.stringify({
      task: "compress_tool_event_to_observation",
      message_type: message.message_type,
      tool_name: message.tool_name,
      tool_input: truncate(message.tool_input),
      tool_response: truncate(message.tool_response),
      cwd: message.cwd,
      prompt_number: message.prompt_number
    });

    try {
      const text = await this.client.chatJson(system, user);
      if (!text) {
        agentMetrics.incr("observation", "fallback_used");
        return await super.processObservation(message);
      }
      const validated = await this.processWithRepair(text, "observation", "observation", validateObservationStrict);
      if (!validated) {
        agentMetrics.incr("observation", "fallback_used");
        return await super.processObservation(message);
      }
      return validated;
    } catch (error) {
      logger.warn("AGENT", "OpenAI observation processing error, fallback to rule-based", { error: String(error) });
      agentMetrics.incr("observation", "fallback_used");
      return await super.processObservation(message);
    }
  }

  override async processSummary(message: PendingMessage): Promise<SummaryInput> {
    if (!this.client.isChatConfigured()) {
      logger.warn("AGENT", "OPENAI_API_KEY missing, fallback to rule-based agent");
      agentMetrics.incr("summary", "fallback_used");
      return await super.processSummary(message);
    }

    const system = this.summarySystemPrompt();

    const user = JSON.stringify({
      task: "summarize_session_fragment",
      message_type: message.message_type,
      last_assistant_message: truncate(message.last_assistant_message)
    });

    try {
      const text = await this.client.chatJson(system, user);
      if (!text) {
        agentMetrics.incr("summary", "fallback_used");
        return await super.processSummary(message);
      }
      const validated = await this.processWithRepair(text, "summary", "summary", validateSummaryStrict);
      if (!validated) {
        agentMetrics.incr("summary", "fallback_used");
        return await super.processSummary(message);
      }
      return validated;
    } catch (error) {
      logger.warn("AGENT", "OpenAI summary processing error, fallback to rule-based", { error: String(error) });
      agentMetrics.incr("summary", "fallback_used");
      return await super.processSummary(message);
    }
  }
}
