import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  createClient,
  parseRetryAfter,
  RateLimited,
  Timeout,
  type CallsPage,
  type Fetch,
} from '../src/agentphone.js';
import { lookupCall, lookupWithRetry, MAX_PAGES, type LookupOptions } from '../src/lookup.js';
import type { LookupResult } from '../src/types.js';

// Redacted responses recorded from the live API (PR 0). Everything else is derived from them.
const fixture = (name: string): CallsPage =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'),
  ) as CallsPage;
const empty = fixture('calls-empty');
const ringing = fixture('calls-ringing');
const inProgress = fixture('calls-in-progress');

const options: LookupOptions = {
  myNumber: '+15550000002',
  subAccounts: [
    { id: 'sub_aditya', ownerName: 'Aditya' },
    { id: 'sub_alex', ownerName: 'Alex' },
  ],
};
// 12 s after the fixture call started.
const now = new Date('2026-11-01T11:05:00Z');

const alexCall: LookupResult = {
  kind: 'one',
  callId: 'call_alex_1',
  agentId: 'agent_alex',
  ownerSub: 'sub_alex',
  ownerName: 'Alex',
  from: '+15550000001',
  to: '+15550000002',
  startedAt: '2026-11-01T11:04:48.425000Z',
};

type Request = {
  sub: string | null;
  status: string;
  offset: number;
  search: string;
  auth: string | null;
};
type Reply = Response | Promise<Response>;

/** A fake `fetch` that answers from `reply`, defaulting to an empty page. */
function fakeApi(reply: (req: Request, signal: AbortSignal) => Reply | undefined) {
  const requests: Request[] = [];
  const fetch: Fetch = (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const req: Request = {
      sub: headers.get('x-sub-account-id'),
      status: url.searchParams.get('status') ?? '',
      offset: Number(url.searchParams.get('offset')),
      search: url.searchParams.get('search') ?? '',
      auth: headers.get('authorization'),
    };
    requests.push(req);
    return Promise.resolve(reply(req, init?.signal as AbortSignal) ?? json(empty));
  };
  return {
    requests,
    client: createClient({ apiKey: 'test-key', baseUrl: 'https://api.test', fetch, timeoutMs: 50 }),
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** The fixture page with its one call changed. */
function page(
  base: CallsPage,
  changes: Partial<CallsPage['data'][number]>,
  hasMore = false,
): CallsPage {
  return {
    data: base.data.map((call) => ({ ...call, ...changes })),
    hasMore,
    total: base.data.length,
  };
}

/** Lookup where the given sub-account and status answer with `body`; everything else is empty. */
function lookupWith(...routes: [sub: string, status: string, body: CallsPage][]) {
  const { client } = fakeApi((req) => {
    const route = routes.find(([sub, status]) => sub === req.sub && status === req.status);
    return route && json(route[2]);
  });
  return lookupCall(client, options, now);
}

test('no live call: none, after asking every sub-account for both statuses', async () => {
  const { client, requests } = fakeApi(() => undefined);
  assert.deepEqual(await lookupCall(client, options, now), { kind: 'none' });
  assert.deepEqual(requests.map((r) => `${r.sub} ${r.status}`).sort(), [
    'sub_aditya in-progress',
    'sub_aditya ringing',
    'sub_alex in-progress',
    'sub_alex ringing',
  ]);
  for (const req of requests) {
    assert.equal(req.auth, 'Bearer test-key');
    assert.equal(req.search, '+15550000002');
  }
});

test('one ringing call: matched before pickup, owner from its sub-account', async () => {
  assert.deepEqual(await lookupWith(['sub_alex', 'ringing', ringing]), alexCall);
});

test('one in-progress call: matched', async () => {
  assert.deepEqual(await lookupWith(['sub_alex', 'in-progress', inProgress]), alexCall);
});

test('the same call in both status queries of one sub-account counts once', async () => {
  const result = await lookupWith(
    ['sub_alex', 'ringing', ringing],
    ['sub_alex', 'in-progress', inProgress],
  );
  assert.deepEqual(result, alexCall);
});

test('one in-progress and another ringing: ambiguous (strict rule)', async () => {
  const other = page(ringing, { id: 'call_aditya_1', agentId: 'agent_aditya' });
  const result = await lookupWith(
    ['sub_alex', 'in-progress', inProgress],
    ['sub_aditya', 'ringing', other],
  );
  assert.deepEqual(result, { kind: 'ambiguous', count: 2 });
});

test('two in-progress calls: ambiguous', async () => {
  const other = page(inProgress, { id: 'call_aditya_1', agentId: 'agent_aditya' });
  const result = await lookupWith(
    ['sub_alex', 'in-progress', inProgress],
    ['sub_aditya', 'in-progress', other],
  );
  assert.deepEqual(result, { kind: 'ambiguous', count: 2 });
});

test('two ringing calls: ambiguous', async () => {
  const two: CallsPage = {
    data: [...ringing.data, ...page(ringing, { id: 'call_alex_2' }).data],
    hasMore: false,
    total: 2,
  };
  assert.deepEqual(await lookupWith(['sub_alex', 'ringing', two]), { kind: 'ambiguous', count: 2 });
});

test('the same call ID under two sub-accounts: ambiguous, never a guess', async () => {
  const result = await lookupWith(
    ['sub_alex', 'in-progress', inProgress],
    ['sub_aditya', 'in-progress', inProgress],
  );
  assert.deepEqual(result, { kind: 'ambiguous', count: 2 });
});

test('agentName naming someone else never changes the owner', async () => {
  const spoofed = page(inProgress, { agentName: "Aditya's assistant" } as Partial<
    CallsPage['data'][number]
  >);
  const result = await lookupWith(['sub_alex', 'in-progress', spoofed]);
  assert.deepEqual(result, alexCall);
  assert.ok(!JSON.stringify(result).includes('Aditya'));
});

test('ignored calls: stale, other number, inbound, wrong status', async (t) => {
  const cases: [string, Partial<CallsPage['data'][number]>][] = [
    ['started 61 s ago', { startedAt: '2026-11-01T11:03:59.000Z' }],
    ['to another number', { toNumber: '+15550000009' }],
    [
      'from my number (search matches from too)',
      { direction: 'inbound', fromNumber: '+15550000002', toNumber: '+15550000001' },
    ],
    ['status not the one asked for', { status: 'completed' }],
  ];
  for (const [name, changes] of cases) {
    await t.test(name, async () => {
      assert.deepEqual(await lookupWith(['sub_alex', 'in-progress', page(inProgress, changes)]), {
        kind: 'none',
      });
    });
  }
});

test('a call started 60 s ago still counts', async () => {
  const edge = page(inProgress, { startedAt: '2026-11-01T11:04:00.000Z' });
  assert.equal((await lookupWith(['sub_alex', 'in-progress', edge])).kind, 'one');
});

test('reads every page: a second call on page 2 makes it ambiguous', async () => {
  const { client, requests } = fakeApi((req) => {
    if (req.sub !== 'sub_alex' || req.status !== 'in-progress') return undefined;
    return json(
      req.offset === 0 ? page(inProgress, {}, true) : page(inProgress, { id: 'call_alex_2' }),
    );
  });
  assert.deepEqual(await lookupCall(client, options, now), { kind: 'ambiguous', count: 2 });
  assert.ok(requests.some((r) => r.offset === 100));
});

test('a hasMore that never ends: api_error after the page cap', async () => {
  const { client, requests } = fakeApi(() => json(page(empty, {}, true)));
  assert.deepEqual(await lookupCall(client, options, now), { kind: 'error', reason: 'api_error' });
  assert.ok(requests.length <= 4 * MAX_PAGES);
});

test('failures end in api_error', async (t) => {
  const failures: [string, () => Reply][] = [
    ['500', () => new Response('oops', { status: 500 })],
    ['plain-text 502', () => new Response('error code: 502', { status: 502 })],
    [
      '401 JSON envelope',
      () =>
        json(
          {
            detail: 'Invalid API key',
            error: { message: 'Invalid API key', code: 'unauthorized', type: 'auth' },
            request_id: 'req_1',
          },
          401,
        ),
    ],
    ['200 with a non-JSON body', () => new Response('<html>', { status: 200 })],
    [
      '200 with a call missing toNumber',
      () =>
        json({ data: [{ ...inProgress.data[0], toNumber: undefined }], hasMore: false, total: 1 }),
    ],
    ['200 with no envelope', () => json(inProgress.data)],
    ['network failure', () => Promise.reject(new TypeError('fetch failed'))],
  ];
  for (const [name, reply] of failures) {
    await t.test(name, async () => {
      const { client } = fakeApi((req) => (req.sub === 'sub_alex' ? reply() : undefined));
      assert.deepEqual(await lookupCall(client, options, now), {
        kind: 'error',
        reason: 'api_error',
      });
    });
  }
});

test('timeout: a request that never answers ends in api_error', async () => {
  const { client } = fakeApi((req, signal) => {
    if (req.sub !== 'sub_alex') return undefined;
    return new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason)),
    );
  });
  // The client reports it as a Timeout, not as a network failure.
  await assert.rejects(
    client.listCalls('sub_alex', { status: 'ringing', search: '', limit: 1, offset: 0 }),
    Timeout,
  );
  assert.deepEqual(await lookupCall(client, options, now), { kind: 'error', reason: 'api_error' });
});

test('429: lookupCall throws RateLimited with the Retry-After delay', async () => {
  const { client } = fakeApi(() => json({}, 429, { 'retry-after': '3' }));
  await assert.rejects(
    lookupCall(client, options, now),
    (err) => err instanceof RateLimited && err.retryAfterMs === 3000,
  );
});

/** A 429 for the first `limited` rounds of requests, then the in-progress fixture. */
function rateLimitedApi(limited: number, headers: Record<string, string>) {
  let calls = 0;
  return fakeApi((req) => {
    calls++;
    if (calls <= limited * 4) return json({}, 429, headers);
    return req.sub === 'sub_alex' && req.status === 'in-progress' ? json(inProgress) : undefined;
  });
}

/** A fake clock that only moves when the retry loop sleeps. */
function fakeClock() {
  let at = now.getTime();
  const waits: number[] = [];
  return {
    waits,
    now: () => at,
    sleep: (ms: number) => ((at += ms), waits.push(ms), Promise.resolve()),
  };
}

test('429 then success: waits Retry-After, then matches', async () => {
  const { client } = rateLimitedApi(1, { 'retry-after': '3' });
  const clock = fakeClock();
  const result = await lookupWithRetry(client, options, {
    deadline: now.getTime() + 10_000,
    ...clock,
  });
  assert.deepEqual(result, alexCall);
  assert.deepEqual(clock.waits, [3000]);
});

test('429 waits: 2 s without Retry-After, capped at 10 s', async () => {
  for (const [headers, wait] of [
    [{}, 2000],
    [{ 'retry-after': '120' }, 10_000],
  ] as const) {
    const { client } = rateLimitedApi(1, headers);
    const clock = fakeClock();
    await lookupWithRetry(client, options, { deadline: now.getTime() + 60_000, ...clock });
    assert.deepEqual(clock.waits, [wait]);
  }
});

test('429 past the deadline: lookup_timeout, without sleeping past it', async () => {
  const { client } = rateLimitedApi(100, { 'retry-after': '3' });
  const clock = fakeClock();
  const result = await lookupWithRetry(client, options, {
    deadline: now.getTime() + 5_000,
    ...clock,
  });
  assert.deepEqual(result, { kind: 'error', reason: 'lookup_timeout' });
  assert.deepEqual(clock.waits, [3000]);
});

test('Retry-After: seconds, HTTP date, or unreadable', () => {
  const at = Date.parse('2026-11-01T11:05:00Z');
  assert.equal(parseRetryAfter('7', at), 7000);
  assert.equal(parseRetryAfter('Sun, 01 Nov 2026 11:05:04 GMT', at), 4000);
  assert.equal(parseRetryAfter('Sun, 01 Nov 2026 11:04:00 GMT', at), 0);
  assert.equal(parseRetryAfter('5.5', at), undefined);
  assert.equal(parseRetryAfter(null, at), undefined);
});
