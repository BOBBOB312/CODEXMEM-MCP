import type { EventHandler } from "../types.js";
import { postWorker, workerHealthy } from "../worker-client.js";

export const sessionEndHandler: EventHandler = {
  async execute(input) {
    if (!(await workerHealthy())) {
      return { continue: true, suppressOutput: true, exitCode: 0 };
    }

    await postWorker("/api/sessions/end", {
      contentSessionId: input.sessionId,
      cleanup: true
    });
    return { continue: true, suppressOutput: true, exitCode: 0 };
  }
};

