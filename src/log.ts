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

/** `status` is "ringing" or "in-progress": shows whether the owner was known before pickup. */
export function _logCallMatched(callId: string, ownerSub: string, status: string): void {
  logEvent(callId, 'call_matched', { ownerSub, status });
}

/** The transcript stream failed once and is being reopened. */
export function _logTranscriptRetry(callId: string): void {
  logEvent(callId, 'transcript_retry');
}

/**
 * A verdict change. `reason` is a ReasonCode; the timings are ms since the call was dialed.
 * State names only: the verdict's owner and claimed name are never logged.
 */
export function _logStage(
  callId: string | null,
  from: string,
  to: string,
  data: { reason?: string; tOwnerKnownMs?: number; tClaimCheckedMs?: number },
): void {
  const fields: Record<string, LogValue> = { from, to };
  for (const [key, value] of Object.entries(data)) if (value !== undefined) fields[key] = value;
  logEvent(callId, 'verdict', fields);
}

/** A lookup failed while no call was being followed; polling continues. */
export function _logPollError(reason: string): void {
  logEvent(null, 'poll_error', { reason });
}

export function _logRequest(method: string, path: string, status: number): void {
  logEvent(null, 'http_request', { method, path, status });
}
