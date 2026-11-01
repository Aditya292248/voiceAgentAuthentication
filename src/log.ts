// One JSON object per line on stdout, keyed by callId.
//
// Rule: log IDs, stage names, status codes and timings only. Never transcript text,
// phone numbers, owner names or API keys. Values are restricted to primitives so a
// whole request, transcript or config object cannot be dumped by accident.

export type LogValue = string | number | boolean | null;

export function logEvent(
  callId: string | null,
  stage: string,
  data: Record<string, LogValue> = {},
): void {
  const line = { ts: new Date().toISOString(), callId, stage, data };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

export function _logServerStarted(port: number, version: string): void {
  logEvent(null, 'server_started', { port, version });
}

export function _logRequest(method: string, path: string, status: number): void {
  logEvent(null, 'http_request', { method, path, status });
}
