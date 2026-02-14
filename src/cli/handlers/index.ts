import type { EventHandler } from "../types.js";
import { sessionInitHandler } from "./session-init.js";
import { observationHandler } from "./observation.js";
import { summarizeHandler } from "./summarize.js";
import { sessionCompleteHandler } from "./session-complete.js";
import { sessionEndHandler } from "./session-end.js";

export function getEventHandler(event: string): EventHandler {
  switch (event) {
    case "session-init":
      return sessionInitHandler;
    case "observation":
      return observationHandler;
    case "summarize":
      return summarizeHandler;
    case "session-complete":
      return sessionCompleteHandler;
    case "session-end":
      return sessionEndHandler;
    default:
      throw new Error(`Unsupported event: ${event}`);
  }
}
