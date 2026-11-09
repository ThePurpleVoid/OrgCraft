// Sign-offs tied to a version (governance G1 and G2, local PR L23 server half; plans/governance/governance-spec.md
// sections 1 and 2, docs/contracts/team-tools.md `signoff`).
//
// A sign-off names the exact version it checked. When a pull request's head moves past it, the sign-off is stale: the
// server emits `signoff.stale` once per sign-off and new head, which wakes the role that signed. The merge gate counts
// a sign-off only when it is fresh: it names the head being merged, says `unverified: []` (an empty list; left out is
// "not stated", never none) and passed. Approving a merge while any sign-off on its pull request is not fresh is refused
// with the list of what is missing, and the approval card shows the same list.
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

/**
 * The newest sign-off from each role (and instance) on pull request `pr` in `team`, oldest first. Only sign-offs a
 * runner session sent through the signoff tool count: the server audited those itself (action tool, target signoff).
 * One posted through the API or a report token is the sender's word and can't stand in for a role's own.
 */
export async function latestSignoffs(q, team, pr) {
  const rows = await q(`select distinct on (e.actor_id, coalesce(e.envelope->'actor'->>'instance', '')) e.envelope from events e
                        where e.team = $1 and e.type = 'message.signoff' and e.envelope->'data'->>'pr' = $2
                          and exists (select 1 from audit a where a.team = e.team and a.event = e.id and a.action = 'tool' and a.target = 'signoff' and a.decision = 'allowed')
                        order by e.actor_id, coalesce(e.envelope->'actor'->>'instance', ''), e.seq desc`, [team, String(pr)]);
  return rows.map((r) => r.envelope).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

/**
 * One sign-off against the version being shipped: { signoff, by, version, fresh, problem }. `kind` is what is shipped:
 * a merge ships a commit, so a sign-off that names a revision or a draft on that pull request is not compared with
 * the head (nothing could ever match it); it still blocks when it failed or left something unchecked.
 */
export function judge(e, version, { kind = null } = {}) {
  const d = e.data ?? {};
  const by = who(e);
  const base = { signoff: e.id, by, version: d.version ?? null, versionKind: d.versionKind ?? null, result: d.result ?? null, unverified: Array.isArray(d.unverified) ? d.unverified : null };
  let problem = null;
  if (!d.version) problem = `${by}'s sign-off names no version; it needs to check again and name it`;
  else if (d.version !== version && !(kind && d.versionKind && d.versionKind !== kind)) problem = `needs a fresh sign-off from ${by} (theirs was for ${short(d.version)})`;
  else if (d.result !== 'pass') problem = `${by}'s sign-off on ${short(d.version)} did not pass`;
  else if (!Array.isArray(d.unverified)) problem = `${by}'s sign-off does not say what it did not check (Unverified: not stated)`;
  else if (d.unverified.length) problem = `${by}'s sign-off has unchecked items: "${String(d.unverified[0]).slice(0, 200)}"${d.unverified.length > 1 ? ` and ${d.unverified.length - 1} more` : ''}`;
  return { ...base, fresh: !problem, ...(problem ? { problem } : {}) };
}

/** The gate for shipping `version` of pull request `pr`: every sign-off on it, and what is missing. */
export async function gate(q, team, pr, version) {
  const signoffs = (await latestSignoffs(q, team, pr)).map((e) => judge(e, version, { kind: 'commit' }));
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
