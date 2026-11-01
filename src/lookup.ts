// Call lookup: which configured sub-account owns the live AgentPhone call to MY_NUMBER.
// The owner is the sub-account whose scoped query returned the call. Nothing the caller
// controls, such as `agentName`, is ever read for ownership.
import { ApiError, RateLimited, Timeout, type AgentPhoneClient, type Call } from './agentphone.js';
import { _logCallMatched } from './log.js';
import type { LookupResult } from './types.js';

/** A call that started longer ago than this is not the one ringing now. */
export const STALE_AFTER_MS = 60_000;
export const PAGE_SIZE = 100;
// A runaway `hasMore` must not loop forever. Past this many pages the lookup fails closed.
export const MAX_PAGES = 10;
export const DEFAULT_RETRY_MS = 2_000;
export const MAX_RETRY_MS = 10_000;

// "ringing" is undocumented but real: for the first seconds `in-progress` is empty and only
// `ringing` has the call. Querying both lets the owner be known before pickup.
const LIVE_STATUSES = ['ringing', 'in-progress'] as const;

export type LookupOptions = {
  myNumber: string;
  subAccounts: readonly { id: string; ownerName: string }[];
};

type Candidate = { call: Call; sub: LookupOptions['subAccounts'][number]; status: string };

/**
 * One pass over every configured sub-account and live status. Strict rule (ADR 0004):
 * ringing and in-progress candidates are counted together; exactly one is a match.
 * API errors, timeouts and bad shapes become `api_error`. A 429 is thrown as `RateLimited`,
 * so the caller can wait and retry.
 */
export async function lookupCall(
  client: AgentPhoneClient,
  options: LookupOptions,
  now: Date,
): Promise<LookupResult> {
  let pages: Candidate[][];
  try {
    pages = await Promise.all(
      options.subAccounts.flatMap((sub) =>
        LIVE_STATUSES.map(async (status) =>
          (await listAll(client, sub.id, status, options.myNumber))
            .filter((call) => isCandidate(call, status, options.myNumber, now))
            .map((call) => ({ call, sub, status })),
        ),
      ),
    );
  } catch (err) {
    if (err instanceof ApiError || err instanceof Timeout)
      return { kind: 'error', reason: 'api_error' };
    throw err;
  }

  // A call caught between `ringing` and `in-progress` can show up in both queries of the same
  // sub-account: count it once. The same call ID under two sub-accounts stays two candidates,
  // so it is ambiguous.
  const seen = new Map<string, Candidate>();
  for (const candidate of pages.flat()) {
    seen.set(`${candidate.sub.id}\n${candidate.call.id}`, candidate);
  }
  const candidates = [...seen.values()];

  const [match] = candidates;
  if (match === undefined) return { kind: 'none' };
  if (candidates.length > 1) return { kind: 'ambiguous', count: candidates.length };

  const { call, sub, status } = match;
  _logCallMatched(call.id, sub.id, status);
  return {
    kind: 'one',
    callId: call.id,
    agentId: call.agentId,
    ownerSub: sub.id,
    ownerName: sub.ownerName,
    from: call.fromNumber,
    to: call.toNumber,
    startedAt: call.startedAt,
  };
}

export type RetryOptions = {
  /** Epoch ms after which a rate-limited lookup gives up with `lookup_timeout`. */
  deadline: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** `lookupCall`, waiting out 429s (Retry-After, capped) until the deadline. */
export async function lookupWithRetry(
  client: AgentPhoneClient,
  options: LookupOptions,
  retry: RetryOptions,
): Promise<LookupResult> {
  const { deadline, now = Date.now, sleep = defaultSleep } = retry;
  for (;;) {
    try {
      return await lookupCall(client, options, new Date(now()));
    } catch (err) {
      if (!(err instanceof RateLimited)) throw err;
      const wait = Math.min(err.retryAfterMs ?? DEFAULT_RETRY_MS, MAX_RETRY_MS);
      if (now() + wait >= deadline) return { kind: 'error', reason: 'lookup_timeout' };
      await sleep(wait);
    }
  }
}

// Every page: missing a second match on page 2 would turn `ambiguous` into a false `one`.
async function listAll(
  client: AgentPhoneClient,
  subAccountId: string,
  status: string,
  myNumber: string,
): Promise<Call[]> {
  const calls: Call[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = { status, search: myNumber, limit: PAGE_SIZE, offset: page * PAGE_SIZE };
    const result = await client.listCalls(subAccountId, query);
    calls.push(...result.data);
    if (!result.hasMore) return calls;
  }
  throw new ApiError(null, `more than ${MAX_PAGES} pages of calls`);
}

// `search` matches from or to, and the server's status filter is not trusted blindly.
function isCandidate(call: Call, status: string, myNumber: string, now: Date): boolean {
  if (call.status !== status || call.direction !== 'outbound' || call.toNumber !== myNumber) {
    return false;
  }
  return now.getTime() - Date.parse(call.startedAt) <= STALE_AFTER_MS;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
