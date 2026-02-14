import type { EventHandler } from "../types.js";
import { postWorker, workerHealthy } from "../worker-client.js";

export const sessionCompleteHandler: EventHandler = {
  async execute(input) {
    if (!(await workerHealthy())) {
      return { continue: true, suppressOutput: true, exitCode: 0 };
    }

    await postWorker("/api/sessions/complete", { contentSessionId: input.sessionId });
    return { continue: true, suppressOutput: true, exitCode: 0 };
  }
};
