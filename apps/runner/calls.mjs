// What you see is what you sign (ADR 0013, review 2): an approval is bound to the exact calls it covers.
//
// A call is { tool, input }: a built-in tool (Bash, Write, ...) or an MCP tool (mcp__server__tool) and its input.
// Its canonical form is JSON with object keys sorted at every level and no whitespace, so the runner and the
// control plane hash the same bytes. Fields that change nothing a call does (a Bash call's `description`) are left
// out, so a model re-typing its note does not unbind it. The hash covers the list of calls, in order.
//
// The runner never lets a model re-decide an approved call: it runs the signed record (a deep copy taken when it
// asked), and only a call whose canonical form equals that record rides the approval, once.
import { createHash } from 'node:crypto';

export const CALLS_VERSION = 'calls/1';

/** Input fields that are notes, not effects. */
const NOTES = { Bash: ['description'] };

/** The canonical JSON text of a value: sorted keys, no whitespace. Rejects what JSON cannot carry exactly. */
export function canonical(v) {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    // Integers only (amounts in minor units): a float has no single text form every language agrees on.
    if (!Number.isSafeInteger(v)) throw new TypeError(`a call carries only whole numbers (got ${v}); amounts go in minor units`);
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x === undefined ? null : x)).join(',')}]`;
  if (typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  throw new TypeError(`a call cannot carry a ${typeof v}`);
}

/** The call as it is signed: the tool's name and a deep copy of its input without note fields. */
export function callOf(tool, input) {
  if (typeof tool !== 'string' || !tool) throw new TypeError('a call names its tool');
  const copy = JSON.parse(canonical(input ?? {}));
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) throw new TypeError('a call\'s input is an object');
  for (const k of NOTES[tool] ?? []) delete copy[k];
  return { tool, input: copy };
}

/** sha256 (hex) of the canonical list of calls, prefixed with the version so a later form never collides. */
export function hashCalls(calls) {
  return createHash('sha256').update(`${CALLS_VERSION}\n${canonical(calls.map((c) => ({ tool: c.tool, input: c.input })))}`).digest('hex');
}

/**
 * The calls a request_approval names in its `call` field, when it names any: `{"tool": ..., "input": {...}}` or a
 * list of those, as JSON. Anything else (prose, a shell line) names no call: approving it approves a decision,
 * never a call, and every call the policy holds is still asked for with its exact input.
 */
export function parseCalls(text) {
  let v;
  try { v = JSON.parse(String(text ?? '')); } catch { return null; }
  const list = Array.isArray(v) ? v : [v];
  if (!list.length || list.length > 20) return null;
  const out = [];
  for (const c of list) {
    if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.tool !== 'string' || !c.input || typeof c.input !== 'object' || Array.isArray(c.input)) return null;
    if (Object.keys(c).some((k) => k !== 'tool' && k !== 'input')) return null;
    try { out.push(callOf(c.tool, c.input)); } catch { return null; }
  }
  return out;
}

/** A deep copy of a signed input, for the tool to run instead of whatever object the model holds. */
export const replay = (call) => JSON.parse(canonical(call.input));
