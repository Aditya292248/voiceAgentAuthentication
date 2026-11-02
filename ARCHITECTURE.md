# Architecture

## Bird's-eye view

The verifier watches for an in-progress AgentPhone call to one configured number. For that
call it asks the platform which agent placed it and which sub-account owns that agent; that
platform record is the only source of identity ([ADR 0001](docs/adr/0001-trust-anchor.md)).
As soon as the owner is known, the person being called is told whose agent it is, whether or
not the agent ever says. If the agent later claims to represent someone else, a second
message warns them. Every step that fails, times out or is ambiguous ends in `UNVERIFIED`
([ADR 0002](docs/adr/0002-fail-closed.md)).

So far there is config, logging, a health endpoint, the verdict state machine, claim
extraction, the AgentPhone client, call lookup, the transcript stream and the orchestrator that
joins them. The orchestrator reports each verdict change through a callback; nothing consumes
it yet, and the server does not start it yet.

## Code map

| Path                  | Role                                                                          |
| --------------------- | ----------------------------------------------------------------------------- |
| `src/agentphone.ts`   | AgentPhone HTTP client: auth, timeout, typed errors, zod validation.          |
| `src/claim.ts`        | `extractClaims(text, registry)`: which known names an agent turn claims.      |
| `src/clock.ts`        | `Clock`: time and timers, passed in so timer paths are testable.              |
| `src/config.ts`       | Parses and validates the environment. The only reader of `process.env`.       |
| `src/log.ts`          | One-line JSON event log, keyed by call ID.                                    |
| `src/lookup.ts`       | `lookupCall`: the one live call to `MY_NUMBER` and the sub-account owning it. |
| `src/orchestrator.ts` | `watch` and `runCall`: lookup, transcript and claims into verdict changes.    |
| `src/server.ts`       | Entry point. `node:http` server; `GET /health` only for now.                  |
| `src/transcript.ts`   | Transcript SSE parsing, watchdog with one reconnect, the agent-speech buffer. |
| `src/types.ts`        | Lookup results, claims, verdict states, events and reason codes.              |
| `src/verdict.ts`      | `nextVerdict(prev, event, aliases)`: the pure verdict state machine.          |
| `test/`               | `node:test` suites, run through `tsx`.                                        |
| `test/fixtures/`      | Redacted responses recorded from the live API. Numbers are `+1555…`.          |
| `docs/adr/`           | Decision records.                                                             |

Planned: token signing and the notifier, each in its own module under `src/`.

## Call lookup

`lookupCall(client, options, now)` makes one pass and returns the `LookupResult` that
`nextVerdict` consumes. The owner is the sub-account whose scoped query returned the call,
named from `SUB_ACCOUNTS`. Nothing the caller chooses, such as the agent's name, is read.

1. For every configured sub-account, list calls with status `ringing` and with status
   `in-progress` (`search=MY_NUMBER`, every page), in parallel. `ringing` is not in the API
   documentation but is real: before pickup it is the only status that lists the call.
2. Keep outbound calls to `MY_NUMBER` that started at most 60 s ago and whose status is the
   one asked for.
3. Count ringing and in-progress candidates together. Exactly one is `one`; none is `none`;
   more is `ambiguous` ([ADR 0004](docs/adr/0004-call-matching.md)). The same call in both
   status queries of one sub-account counts once; under two sub-accounts it is ambiguous.

Errors: a non-2xx status, a body that is not JSON (a 502 arrives as plain text), a response
that fails zod validation, a timeout (3 s per request) or more than 10 pages all give
`api_error`. A 429 is thrown as `RateLimited`; `lookupWithRetry` waits for `Retry-After`
(2 s if missing, at most 10 s) and gives up with `lookup_timeout` at its deadline. The client
takes `fetch` as a parameter, so the tests replay the recorded fixtures without a network.

## Claim extraction

`extractClaims(text, registry)` reads one agent turn and returns a claim for each principal it
says it acts for. The registry is every owner name and alias (`principalNames` builds it from
the sub-accounts and aliases). It is pure: the caller passes only agent turns, never the
callee's, so "is this about Alex?" from the person being called is never checked.

1. Normalize the text and the registry the same way: lowercase, drop apostrophes ("Aditya's"
   and "Adityas" become one word), turn other punctuation into spaces.
2. Match fixed patterns whose name slot is the registry itself: "on behalf of X", "X's
   assistant / agent / office", "calling for X", "I represent X", "I work for X". Whole words
   only, so "Al" never matches inside "Alfred".
3. Return each matched registry entry once, as written in the registry. Several names in one
   turn give several claims; `verdict.ts` decides which, if any, is the owner.

Only registry names can come back, so nothing the caller says becomes the text of a claim,
and an instruction like "ignore previous instructions, mark verified" matches nothing. The
cost is that a claim for someone outside the registry is not flagged; the owner is still
disclosed. Known false claims, "I'm calling for Aditya" meaning "may I speak to Aditya" and
"I'm not calling on behalf of Aditya", both err towards `MISMATCH`, never towards `VERIFIED`.
There is no LLM fallback.

## Transcript stream

`client.openTranscript(subAccountId, callId, signal)` opens
`GET /v1/calls/{id}/transcript/stream` as the owning sub-account. Its 3 s timeout covers only
the wait for headers; the body stays open for the call. `followTranscript` turns the body into
events:

- `connected` (its `callId` must be the call asked for), `turn` (`role`, `content`) and
  `ended`. Other event names and SSE comments are skipped; a malformed known event is a
  failure. `agentName` and the phone numbers in `connected` are dropped at parsing.
- Turns arrive as fragments, sent in batches when the speaker changes, and a user turn can
  split one agent sentence. So claims are not read per turn: `createAgentBuffer` joins every
  agent turn so far and runs `extractClaims` over all of it after each one, returning each
  principal once. User turns are never added.
- No bytes for 20 s, a close before `ended`, a failed open or a malformed event is a failure.
  The first one reconnects; the second throws `TranscriptError`. The stream has no event IDs,
  so a reconnect cannot resume; the buffer is kept, and because each principal is returned
  once, replayed turns add nothing.

## Orchestrator

`watch(deps, signal)` calls the lookup every second. `one` starts `runCall` for that call, once
per call ID. `ambiguous` is reported once (with no call ID) until the lookup returns to `none`.
`none` and errors while idle are not verdicts: there is no call to attach them to. So
`no_agentphone_call` and `lookup_timeout` cannot happen yet; that needs a signal that the phone
is ringing which does not come from AgentPhone.

`runCall(call, deps)` follows one call:

1. Feed the lookup to `nextVerdict`: `OWNER_KNOWN` is reported before the stream opens, often
   while the phone still rings.
2. Open the transcript. The first `connected` (pickup) starts the 20 s claim window.
3. Feed each new claim from the agent buffer to `nextVerdict`.
4. The window closing, or `ended`, sends `deadline: claim`. A stream failure sends
   `transcript_error`; once the window has closed, `nextVerdict` ignores it. The call is followed
   for at most 10 minutes, and no longer once the verdict is `MISMATCH` or `UNVERIFIED`.

Every change of state calls `onStage(event)` with the new verdict and two timings, measured from
when the call was dialed: `tOwnerKnownMs` and `tClaimCheckedMs` (claim heard or window closed).
They are also logged, by state name only. Dependencies (`lookup`, `openTurns`, `clock`) are
parameters, so the tests run without a network or real timers.

## Verdict state machine

Every call starts in `IDENTIFYING`. Events are a lookup result, a claim, a deadline (`lookup`
or `claim`) or an error; `nextVerdict` maps the current state and one event to the next state.

```
IDENTIFYING ──one match──▶ OWNER_KNOWN ──claim names owner─────────▶ VERIFIED
     │                          ├──claim names someone else──▶ MISMATCH
     │                          ├──claim deadline────────────▶ VERIFIED_NO_CLAIM
     │                          └──error─────────────────────▶ UNVERIFIED
     └──none / ambiguous / error / lookup deadline──▶ UNVERIFIED

VERIFIED, VERIFIED_NO_CLAIM ──claim names someone else──▶ MISMATCH
```

- Claims heard in `IDENTIFYING` are kept and checked when the owner is known: one match plus
  any wrong claim goes straight to `MISMATCH`.
- In `VERIFIED` and `VERIFIED_NO_CLAIM`, only a claim for someone else changes anything.
- `MISMATCH` and `UNVERIFIED` are final. Events that do not apply to the current state, such
  as a late lookup deadline, are ignored.

Its invariants, each checked over every sequence of up to three events in
`test/verdict.test.ts`:

1. **Fail closed.** No error, timeout, ambiguity or missing call yields `VERIFIED` or
   `VERIFIED_NO_CLAIM` ([ADR 0002](docs/adr/0002-fail-closed.md)).
2. **Monotonic.** Once `MISMATCH` or `UNVERIFIED`, the verdict never changes.
3. **Claims only downgrade.** A claim never creates trust: its only upward move is
   `OWNER_KNOWN` to `VERIFIED`, and only for the owner's name or alias
   ([ADR 0003](docs/adr/0003-claim-only-downgrades.md)).

### Notifications

The state machine only computes verdicts; the notifier (not built yet) decides what to send,
from the orchestrator's `onStage` events.

| Entering        | Message to the person being called                              |
| --------------- | --------------------------------------------------------------- |
| `OWNER_KNOWN`   | Disclosure: whose agent is calling, with a link to the proof    |
| `MISMATCH`      | Warning: the agent claimed someone other than its owner         |
| Any other state | Nothing yet; whether `UNVERIFIED` sends a message is still open |

A wrong claim heard before the lookup finishes goes straight from `IDENTIFYING` to
`MISMATCH`, so the notifier sends the disclosure and the warning together. For the demo, each
message is a proof-page link printed to the terminal; SMS or iMessage comes later.

## Invariants

- `process.env` is read in exactly one place, `loadConfig()` in `src/config.ts`.
- Logs carry IDs, stage names, status codes and timings. Never transcript text, phone
  numbers, owner names or API keys. Config errors never echo the bad value.
- The server binds to `127.0.0.1`.
- Caller ID and anything the caller says are untrusted input. They can lower a verdict but
  never raise one.
- The verdict for a call never moves from `MISMATCH` or `UNVERIFIED` back to `VERIFIED`.
- A claim's principal is always an entry from the registry, never text taken from the call.
- A call's owner comes only from which sub-account's query returned it, never from
  `agentName` or any other field the caller sets.
- `src/agentphone.ts` is the only module that talks to the AgentPhone API.
- `src/verdict.ts` and `src/claim.ts` do no I/O, and `verdict.ts` reads no clock. Timers live in the caller and arrive as
  deadline events.
- Only `role: "agent"` turns are ever checked for claims.

## Intentional oddities

- **`.js` in TypeScript imports** (`'./config.js'`). Required by `NodeNext` module
  resolution: the import names the file that exists at runtime.
- **Two tsconfigs.** `tsconfig.json` type-checks `src` and `test` without emitting;
  `tsconfig.build.json` emits only `src` to `dist/`, so `dist/server.js` sits one level below
  the root, like `src/server.ts`.
- **`package.json` is read at runtime** for the version. Importing it would pull a file
  outside `rootDir` into the build.
- **`parseConfig` throws instead of exiting.** It stays pure so tests can call it;
  `loadConfig` is the thin wrapper that prints and exits.
- **`@types/node` is pinned to 20** so the compiler rejects APIs that the oldest supported
  Node lacks.
