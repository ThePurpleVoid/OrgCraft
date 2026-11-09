// Sign-offs tied to a version (governance G1 and G2, local PR L23 server half; plans/governance/governance-spec.md
// sections 1 and 2, docs/contracts/team-tools.md `signoff`).
//
// A sign-off names the exact version it checked. When a pull request's head moves past it, the sign-off is stale: the
// server emits `signoff.stale` once per sign-off and new head, which wakes the role that signed. The merge gate counts
// a sign-off only when it is fresh: it names the head being merged, says `unverified: []` (an empty list; left out is
// "not stated", never none) and passed. Approving a merge while any sign-off on its pull request is not fresh is refused
// with the list of what is missing, and the approval card shows the same list.
//
// Who stands behind a sign-off (security ruling on L23s): the server stamps `origin` "session" on one a runner session
// sent through the signoff tool, and "reported" on one from the API or a report token. A role's newest session sign-off
// is what counts; a later reported one can only tighten it. A role with none is judged on its newest reported one.
import { Problem } from './store.mjs';

const FULL_SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const IO_ID = /^io_[0-9A-HJKMNP-TV-Z]{26}$/;
const CHECKS_MAX = 20;
const short = (v) => (FULL_SHA.test(String(v ?? '')) ? String(v).slice(0, 7) : String(v ?? '').slice(0, 40));
const who = (e) => (e.actor?.instance ? `${e.actor.id}#${e.actor.instance}` : e.actor?.id ?? 'someone');

/**
 * The runner's `checks` on a sign-off, cleaned: at most 20 `{ call, tool, effect, summary, at, io? }` of bounded text.
 * Only a runner session sends them (POST /sessions/{session}/tools); an `io` must be that session's own step I/O.
 */
export async function cleanChecks(q, session, checks) {
  if (!Array.isArray(checks)) return undefined;
  const str = (v, n) => (typeof v === 'string' && v.length <= n ? v : undefined);
  const out = checks.slice(-CHECKS_MAX).filter((c) => c && typeof c === 'object').map((c) => ({
    call: str(c.call, 80), tool: str(c.tool, 200), effect: str(c.effect, 20), summary: str(c.summary, 300),
    at: str(c.at, 40) && !Number.isNaN(Date.parse(c.at)) ? c.at : undefined, io: str(c.io, 40) && IO_ID.test(c.io) ? c.io : undefined,
  })).filter((c) => c.tool).map((c) => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)));
  const named = out.map((c) => c.io).filter(Boolean);
  if (named.length) {
    const mine = new Set((await q('select id from step_io where session = $1 and id = any($2)', [session, named])).map((r) => r.id));
    for (const c of out) if (c.io && !mine.has(c.io)) delete c.io;
  }
  return out;
}

/** A reported sign-off's kit is 0.23.0 or later: it sends version and unverified, so leaving them out means something. */
export function kitStates(kit) {
  const m = /^(\d+)\.(\d+)\.\d+/.exec(String(kit ?? ''));
  return Boolean(m) && (Number(m[1]) > 0 || Number(m[2]) >= 23);
}

/**
 * The sign-offs that count on pull request `pr` in `team`, one entry per role (and instance), oldest first:
 * `{ e, origin, later }`. `origin` is "session" for a sign-off a runner session sent through the signoff tool (the
 * server audited it itself: action tool, target signoff) and "reported" for one posted through the API or a report
 * token, which is the sender's word. Once a role has a session sign-off, the newest one is what counts, and `later`
 * holds the reported sign-offs after it: they can only tighten the result (a fail, or unchecked items), never pass it.
 * A role with no session sign-off is judged on its newest reported one.
 */
export async function signoffsOn(q, team, pr) {
  const rows = await q(`select e.seq, e.envelope,
                          exists (select 1 from audit a where a.team = e.team and a.event = e.id and a.action = 'tool' and a.target = 'signoff' and a.decision = 'allowed') as session
                        from events e where e.team = $1 and e.type = 'message.signoff' and e.envelope->'data'->>'pr' = $2 order by e.seq`, [team, String(pr)]);
  const byRole = new Map();
  for (const r of rows) {
    const key = who(r.envelope);
    if (!byRole.has(key)) byRole.set(key, []);
    byRole.get(key).push(r);
  }
  const out = [];
  for (const list of byRole.values()) {
    const s = list.filter((r) => r.session).at(-1);
    if (s) out.push({ e: s.envelope, origin: 'session', later: list.filter((r) => !r.session && Number(r.seq) > Number(s.seq)).map((r) => r.envelope) });
    else out.push({ e: list.at(-1).envelope, origin: 'reported', later: [] });
  }
  return out.sort((a, b) => Date.parse(a.e.time) - Date.parse(b.e.time));
}

/** The envelopes that count, as `signoffsOn` picks them (for stale marking). */
export async function latestSignoffs(q, team, pr) {
  return (await signoffsOn(q, team, pr)).map((x) => x.e);
}

/**
 * One sign-off against the version being shipped: { signoff, by, origin, label, version, fresh, problem, notes }.
 * `kind` is what is shipped: a merge ships a commit, so a sign-off that names a revision or a draft on that pull
 * request is not compared with the head (nothing could ever match it); it still blocks when it failed or left
 * something unchecked. A reported sign-off from a kit before 0.23.0 (no `kit`, or an older one) can't state a version
 * or what it did not check: those are shown as "not stated" and do not block; one from 0.23.0 on is judged in full.
 * `later` (session sign-offs only): reported sign-offs after it, which can only add a problem.
 */
export function judge(e, version, { kind = null, origin = 'session', later = [] } = {}) {
  const d = e.data ?? {};
  const by = who(e);
  const reported = origin === 'reported';
  const old = reported && !kitStates(d.kit);
  const base = {
    signoff: e.id, by, origin, ...(reported ? { label: 'reported, not run here' } : {}),
    version: d.version ?? null, versionKind: d.versionKind ?? null, result: d.result ?? (old ? 'pass' : null), unverified: Array.isArray(d.unverified) ? d.unverified : null,
  };
  const notes = [];
  let problem = null;
  if (!d.version && old) notes.push(`${by}'s sign-off was reported by a kit before 0.23.0: version not stated`);
  else if (!d.version) problem = `${by}'s sign-off names no version; it needs to check again and name it`;
  if (problem) { /* already blocked */ }
  else if (d.version && d.version !== version && !(kind && d.versionKind && d.versionKind !== kind)) problem = `needs a fresh sign-off from ${by} (theirs was for ${short(d.version)})`;
  else if (base.result !== 'pass') problem = `${by}'s sign-off${d.version ? ` on ${short(d.version)}` : ''} did not pass`;
  else if (!Array.isArray(d.unverified) && old) notes.push(`${by}'s sign-off was reported by a kit before 0.23.0: Unverified not stated`);
  else if (!Array.isArray(d.unverified)) problem = `${by}'s sign-off does not say what it did not check (Unverified: not stated)`;
  else if (d.unverified.length) problem = `${by}'s sign-off has unchecked items: "${String(d.unverified[0]).slice(0, 200)}"${d.unverified.length > 1 ? ` and ${d.unverified.length - 1} more` : ''}`;
  // A newer reported sign-off tightens a session one: a fail or unchecked items count; a pass changes nothing.
  for (const r of problem ? [] : later) {
    const x = r.data ?? {};
    if (x.result && x.result !== 'pass') problem = `${by} reported a sign-off that did not pass after its own (reported, not run here)`;
    else if (Array.isArray(x.unverified) && x.unverified.length) problem = `${by} reported unchecked items after its own sign-off (reported, not run here): "${String(x.unverified[0]).slice(0, 200)}"`;
    if (problem) break;
  }
  return { ...base, fresh: !problem, ...(problem ? { problem } : {}), ...(notes.length ? { notes } : {}) };
}

/** The gate for shipping `version` of pull request `pr`: every sign-off on it, and what is missing. */
export async function gate(q, team, pr, version) {
  const signoffs = (await signoffsOn(q, team, pr)).map(({ e, origin, later }) => judge(e, version, { kind: 'commit', origin, later }));
  const missing = signoffs.filter((s) => !s.fresh).map((s) => s.problem);
  return { signoffs, missing, ok: !missing.length };
}

export const refusal = (missing) => `Can't ship yet: ${missing.join(' · ')}.`;

/** Throws 409 when the gate is not met (approving a merge). */
export async function requireFresh(q, team, pr, version) {
  const g = await gate(q, team, pr, version);
  if (!g.ok) throw new Problem(409, refusal(g.missing), { type: 'signoffs', body: { signoffs: g.signoffs, missing: g.missing } });
  return g;
}

/**
 * A pull request's head moved (proposal.opened or proposal.updated from the runner): every newest sign-off on it that
 * named another commit is stale. Emits `signoff.stale` once per sign-off and new head; it wakes the role that signed.
 */
export async function markStale(ctx, event) {
  const d = event.data ?? {};
  const pr = d.ref, head = d.headSha;
  if (!event.team || pr === undefined || pr === null || typeof head !== 'string' || !FULL_SHA.test(head)) return;
  for (const s of await latestSignoffs(ctx.q, event.team, pr)) {
    const old = s.data?.version;
    if (s.data?.versionKind && s.data.versionKind !== 'commit') continue;
    if (!old || old === head) continue;
    const [seen] = await ctx.q("select 1 from events where team = $1 and type = 'signoff.stale' and envelope->'data'->>'signoff' = $2 and envelope->'data'->>'newVersion' = $3 limit 1", [event.team, s.id, head]);
    if (seen) continue;
    await ctx.emit(event.team, 'signoff.stale', {
      signoff: s.id, by: who(s), oldVersion: old, newVersion: head, pr: Number(pr) || pr,
      ...(s.data?.task ? { task: s.data.task } : {}), ...(s.data?.issue ? { issue: s.data.issue } : {}),
      detail: `${who(s)}'s sign-off was for an earlier version (${short(old)}); pull request #${pr} is now at ${short(head)}. It needs to check again.`,
    }, { subject: `pr/${pr}`, ...(event.run ? { run: event.run } : {}), cause: s.id });
  }
}
