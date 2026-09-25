export type LogLevel = "info" | "warn" | "error";

export type Logger = (level: LogLevel, message: string, context?: Record<string, unknown>) => void;

/** One JSON object per line on stdout, so any log collector can parse it. */
export const jsonLogger: Logger = (level, message, context = {}) => {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, message, ...context })}\n`);
};

export const silentLogger: Logger = () => undefined;
