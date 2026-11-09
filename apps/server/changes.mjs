// Change requests on a managed team (ADR 0012 and 0013, spec L9 sections 4.4 and 4.5, step L9c). A publish from the
// Studio opens one (apps/studio/managed.mjs); this module lists them, accepts and closes them, and rolls back.
//
// Accepting re-runs, at the change's head, what CI would: the checks (validate, and sync's output equals what is
// committed) and the capability diff against the current main (ADR 0013 rule 2). Then, in this order:
//   - red checks refuse (409 checks), like red CI;
//   - a change a teammate drafted that widens that teammate, or weakens a check, is refused (403 self-widening);
//   - a change to commands the team runs needs an admin (403 publish-code);
//   - a non-empty capability diff needs a step-up (passkey) and writes an audit row with the person's own words;
//   - main moves by compare-and-swap, fast-forward only (409 stale), and team.published is appended once per commit.
import { managedBackend } from '../studio/managed.mjs';
import { activatePending } from './credentials.mjs';
import * as core from '../studio/core.mjs';
import { capabilityDiff, selfCapability } from '../../packages/team-model/index.mjs';
import { loadKit } from '../../packages/team-model/node.mjs';
import { mint } from './m3.mjs';
import { atLeast } from './roles.mjs';
import { pgObjects, pgRefs } from './managed-db.mjs';
import { Problem, publishedId } from './store.mjs';
import { createHash } from 'node:crypto';

const STATES = new Set(['open', 'accepted', 'closed']);
/**
 * The step-up scope for accepting one change (ADR 0013, the L7 scope): the passkey is bound to this team's change
 * number, so a step-up made for another change, a resume or anything else is refused and stays unspent.
 */
export const acceptScope = (team, number) => `accept-change:${team}_${number}`;
const NUMBER = /^[1-9][0-9]{0,8}$/;
const actor = (who) => ({ kind: 'person', id: String(who.principal) });

/** The diff's hash, for the step-up's audit row and the ledger: the same items always hash the same. */
export const diffHash = (items) => createHash('sha256').update(JSON.stringify(items ?? [])).digest('hex');

/**
 * { db, m3 } → { list, get, accept, close, rollback }. `backendFor(tenant, team)` may be given (tests); by default the
 * team's store in this database.
 */
export function createChanges({ db, m3, now = () => new Date(), backendFor = null }) {
  const kit = loadKit();
  const backendOf = async (tenant, team) => {
    const [row] = await db.tenant(tenant, ({ q }) => q('select backend from teams where id = $1', [team]));
    if (!row) throw new Problem(404, 'no such team');
    if (row.backend !== 'managed') throw new Problem(409, 'this team lives in a code host: its changes are pull requests there', { type: 'not-managed' });
    return backendFor ? backendFor(tenant, team) : managedBackend({ store: pgObjects(db, tenant, team), refs: pgRefs(db, tenant, team), now });
  };
  const refsOf = (tenant, team) => pgRefs(db, tenant, team);
  const numberOf = (n) => { if (!NUMBER.test(String(n))) throw new Problem(400, 'a change is numbered 1, 2, 3'); return Number(n); };
  const specAt = async (b, sha) => (sha ? core.state(await b.readTeam(sha)).spec ?? { roles: {} } : { roles: {} });

  /** The checks and the capability diff at `head`, against `against` (the current main, or null for none). */
  async function assess(b, head, against) {
    const read = await b.readTeam(head);
    const checks = core.checkTeam(read);
    const capability = capabilityDiff(await specAt(b, against), core.state(read).spec ?? { roles: {} }, kit);
    return { checks, capability };
  }

  async function emit(tenant, team, type, data, who, id = null) {
    const e = mint(tenant, team, type, data, { actor: actor(who), time: now() });
    if (id) e.id = id;
    return m3.appendEvents(tenant, team, [e]);
  }

  const view = (c) => ({
    number: c.number, title: c.title, body: c.body, state: c.state, base: c.base, head: c.head, branch: `cr/${c.number}`,
    url: `/studio/changes/${c.number}`, checks: c.checks ?? null, capability: c.capability ?? [], needsCode: !!c.needsCode,
    createdBy: c.createdBy ?? null, authorMember: c.authorMember ?? null, acceptedBy: c.acceptedBy ?? null, acceptedSha: c.acceptedSha ?? null,
    createdAt: c.createdAt ?? null, closedAt: c.closedAt ?? null,
  });

  return {
    /** GET /v1/teams/{team}/changes?state= */
    async list(tenant, team, state = '') {
      await backendOf(tenant, team);
      if (state && !STATES.has(state)) throw new Problem(400, 'state is open, accepted or closed');
      const rows = await db.tenant(tenant, ({ q }) => q(`select number from change_requests where team = $1${state ? ' and state = $2' : ''} order by number desc limit 200`, state ? [team, state] : [team]));
      const refs = refsOf(tenant, team);
      return { changes: (await Promise.all(rows.map((r) => refs.getChange(r.number)))).map((c) => { const v = view(c); delete v.body; return v; }) };
    },

    /** GET /v1/teams/{team}/changes/{n}: the change with its files, capability diff, checks and commands. */
    async get(tenant, team, n) {
      const b = await backendOf(tenant, team);
      const c = await refsOf(tenant, team).getChange(numberOf(n));
      if (!c) throw new Problem(404, `no change ${n}`);
      const files = await b.diff(c.base, c.head);
      const commands = c.needsCode ? core.code(files.map((f) => ({ path: f.path, content: f.after, before: f.before, mode: '100644' }))).commands : [];
      return { ...view(c), files, commands };
    },

    /**
     * POST /v1/teams/{team}/changes/{n}/accept { words? } with x-step-up when the change widens anything. Interactive
     * only (ADR 0013): a host or a session token never reaches it (the route table and person() see to that).
     */
    async accept(who, team, n, { stepUp = null, words = '' } = {}) {
      const tenant = who.tenant;
      const number = numberOf(n);
      const b = await backendOf(tenant, team);
      const refs = refsOf(tenant, team);
      const c = await refs.getChange(number);
      if (!c) throw new Problem(404, `no change ${number}`);
      if (c.state !== 'open') throw new Problem(409, `change ${number} is ${c.state}`, { type: c.state });
      const main = (await refs.getRef('main'))?.sha ?? null;
      const failed = async (reason, status, message, type) => {
        await emit(tenant, team, 'proposal.failed', { connector: 'managed', ref: number, url: `/studio/changes/${number}`, branch: `cr/${number}`, headSha: c.head, reason }, who);
        throw new Problem(status, message, { type });
      };
      if ((c.base ?? null) !== main) return failed('head-moved', 409, 'the team changed since this change was made; make it again from the Studio', 'stale');
      const { checks, capability } = await assess(b, c.head, main);
      await refs.updateChange(number, { checks, capability }, 'open');
      if (!checks.ok) return failed('checks', 409, `the checks failed: ${[...checks.errors, ...checks.drift.map((p) => `${p} is not what sync writes`)].slice(0, 3).join('; ')}`, 'checks');
      if (c.authorMember && selfCapability(capability, c.authorMember).length) return failed('self-widening', 403, `${c.authorMember} drafted this change and it widens ${c.authorMember}'s own access or a check; another role or a person has to propose it`, 'self-widening');
      if (c.needsCode && !atLeast(who.role, 'admin')) throw new Problem(403, 'this change adds or changes commands the team runs, and you are not allowed to accept those; ask an admin who is', { type: 'publish-code' });
      const hash = diffHash(capability);
      if (capability.length) {
        await m3.requireStepUp(tenant, String(who.principal), stepUp, `Accepting change ${number}, which widens access (${capability.length} item${capability.length > 1 ? 's' : ''}, ${hash.slice(0, 12)})`, acceptScope(team, number));
      }
      // The audit row is written before main moves (security L9c low): the move is a compare-and-swap on the refs
      // table, outside this module's transaction, so a crash between the two must never leave a move with no row.
      // The pending row names the head that will become main; the outcome row follows it.
      const record = (decision, extra = {}) => m3.tx(tenant, (ctx) => ctx.audit({
        team, actorKind: 'person', actorId: String(who.principal), action: 'change-accept', target: `cr/${number}`, decision, rule: capability.length ? 'widens-access' : null,
        detail: { sha: c.head, base: c.base, widens: capability.map((x) => x.detail).slice(0, 50), diffHash: hash, words: String(words ?? '').slice(0, 2000) || null, needsCode: !!c.needsCode, ...extra },
      }));
      await record('pending');
      let done;
      try { done = await b.accept(number, { by: { id: String(who.principal) } }); } catch (e) {
        await record('failed', { reason: e?.type === 'stale' ? 'head-moved' : String(e?.message ?? e).slice(0, 200) });
        if (e?.type === 'stale') return failed('head-moved', 409, e.message, 'stale');
        throw e;
      }
      await record('allowed', { sha: done.sha });
      await emit(tenant, team, 'proposal.accepted', { connector: 'managed', ref: number, url: `/studio/changes/${number}`, branch: `cr/${number}`, headSha: c.head, result: done.sha }, who);
      const files = await b.diff(c.base, c.head);
      await emit(tenant, team, 'team.published', { version: done.sha, publishedAt: now().toISOString(), pr: number, roles: [], off: [], plan: {}, changes: files.map((f) => f.path).slice(0, 200), by: String(who.principal), via: 'managed' }, who, publishedId(done.sha));
      // L40b: the server moved main itself, so it vouches for this publish: a systems change pending on this change's
      // head (or the commit main moved to) switches on now, if its base is unmoved.
      await m3.tx(tenant, (ctx) => activatePending(ctx, team, { shas: [c.head, done.sha], via: 'managed' }));
      return { ...view(done.change), files: files.map((f) => ({ path: f.path, status: f.status })) };
    },

    /** POST /v1/teams/{team}/changes/{n}/close */
    async close(who, team, n) {
      const b = await backendOf(who.tenant, team);
      const row = await b.close(numberOf(n)).catch((e) => { throw new Problem(e.status ?? 409, e.message); });
      return view(row);
    },

    /**
     * POST /v1/teams/{team}/rollback { to }: a change request whose tree is version `to`'s, diffed against the current
     * main (S2-19), so access it restores shows as widening and needs the step-up when it is accepted.
     */
    async rollback(who, team, { to } = {}) {
      const tenant = who.tenant;
      const b = await backendOf(tenant, team);
      const main = (await refsOf(tenant, team).getRef('main'))?.sha ?? null;
      if (!main) throw new Problem(409, 'the team has no published version yet');
      if (!(await b.published(String(to ?? '')).catch(() => false))) throw new Problem(404, 'that is not a version this team published');
      // The old version's team (.agent-team/), synced with today's kit against main: the generated files are what sync
      // writes now, so the checks at accept pass even when the kit changed since `to` was published.
      const spec = core.state(await b.readTeam(to)).spec;
      if (!spec) throw new Problem(409, 'that version has no team to roll back to');
      // The kit pin stays main's: the generated files come from today's kit, so team.json must say so (code review L9c).
      const mainRead = await b.readTeam(main);
      const pin = core.state(mainRead).spec?.kit;
      if (pin !== undefined) spec.kit = pin; else delete spec.kit;
      let p;
      try { p = core.plan(mainRead, spec, { strict: true }); } catch (e) { throw new Problem(e.status ?? 422, `that version can't be rolled back to with this kit: ${String(e.message).slice(0, 200)}`); }
      const checks = { ok: !p.issues.some((i) => i.level === 'error'), errors: p.issues.filter((i) => i.level === 'error').map((i) => `${i.where}: ${i.message}`), drift: [] };
      const out = await b.rollback({ to, changes: p.changes, by: { id: String(who.principal) }, checks, capability: p.capability, needsCode: p.needsCode, pr: { title: `Roll back to ${String(to).slice(0, 12)}`, body: '' } })
        .catch((e) => { throw e?.status ? new Problem(e.status, e.message, e.type ? { type: e.type } : undefined) : e; });
      await emit(tenant, team, 'proposal.opened', { connector: 'managed', ref: out.number, url: out.url, branch: out.branch, headSha: out.commit }, who);
      return this.get(tenant, team, out.number);
    },
  };
}
