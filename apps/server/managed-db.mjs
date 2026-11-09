// The managed store's refs, change requests and objects in Postgres (migration 015; ADR 0012, spec L9 section 4).
// The same contracts as apps/studio/managed.mjs memoryRefs() and packages/git-store memoryStore(), so
// managedBackend({ store: pgObjects(db, tenant, team), refs: pgRefs(db, tenant, team) }) is the hosted backend.
// Every query runs as agent_team_app under the tenant's row-level security.
import { id } from './store.mjs';

const SHA = /^[0-9a-f]{40}$/;
// Only a person's id goes in created_by and accepted_by (they reference people); an admin token or a host is not one.
const person = (v) => (typeof v === 'string' && /^per_[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null);

/** Git objects, content-addressed: a put of an id already stored does nothing. */
export function pgObjects(db, tenant, team) {
  return {
    async get(sha) {
      if (!SHA.test(sha)) return null;
      const [row] = await db.tenant(tenant, ({ q }) => q('select body from managed_objects where team = $1 and sha = $2', [team, sha]));
      return row ? Buffer.from(row.body) : null;
    },
    async put(sha, framed) {
      if (!SHA.test(sha)) throw new TypeError('not an object id');
      await db.tenant(tenant, ({ q }) => q('insert into managed_objects(tenant, team, sha, body) values ($1, $2, $3, $4) on conflict do nothing', [tenant, team, sha, Buffer.from(framed)]));
    },
    async has(sha) {
      if (!SHA.test(sha)) return false;
      return (await db.tenant(tenant, ({ q }) => q('select 1 from managed_objects where team = $1 and sha = $2', [team, sha]))).length > 0;
    },
  };
}

const iso = (t) => (t ? new Date(t).toISOString() : null);
const change = (r) => r && ({
  number: r.number, base: r.base, head: r.head, title: r.title, body: r.body, state: r.state, checks: r.checks,
  capability: r.capability_diff, needsCode: r.needs_code, createdBy: r.created_by, authorMember: r.author_member,
  acceptedBy: r.accepted_by, acceptedSha: r.accepted_sha, createdAt: iso(r.created_at), closedAt: iso(r.closed_at),
});

/** Refs (main, cr/<n>) moved by compare-and-swap (spec 4.2), and the team's change requests numbered 1, 2, 3. */
export function pgRefs(db, tenant, team) {
  return {
    async getRef(name) {
      const [row] = await db.tenant(tenant, ({ q }) => q('select sha, version from managed_refs where team = $1 and name = $2', [team, name]));
      return row ? { sha: row.sha, version: Number(row.version) } : null;
    },
    async setRef(name, sha, expected) {
      return db.tenant(tenant, async ({ q }) => {
        if (expected === null) return (await q('insert into managed_refs(tenant, team, name, sha) values ($1, $2, $3, $4) on conflict do nothing returning version', [tenant, team, name, sha])).length === 1;
        return (await q('update managed_refs set sha = $3, version = version + 1, updated_at = now() where team = $1 and name = $2 and sha = $4 and version = $5 returning version',
          [team, name, sha, expected.sha, expected.version])).length === 1;
      });
    },
    async openChange(row) {
      return db.tenant(tenant, async ({ q }) => {
        // One number per team: a per-team lock inside the transaction, so two opens never pick the same number.
        await q('select pg_advisory_xact_lock(hashtext($1))', [`change_requests:${tenant}:${team}`]);
        const [{ next }] = await q('select coalesce(max(number), 0) + 1 as next from change_requests where team = $1', [team]);
        await q(`insert into change_requests(id, tenant, team, number, base, head, title, body, checks, capability_diff, needs_code, created_by, author_member)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [id('cr'), tenant, team, next, row.base, row.head, row.title, row.body ?? '', row.checks === null || row.checks === undefined ? null : JSON.stringify(row.checks),
          JSON.stringify(row.capability ?? []), !!row.needsCode, person(row.createdBy), row.authorMember ?? null]);
        return Number(next);
      });
    },
    async getChange(number) {
      const [row] = await db.tenant(tenant, ({ q }) => q('select * from change_requests where team = $1 and number = $2', [team, number]));
      return change(row) ?? null;
    },
    async updateChange(number, patch, expectState) {
      const cols = { state: 'state', acceptedBy: 'accepted_by', acceptedSha: 'accepted_sha', closedAt: 'closed_at', checks: 'checks', capability: 'capability_diff' };
      const sets = [];
      const args = [team, number];
      for (const [k, v] of Object.entries(patch)) {
        if (!cols[k]) throw new TypeError(`updateChange: ${k} cannot be changed`);
        args.push(k === 'checks' || k === 'capability' ? JSON.stringify(v) : k === 'acceptedBy' ? person(v) : v);
        sets.push(`${cols[k]} = $${args.length}`);
      }
      let where = 'team = $1 and number = $2';
      if (expectState) { args.push(expectState); where += ` and state = $${args.length}`; }
      const [row] = await db.tenant(tenant, ({ q }) => q(`update change_requests set ${sets.join(', ')} where ${where} returning *`, args));
      return change(row) ?? null;
    },
  };
}
