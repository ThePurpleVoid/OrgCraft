// Step boundaries and step I/O for the run inspector (N1, ADR 0009; L19 runner part).
//
// Every tool call a session makes gets a `call` id, minted here, that pairs its `session.tool` decision with its
// `session.result`. The runner, never the agent, decides `effect` and `retryOf`. When the team captures step
// details (`session.start.caps.capture`: all or tools; off or absent sends none), the call's input and output and
// each turn's own text go to the control plane as `step.io` frames, redacted first, at most 64 KiB a part. They
// live outside the event log so they can be deleted; the events name them by `io` id.
import { createHash } from 'node:crypto';
import { ulid } from './link.mjs';
import { PATTERNS } from './secrets.mjs';

export const IO_MAX = 64 * 1024;
export const CHECKS_MAX = 20;
const READS_KEPT = 5;
const READS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'TodoRead']);
const WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'TodoWrite']);
const OUTSIDE = new Set(['WebFetch', 'WebSearch']);
/** The effect of a call the policy classified, by its rule (policy.mjs DEFAULT_RULES actions). */
const BY_RULE = { accept: 'deploy', 'deploy-production': 'deploy', 'destructive-data': 'destructive', 'force-push': 'destructive', payment: 'payment', 'outbound-message': 'send', 'secret-write': 'write' };

/** read, write, send, destructive, payment or deploy; undefined for a connector tool (its manifest says, N3). */
export function effectOf(tool, rule) {
  if (rule && BY_RULE[rule]) return BY_RULE[rule];
  if (READS.has(tool)) return 'read';
  if (WRITES.has(tool)) return 'write';
  return undefined;
}

/** Output that came from outside the team: a web fetch or a connector (MCP) result. The team's own tools are not. */
export const isOutside = (tool) => OUTSIDE.has(tool) || (/^mcp__/.test(tool) && !/^mcp__team__/.test(tool));

const stable = (v) => (v && typeof v === 'object' ? (Array.isArray(v) ? v.map(stable) : Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]))) : v);
const inputHash = (tool, input) => createHash('sha256').update(`${tool}\n${JSON.stringify(stable(input ?? {}))}`).digest('hex');

/**
 * Known secret values replaced by `[secret: NAME]`, and anything that looks like a credential (secrets.mjs PATTERNS)
 * by `[secret: KIND]`; returns the text and the names it found. A value is also found in its JSON-escaped form,
 * because step I/O is often a tool's response turned into JSON (a value with a quote, a backslash or a newline).
 */
export function redactNamed(text, secrets) {
  let out = String(text ?? '');
  const names = [];
  for (const { name, value } of secrets) {
    if (typeof value !== 'string' || value.length < 8) continue;
    let hit = false;
    for (const form of new Set([value, JSON.stringify(value).slice(1, -1)])) {
      if (!out.includes(form)) continue;
      out = out.split(form).join(`[secret: ${name}]`);
      hit = true;
    }
    if (hit) names.push(name);
  }
  for (const [kind, re] of PATTERNS) {
    const g = new RegExp(re.source, 'g');
    if (!g.test(out)) continue;
    out = out.replace(new RegExp(re.source, 'g'), `[secret: ${kind}]`);
    names.push(kind);
  }
  return { text: out, names };
}

/** Did a tool's response say it failed? (The Agent SDK's is_error, an MCP isError, an interrupted shell.) */
export function failed(response) {
  if (!response || typeof response !== 'object') return false;
  return response.is_error === true || response.isError === true || response.interrupted === true;
}

/**
 * At most 300 characters, one line: what the call did, from its tool and input only. Never from the output: the
 * summary goes into the append-only event log, where no retention or erasure reaches, so the output's text (customer
 * data, outside text) stays in the deletable output io.
 */
export function summarize(tool, input, response, ok) {
  const path = (input?.file_path ?? input?.notebook_path ?? input?.path ?? '').toString().split('/').slice(-2).join('/');
  let s;
  if (tool === 'Read' && path) s = `read ${path}`;
  else if (WRITES.has(tool) && tool !== 'Bash' && path) s = `changed ${path}`;
  else if (tool === 'Bash') s = `ran ${String(input?.command ?? '').split('\n')[0].slice(0, 120)}`;
  else s = tool;
  return `${s}${ok ? '' : ' · failed'}`.replace(/\s+/g, ' ').trim().slice(0, 300);
}

export class Steps {
  /**
   * `capture`: all, tools, off (or absent: off). `send(frame)`: sends a step.io frame. `secrets()`: [{ name, value }]
   * known by name. `session`: the session id.
   */
  constructor({ capture, send, secrets = () => [], session }) {
    this.capture = ['all', 'tools'].includes(capture) ? capture : 'off';
    this.send = send;
    this.secrets = secrets;
    this.session = session;
    this.history = []; // the last 20 calls: { call, tool, hash, failed }
    this.done = []; // the last 20 calls that ran and succeeded: the checks a sign-off carries as evidence
    this.pending = new Map(); // tool_use id (or tool+hash) -> step
    this.text = [];
  }

  /** A step.io frame for one part; returns its id, or undefined when nothing is captured. */
  io(part, body, mime) {
    if (this.capture === 'off' || !this.send) return undefined;
    const raw = typeof body === 'string' ? body : JSON.stringify(body ?? null);
    const { text, names } = redactNamed(raw, this.secrets());
    const buf = Buffer.from(text, 'utf8');
    const truncated = buf.length > IO_MAX;
    const id = `io_${ulid()}`;
    // Cut on a character boundary: decoding the cut bytes drops a split character's half.
    const cut = truncated ? buf.subarray(0, IO_MAX).toString('utf8').replace(/�$/, '') : text;
    this.send({ session: this.session, id, part, mime, body: cut, bytes: buf.length, truncated, redactions: names });
    return id;
  }

  /** A tool call is about to be decided: its id, effect, input io and whether it repeats a failed call. */
  begin(tool, input, { id } = {}) {
    const hash = inputHash(tool, input);
    const retry = [...this.history].reverse().find((h) => h.tool === tool && h.hash === hash && h.failed);
    const step = { call: `call_${ulid()}`, tool, hash, key: id ?? `${tool}:${hash}`, started: Date.now(), retryOf: retry?.call };
    step.io = this.io('input', input ?? {}, 'application/json');
    return step;
  }

  /**
   * What this session itself ran and saw succeed, newest last: the evidence behind a sign-off's "Unverified: none"
   * (governance G1, review 2 AI-1). Recorded by the runner from the calls it decided; an agent can't add to it.
   */
  checks() { return this.done.map((c) => ({ ...c })); }

  /** The fields every session.tool for this call carries. */
  fields(step, rule) {
    if (!step) return {};
    step.effect = effectOf(step.tool, rule);
    return { call: step.call, effect: step.effect, ...(step.io ? { io: step.io } : {}), ...(step.retryOf ? { retryOf: step.retryOf } : {}) };
  }

  /** The decision: an allowed call waits for its result; a refused one is remembered as failed (for retryOf). */
  decided(step, allowed) {
    if (!step) return;
    if (allowed) this.pending.set(step.key, step);
    else this.remember(step, true);
  }

  remember(step, isFailed) {
    this.history.push({ call: step.call, tool: step.tool, hash: step.hash, failed: isFailed });
    if (this.history.length > 20) this.history.shift();
  }

  /** The call finished: the session.result data, or null for a call this session never decided (a team tool). */
  end(tool, input, response, { id } = {}) {
    const key = id ?? `${tool}:${inputHash(tool, input)}`;
    const step = this.pending.get(key);
    if (!step) return null;
    this.pending.delete(key);
    const ok = !failed(response);
    this.remember(step, !ok);
    const summary = redactNamed(summarize(tool, input, response, ok), this.secrets()).text.slice(0, 300);
    const io = this.io('output', response ?? null, typeof response === 'string' ? 'text/plain' : 'application/json');
    if (ok) {
      this.done.push({ call: step.call, tool, ...(step.effect ? { effect: step.effect } : {}), summary, at: new Date().toISOString(), ...(io ? { io } : {}) });
      // Reads never push out what the session ran or changed: at most READS_KEPT of the kept checks are reads.
      const isRead = (c) => c.effect === 'read';
      if (this.done.filter(isRead).length > READS_KEPT) this.done.splice(this.done.findIndex(isRead), 1);
      if (this.done.length > CHECKS_MAX) this.done.shift();
    }
    return { call: step.call, tool, ok, durationMs: Date.now() - step.started, summary, ...(io ? { io } : {}), ...(isOutside(tool) ? { outside: true } : {}) };
  }

  /** A completed text block of this turn (kept only when the team captures everything). */
  said(text) { if (this.capture === 'all' && String(text ?? '').trim()) this.text.push(String(text)); }

  /** The turn's own text as an output io, for usage.recorded; undefined when there is none or it is not captured. */
  /** Drop this turn's text without sending it (no usage.recorded names it). */
  forgetText() { this.text = []; }

  turnText() {
    if (this.capture !== 'all' || !this.text.length) { this.text = []; return undefined; }
    const body = this.text.join('\n\n');
    this.text = [];
    return this.io('output', body, 'text/plain');
  }
}
