// Members and invitations of a workspace (docs/specs/m4-sign-in.md section 4). Roles are roles.mjs's.
//
//   GET    /v1/members                 viewer: who is in this workspace, and their role
//   PATCH  /v1/members/{member}        admin, step-up: { role }
//   DELETE /v1/members/{member}        admin, step-up: removes the member; access ends on their next request
//   GET    /v1/invitations             admin: open invitations
//   POST   /v1/invitations             admin, step-up: { github: login | numeric id, role, days? }
//   DELETE /v1/invitations/{id}        admin: withdraws an open invitation
//
// The rules: only an owner makes, changes or removes an owner; nobody removes or demotes the last owner. A person
// whose last membership is removed is signed out everywhere (sessions and app tokens). Every change needs a fresh su_
// token and is written to the workspace's audit log and the person's identity log.
import { randomBytes } from 'node:crypto';
import { Problem } from './store.mjs';
import { ROLES, atLeast } from './roles.mjs';

const INVITE_DAYS = { default: 7, max: 30 };
const rid = (p, n = 12) => `${p}${randomBytes(n).toString('base64url')}`;

/**
 * `lookup(login)` resolves a GitHub login to { subject, login } (the numeric id is what sign-in matches, S2), or
 * null. `endSessions(person)` signs a person out everywhere. `requireStepUp(who, token, what)` spends a su_ token.
 */
export function createMembers({ db, lookup, endSessions, requireStepUp, now = () => new Date() }) {
  const view = (r) => ({ id: r.id, person: r.person, login: r.login, name: r.name ?? r.login, role: r.role, since: new Date(r.created_at).toISOString() });
  const inviteView = (r) => ({ id: r.id, github: r.subject, login: r.login ?? null, email: r.email ?? null, role: r.role, invitedBy: r.invited_by, createdAt: new Date(r.created_at).toISOString(), expiresAt: new Date(r.expires_at).toISOString() });
  async function auditBoth(q, who, person, action, target, detail) {
    await q("insert into audit(tenant, actor_kind, actor_id, action, target, decision, detail) values ($1, 'person', $2, $3, $4, 'allowed', $5)", [who.tenant, who.principal, action, target, detail]);
    if (person) await q('insert into identity_audit(person, action, detail) values ($1, $2, $3)', [person, action, { by: who.principal, tenant: who.tenant, ...detail }]);
  }
  const roleOf = (v) => {
    if (!ROLES.includes(v)) throw new Problem(400, `role must be one of ${ROLES.join(', ')}`);
    return v;
  };
  /** Changing a member to or from owner, or making an owner invitation, is an owner's call. */
  const mayGrant = (who, role) => {
    if (role === 'owner' && who.role !== 'owner') throw new Problem(403, 'only an owner can make an owner', { type: 'forbidden' });
  };

  async function list(who) {
    const rows = await db.system(`select m.id, m.person, m.role, m.created_at, p.login, p.name from members m join people p on p.id = m.person
      where m.tenant = $1 and m.removed_at is null order by m.created_at, m.id`, [who.tenant]);
    return { members: rows.map(view) };
  }

  /** One member, read under the workspace's member lock (4854) so two admins cannot both demote the last owners. */
  async function change(who, id, stepUp, what, fn) {
    await requireStepUp(who, stepUp, what);
    const out = await db.systemTx(async ({ q }) => {
      await q('select pg_advisory_xact_lock(4854, hashtext($1))', [who.tenant]);
      const [m] = await q('select id, person, role from members where id = $1 and tenant = $2 and removed_at is null', [id, who.tenant]);
      if (!m) throw new Problem(404, 'no such member');
      const [{ n }] = await q("select count(*)::int as n from members where tenant = $1 and role = 'owner' and removed_at is null", [who.tenant]);
      return fn(q, m, Number(n));
    });
    return out;
  }

  function update(who, id, body, stepUp) {
    const role = roleOf(body?.role);
    return change(who, id, stepUp, 'Changing a member\'s role', async (q, m, owners) => {
      if (m.role === 'owner' || role === 'owner') mayGrant(who, 'owner');
      if (m.role === 'owner' && role !== 'owner' && owners <= 1) throw new Problem(409, 'this is the last owner: make someone else an owner first', { type: 'last-owner' });
      if (m.role !== role) {
        await q('update members set role = $2 where id = $1', [m.id, role]);
        await auditBoth(q, who, m.person, 'member.role-changed', m.id, { from: m.role, to: role });
      }
      return { id: m.id, role };
    });
  }

  async function remove(who, id, stepUp) {
    const out = await change(who, id, stepUp, 'Removing a member', async (q, m, owners) => {
      if (m.role === 'owner') mayGrant(who, 'owner');
      if (m.role === 'owner' && owners <= 1) throw new Problem(409, 'this is the last owner: make someone else an owner first', { type: 'last-owner' });
      await q('update members set removed_at = $2 where id = $1', [m.id, now()]);
      await auditBoth(q, who, m.person, 'member.removed', m.id, { role: m.role });
      const [{ left }] = await q('select count(*)::int as left from members where person = $1 and removed_at is null', [m.person]);
      return { person: m.person, left: Number(left) };
    });
    // In no workspace any more: signed out everywhere, app tokens too. Otherwise /v1 already answers 404 here, since
    // membership is read on every request.
    if (out.left === 0) await endSessions(out.person);
    return { ok: true };
  }

  async function invitations(who) {
    const rows = await db.system(`select i.*, p.login from invitations i left join people p on p.provider = i.provider and p.subject = i.subject
      where i.tenant = $1 and i.accepted_at is null and i.expires_at > $2 order by i.created_at, i.id`, [who.tenant, now()]);
    return { invitations: rows.map(inviteView) };
  }

  async function invite(who, body, stepUp) {
    const role = roleOf(body?.role);
    mayGrant(who, role);
    const days = body?.days === undefined ? INVITE_DAYS.default : Number(body.days);
    if (!Number.isInteger(days) || days < 1 || days > INVITE_DAYS.max) throw new Problem(400, `days must be a whole number from 1 to ${INVITE_DAYS.max}`);
    const github = typeof body?.github === 'string' ? body.github.trim().replace(/^@/, '') : typeof body?.github === 'number' ? String(body.github) : '';
    if (!/^[0-9]{1,20}$/.test(github) && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(github)) throw new Problem(400, 'send { github, role }: a GitHub login or numeric user id');
    await requireStepUp(who, stepUp, 'Inviting someone');
    // A login can change hands; the numeric id cannot, so that is what the invitation holds (S2).
    const found = await lookup(github);
    if (!found) throw new Problem(404, `GitHub has no user ${github}`, { type: 'no-such-github-user' });
    const id = rid('inv_');
    const expires = new Date(now().getTime() + days * 86_400_000);
    const [row] = await db.systemTx(async ({ q }) => {
      const [m] = await q("select m.id from members m join people p on p.id = m.person where m.tenant = $1 and m.removed_at is null and p.provider = 'github' and p.subject = $2", [who.tenant, found.subject]);
      if (m) throw new Problem(409, `${found.login} is already a member: change their role instead`, { type: 'already-member' });
      // A newer invitation for the same person replaces an open one.
      await q("update invitations set expires_at = $3 where tenant = $1 and provider = 'github' and subject = $2 and accepted_at is null and expires_at > $3", [who.tenant, found.subject, now()]);
      const rows = await q('insert into invitations(id, tenant, provider, subject, role, invited_by, expires_at) values ($1, $2, $3, $4, $5, $6, $7) returning *',
        [id, who.tenant, 'github', found.subject, role, who.principal, expires]);
      await auditBoth(q, who, null, 'invitation.created', id, { github: found.subject, login: found.login, role });
      return rows;
    });
    return { ...inviteView(row), login: found.login };
  }

  async function withdraw(who, id) {
    const done = await db.systemTx(async ({ q }) => {
      const r = await q('update invitations set expires_at = $3 where id = $1 and tenant = $2 and accepted_at is null and expires_at > $3 returning id', [id, who.tenant, now()]);
      if (r.length) await auditBoth(q, who, null, 'invitation.withdrawn', id, {});
      return r.length > 0;
    });
    if (!done) throw new Problem(404, 'no such open invitation');
    return { ok: true };
  }

  return { list, update, remove, invitations, invite, withdraw };
}

/** The host's way back in when no owner can sign in (`agent-team-server admin reset-owner <github-id>`): an owner
 *  invitation for that GitHub user id, valid one day, written to the audit logs. Run on the host, never over HTTP. */
export async function resetOwner(db, tenant, subject, { now = () => new Date() } = {}) {
  if (!/^[0-9]{1,20}$/.test(String(subject))) throw new Error('give the numeric GitHub user id (https://api.github.com/users/<login> shows it)');
  const id = rid('inv_');
  await db.systemTx(async ({ q }) => {
    await q('insert into tenants(id, name) values ($1, $1) on conflict (id) do nothing', [tenant]);
    await q('insert into invitations(id, tenant, provider, subject, role, invited_by, expires_at) values ($1, $2, $3, $4, $5, $6, $7)',
      [id, tenant, 'github', String(subject), 'owner', 'host', new Date(now().getTime() + 86_400_000)]);
    await q("insert into audit(tenant, actor_kind, actor_id, action, target, decision, detail) values ($1, 'person', 'host', 'invitation.created', $2, 'allowed', $3)", [tenant, id, { github: String(subject), role: 'owner', via: 'reset-owner' }]);
  });
  return id;
}
