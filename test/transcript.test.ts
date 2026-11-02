import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ApiError, createClient, Timeout, type Fetch } from '../src/agentphone.js';
import type { Clock } from '../src/clock.js';
import {
  createAgentBuffer,
  followTranscript,
  IDLE_TIMEOUT_MS,
  TranscriptError,
  transcriptEvents,
  type OpenStream,
  type TranscriptEvent,
} from '../src/transcript.js';

// The redacted PR 0 capture: Alex's agent claims to call on behalf of Aditya.
const capture = readFileSync(new URL('./fixtures/transcript-stream.txt', import.meta.url));
const registry = ['Aditya', 'Alex'];

async function* chunked(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}
const bytes = (text: string) => new TextEncoder().encode(text);

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

const turn = (role: string, content: string) => ({ role, content });

function fakeClock(): Clock & { advance(ms: number): void } {
  let now = 0;
  let timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return () => (timers = timers.filter((t) => t !== timer));
    },
    advance(ms) {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      timers = timers.filter((t) => t.at > now);
      for (const t of due) t.fn();
    },
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const silent = async function* (): AsyncGenerator<Uint8Array> {
  await new Promise(() => {});
};

test('the capture parses into connected, eight turns and ended', async () => {
  const events = await collect(transcriptEvents(chunked(capture, capture.length)));
  assert.deepEqual(events[0], { type: 'connected', callId: 'call_alex_1' });
  assert.deepEqual(events.at(-1), { type: 'ended' });
  const turns = events.filter((e) => e.type === 'turn');
  assert.equal(turns.length, 8);
  assert.deepEqual(turns[1], { type: 'turn', role: 'user', content: 'Who are the ' });
});

test('one-byte chunks give the same events, including split UTF-8 characters', async () => {
  const whole = await collect(transcriptEvents(chunked(capture, capture.length)));
  const split = await collect(transcriptEvents(chunked(capture, 1)));
  assert.deepEqual(split, whole);
  assert.ok(split.some((e) => e.type === 'turn' && e.content.includes('can’t')));
});

test('agentName and the numbers in connected are not passed on', async () => {
  const [connected] = await collect(transcriptEvents(chunked(capture, capture.length)));
  assert.deepEqual(Object.keys(connected ?? {}).sort(), ['callId', 'type']);
});

test('CRLF lines and heartbeat comments parse; unknown events are skipped', async () => {
  const text =
    ': ping\r\n\r\nevent: usage\r\ndata: {}\r\n\r\nevent: turn\r\ndata: {"role":"agent","content":"Hi"}\r\n\r\n';
  const events = await collect(transcriptEvents(chunked(bytes(text), 3)));
  assert.deepEqual(events, [{ type: 'turn', role: 'agent', content: 'Hi' }]);
});

test('a malformed turn throws TranscriptError', async () => {
  const text = 'event: turn\ndata: {"role":"agent"}\n\n';
  await assert.rejects(collect(transcriptEvents(chunked(bytes(text), 64))), TranscriptError);
});

test('the capture yields one claim, for Aditya, from agent turns', () => {
  const buffer = createAgentBuffer(registry);
  const claims = [
    turn('agent', "Hi, I'm an AI assistant calling on behalf of Aditya. He needs "),
    turn('user', 'Who are the '),
    turn('agent', "last month's "),
  ].flatMap((t) => buffer.add(t));
  assert.deepEqual(claims, [{ kind: 'claimed', principal: 'Aditya' }]);
});

test('a claim split across two agent fragments with a user turn between is caught', () => {
  const buffer = createAgentBuffer(registry);
  assert.deepEqual(buffer.add(turn('agent', "Hi, I'm calling on behalf ")), []);
  assert.deepEqual(buffer.add(turn('user', 'Sorry, who? ')), []);
  assert.deepEqual(buffer.add(turn('agent', 'of Aditya. ')), [
    { kind: 'claimed', principal: 'Aditya' },
  ]);
});

test('a user turn naming someone never yields a claim', () => {
  const buffer = createAgentBuffer(registry);
  assert.deepEqual(
    buffer.add(turn('user', "Is this about Aditya? Are you Aditya's assistant?")),
    [],
  );
  assert.deepEqual(buffer.add(turn('agent', 'I can’t share personal details. ')), []);
});

test('a turn replayed after a reconnect adds no new claim', () => {
  const buffer = createAgentBuffer(registry);
  const said = turn('agent', "This is Aditya's assistant. ");
  assert.equal(buffer.add(said).length, 1);
  assert.deepEqual(buffer.add(said), []);
});

test('a stream that closes before ended is reopened once', async () => {
  const sources = [
    chunked(bytes('event: connected\ndata: {"callId":"call_alex_1"}\n\n'), 64),
    chunked(capture, 64),
  ];
  let opens = 0;
  const open: OpenStream = async () => sources[opens++] ?? silent();
  const events = await collect(
    followTranscript(open, 'call_alex_1', fakeClock(), new AbortController().signal),
  );
  assert.equal(opens, 2);
  assert.deepEqual(events.at(-1), { type: 'ended' });
});

test('two silent streams end in TranscriptError after the watchdog fires twice', async () => {
  const clock = fakeClock();
  let opens = 0;
  const open: OpenStream = async () => {
    opens++;
    return silent();
  };
  const result = collect(
    followTranscript(open, 'call_alex_1', clock, new AbortController().signal),
  );
  result.catch(() => {});
  await settle();
  clock.advance(IDLE_TIMEOUT_MS);
  await settle();
  clock.advance(IDLE_TIMEOUT_MS);
  await assert.rejects(result, TranscriptError);
  assert.equal(opens, 2);
});

test('a stream for a different call is rejected', async () => {
  const open: OpenStream = async () => chunked(capture, 64);
  const events: TranscriptEvent[] = [];
  await assert.rejects(async () => {
    for await (const e of followTranscript(
      open,
      'call_other',
      fakeClock(),
      new AbortController().signal,
    ))
      events.push(e);
  }, TranscriptError);
  assert.deepEqual(events, []);
});

test('aborting the signal ends the stream quietly', async () => {
  const controller = new AbortController();
  const open: OpenStream = async () => silent();
  const result = collect(followTranscript(open, 'call_alex_1', fakeClock(), controller.signal));
  await settle();
  controller.abort();
  assert.deepEqual(await result, []);
});

// The client's stream request: the header timeout must not cut a body that is still streaming.
function streamClient(
  reply: (url: URL, headers: Headers, signal: AbortSignal) => Promise<Response>,
) {
  const fetch: Fetch = (input, init) =>
    reply(new URL(String(input)), new Headers(init?.headers), init?.signal as AbortSignal);
  return createClient({ apiKey: 'test-key', baseUrl: 'https://api.test', fetch, timeoutMs: 20 });
}

test('openTranscript asks for the call stream as its owner and returns the body', async () => {
  let seen: { path: string; sub: string | null; accept: string | null } | undefined;
  const client = streamClient(async (url, headers) => {
    seen = {
      path: url.pathname,
      sub: headers.get('x-sub-account-id'),
      accept: headers.get('accept'),
    };
    return new Response(capture, { headers: { 'content-type': 'text/event-stream' } });
  });
  const body = await client.openTranscript('sub_alex', 'call_alex_1', new AbortController().signal);
  const events = await collect(transcriptEvents(body));
  assert.deepEqual(seen, {
    path: '/v1/calls/call_alex_1/transcript/stream',
    sub: 'sub_alex',
    accept: 'text/event-stream',
  });
  assert.deepEqual(events.at(-1), { type: 'ended' });
});

test('openTranscript turns a non-2xx status into ApiError', async () => {
  const client = streamClient(async () => new Response('not found', { status: 404 }));
  await assert.rejects(
    client.openTranscript('sub_alex', 'call_alex_1', new AbortController().signal),
    ApiError,
  );
});

test('openTranscript times out waiting for headers, but not while the body streams', async () => {
  const hanging = streamClient(
    (_url, _headers, signal) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted'))),
      ),
  );
  await assert.rejects(
    hanging.openTranscript('sub_alex', 'call_alex_1', new AbortController().signal),
    Timeout,
  );

  const slow = streamClient(async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(capture);
          controller.close();
        }, 60);
      },
    });
    return new Response(stream);
  });
  const body = await slow.openTranscript('sub_alex', 'call_alex_1', new AbortController().signal);
  assert.deepEqual((await collect(transcriptEvents(body))).at(-1), { type: 'ended' });
});
