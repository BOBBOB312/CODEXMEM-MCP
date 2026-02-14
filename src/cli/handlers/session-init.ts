import type { EventHandler } from "../types.js";
import { postWorker, workerHealthy } from "../worker-client.js";

function getProjectName(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] || "unknown";
}

export const sessionInitHandler: EventHandler = {
  async execute(input) {
    if (!(await workerHealthy())) {
      return { continue: true, suppressOutput: true, exitCode: 0 };
    }

    const prompt = input.prompt && input.prompt.trim() ? input.prompt : "[media prompt]";
    const response = await postWorker("/api/sessions/init", {
      contentSessionId: input.sessionId,
      project: getProjectName(input.cwd),
      prompt
    });

    if (!response.ok) {
      return { continue: true, suppressOutput: true, exitCode: 0 };
    }

    return { continue: true, suppressOutput: true, exitCode: 0 };
  }
};
