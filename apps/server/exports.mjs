// A managed team's standing export (spec L9 section 5.2; ADR 0012's "you can always take your team with you"; ADR 0013
// rule 3). The same zip as a download (changes.mjs exportTeam), written on a schedule to a folder or bucket the team
// already connected, so a copy exists outside OrgCraft without anyone remembering to download it.
//
//   GET    /v1/teams/{team}/standing-export   admin: what is set, what is pending and when it takes effect, the last run
//   PUT    /v1/teams/{team}/standing-export   admin, on the web, step-up scoped standing-export:<team>:
//                                             { connection, target, cadence } (cadence daily or on-publish)
//   DELETE /v1/teams/{team}/standing-export   the same: turns it off, at once
//
// A new target (turning it on, another connection, another folder) is a way to copy the team out, so it waits 24 hours
// (pending_*), announced to every owner and admin as a security notice; only then does the job write to it. Changing
// the cadence alone, or turning it off, narrows nothing and takes effect at once. `connection` is a credential id in
// the vault of a storage service (EXPORT_SERVICES); the job never sees its value: `deliver` (the connector gateway's
// put-file effect) is handed the connection id, the target, the file name and the bytes.
//
// The job (runDue, on the tick): promotes pending targets whose 24 hours are up; then writes each team that is due
// (daily: not yet today, UTC; on-publish: main moved since the last write), at most one try an hour. A failure goes
// to last_error and, once a day, to the owner's notifications (standing-export.failed); never silently.
import { Problem } from './store.mjs';
import { atLeast } from './roles.mjs';
import { mint } from './m3.mjs';

export const standingScope = (team) => `standing-export:${team}`;
/** Storage services a standing export can write to (the vault's service names). */
export const EXPORT_SERVICES = new Set(['google-drive', 's3']);
export const NEW_TARGET_WAIT_MS = 24 * 3600_000;
const RETRY_MS = 3600_000;
const CADENCES = new Set(['daily', 'on-publish']);
const iso = (t) => (t ? new Date(t).toISOString() : null);
const day = (t) => new Date(t).toISOString().slice(0, 10);

/** No connector can write files yet: every try fails with this, recorded and announced, until one is wired. */
export async function noDeliver({ service }) {
  throw new Error(`OrgCraft can't write to ${service} yet; download the team from Settings meanwhile`);
}

export function createStandingExports({ db, m3, exportOf, deliver = noDeliver, now = () => new Date() }) {
  const view = (r) => (!r ? { active: null, pending: null, last: null } : {
    active: r.connection ? { connection: r.connection, target: r.target, cadence: r.cadence, since: iso(r.changed_at), by: r.changed_by } : null,
    pending: r.pending_connection ? { connection: r.pending_connection, target: r.pending_target, cadence: r.pending_cadence, effectiveAt: iso(r.pending_at), by: r.pending_by } : null,
    last: r.last_at || r.last_error ? { sha: r.last_sha, at: iso(r.last_at), error: r.last_error, triedAt: iso(r.last_try_at) } : null,
  });
  const rowOf = async (tenant, team) => (await db.tenant(tenant, ({ q }) => q('select * from standing_exports where team = $1', [team])))[0] ?? null;

  async function mustAdminOnWeb(who, team) {
    if (who.via !== 'cookie') throw new Problem(403, 'change the standing export in the Studio, signed in on the web, with your passkey', { type: 'forbidden' });
    if (!atLeast(who.role, 'admin')) throw new Problem(403, 'only an admin can change the standing export', { type: 'forbidden' });
    const [t] = await db.tenant(who.tenant, ({ q }) => q('select backend from teams where id = $1', [team]));
    if (!t) throw new Problem(404, 'no such team');
    if (t.backend !== 'managed') throw new Problem(409, 'this team lives in a code host, which already keeps a copy', { type: 'not-managed' });
  }

  /** Security notices for every owner and admin (identity_audit is the system's, as in recovery.mjs). */
  async function notify(tenant, by, detail) {
    await db.systemTx(async ({ q }) => {
      const people = await q("select person from members where tenant = $1 and role in ('owner', 'admin') and removed_at is null", [tenant]);
      for (const p of new Set([...people.map((r) => r.person), by])) if (/^per_/.test(p)) await q('insert into identity_audit(person, action, detail) values ($1, $2, $3)', [p, 'standing-export.changed', { by, tenant, ...detail }]);
    });
  }

  const emit = (tenant, team, type, data, actor) => m3.appendEvents(tenant, team, [mint(tenant, team, type, data, { actor, time: now() })]);

  return {
    async get(who, team) {
      if (!atLeast(who.role, 'admin')) throw new Problem(403, 'only an admin can see the standing export', { type: 'forbidden' });
      return view(await rowOf(who.tenant, team));
    },

    async put(who, team, body, stepUp) {
      await mustAdminOnWeb(who, team);
      const connection = String(body?.connection ?? '');
      const target = String(body?.target ?? '').trim();
      const cadence = String(body?.cadence ?? '');
      if (!/^cred_[A-Za-z0-9_-]{8,40}$/.test(connection)) throw new Problem(400, 'connection is the id of a connected storage account (GET /v1/credentials)');
      if (!target || target.length > 300 || /[\u0000-\u001f\u007f]/.test(target)) throw new Problem(400, 'target is the folder or bucket path, at most 300 characters');
      if (!CADENCES.has(cadence)) throw new Problem(400, 'cadence is daily or on-publish');
      const [cred] = await db.tenant(who.tenant, ({ q }) => q('select service from credentials where id = $1 and removed_at is null', [connection]));
      if (!cred) throw new Problem(404, 'no such connection in this workspace');
      if (!EXPORT_SERVICES.has(cred.service)) throw new Problem(422, `a standing export writes to ${[...EXPORT_SERVICES].join(' or ')}; this connection is ${cred.service}`, { type: 'wrong-service' });
      const by = String(who.principal);
      const cur = await rowOf(who.tenant, team);
      const sameTarget = cur?.connection === connection && cur?.target === target;
      await m3.requireStepUp(who.tenant, by, stepUp, sameTarget ? `Exporting ${team} ${cadence === 'daily' ? 'every day' : 'after every publish'}` : `Sending a copy of ${team} to ${target}, from tomorrow`, standingScope(team));
      const at = now();
      const effectiveAt = new Date(at.getTime() + NEW_TARGET_WAIT_MS);
      await db.tenant(who.tenant, async ({ q }) => {
        if (sameTarget) {
          await q('update standing_exports set cadence = $2, changed_by = $3, changed_at = $4, pending_connection = null, pending_target = null, pending_cadence = null, pending_at = null, pending_by = null where team = $1', [team, cadence, by, at]);
        } else {
          await q(`insert into standing_exports(tenant, team, pending_connection, pending_target, pending_cadence, pending_at, pending_by) values ($1, $2, $3, $4, $5, $6, $7)
                   on conflict (tenant, team) do update set pending_connection = $3, pending_target = $4, pending_cadence = $5, pending_at = $6, pending_by = $7`, [who.tenant, team, connection, target, cadence, effectiveAt, by]);
        }
        await q("insert into audit(tenant, team, actor_kind, actor_id, action, target, decision, detail) values ($1, $2, 'person', $3, 'standing-export.set', $4, 'allowed', $5)",
          [who.tenant, team, by, team, { connection, target, cadence, ...(sameTarget ? { cadence_only: true } : { effectiveAt: effectiveAt.toISOString() }) }]);
      });
      if (!sameTarget) await notify(who.tenant, by, { team, target, effectiveAt: effectiveAt.toISOString(), change: 'new-target' });
      return view(await rowOf(who.tenant, team));
    },

    async remove(who, team, stepUp) {
      await mustAdminOnWeb(who, team);
      const by = String(who.principal);
      const cur = await rowOf(who.tenant, team);
      if (!cur) return view(null);
      await m3.requireStepUp(who.tenant, by, stepUp, `Turning off ${team}'s standing export`, standingScope(team));
      await db.tenant(who.tenant, async ({ q }) => {
        await q('delete from standing_exports where team = $1', [team]);
        await q("insert into audit(tenant, team, actor_kind, actor_id, action, target, decision, detail) values ($1, $2, 'person', $3, 'standing-export.off', $4, 'allowed', $5)", [who.tenant, team, by, team, { was: cur.target, pending: cur.pending_target }]);
      });
      await notify(who.tenant, by, { team, target: cur.target ?? cur.pending_target, change: 'off' });
      return view(null);
    },

    /** The tick: promote pending targets that are due, then write the teams that are due. Returns what it did. */
    async runDue() {
      const at = now();
      const done = { promoted: 0, written: 0, failed: 0 };
      const promote = await db.system('select tenant, team from standing_exports where pending_at is not null and pending_at <= $1', [at]);
      for (const { tenant, team } of promote) {
        const moved = await db.tenant(tenant, ({ q }) => q(`update standing_exports set connection = pending_connection, target = pending_target, cadence = pending_cadence,
            changed_by = pending_by, changed_at = $2, pending_connection = null, pending_target = null, pending_cadence = null, pending_at = null, pending_by = null,
            last_error = null where team = $1 and pending_at <= $2 returning target, changed_by`, [team, at]));
        if (moved.length) {
          done.promoted++;
          await db.tenant(tenant, ({ q }) => q("insert into audit(tenant, team, actor_kind, actor_id, action, target, decision, detail) values ($1, $2, 'system', 'control-plane', 'standing-export.active', $3, 'allowed', $4)", [tenant, team, team, { target: moved[0].target, by: moved[0].changed_by }]));
        }
      }
      const rows = await db.system(`select s.tenant, s.team, s.connection, s.target, s.cadence, s.last_sha, s.last_at, s.last_error, s.last_try_at, r.sha as main
        from standing_exports s left join managed_refs r on r.tenant = s.tenant and r.team = s.team and r.name = 'main'
        where s.connection is not null and (s.last_try_at is null or s.last_try_at <= $1)`, [new Date(at.getTime() - RETRY_MS)]);
      for (const r of rows) {
        if (!r.main) continue;
        const due = r.cadence === 'daily' ? (!r.last_at || day(r.last_at) !== day(at)) : r.last_sha !== r.main;
        if (!due) continue;
        await db.tenant(r.tenant, ({ q }) => q('update standing_exports set last_try_at = $2 where team = $1', [r.team, at]));
        try {
          const [cred] = await db.tenant(r.tenant, ({ q }) => q('select service from credentials where id = $1 and removed_at is null', [r.connection]));
          if (!cred) throw new Error('the connection was removed; choose another in Settings');
          const out = await exportOf(r.tenant, r.team);
          await deliver({ tenant: r.tenant, team: r.team, connection: r.connection, service: cred.service, target: r.target, name: out.name, bytes: out.zip });
          await db.tenant(r.tenant, async ({ q }) => {
            await q('update standing_exports set last_sha = $2, last_at = $3, last_error = null where team = $1', [r.team, out.sha, at]);
            await q("insert into audit(tenant, team, actor_kind, actor_id, action, target, decision, detail) values ($1, $2, 'system', 'control-plane', 'team.export', $3, 'allowed', $4)", [r.tenant, r.team, r.team, { sha: out.sha, kind: 'standing', target: r.target, bytes: out.zip.length }]);
          });
          await emit(r.tenant, r.team, 'team.exported', { by: 'control-plane', sha: out.sha, kind: 'standing', target: r.target }, { kind: 'system', id: 'control-plane', via: 'api' });
          done.written++;
        } catch (e) {
          done.failed++;
          const error = String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 300);
          const firstToday = !r.last_error || !r.last_try_at || day(r.last_try_at) !== day(at);
          await db.tenant(r.tenant, ({ q }) => q('update standing_exports set last_error = $2 where team = $1', [r.team, error]));
          if (firstToday) await emit(r.tenant, r.team, 'standing-export.failed', { target: r.target, error }, { kind: 'system', id: 'control-plane', via: 'api' });
        }
      }
      return done;
    },
  };
}
