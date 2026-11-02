// Drives one verdict per call: lookup, then the transcript's claims, fed to `nextVerdict`. Owns
// the timers the state machine does not have, and reports every change of state.
import type { Clock } from './clock.js';
import { _logPollError, _logStage } from './log.js';
import { createAgentBuffer, type TranscriptEvent } from './transcript.js';
import type { CallRecord, LookupResult, Verdict, VerdictEvent } from './types.js';
import { initialVerdict, nextVerdict, type Aliases } from './verdict.js';

/** How long after the call is answered the agent has to say who it acts for. */
export const CLAIM_WINDOW_MS = 20_000;
/** Hard stop for following one call, whatever the stream does. */
export const CALL_LIMIT_MS = 10 * 60_000;
export const POLL_INTERVAL_MS = 1_000;

/** One change of verdict state. The hook the notifier consumes. */
export type StageEvent = {
  /** Null for an ambiguous lookup, which matched no single call. */
  callId: string | null;
  from: Verdict['state'];
  verdict: Verdict;
  atMs: number;
  /** Ms from dialing to the owner being known; set from then on. */
  tOwnerKnownMs?: number;
  /** Ms from dialing to the claim being settled (claimed or window closed); set from then on. */
  tClaimCheckedMs?: number;
};

export type CallDeps = {
  /** The call's transcript events, ending at `ended`; throws when the stream fails. */
  openTurns(call: CallRecord, signal: AbortSignal): AsyncIterable<TranscriptEvent>;
  clock: Clock;
  aliases: Aliases;
  /** Every owner name and alias (`principalNames`). */
  registry: readonly string[];
  onStage(event: StageEvent): void;
};

/**
 * Follows one matched call to a final verdict. OWNER_KNOWN is reported straight from the
 * lookup, before the stream opens, so the owner can be disclosed while the phone still rings.
 */
export async function runCall(call: CallRecord, deps: CallDeps): Promise<Verdict> {
  const { clock, aliases, onStage } = deps;
  const dialedAt = Date.parse(call.startedAt);
  let verdict = initialVerdict;
  let tOwnerKnownMs: number | undefined;
  let tClaimCheckedMs: number | undefined;

  const apply = (event: VerdictEvent): void => {
    const next = nextVerdict(verdict, event, aliases);
    const from = verdict.state;
    verdict = next;
    if (next.state === from) return;
    const atMs = clock.now();
    if (tOwnerKnownMs === undefined && 'owner' in next) tOwnerKnownMs = atMs - dialedAt;
    if (tClaimCheckedMs === undefined && next.state !== 'OWNER_KNOWN' && 'owner' in next) {
      tClaimCheckedMs = atMs - dialedAt;
    }
    const reason = next.state === 'UNVERIFIED' ? next.reason : undefined;
    _logStage(call.callId, from, next.state, { reason, tOwnerKnownMs, tClaimCheckedMs });
    onStage({ callId: call.callId, from, verdict: next, atMs, tOwnerKnownMs, tClaimCheckedMs });
  };

  apply({ type: 'lookup', result: call });

  const controller = new AbortController();
  const cancelLimit = clock.setTimeout(() => controller.abort(), CALL_LIMIT_MS);
  let cancelClaimWindow: (() => void) | undefined;
  const buffer = createAgentBuffer(deps.registry);
  try {
    for await (const event of deps.openTurns(call, controller.signal)) {
      // The window opens on the first `connected` (the call is answered), not at lookup:
      // the owner can be known while the phone still rings. A reconnect does not reopen it.
      if (event.type === 'connected' && cancelClaimWindow === undefined) {
        cancelClaimWindow = clock.setTimeout(
          () => apply({ type: 'deadline', which: 'claim' }),
          CLAIM_WINDOW_MS,
        );
      } else if (event.type === 'turn') {
        for (const result of buffer.add(event)) apply({ type: 'claim', result });
      }
      // Nothing can change MISMATCH or UNVERIFIED, so stop listening.
      if (verdict.state === 'MISMATCH' || verdict.state === 'UNVERIFIED') break;
    }
    // The call ended (or hit the limit) with no claim against the owner: the window is closed.
    apply({ type: 'deadline', which: 'claim' });
  } catch {
    // After the window has closed, nextVerdict ignores this: a dropped stream late in a call
    // cannot undo a verdict already reached.
    apply(
      controller.signal.aborted
        ? { type: 'deadline', which: 'claim' }
        : { type: 'error', reason: 'transcript_error' },
    );
  } finally {
    cancelClaimWindow?.();
    cancelLimit();
    controller.abort();
  }
  return verdict;
}

export type WatchDeps = CallDeps & {
  /** One lookup (with its own retries); see `lookupWithRetry`. */
  lookup(): Promise<LookupResult>;
};

/**
 * Polls for calls until `signal` aborts. Each matched call is followed once. While idle, `none`
 * only means no call yet, and an error has no call to mark, so neither is a verdict. An
 * ambiguous result is reported once, until the lookup returns to `none`.
 */
export async function watch(deps: WatchDeps, signal: AbortSignal): Promise<void> {
  const followed = new Set<string>();
  let ambiguousReported = false;
  while (!signal.aborted) {
    const result = await deps.lookup();
    if (result.kind === 'one') {
      ambiguousReported = false;
      if (!followed.has(result.callId)) {
        followed.add(result.callId);
        void runCall(result, deps);
      }
    } else if (result.kind === 'ambiguous') {
      if (!ambiguousReported) {
        ambiguousReported = true;
        const verdict = nextVerdict(initialVerdict, { type: 'lookup', result }, deps.aliases);
        _logStage(null, initialVerdict.state, verdict.state, { reason: 'ambiguous' });
        deps.onStage({
          callId: null,
          from: initialVerdict.state,
          verdict,
          atMs: deps.clock.now(),
        });
      }
    } else if (result.kind === 'none') {
      ambiguousReported = false;
    } else {
      _logPollError(result.reason);
    }
    await new Promise<void>((resolve) => deps.clock.setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
