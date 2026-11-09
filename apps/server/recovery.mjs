// Recovery owners (L27, architecture B15, rule 11 Now minimum): the people who can still get into a workspace and
// put it right when another owner loses their way in. A workspace should have at least two; the list says so when
// it has fewer, and names a recovery owner who has no second way to sign in.
//
//   GET    /v1/recovery            the recovery owners, each one's sign-in methods, and warnings (admin)
//   POST   /v1/recovery            { person } names an owner with a passkey (owner + step-up). Takes effect in 24 hours,
//                                  told to every owner; the very first one, an owner naming themselves, counts at once
//   DELETE /v1/recovery/{person}   ends it at once (owner + step-up); a pending one can be undone this way too
//
// Only an owner of the workspace with a passkey can be one: someone whose only way in is GitHub would be lost with
// the same account. Being demoted from owner or removed ends it (the list stops counting them and says why).
import { randomBytes } from 'node:crypto';
import { Problem } from './store.mjs';

export const COOLING_OFF_MS = 24 * 3600_000;
export const WANTED = 2;
const rid = () => `rco_${randomBytes(12).toString('base64url')}`;
/** The step-up scope for naming or removing one recovery owner. */
export const recoveryScope = (tenant, person) => `recovery:${tenant}_${person}`;

export function createRecovery({ db, requireStepUp, now = () => new Date() }) {
  const view = (r, at) => {
    const methods = [...(r.login ? ['github'] : []), ...(Number(r.passkeys) ? ['passkey'] : [])];
    const pending = new Date(r.effective_at) > at;
    const why = r.role !== 'owner' ? 'not-owner' : !Number(r.passkeys) ? 'no-passkey' : pending ? 'pending' : null;
    return { person: r.person, login: r.login, name: r.name ?? r.login, methods, addedBy: r.added_by, addedAt: new Date(r.added_at).toISOString(),
      effectiveAt: new Date(r.effective_at).toISOString(), counts: why === null, ...(why ? { why } : {}) };
  };

  function warnings(owners) {
    const counted = owners.filter((o) => o.counts).length;
    const out = [];
    if (counted < WANTED) out.push({ code: 'fewer-than-two', text: counted === 0 ? 'This workspace has no recovery owner. If its owner loses their way in, nobody can put it right.' : 'This workspace has one recovery owner. Name a second, so losing one account never locks the workspace.' });
    for (const o of owners.filter((x) => x.why === 'no-passkey')) out.push({ code: 'no-passkey', person: o.person, text: `${o.name} has no passkey, so their only way in is GitHub. They do not count until they add one.` });
    for (const o of owners.filter((x) => x.why === 'not-owner')) out.push({ code: 'not-owner', person: o.person, text: `${o.name} is no longer an owner, so they do not count.` });
    return out;
  }

  async function list(who) {
    const at = now();
    const owners = (await db.system(...forTenant(who.tenant))).map((r) => view(r, at));
    return { owners, wanted: WANTED, warnings: warnings(owners) };
  }
  const forTenant = (tenant) => [`select r.person, r.added_by, r.added_at, r.effective_at, p.login, p.name, m.role,
      (select count(*)::int from passkeys k where k.person = r.person) as passkeys
    from recovery_owners r join people p on p.id = r.person
    left join members m on m.tenant = r.tenant and m.person = r.person and m.removed_at is null
    where r.tenant = $1 and r.removed_at is null order by r.added_at, r.id`, [tenant]];

  const mustOwn = (who) => {
    if (who.role !== 'owner') throw new Problem(403, 'only an owner names or removes recovery owners', { type: 'forbidden' });
  };

  /** Tells every owner of the workspace (their next visit shows it, /v1/me notices) and writes the workspace's audit. */
  async function tell(q, who, action, person, detail) {
    await q("insert into audit(tenant, actor_kind, actor_id, action, target, decision, detail) values ($1, 'person', $2, $3, $4, 'allowed', $5)", [who.tenant, who.principal, action, person, detail]);
    const owners = await q("select person from members where tenant = $1 and role = 'owner' and removed_at is null", [who.tenant]);
    for (const o of new Set([...owners.map((x) => x.person), person])) await q('insert into identity_audit(person, action, detail) values ($1, $2, $3)', [o, action, { by: who.principal, tenant: who.tenant, person, ...detail }]);
  }

  async function add(who, body, stepUp) {
    mustOwn(who);
    const person = typeof body?.person === 'string' ? body.person : '';
    if (!/^per_[A-Za-z0-9_-]{8,64}$/.test(person)) throw new Problem(400, 'send { person }: the id of an owner of this workspace (GET /v1/members)');
    // ADR 0013 rule 3: the step-up names this exact change (security review low 3).
    await requireStepUp(who, stepUp, 'Naming a recovery owner', recoveryScope(who.tenant, person));
    return db.systemTx(async ({ q }) => {
      await q('select pg_advisory_xact_lock(4854, hashtext($1))', [who.tenant]);
      const [m] = await q('select role from members where tenant = $1 and person = $2 and removed_at is null', [who.tenant, person]);
      if (!m) throw new Problem(404, 'no such member');
      if (m.role !== 'owner') throw new Problem(409, 'a recovery owner must be an owner of the workspace; make them an owner first', { type: 'not-owner' });
      const [{ n }] = await q('select count(*)::int as n from passkeys where person = $1', [person]);
      if (!n) throw new Problem(409, 'they need a passkey first, so their way in does not depend on GitHub alone', { type: 'no-passkey' });
      const [dupe] = await q('select id from recovery_owners where tenant = $1 and person = $2 and removed_at is null', [who.tenant, person]);
      if (dupe) throw new Problem(409, 'already a recovery owner', { type: 'already' });
      const at = now();
      const [{ live }] = await q('select count(*)::int as live from recovery_owners where tenant = $1 and removed_at is null', [who.tenant]);
      // Widening access waits 24 hours, so a stolen session cannot quietly add a way back in. The one exception is a
      // workspace with none at all, where an owner names themselves: nobody is given anything they did not have.
      const atOnce = Number(live) === 0 && person === who.principal;
      const effective = atOnce ? at : new Date(at.getTime() + COOLING_OFF_MS);
      await q('insert into recovery_owners(id, tenant, person, added_by, added_at, effective_at) values ($1, $2, $3, $4, $5, $6)', [rid(), who.tenant, person, who.principal, at, effective]);
      await tell(q, who, 'recovery-owner.added', person, { effectiveAt: effective.toISOString() });
      return { person, effectiveAt: effective.toISOString(), pending: !atOnce };
    });
  }

  async function remove(who, person, stepUp) {
    mustOwn(who);
    await requireStepUp(who, stepUp, 'Removing a recovery owner', recoveryScope(who.tenant, person));
    return db.systemTx(async ({ q }) => {
      await q('select pg_advisory_xact_lock(4854, hashtext($1))', [who.tenant]);
      const gone = await q('update recovery_owners set removed_at = $3, removed_by = $4 where tenant = $1 and person = $2 and removed_at is null returning id', [who.tenant, person, now(), who.principal]);
      if (!gone.length) throw new Problem(404, 'not a recovery owner');
      await tell(q, who, 'recovery-owner.removed', person, {});
      return { ok: true };
    });
  }

  return { list, add, remove };
}
