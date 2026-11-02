import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Clock } from '../src/clock.js';
import {
  CLAIM_WINDOW_MS,
  runCall,
  watch,
  type CallDeps,
  type StageEvent,
} from '../src/orchestrator.js';
import { followTranscript, type TranscriptEvent } from '../src/transcript.js';
import type { CallRecord, LookupResult } from '../src/types.js';

const alexCall: CallRecord = {
  kind: 'one',
  callId: 'call_alex_1',
  agentId: 'agent_alex',
  ownerSub: 'sub_alex',
  ownerName: 'Alex',
  from: '+15550000001',
  to: '+15550000002',
  startedAt: '2026-11-01T11:04:48.425Z',
};
const dialedAt = Date.parse(alexCall.startedAt);

function fakeClock(start: number): Clock & { advance(ms: number): void } {
  let now = start;
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

const connected: TranscriptEvent = { type: 'connected', callId: 'call_alex_1' };
const ended: TranscriptEvent = { type: 'ended' };
const agent = (content: string): TranscriptEvent => ({ type: 'turn', role: 'agent', content });
const user = (content: string): TranscriptEvent => ({ type: 'turn', role: 'user', content });

/** Events the test pushes one at a time; `fail` makes the stream throw. */
function scripted() {
  const queue: (TranscriptEvent | Error)[] = [];
  let wake = () => {};
  async function* turns(): AsyncGenerator<TranscriptEvent> {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) {
        await new Promise<void>((resolve) => (wake = resolve));
        continue;
      }
      if (next instanceof Error) throw next;
      yield next;
      if (next.type === 'ended') return;
    }
  }
  return {
    turns,
    push(...items: (TranscriptEvent | Error)[]) {
      queue.push(...items);
      wake();
    },
  };
}

function setup(start = dialedAt + 5_000) {
  const clock = fakeClock(start);
  const stages: StageEvent[] = [];
  const stream = scripted();
  let stagesAtOpen = -1;
  const deps: CallDeps = {
    openTurns() {
      stagesAtOpen = stages.length;
      return stream.turns();
    },
    clock,
    aliases: new Map(),
    registry: ['Aditya', 'Alex'],
    onStage: (event) => stages.push(event),
  };
  const states = () => stages.map((s) => s.verdict.state);
  return { clock, stages, stream, deps, states, stagesAtOpen: () => stagesAtOpen };
}

test('the owner is reported before the transcript stream opens', async () => {
  const { deps, stream, stages, stagesAtOpen } = setup();
  const done = runCall(alexCall, deps);
  stream.push(ended);
  await done;
  assert.equal(stagesAtOpen(), 1);
  assert.equal(stages[0]?.verdict.state, 'OWNER_KNOWN');
  assert.equal(stages[0]?.tOwnerKnownMs, 5_000);
});

test('an agent claiming someone other than the owner gives MISMATCH', async () => {
  const { deps, stream, states, stages, clock } = setup();
  const done = runCall(alexCall, deps);
  stream.push(connected);
  await settle();
  clock.advance(7_000);
  stream.push(agent("Hi, I'm calling on behalf of Aditya. "));
  const verdict = await done;
  assert.deepEqual(states(), ['OWNER_KNOWN', 'MISMATCH']);
  assert.deepEqual(verdict, { state: 'MISMATCH', owner: alexCall, claimed: 'Aditya' });
  assert.equal(stages[1]?.tClaimCheckedMs, 12_000);
});

test('an agent naming its owner gives VERIFIED', async () => {
  const { deps, stream, states } = setup();
  const done = runCall(alexCall, deps);
  stream.push(connected, agent("This is Alex's assistant. "), ended);
  assert.equal((await done).state, 'VERIFIED');
  assert.deepEqual(states(), ['OWNER_KNOWN', 'VERIFIED']);
});

test('the callee naming someone else never gives MISMATCH', async () => {
  const { deps, stream, states } = setup();
  const done = runCall(alexCall, deps);
  stream.push(connected, user("Is this Aditya's assistant? "), agent('Hello there. '), ended);
  await done;
  assert.deepEqual(states(), ['OWNER_KNOWN', 'VERIFIED_NO_CLAIM']);
});

test('no claim within the window gives VERIFIED_NO_CLAIM, and a later wrong claim still downgrades', async () => {
  const { deps, stream, states, clock } = setup();
  const done = runCall(alexCall, deps);
  stream.push(connected);
  await settle();
  clock.advance(CLAIM_WINDOW_MS);
  assert.deepEqual(states(), ['OWNER_KNOWN', 'VERIFIED_NO_CLAIM']);
  stream.push(agent("By the way, I'm Aditya's assistant. "));
  assert.equal((await done).state, 'MISMATCH');
});

test('the claim window opens at pickup, not at lookup', async () => {
  const { deps, stream, states, clock } = setup();
  const done = runCall(alexCall, deps);
  await settle();
  clock.advance(CLAIM_WINDOW_MS);
  assert.deepEqual(states(), ['OWNER_KNOWN']);
  stream.push(connected, ended);
  await done;
});

test('a failed stream before any claim gives UNVERIFIED transcript_error', async () => {
  const { deps, stream } = setup();
  const done = runCall(alexCall, deps);
  stream.push(connected, new Error('dropped'));
  assert.deepEqual(await done, { state: 'UNVERIFIED', reason: 'transcript_error' });
});

test('a stream failing after the window closed leaves the verdict alone', async () => {
  const { deps, stream, clock } = setup();
  const done = runCall(alexCall, deps);
  stream.push(connected);
  await settle();
  clock.advance(CLAIM_WINDOW_MS);
  stream.push(new Error('dropped'));
  assert.equal((await done).state, 'VERIFIED_NO_CLAIM');
});

test('the recorded call, replayed through the real parser, discloses Alex then flags Aditya', async () => {
  const { deps, states } = setup();
  const capture = readFileSync(new URL('./fixtures/transcript-stream.txt', import.meta.url));
  async function* body(): AsyncGenerator<Uint8Array> {
    yield capture;
  }
  const verdict = await runCall(alexCall, {
    ...deps,
    openTurns: (call, signal) =>
      followTranscript(async () => body(), call.callId, deps.clock, signal),
  });
  assert.deepEqual(states(), ['OWNER_KNOWN', 'MISMATCH']);
  assert.deepEqual(verdict, { state: 'MISMATCH', owner: alexCall, claimed: 'Aditya' });
});

test('watch follows each call once and reports an ambiguous lookup once', async () => {
  const results: LookupResult[] = [
    { kind: 'none' },
    { kind: 'ambiguous', count: 2 },
    { kind: 'ambiguous', count: 2 },
    { kind: 'error', reason: 'api_error' },
    alexCall,
    alexCall,
  ];
  const { deps, stages, clock } = setup();
  const controller = new AbortController();
  let opens = 0;
  const looping = watch(
    {
      ...deps,
      openTurns: () => {
        opens++;
        return scripted().turns();
      },
      lookup: async () => {
        const next = results.shift();
        if (results.length === 0) controller.abort();
        return next ?? { kind: 'none' };
      },
    },
    controller.signal,
  );
  for (let i = 0; i < 6; i++) {
    await settle();
    clock.advance(1_000);
  }
  await looping;
  assert.equal(opens, 1);
  assert.deepEqual(
    stages.map((s) => [s.callId, s.verdict.state]),
    [
      [null, 'UNVERIFIED'],
      ['call_alex_1', 'OWNER_KNOWN'],
    ],
  );
});
