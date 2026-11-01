# 0003. What the caller claims can only lower the verdict

- Status: Accepted
- Date: 2026-11-01

## Context

An agent usually says who it is calling for: "I'm Aditya's assistant". That sentence is the
most natural thing to show the person being called, and also the easiest to fake. Anyone can
say any name, and a transcript can be wrong. The platform's call record, which links the
calling agent to the sub-account that owns it, is the only thing the caller cannot choose
([ADR 0001](0001-trust-anchor.md)).

The person being called is told whose agent it is as soon as the owner is known, so a claim
is never needed. Still, an agent that says "I'm calling on behalf of Alex" while owned by
someone else is the most direct form of deception, and the callee may not compare the two
names themselves. If a claim could raise the verdict, a caller would control part of the
outcome. If claims are ignored completely, that lie goes unflagged.

## Decision

- Trust comes only from the owner lookup. A claim never creates it.
- A claim is compared with the owner's name and that owner's aliases, keyed by sub-account
  ID. The match is exact and case-insensitive, with no partial or fuzzy matching.
- A claim for anyone else moves the verdict to `MISMATCH`, from `OWNER_KNOWN`, `VERIFIED` or
  `VERIFIED_NO_CLAIM`. A claim heard before the lookup finishes is kept and checked as soon
  as the owner is known, so an early claim cannot be lost.
- A claim that matches the owner can take `OWNER_KNOWN` to `VERIFIED`, and nothing further.
  It never lifts `VERIFIED_NO_CLAIM`, `MISMATCH` or `UNVERIFIED`.
- If several claims are heard, one wrong claim outweighs any number of right ones.

## Consequences

- `VERIFIED` and `VERIFIED_NO_CLAIM` are not final: a later claim for someone else still
  downgrades them. Only `MISMATCH` and `UNVERIFIED` never change.
- An agent that never names anyone gets `VERIFIED_NO_CLAIM`, not `VERIFIED`. The owner is
  still disclosed, so the callee knows whose agent it is. The agent never has to do anything
  for the check: claims are read passively from the call.
- A real nickname that is not in the alias list shows as `MISMATCH`. A false warning is the
  accepted cost of never showing a false check mark.
- Missing a claim (for example, an extraction miss) can only leave the verdict at
  `VERIFIED_NO_CLAIM`. It can never produce `VERIFIED` for the wrong person.
