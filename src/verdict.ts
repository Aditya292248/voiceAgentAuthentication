// The verdict state machine. Pure: no I/O, no clock, so every path can be tested.
import type { CallRecord, LookupResult, ReasonCode, Verdict, VerdictEvent } from './types.js';

/** Extra names per owner, keyed by sub-account ID (the identity anchor), not by name. */
export type Aliases = ReadonlyMap<string, readonly string[]>;

export const initialVerdict: Verdict = { state: 'IDENTIFYING', claims: [] };

type State<S extends Verdict['state']> = Extract<Verdict, { state: S }>;

export function nextVerdict(prev: Verdict, event: VerdictEvent, aliases: Aliases): Verdict {
  switch (prev.state) {
    case 'IDENTIFYING':
      return fromIdentifying(prev, event, aliases);
    case 'OWNER_KNOWN':
      return fromOwnerKnown(prev, event, aliases);
    case 'VERIFIED':
    case 'VERIFIED_NO_CLAIM':
      // A later claim for someone else still downgrades. Nothing else changes an earned verdict.
      if (event.type === 'claim' && event.result.kind === 'claimed') {
        const after = withOwner(prev.owner, [event.result.principal], aliases);
        if (after.state === 'MISMATCH') return after;
      }
      return prev;
    case 'MISMATCH':
    case 'UNVERIFIED':
      return prev;
  }
}

function fromIdentifying(
  prev: State<'IDENTIFYING'>,
  event: VerdictEvent,
  aliases: Aliases,
): Verdict {
  switch (event.type) {
    case 'lookup':
      return fromLookup(event.result, prev.claims, aliases);
    case 'claim':
      if (event.result.kind === 'none') return prev;
      return { state: 'IDENTIFYING', claims: [...prev.claims, event.result.principal] };
    case 'deadline':
      // The claim window only starts once the owner is known.
      return event.which === 'lookup' ? unverified('lookup_timeout') : prev;
    case 'error':
      return unverified(event.reason);
  }
}

function fromLookup(result: LookupResult, claims: readonly string[], aliases: Aliases): Verdict {
  switch (result.kind) {
    case 'one':
      return withOwner(result, claims, aliases);
    case 'none':
      return unverified('no_agentphone_call');
    case 'ambiguous':
      return unverified('ambiguous');
    case 'error':
      return unverified(result.reason);
  }
}

function fromOwnerKnown(
  prev: State<'OWNER_KNOWN'>,
  event: VerdictEvent,
  aliases: Aliases,
): Verdict {
  switch (event.type) {
    case 'claim':
      if (event.result.kind === 'none') return prev;
      return withOwner(prev.owner, [event.result.principal], aliases);
    case 'deadline':
      if (event.which === 'lookup') return prev;
      return { state: 'VERIFIED_NO_CLAIM', owner: prev.owner };
    case 'error':
      return unverified(event.reason);
    case 'lookup':
      // Out of order: the owner is already known, and a second lookup cannot replace it.
      return prev;
  }
}

/** Any claim naming someone other than the owner wins: MISMATCH beats VERIFIED. */
function withOwner(owner: CallRecord, claims: readonly string[], aliases: Aliases): Verdict {
  const wrong = claims.find((claimed) => !isOwner(owner, claimed, aliases));
  if (wrong !== undefined) return { state: 'MISMATCH', owner, claimed: wrong };
  const right = claims[0];
  if (right !== undefined) return { state: 'VERIFIED', owner, claimed: right };
  return { state: 'OWNER_KNOWN', owner };
}

// Exact and case-insensitive. No partial or fuzzy match: a false MISMATCH is safer than a
// false VERIFIED.
function isOwner(owner: CallRecord, claimed: string, aliases: Aliases): boolean {
  const names = [owner.ownerName, ...(aliases.get(owner.ownerSub) ?? [])];
  const want = normalize(claimed);
  return names.some((name) => normalize(name) === want);
}

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

function unverified(reason: ReasonCode): Verdict {
  return { state: 'UNVERIFIED', reason };
}
