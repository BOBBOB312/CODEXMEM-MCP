import type { EventHandler } from "../types.js";
import { postWorker, workerHealthy } from "../worker-client.js";

export const observationHandler: EventHandler = {
  async execute(input) {
    if (!(await workerHealthy())) {
      return { continue: true, suppressOutput: true, exitCode: 0 };
    }

    if (!input.toolName) {
      throw new Error("observation handler requires toolName");
    }

    const response = await postWorker("/api/sessions/observations", {
      contentSessionId: input.sessionId,
      tool_name: input.toolName,
      tool_input: input.toolInput,
      tool_response: input.toolResponse,
      cwd: input.cwd
    });

    if (!response.ok) {
      return { continue: true, suppressOutput: true, exitCode: 0 };
    }

    return { continue: true, suppressOutput: true, exitCode: 0 };
  }
};
