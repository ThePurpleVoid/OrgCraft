// Live overrides (L18, CTO review-2 R2): the emergency controls are control-plane state, never Git.
//
//   GET    /v1/teams/{team}/live                      viewer: the live changes in force, for the banner and the
//                                                     next publish diff ("Live change ... Keep it?")
//   POST   /v1/teams/{team}/live/stop-everything      editor: every running run of the team pauses, no new run starts
//   PUT    /v1/teams/{team}/live/members/{member}     editor: { state: paused | off, reason? } one teammate takes no
//                                                     work; its live sessions stop (paused: at a safe point; off: now)
//   DELETE /v1/teams/{team}/live/{override}           editor + step-up scoped `lift:<override>`: lift one
//   POST   /v1/live/stop-everything                   editor: Stop everything for every team in the workspace
//
// Stopping is one tap and never needs a passkey; carrying on does (ADR 0013 rule 4), and a host may stop but never
// lift. None of it needs the code host, Git or a publish. Every change is an event (live.changed) and an audit row. A
// publish reconciles: an 'off' override whose teammate the newly started run's roster no longer has is cleared as
// 'published', since the team's own files now say the same.
import { Problem, SLUG, getTeam, id } from './store.mjs';
import { StepUpRequired, personActor } from './m3.mjs';

const INSTANCE = /^[A-Za-z0-9_-]{1,64}$/;

/** "web-dev" or "support-agent#2" -> { role, instance }, checked. */
export function memberOf(s) {
  const [role, instance = null, extra] = String(s ?? '').split('#');
  if (extra !== undefined || !SLUG.test(role) || (instance !== null && !INSTANCE.test(instance))) throw new Problem(400, 'a teammate is its id, like web-dev or support-agent#2');
  return { role, instance };
}

const nameOf = (o) => (o.kind === 'halt' ? 'everything' : o.instance ? `${o.role}#${o.instance}` : o.role);

/** A row as the API shows it, with the words the publish diff and the banner use. */
export function view(o) {
  const target = nameOf(o);
  const what = o.kind === 'halt' ? 'Stop everything is on: no run starts or carries on'
    : o.state === 'off' ? `${target} is switched off: it takes no work and its sessions were stopped`
      : `${target} is paused: its work waits`;
  return {
    id: o.id, kind: o.kind, ...(o.kind === 'member' ? { member: target } : {}), state: o.state, reason: o.reason ?? null,
    by: o.set_by, at: new Date(o.set_at).toISOString(), ...(o.kind === 'halt' ? { runs: o.runs ?? [] } : {}),
    text: what, liveChange: `Live change by ${o.set_by}: ${what}.`,
  };
}

export function createLive({ db, m3 }) {
  const active = (q, team) => q('select * from live_overrides where team = $1 and cleared_at is null order by set_at', [team]);

  async function list(tenant, team) {
    await getTeam(db, tenant, team);
    return { live: (await db.tenant(tenant, ({ q }) => active(q, team))).map(view) };
  }

  /** Stop everything for one team: its running runs pause (reason owner), and no run starts until it is lifted. */
  async function stopEverything(tenant, team, by, { reason = null } = {}) {
    await getTeam(db, tenant, team);
    const why = checkReason(reason);
    const { result } = await m3.tx(tenant, async (ctx) => {
      const [o] = await ctx.q(`insert into live_overrides(id, tenant, team, kind, state, reason, set_by) values ($1, $2, $3, 'halt', 'paused', $4, $5)
                               on conflict do nothing returning *`, [id('live'), tenant, team, why, by]);
      const row = o ?? (await ctx.q("select * from live_overrides where team = $1 and kind = 'halt' and cleared_at is null for update", [team]))[0];
      const paused = [];
      for (const r of await ctx.q("select id from runs where team = $1 and state = 'running' for update", [team])) {
        await m3.setRunState(ctx, team, r.id, 'paused', 'owner', personActor(by));
        paused.push(r.id);
      }
      const runs = [...new Set([...(row.runs ?? []), ...paused])];
      const [saved] = await ctx.q('update live_overrides set runs = $2 where id = $1 returning *', [row.id, JSON.stringify(runs)]);
      await changed(ctx, team, saved, 'set', by);
      return view(saved);
    });
    return result;
  }

  /** Stop everything in every team of the workspace. */
  async function stopEverywhere(tenant, by, opts = {}) {
    const teams = await db.tenant(tenant, ({ q }) => q('select id from teams order by id'));
    const out = [];
    for (const t of teams) out.push({ team: t.id, ...(await stopEverything(tenant, t.id, by, opts)) });
    return { live: out };
  }

  /** Pause or switch off one teammate. Paused to off (or back) is a change of how it is stopped, so no step-up. */
  async function setMember(tenant, team, member, body, by) {
    await getTeam(db, tenant, team);
    const { role, instance } = memberOf(member);
    const state = body?.state;
    if (state !== 'paused' && state !== 'off') throw new Problem(400, 'state is paused or off; to carry on, lift the live change (DELETE, with a passkey)');
    const why = checkReason(body?.reason ?? null);
    const { result } = await m3.tx(tenant, async (ctx) => {
      const [o] = await ctx.q(`insert into live_overrides(id, tenant, team, kind, role, instance, state, reason, set_by) values ($1, $2, $3, 'member', $4, $5, $6, $7, $8)
                               on conflict do nothing returning *`, [id('live'), tenant, team, role, instance, state, why, by]);
      let row = o;
      if (!row) {
        [row] = await ctx.q(`update live_overrides set state = $4, reason = coalesce($5, reason) where team = $1 and kind = 'member' and role = $2
                               and coalesce(instance, '') = coalesce($3, '') and cleared_at is null returning *`, [team, role, instance, state, why]);
      }
      await changed(ctx, team, row, 'set', by);
      ctx.after.push(() => m3.hooks.memberChanged?.(tenant, team, role, instance, state));
      return view(row);
    });
    return result;
  }

  /**
   * Lift one live change: needs a step-up made for exactly it (`lift:<id>`). Lifting Stop everything resumes the runs
   * it paused that are still paused by it, unless today's budget is spent; lifting a teammate releases its work.
   */
  async function lift(tenant, team, oid, by, { stepUp = null } = {}) {
    await getTeam(db, tenant, team);
    if (!/^live_[A-Za-z0-9_-]{1,64}$/.test(String(oid))) throw new Problem(404, 'no such live change');
    const { result } = await m3.tx(tenant, async (ctx) => {
      const [o] = await ctx.q('select * from live_overrides where id = $1 and team = $2 and cleared_at is null for update', [oid, team]);
      if (!o) throw new Problem(404, 'no such live change, or it was already lifted');
      const scope = `lift:${o.id}`;
      if (!(await m3.useStepUp(ctx, by, stepUp, scope))) throw new StepUpRequired(o.kind === 'halt' ? 'Lifting Stop everything' : `Letting ${nameOf(o)} work again`, scope);
      const [row] = await ctx.q("update live_overrides set cleared_at = now(), cleared_by = $2, cleared_how = 'lifted' where id = $1 returning *", [o.id, by]);
      const resumed = [];
      if (o.kind === 'halt' && (await m3.today(ctx.q, team, ctx.now)).state !== 'exhausted') {
        for (const r of await ctx.q("select id from runs where id = any($1) and state = 'paused' and reason = 'owner' for update", [o.runs ?? []])) {
          await m3.setRunState(ctx, team, r.id, 'running', 'owner', personActor(by));
          resumed.push(r.id);
        }
      }
      await changed(ctx, team, row, 'lifted', by, { stepUp: true, ...(o.kind === 'halt' ? { resumed } : {}) });
      if (o.kind === 'member') ctx.after.push(() => m3.hooks.memberChanged?.(tenant, team, o.role, o.instance, 'on'));
      return { ...view(row), lifted: true, ...(o.kind === 'halt' ? { resumed } : {}) };
    });
    return result;
  }

  async function changed(ctx, team, o, op, by, extra = {}) {
    const data = { op, override: o.id, kind: o.kind, ...(o.kind === 'member' ? { member: nameOf(o) } : {}), state: o.state, by, ...(o.reason ? { reason: o.reason } : {}), ...extra };
    await ctx.emit(team, 'live.changed', data, { actor: personActor(by), subject: o.kind === 'member' ? `role/${o.role}` : `team/${team}` });
    await ctx.audit({ team, actorKind: 'person', actorId: by, action: 'live', target: o.id, decision: 'allowed', detail: data });
  }

  return { list, stopEverything, stopEverywhere, setMember, lift };
}

/**
 * Inside a transaction: is Stop everything on for this team, and which teammate is held (for the bus)? The bus asks
 * before every delivery, so a held teammate's work waits as `held` and goes when the override is lifted.
 */
export async function halted(q, team) {
  return (await q("select 1 from live_overrides where team = $1 and kind = 'halt' and cleared_at is null", [team])).length > 0;
}
export async function memberHeld(q, team, role, instance) {
  return (await q(`select 1 from live_overrides where team = $1 and kind = 'member' and cleared_at is null and role = $2
                   and (instance is null or instance = coalesce($3, ''))`, [team, role, instance])).length > 0;
}

/**
 * A publish reconciles (R2): when a run starts on a roster that no longer has a teammate an 'off' override names, the
 * team's files now say the same, so the override is cleared as 'published' (an event and an audit row say so).
 */
export async function reconcile(ctx, team, roster, by) {
  const slugs = new Set((roster?.roles ?? []).map((r) => r.slug));
  for (const o of await ctx.q("select * from live_overrides where team = $1 and kind = 'member' and state = 'off' and cleared_at is null for update", [team])) {
    if (slugs.has(o.role)) continue;
    await ctx.q("update live_overrides set cleared_at = now(), cleared_by = $2, cleared_how = 'published' where id = $1", [o.id, by]);
    const data = { op: 'published', override: o.id, kind: 'member', member: nameOf(o), state: 'off', by };
    await ctx.emit(team, 'live.changed', data, { actor: personActor(by), subject: `role/${o.role}` });
    await ctx.audit({ team, actorKind: 'person', actorId: by, action: 'live', target: o.id, decision: 'allowed', detail: data });
  }
}

function checkReason(r) {
  if (r === null || r === undefined) return null;
  if (typeof r !== 'string' || r.length > 500) throw new Problem(400, 'reason is text of at most 500 characters');
  return r.trim() || null;
}
