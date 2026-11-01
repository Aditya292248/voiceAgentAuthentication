// The AgentPhone HTTP client: auth, timeout, typed errors and response validation.
// The API reference types responses as `any`, so every body is checked with zod here.
import { z } from 'zod';

export type Fetch = typeof fetch;

// Only the fields lookup reads. Objects are not strict, so a new API field breaks nothing.
// `status` is a plain string: the API already returns one undocumented value, "ringing".
const CallSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  fromNumber: z.string(),
  toNumber: z.string(),
  direction: z.string(),
  status: z.string(),
  // Live responses carry microseconds: "2026-11-01T11:04:48.425000Z".
  startedAt: z.iso.datetime(),
});

const CallsPageSchema = z.object({
  data: z.array(CallSchema),
  hasMore: z.boolean(),
  total: z.number().int().nonnegative(),
});

// Error bodies seen live: a JSON envelope on 401, plain text ("error code: 502") on 502.
const ErrorBodySchema = z.object({ error: z.object({ code: z.string() }) });

export type Call = z.infer<typeof CallSchema>;
export type CallsPage = z.infer<typeof CallsPageSchema>;
export type CallsQuery = { status: string; search: string; limit: number; offset: number };

export class RateLimited extends Error {
  override name = 'RateLimited';
  /** From the Retry-After header; undefined when it is missing or unreadable. */
  readonly retryAfterMs: number | undefined;
  constructor(retryAfterMs: number | undefined) {
    super('AgentPhone API rate limit (429)');
    this.retryAfterMs = retryAfterMs;
  }
}

export class ApiError extends Error {
  override name = 'ApiError';
  /** HTTP status, or null when no usable response arrived. */
  readonly status: number | null;
  constructor(status: number | null, message: string) {
    super(message);
    this.status = status;
  }
}

export class Timeout extends Error {
  override name = 'Timeout';
}

export type AgentPhoneClient = {
  /** One page of `GET /v1/calls`, scoped to one sub-account. */
  listCalls(subAccountId: string, query: CallsQuery): Promise<CallsPage>;
};

export type ClientOptions = {
  apiKey: string;
  baseUrl: string;
  fetch?: Fetch;
  timeoutMs?: number;
  now?: () => number;
};

// Error messages never include the URL (its query holds MY_NUMBER) or the API key.
export function createClient(options: ClientOptions): AgentPhoneClient {
  const { apiKey, fetch: fetchFn = fetch, timeoutMs = 3000, now = Date.now } = options;
  const base = options.baseUrl.replace(/\/+$/, '');

  async function getJson<T>(path: string, subAccountId: string, schema: z.ZodType<T>): Promise<T> {
    let response: Response;
    let text: string;
    try {
      response = await fetchFn(`${base}${path}`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'X-Sub-Account-Id': subAccountId,
          Accept: 'application/json',
        },
        // Also covers reading the body, not only waiting for the headers.
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Timeout(`no response within ${timeoutMs} ms`);
      }
      throw new ApiError(null, 'request failed before a response arrived');
    }

    const { status } = response;
    if (status === 429) {
      throw new RateLimited(parseRetryAfter(response.headers.get('retry-after'), now()));
    }
    if (!response.ok)
      throw new ApiError(status, `AgentPhone API returned ${status}${errorCode(text)}`);
    const parsed = schema.safeParse(parseJson(text));
    if (!parsed.success) throw new ApiError(status, `unexpected response shape (HTTP ${status})`);
    return parsed.data;
  }

  return {
    listCalls(subAccountId, query) {
      const params = new URLSearchParams({
        status: query.status,
        search: query.search,
        limit: String(query.limit),
        offset: String(query.offset),
      });
      return getJson(`/v1/calls?${params}`, subAccountId, CallsPageSchema);
    },
  };
}

/** Retry-After is either whole seconds or an HTTP date (RFC 9110). */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  const raw = value?.trim() ?? '';
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  // Only real HTTP dates: Date.parse would also accept strings like "5.5".
  if (!raw.endsWith('GMT')) return undefined;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

// A body that is not JSON (the plain-text 502) becomes undefined and fails validation.
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorCode(text: string): string {
  const body = ErrorBodySchema.safeParse(parseJson(text));
  return body.success ? ` (${body.data.error.code})` : '';
}
