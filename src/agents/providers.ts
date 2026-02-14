import { RuleBasedAgent } from "./rule-based-agent.js";
import { OpenAIAgent } from "./openai-agent.js";
import type { MemoryAgent } from "./types.js";

export function createAgent(provider: string | undefined): MemoryAgent {
  switch ((provider || "openai").toLowerCase()) {
    case "openai":
      return new OpenAIAgent();
    case "rule-based":
      return new RuleBasedAgent();
    default:
      return new OpenAIAgent();
  }
}
