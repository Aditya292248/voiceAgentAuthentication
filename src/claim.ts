// Claim extraction: which known principal the agent says it acts for. Pure: no I/O, no config.
import type { ClaimResult } from './types.js';
import type { Aliases } from './verdict.js';

/** Every owner name and alias: the closed list `extractClaims` matches against. */
export function principalNames(
  subAccounts: readonly { id: string; ownerName: string }[],
  aliases: Aliases,
): string[] {
  return subAccounts.flatMap((sub) => [sub.ownerName, ...(aliases.get(sub.id) ?? [])]);
}

/**
 * The registry names that one agent turn claims to act for, once each, in registry order.
 * Names outside the registry are never captured, so the caller cannot choose the text of a
 * claim; at worst a claim is missed, which leaves the owner disclosed and never adds trust.
 */
export function extractClaims(text: string, registry: readonly string[]): ClaimResult[] {
  // Normalized form to the registry entry as written; the first entry wins a collision.
  const entries = new Map<string, string>();
  for (const name of registry) {
    const form = normalize(name);
    if (form !== '' && !entries.has(form)) entries.set(form, name);
  }
  if (entries.size === 0) return [];

  const said = normalize(text);
  const found = new Set<string>();
  for (const pattern of claimPatterns([...entries.keys()]))
    for (const [, form] of said.matchAll(pattern)) if (form !== undefined) found.add(form);

  return [...entries]
    .filter(([form]) => found.has(form))
    .map(([, name]) => ({ kind: 'claimed', principal: name }));
}

// Lowercase, drop apostrophes ("Aditya's" and "Adityas" become the same word), turn other
// punctuation into spaces. What is left is letters, digits and single spaces.
function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Normalized names contain no regex metacharacters, so they need no escaping. Longest first,
// so "adis assistant" picks "adis" over "adi" plus a possessive s.
function claimPatterns(forms: string[]): RegExp[] {
  const name = `(${[...forms].sort((a, b) => b.length - a.length).join('|')})`;
  const shapes = [
    `on behalf of ${name}`,
    // Also covers "calling from Aditya's office".
    `${name}s? (?:assistant|agent|office)`,
    // Can also mean "I'd like to speak to X". A false MISMATCH is the safe way to be wrong.
    `calling for ${name}`,
    `i represent ${name}`,
    `i work for ${name}`,
  ];
  // Whole words only: a match starts and ends at a space or at the ends of the text.
  return shapes.map((shape) => new RegExp(`(?<=^| )${shape}(?= |$)`, 'gu'));
}
