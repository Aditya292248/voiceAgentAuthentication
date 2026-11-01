// Shared shapes for the verdict pipeline. Types only, no logic.

/** Why a call ended UNVERIFIED. */
export type ReasonCode =
  | 'lookup_timeout'
  | 'ambiguous'
  | 'api_error'
  | 'no_agentphone_call'
  | 'transcript_error'
  // Sent as an error event by the orchestrator when claim extraction itself times out.
  | 'claim_timeout';

/** The one in-progress AgentPhone call that matched, with the sub-account that owns its agent. */
export type CallRecord = {
  kind: 'one';
  callId: string;
  agentId: string;
  ownerSub: string;
  ownerName: string;
  from: string;
  to: string;
  startedAt: string;
};

export type LookupResult =
  | CallRecord
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'error'; reason: ReasonCode };

/** What the caller said they represent. Untrusted: it can only lower a verdict. */
export type ClaimResult = { kind: 'claimed'; principal: string } | { kind: 'none' };

export type Verdict =
  // Claims heard before the lookup finishes are kept, so an early lie is not lost.
  | { state: 'IDENTIFYING'; claims: readonly string[] }
  | { state: 'OWNER_KNOWN'; owner: CallRecord }
  | { state: 'VERIFIED'; owner: CallRecord; claimed: string }
  | { state: 'VERIFIED_NO_CLAIM'; owner: CallRecord }
  | { state: 'MISMATCH'; owner: CallRecord; claimed: string }
  | { state: 'UNVERIFIED'; reason: ReasonCode };

export type VerdictEvent =
  | { type: 'lookup'; result: LookupResult }
  | { type: 'claim'; result: ClaimResult }
  // Two separate timers: the lookup must finish in time, then the claim window closes.
  | { type: 'deadline'; which: 'lookup' | 'claim' }
  | { type: 'error'; reason: ReasonCode };
