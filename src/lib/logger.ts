type Level = "DEBUG" | "INFO" | "WARN" | "ERROR";

function shouldLog(level: Level): boolean {
  const order: Record<Level, number> = {
    DEBUG: 10,
    INFO: 20,
    WARN: 30,
    ERROR: 40
  };
  const env = (process.env.CODEXMEM_LOG_LEVEL || "INFO").toUpperCase() as Level;
  return order[level] >= (order[env] ?? order.INFO);
}

function write(level: Level, scope: string, message: string, data?: unknown): void {
  if (!shouldLog(level)) return;
  const base = `[${new Date().toISOString()}] [${level}] [${scope}] ${message}`;
  if (data === undefined) {
    console.error(base);
  } else {
    console.error(base, data);
  }
}

export const logger = {
  debug(scope: string, message: string, data?: unknown) {
    write("DEBUG", scope, message, data);
  },
  info(scope: string, message: string, data?: unknown) {
    write("INFO", scope, message, data);
  },
  warn(scope: string, message: string, data?: unknown) {
    write("WARN", scope, message, data);
  },
  error(scope: string, message: string, data?: unknown) {
    write("ERROR", scope, message, data);
  }
};
