# 0001. The trust anchor is the platform's call record

- Status: Accepted
- Date: 2026-11-01

## Context

The person receiving a call from an AI agent needs to know who is really behind it. The
obvious signals are all controlled by the caller:

- Caller ID can be spoofed, and a number says nothing about which agent is using it.
- What the agent says ("I'm calling on behalf of ...") is generated text. A malicious
  operator can make it say anything.

The one party that knows which agent placed a call is the platform that placed it.
AgentPhone keeps a record of every in-progress call, including the agent that placed it, and
each agent belongs to a sub-account.

## Decision

Identity comes only from AgentPhone's live call record: find the in-progress call to the
configured number, take its `agentId`, and resolve that agent to its sub-account and owner.

Caller ID and the caller's speech are untrusted input. They are never used to establish
identity. The claimed principal is extracted only to compare with the owner, and can only
lower the verdict.

## Consequences

- Calls not placed through AgentPhone cannot be verified. They show as unverified, by design.
- The owner is whatever name the sub-account was configured with. A production version needs
  a verified owner identity.
- This prototype can only see sub-accounts it holds API access to. A real deployment would
  run the lookup on the platform side across all accounts and sign with the platform's keys.
- If two matching calls are in progress at once, the record does not single one out, so the
  result is unverified (see [0002](0002-fail-closed.md)).
