import type { EventHandler } from "../types.js";
import { postWorker, workerHealthy } from "../worker-client.js";
import { extractLastAssistantMessage } from "../transcript.js";

export const summarizeHandler: EventHandler = {
  async execute(input) {
    if (!(await workerHealthy())) {
      return { continue: true, suppressOutput: true, exitCode: 0 };
    }

    const lastMessage = (input.output && String(input.output).trim()) || extractLastAssistantMessage(input.transcriptPath);

    const response = await postWorker("/api/sessions/summarize", {
      contentSessionId: input.sessionId,
      last_assistant_message: lastMessage
    });

    if (!response.ok) {
      return { continue: true, suppressOutput: true, exitCode: 0 };
    }

    return { continue: true, suppressOutput: true, exitCode: 0 };
  }
};
