// The live transcript of one call: SSE parsing, a watchdog with one reconnect, and the buffer of
// agent speech that claims are read from.
import { z } from 'zod';
import { extractClaims } from './claim.js';
import type { Clock } from './clock.js';
import { _logTranscriptRetry } from './log.js';
import type { ClaimResult } from './types.js';

/** No bytes for this long means the stream is dead, even if the socket is still open. */
export const IDLE_TIMEOUT_MS = 20_000;

export type TranscriptEvent =
  | { type: 'connected'; callId: string }
  // `role` stays a string: only "agent" is ever read, so an unknown role is simply ignored.
  | { type: 'turn'; role: string; content: string }
  | { type: 'ended' };

/** Opens the raw event stream. Aborting the signal must close it. */
export type OpenStream = (signal: AbortSignal) => Promise<AsyncIterable<Uint8Array>>;

export class TranscriptError extends Error {
  override name = 'TranscriptError';
}

// Only the fields used. `connected` also carries `agentName` and both numbers; they are left
// out so nothing downstream can read them (the caller chooses `agentName`).
const ConnectedSchema = z.object({ callId: z.string().min(1) });
const TurnSchema = z.object({ role: z.string(), content: z.string() });
const EndedSchema = z.object({});

type SseMessage = { event: string; data: string };

/** Splits a byte stream into SSE messages. Comments (heartbeats) and `id`/`retry` are dropped. */
export async function* parseSse(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<SseMessage> {
  // `stream: true` keeps a character split across two chunks ("’" is three bytes) intact.
  const decoder = new TextDecoder();
  let pending = '';
  let event = '';
  let data: string[] = [];
  for await (const chunk of chunks) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line === '') {
        if (data.length > 0) yield { event: event || 'message', data: data.join('\n') };
        event = '';
        data = [];
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
    }
  }
}

/** Typed events from a byte stream. Unknown event names are skipped; a malformed known one throws. */
export async function* transcriptEvents(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<TranscriptEvent> {
  for await (const { event, data } of parseSse(chunks)) {
    if (event === 'connected') {
      yield { type: 'connected', callId: parse(ConnectedSchema, data, event).callId };
    } else if (event === 'turn') {
      const { role, content } = parse(TurnSchema, data, event);
      yield { type: 'turn', role, content };
    } else if (event === 'ended') {
      parse(EndedSchema, data, event);
      yield { type: 'ended' };
    }
  }
}

/**
 * Follows one call's transcript until `ended`. A dead stream (no bytes for IDLE_TIMEOUT_MS),
 * one that closes before `ended`, a failed open or a malformed event is retried once by
 * reconnecting; the second failure throws TranscriptError. Aborting `signal` ends it quietly.
 */
export async function* followTranscript(
  open: OpenStream,
  callId: string,
  clock: Clock,
  signal: AbortSignal,
): AsyncGenerator<TranscriptEvent> {
  for (let attempt = 1; ; attempt++) {
    try {
      for await (const event of connectOnce(open, callId, clock, signal)) {
        yield event;
        if (event.type === 'ended') return;
      }
      throw new TranscriptError('stream closed before the call ended');
    } catch (err) {
      if (signal.aborted) return;
      if (attempt >= 2) {
        throw err instanceof TranscriptError
          ? err
          : new TranscriptError('transcript stream failed');
      }
      _logTranscriptRetry(callId);
    }
  }
}

async function* connectOnce(
  open: OpenStream,
  callId: string,
  clock: Clock,
  outer: AbortSignal,
): AsyncGenerator<TranscriptEvent> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  outer.addEventListener('abort', stop);
  try {
    const chunks = await watched(open(controller.signal), clock, controller.signal);
    for await (const event of transcriptEvents(watchdog(chunks, clock, controller.signal))) {
      if (event.type === 'connected' && event.callId !== callId) {
        throw new TranscriptError('stream is for a different call');
      }
      yield event;
    }
  } finally {
    outer.removeEventListener('abort', stop);
    controller.abort();
  }
}

// Every chunk must arrive within IDLE_TIMEOUT_MS of the previous one.
async function* watchdog(
  chunks: AsyncIterable<Uint8Array>,
  clock: Clock,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const iterator = chunks[Symbol.asyncIterator]();
  for (;;) {
    const next = await watched(iterator.next(), clock, signal);
    if (next.done) return;
    yield next.value;
  }
}

// Races `promise` against the idle timer and the abort signal. Racing, rather than only
// aborting, also unblocks a source that ignores its signal.
function watched<T>(promise: Promise<T>, clock: Clock, signal: AbortSignal): Promise<T> {
  let cancel = () => {};
  let onAbort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    cancel = clock.setTimeout(
      () => reject(new TranscriptError(`no data for ${IDLE_TIMEOUT_MS} ms`)),
      IDLE_TIMEOUT_MS,
    );
    onAbort = () => reject(new TranscriptError('stopped'));
    if (signal.aborted) onAbort();
    signal.addEventListener('abort', onAbort);
  });
  return Promise.race([promise, stopped]).finally(() => {
    cancel();
    signal.removeEventListener('abort', onAbort);
  });
}

function parse<T>(schema: z.ZodType<T>, data: string, event: string): T {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    json = undefined;
  }
  const result = schema.safeParse(json);
  if (!result.success) throw new TranscriptError(`malformed ${event} event`);
  return result.data;
}

export type AgentBuffer = { add(turn: { role: string; content: string }): ClaimResult[] };

/**
 * Collects everything the agent has said and re-checks all of it after each agent turn: turns
 * arrive as fragments, and a user turn can split one agent sentence in two. User turns are
 * never read. Each principal is returned once, so a turn replayed after a reconnect adds nothing.
 */
export function createAgentBuffer(registry: readonly string[]): AgentBuffer {
  let text = '';
  const sent = new Set<string>();
  return {
    add(turn) {
      if (turn.role !== 'agent') return [];
      // Fragments carry their own spaces ("He needs " + "last month's "), so no separator.
      text += turn.content;
      const fresh: ClaimResult[] = [];
      for (const claim of extractClaims(text, registry)) {
        if (claim.kind !== 'claimed' || sent.has(claim.principal)) continue;
        sent.add(claim.principal);
        fresh.push(claim);
      }
      return fresh;
    },
  };
}
