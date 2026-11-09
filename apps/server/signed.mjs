// What you see is what you sign (ADR 0013 rule 1), the control plane's half.
//
// A session that names the exact calls an approval covers sends them with their hash (packages/calls: the same
// canonical bytes the runner hashes). The server never trusts the text: it re-canonicalises the parsed calls, checks
// the hash against them, and renders the card's facts from that object only. A raw `call` string is never shown as
// the facts, because JSON.parse keeps the last of two duplicate keys: text reading "to: jane" can parse to
// "to: attacker", and the parsed object is what gets signed and run.
//
// The step-up that approves a bound card is itself bound: its scope is a hash of the tenant, team, approval, card
// version and calls, so a step-up for card v1 cannot approve v2, another approval, or anything in another tenant.
import { createHash } from 'node:crypto';
import { MAX_CALLS, callOf, canonical, hashCalls } from '../../packages/calls/index.mjs';

export { MAX_CALLS };

/**
 * Removes what looks like a secret from a command before it is stored or shown on a card. Best effort: the runner's
 * own scans of what leaves a session are the real line; this only keeps the obvious shapes off cards and the log.
 */
export function redact(text) {
  return String(text ?? '')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9-_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, '[redacted]')
    .replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)\S+/gi, '$1[redacted]')
    .slice(0, 16 * 1024);
}

const HASH = /^[0-9a-f]{64}$/;

/**
 * The calls a session says an approval covers, checked: `{ calls, hash }` in canonical form, `{ problem }` when they
 * are malformed or the hash is not theirs, or null when the session named none (a decision, not a call).
 */
export function boundCalls(calls, hash) {
  if (calls === undefined && hash === undefined) return null;
  if (!Array.isArray(calls) || !calls.length || calls.length > MAX_CALLS) return { problem: `calls is a list of 1 to ${MAX_CALLS} calls, each { tool, input }` };
  if (typeof hash !== 'string' || !HASH.test(hash)) return { problem: 'callsHash is the sha256 (lowercase hex) of the canonical calls' };
  let canon;
  try {
    canon = calls.map((c) => {
      if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some((k) => k !== 'tool' && k !== 'input')) throw new TypeError('a call is { tool, input }');
      return callOf(c.tool, c.input);
    });
  } catch (e) {
    return { problem: `calls: ${e.message}` };
  }
  if (hashCalls(canon) !== hash) return { problem: 'callsHash does not match the calls: it is the sha256 of "calls/1", a newline, and their canonical JSON' };
  return { calls: canon, hash };
}

/**
 * The card's facts, rendered by the server from the canonical calls, never from what the role wrote. Without a
 * connector `facts` map (none ship yet) a fact is the tool and its exact input. `redact` keeps secret shapes off the
 * card; the hash still covers the exact call.
 */
export function factsOf(calls, redact = (s) => s) {
  const cut = (t, n = 2000) => (t.length > n ? `${t.slice(0, n)}…` : t);
  return calls.map((c) => {
    if (c.tool === 'Bash' && typeof c.input.command === 'string' && Object.keys(c.input).every((k) => k === 'command')) return { tool: 'Bash', text: cut(redact(`Run: ${c.input.command}`)) };
    return { tool: c.tool, text: cut(redact(`${c.tool} ${canonical(c.input)}`)) };
  });
}

/**
 * The risk class of an approval, computed here; whatever the role said is ignored (security criterion 7). Bound calls
 * have no connector facts map yet, so they are high (never swipe-eligible); an old-style card is medium (normal).
 */
export const riskOf = ({ bound }) => (bound ? 'high' : 'medium');

/** The step-up scope that approves this card at this version: `approve:` and a hash of everything it binds. */
export function approveScope({ tenant, team, approval, version, callsHash }) {
  return `approve:${createHash('sha256').update(['approve/1', tenant, team, approval, String(version), callsHash].join('\n')).digest('hex')}`;
}
