const MAX_LOG_LINES = 500;
const logBuffer: string[] = [];

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function capture(level: string, args: any[]): void {
  const ts = new Date().toISOString();
  const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  logBuffer.push(`${ts} [${level}] ${msg}`);
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
}

export function installLogCapture(): void {
  console.log = (...args: any[]) => { capture("INFO", args); originalLog(...args); };
  console.error = (...args: any[]) => { capture("ERROR", args); originalError(...args); };
  console.warn = (...args: any[]) => { capture("WARN", args); originalWarn(...args); };
}

export function getRecentLogs(count: number = 100): string[] {
  return logBuffer.slice(-count);
}
