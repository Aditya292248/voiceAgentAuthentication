# 0002. Fail closed, and verdicts only move down

- Status: Accepted
- Date: 2026-11-01

## Context

A verifier that says "verified" when it is unsure is worse than no verifier: it lends
credibility to exactly the calls it could not check. The lookup depends on network calls that
can time out, be rate limited or return something unexpected, and it can find zero or several
candidate calls.

A verdict that changes during a call has a second risk. If a warning can later turn into a
check mark, a caller can try to trigger that upgrade, and the person on the phone has to
judge which of two messages to believe.

## Decision

- **Fail closed.** Any error, timeout, rate limit, missing data or ambiguous match produces
  `UNVERIFIED` with a reason code. `VERIFIED` requires one positive, unambiguous match.
- **Monotonic.** Within a call, the verdict never moves from `MISMATCH` or `UNVERIFIED` to
  `VERIFIED`.
- The verdict is computed by a pure function, so these properties can be tested exhaustively.

The same rule applies at startup: invalid configuration stops the process instead of running
with defaults.

## Consequences

- Some legitimate calls will show as unverified during outages or when two calls overlap.
  This false negative is the accepted cost of never producing a false positive.
- Every failure path needs a reason code and a test showing that it ends in `UNVERIFIED`.
- Users see at most one downgrade per call and never a reversal.
