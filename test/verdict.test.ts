import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CallRecord, ReasonCode, Verdict, VerdictEvent } from '../src/types.js';
import { type Aliases, initialVerdict, nextVerdict } from '../src/verdict.js';

const owner: CallRecord = {
  kind: 'one',
  callId: 'call_1',
  agentId: 'agent_1',
  ownerSub: 'sa_alex',
  ownerName: 'Alex',
  from: '+12025550100',
  to: '+12025550123',
  startedAt: '2026-11-01T12:00:00Z',
};
const aliases: Aliases = new Map([['sa_alex', ['Al']]]);

// Events
const found: VerdictEvent = { type: 'lookup', result: owner };
const notFound: VerdictEvent = { type: 'lookup', result: { kind: 'none' } };
const ambiguous: VerdictEvent = { type: 'lookup', result: { kind: 'ambiguous', count: 2 } };
const lookupError: VerdictEvent = {
  type: 'lookup',
  result: { kind: 'error', reason: 'api_error' },
};
const claim = (principal: string): VerdictEvent => ({
  type: 'claim',
  result: { kind: 'claimed', principal },
});
const noClaim: VerdictEvent = { type: 'claim', result: { kind: 'none' } };
const lookupDeadline: VerdictEvent = { type: 'deadline', which: 'lookup' };
const claimDeadline: VerdictEvent = { type: 'deadline', which: 'claim' };
const error = (reason: ReasonCode): VerdictEvent => ({ type: 'error', reason });

// States
const identifying = (...claims: string[]): Verdict => ({ state: 'IDENTIFYING', claims });
const ownerKnown: Verdict = { state: 'OWNER_KNOWN', owner };
const verified = (claimed: string): Verdict => ({ state: 'VERIFIED', owner, claimed });
const verifiedNoClaim: Verdict = { state: 'VERIFIED_NO_CLAIM', owner };
const mismatch = (claimed: string): Verdict => ({ state: 'MISMATCH', owner, claimed });
const unverified = (reason: ReasonCode): Verdict => ({ state: 'UNVERIFIED', reason });

const transitions: [name: string, from: Verdict, event: VerdictEvent, to: Verdict][] = [
  ['one match', identifying(), found, ownerKnown],
  ['no matching call', identifying(), notFound, unverified('no_agentphone_call')],
  ['several matching calls', identifying(), ambiguous, unverified('ambiguous')],
  ['lookup error', identifying(), lookupError, unverified('api_error')],
  ['lookup deadline', identifying(), lookupDeadline, unverified('lookup_timeout')],
  ['transcript error', identifying(), error('transcript_error'), unverified('transcript_error')],
  ['early claim is kept', identifying(), claim('Aditya'), identifying('Aditya')],
  ['empty claim is ignored', identifying(), noClaim, identifying()],
  ['claim deadline is out of order', identifying(), claimDeadline, identifying()],
  ['early wrong claim, then match', identifying('Aditya'), found, mismatch('Aditya')],
  ['early right claim, then match', identifying('alex'), found, verified('alex')],
  ['right then wrong claim', identifying('Alex', 'Aditya'), found, mismatch('Aditya')],
  ['early claim, then no call', identifying('Alex'), notFound, unverified('no_agentphone_call')],

  ['claim names owner', ownerKnown, claim('Alex'), verified('Alex')],
  ['claim ignores case and spaces', ownerKnown, claim(' ALEX '), verified(' ALEX ')],
  ['claim names an alias', ownerKnown, claim('al'), verified('al')],
  ['claim names someone else', ownerKnown, claim('Aditya'), mismatch('Aditya')],
  ['no partial match', ownerKnown, claim('Alexander'), mismatch('Alexander')],
  ['empty claim is ignored', ownerKnown, noClaim, ownerKnown],
  ['claim deadline', ownerKnown, claimDeadline, verifiedNoClaim],
  ['late lookup deadline', ownerKnown, lookupDeadline, ownerKnown],
  ['second lookup', ownerKnown, notFound, ownerKnown],
  ['claim timeout', ownerKnown, error('claim_timeout'), unverified('claim_timeout')],
  ['transcript error', ownerKnown, error('transcript_error'), unverified('transcript_error')],

  ['later wrong claim', verified('Alex'), claim('Aditya'), mismatch('Aditya')],
  ['later right claim', verified('Alex'), claim('Al'), verified('Alex')],
  ['later error', verified('Alex'), error('transcript_error'), verified('Alex')],
  ['later deadline', verified('Alex'), claimDeadline, verified('Alex')],

  ['late wrong claim', verifiedNoClaim, claim('Aditya'), mismatch('Aditya')],
  ['late right claim never upgrades', verifiedNoClaim, claim('Alex'), verifiedNoClaim],
  ['later error', verifiedNoClaim, error('api_error'), verifiedNoClaim],
];

for (const [name, from, event, to] of transitions) {
  test(`${from.state}: ${name}`, () => {
    assert.deepEqual(nextVerdict(from, event, aliases), to);
  });
}

test('an owner with no aliases matches only its own name', () => {
  assert.deepEqual(nextVerdict(ownerKnown, claim('Al'), new Map()), mismatch('Al'));
});

// Every kind of event, used both for the absorbing-state test and for the sequences below.
const ownerClaims = new Set(['Alex', 'AL']);
const allEvents: VerdictEvent[] = [
  found,
  notFound,
  ambiguous,
  lookupError,
  claim('Alex'),
  claim('AL'),
  claim('Aditya'),
  noClaim,
  lookupDeadline,
  claimDeadline,
  error('transcript_error'),
];

test('MISMATCH and UNVERIFIED ignore every event', () => {
  for (const from of [mismatch('Aditya'), unverified('api_error')])
    for (const event of allEvents) assert.equal(nextVerdict(from, event, aliases), from);
});

// Property-style checks: every event sequence of length 1 to 3, starting from IDENTIFYING.
type Step = { prev: Verdict; event: VerdictEvent; next: Verdict };

function sequences(length: number): VerdictEvent[][] {
  if (length === 0) return [[]];
  return sequences(length - 1).flatMap((seq) => allEvents.map((event) => [...seq, event]));
}

function run(events: VerdictEvent[]): Step[] {
  let prev = initialVerdict;
  return events.map((event) => {
    const next = nextVerdict(prev, event, aliases);
    const step = { prev, event, next };
    prev = next;
    return step;
  });
}

const isTrusted = (v: Verdict) => v.state === 'VERIFIED' || v.state === 'VERIFIED_NO_CLAIM';
const isAbsorbing = (v: Verdict) => v.state === 'MISMATCH' || v.state === 'UNVERIFIED';
const isFailure = (e: VerdictEvent) =>
  e.type === 'error' ||
  (e.type === 'lookup' && e.result.kind !== 'one') ||
  (e.type === 'deadline' && e.which === 'lookup');
const claimed = (e: VerdictEvent) =>
  e.type === 'claim' && e.result.kind === 'claimed' ? e.result.principal : undefined;
const isWrongClaim = (e: VerdictEvent) => {
  const principal = claimed(e);
  return principal !== undefined && !ownerClaims.has(principal);
};

const cases = [1, 2, 3].flatMap(sequences).map((events) => ({ events, steps: run(events) }));

test('invariant 1, fail closed: no failure event produces a trusted verdict', () => {
  assert.equal(cases.length, 11 + 11 ** 2 + 11 ** 3);
  for (const { events, steps } of cases) {
    for (const { prev, event, next } of steps)
      if (isFailure(event)) assert.ok(!isTrusted(next) || next === prev, JSON.stringify(events));
    const last = steps.at(-1)?.next;
    if (last && isTrusted(last)) assert.ok(events.includes(found), JSON.stringify(events));
  }
});

test('invariant 2, monotonic: MISMATCH and UNVERIFIED never change', () => {
  for (const { events, steps } of cases) {
    const first = steps.findIndex((step) => isAbsorbing(step.next));
    if (first === -1) continue;
    for (const step of steps.slice(first + 1))
      assert.equal(step.next, step.prev, JSON.stringify(events));
  }
});

test('invariant 3, claims only downgrade', () => {
  for (const { events, steps } of cases) {
    for (const { prev, event, next } of steps) {
      if (claimed(event) === undefined) continue;
      // The only upward move a claim makes is OWNER_KNOWN to VERIFIED, and only for the owner.
      if (isTrusted(next) && next !== prev)
        assert.ok(prev.state === 'OWNER_KNOWN' && !isWrongClaim(event), JSON.stringify(events));
      if (isWrongClaim(event) && 'owner' in prev)
        assert.equal(next.state, 'MISMATCH', JSON.stringify(events));
    }
    // A claim for anyone else, at any point, means the call never ends trusted.
    const last = steps.at(-1)?.next;
    if (events.some(isWrongClaim)) assert.ok(last && !isTrusted(last), JSON.stringify(events));
  }
});
