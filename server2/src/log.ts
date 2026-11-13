/** Журнал server2: строка с временем и разделом в stdout (systemd пишет его в journal). */

function stamp(): string {
  const now = new Date();
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

export function log(section: string, ...parts: unknown[]): void {
  console.log(stamp(), `[${section}]`, ...parts);
}

export function logError(section: string, ...parts: unknown[]): void {
  console.error(stamp(), `[${section}]`, ...parts);
}
