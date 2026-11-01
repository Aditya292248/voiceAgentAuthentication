# 0004. A call matches only when it is the one live call to the number

- Status: Accepted
- Date: 2026-11-01

## Context

The owner of a call is the sub-account whose `GET /v1/calls` query returned it
([ADR 0001](0001-trust-anchor.md)). To find it, the verifier lists live outbound calls to
`MY_NUMBER` in every configured sub-account. Sometimes that list has more than one call: one
agent is talking while another rings (call waiting), or one has gone to voicemail.

The API has two live statuses. `ringing` is not in the documentation, but `POST /v1/calls`
returns it, and for the first seconds of a call only `?status=ringing` lists the call;
`?status=in-progress` is empty until pickup. Querying both means the owner can be disclosed
while the phone is still ringing.

A tempting rule is "exactly one `in-progress` call wins, even if another is ringing", on the
grounds that the in-progress call is the one being heard. It fails in this case: call B has
gone to voicemail, which may count as `in-progress` (untested), while call A rings the phone.
The rule matches B and discloses B's owner during A's ring. The verdict is monotonic, and a
second lookup cannot replace a known owner, so after A is answered the callee still sees B's
owner.

## Decision

- A candidate is a call with status `ringing` or `in-progress` (the status in the response
  must match the one queried), direction `outbound`, `toNumber` equal to `MY_NUMBER`, and
  `startedAt` at most 60 s ago.
- Candidates from both statuses and all sub-accounts are counted together. Exactly one is a
  match. None is `none`. Two or more is `ambiguous`, which ends `UNVERIFIED`.
- The same call ID in both status queries of one sub-account counts once (a call caught
  between `ringing` and `in-progress`). The same call ID under two sub-accounts counts twice,
  so it is ambiguous.
- Every page is read. A response that never stops saying `hasMore` fails as `api_error`.
- `agentName` is never read. The caller chooses it.

## Consequences

- During call waiting, a real call shows as `UNVERIFIED` (`ambiguous`). This is the accepted
  cost of never naming the wrong owner.
- The owner is usually known before pickup.
- `startedAt` is the time the call was dialled and does not change at pickup, so the 60 s
  window counts from dialling. The API has no `startedAt` filter, so the check runs
  client-side.
- A call that changes status between the two queries of one pass can appear in neither. The
  next pass finds it.
