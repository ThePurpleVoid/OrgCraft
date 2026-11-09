// The Studio's `managed` backend (ADR 0012, spec L9 section 4.3): the team's files live in OrgCraft's own Git store,
// with no code host. Same RepoBackend shape as github.mjs ({ kind, info, readTeam, listPaths, readRootFile, publish,
// prStatus }), so the handler and the page work unchanged. A publish opens a change request on a ref `cr/<n>`; only
// accepting it moves `main`, by compare-and-swap, fast-forward only. Nothing here forces or rewrites a ref.
//
//   store   a Git object store { get(sha), put(sha, framed), has(sha) } (packages/git-store: memoryStore, or the
//           server's managed_objects / object storage)
//   refs    the team's refs and change requests (memoryRefs() here; apps/server/managed-db.mjs for Postgres):
//             getRef(name) → { sha, version } | null
//             setRef(name, sha, expected) → boolean   expected { sha, version } moves it; null creates it; false = lost
//             openChange(row) → number               numbers 1, 2, 3 per team, atomically
//             getChange(number) → row | null         updateChange(number, patch, expectState) → row | null
import { CoreError, inReadSet } from './core.mjs';
import { applyChanges, listTree, readCommit, readObject, writeCommit, writeObject } from '../../packages/git-store/index.mjs';

const MAX_FILES = 2000;
const MAX_BYTES = 20 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const CR = /^cr\/([1-9][0-9]{0,8})$/;
const STALE = 'the team changed since you opened it; reload';

/** In-memory refs and change requests, for tests and local mode. Same contract as the Postgres one. */
export function memoryRefs() {
  const refs = new Map();
  const changes = new Map();
  return {
    async getRef(name) { const r = refs.get(name); return r ? { ...r } : null; },
    async setRef(name, sha, expected) {
      const cur = refs.get(name);
      if (expected === null) { if (cur) return false; refs.set(name, { sha, version: 1 }); return true; }
      if (!cur || cur.sha !== expected.sha || cur.version !== expected.version) return false;
      refs.set(name, { sha, version: cur.version + 1 });
      return true;
    },
    async openChange(row) { const number = changes.size + 1; changes.set(number, { ...row, number, state: 'open', createdAt: new Date().toISOString() }); return number; },
    async getChange(number) { const c = changes.get(number); return c ? structuredClone(c) : null; },
    async acceptChange(number, { from, to, by, at }) {
      const c = changes.get(number);
      if (!c || c.state !== 'open') return { ok: false, reason: 'state' };
      const cur = refs.get('main');
      if (from === null ? !!cur : cur?.sha !== from) return { ok: false, reason: 'stale' };
      refs.set('main', { sha: to, version: (cur?.version ?? 0) + 1 });
      Object.assign(c, { state: 'accepted', acceptedBy: by, acceptedSha: to, closedAt: at });
      return { ok: true, row: structuredClone(c) };
    },
    async updateChange(number, patch, expectState) {
      const c = changes.get(number);
      if (!c || (expectState && c.state !== expectState)) return null;
      Object.assign(c, patch);
      return structuredClone(c);
    },
  };
}

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * `author(user)` → { name, email } for the commit (default: OrgCraft's own name; never a person's email unless the
 * host gives one). `now()` → Date. `autoAccept`: a one-person organisation's "publish straight away" (spec 4.5): the
 * publish accepts its own change request in the same call, still fast-forward only.
 */
export function managedBackend({ store, refs, now = () => new Date(), author = () => ({ name: 'OrgCraft Studio', email: 'studio@orgcraft.invalid' }), autoAccept = false } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.put !== 'function') throw new TypeError('managedBackend: store is a Git object store');
  for (const m of ['getRef', 'setRef', 'openChange', 'getChange', 'updateChange', 'acceptChange']) if (typeof refs?.[m] !== 'function') throw new TypeError(`managedBackend: refs.${m} is required`);

  const commitOf = async (sha) => {
    if (!SHA.test(sha ?? '')) throw new CoreError(400, 'base is a commit id');
    try { return readCommit((await readObject(store, sha, 'commit')).body); } catch { throw new CoreError(404, 'no such version of the team'); }
  };
  const files = async (sha) => (sha ? listTree(store, (await commitOf(sha)).tree) : []);
  const text = async (sha) => (await readObject(store, sha, 'blob')).body.toString('utf8');

  const api = {
    kind: 'managed',
    async info() {
      const main = await refs.getRef('main');
      const head = main ? { sha: main.sha, at: new Date((await commitOf(main.sha)).committer?.time * 1000 || now()).toISOString() } : null;
      return { repo: null, defaultBranch: 'main', head, pr: true, managed: true };
    },
    async readTeam(base) {
      if (base === null || base === undefined) return { files: [], base: null };
      const list = (await files(base)).filter((e) => (e.mode === '100644' || e.mode === '100755') && inReadSet(e.path));
      if (list.length > MAX_FILES) throw new CoreError(413, `the team's files are too large to read (${list.length} files; at most ${MAX_FILES})`);
      const out = [];
      let size = 0;
      for (const e of list) {
        const content = await text(e.sha);
        size += Buffer.byteLength(content);
        if (size > MAX_BYTES) throw new CoreError(413, 'the team\'s files are too large to read (more than 20 MB)');
        out.push({ path: e.path, content, mode: e.mode });
      }
      return { files: out, base };
    },
    async listPaths(base) { return (await files(base)).map((e) => e.path); },
    async readRootFile(base, path) {
      const e = (await files(base)).find((x) => x.path === path && !x.path.includes('/'));
      return e ? text(e.sha) : null;
    },
    /**
     * Writes the change as a commit on `base` and opens change request n on ref cr/<n>. `base` null is the team's first
     * version (no main yet). Refused with 409 stale when main moved from `base`. `pr` gives the title and body.
     */
    async publish({ base, message, changes, pr, by = null, needsCode = false, checks = null, capability = [], authorMember = null }) {
      const main = await refs.getRef('main');
      if ((main?.sha ?? null) !== (base ?? null)) throw new CoreError(409, STALE, { type: 'stale' });
      for (const c of changes) if (!inReadSet(c.path)) throw new CoreError(400, `${c.path} is outside the team's files`);
      const baseTree = base ? (await commitOf(base)).tree : null;
      let tree;
      try { tree = await applyChanges(store, baseTree, changes.map((c) => ({ path: c.path, mode: c.mode ?? '100644', content: c.content }))); } catch (e) { throw new CoreError(400, `the change could not be written: ${clean(e.message, 160)}`); }
      const a = author(by);
      const who = { name: clean(a?.name, 100) || 'OrgCraft Studio', email: clean(a?.email, 100) || 'studio@orgcraft.invalid', time: Math.floor(now().getTime() / 1000), tz: '+0000' };
      const commit = await writeObject(store, 'commit', writeCommit({ tree, parents: base ? [base] : [], author: who, message }));
      const number = await refs.openChange({ base: base ?? null, head: commit, title: clean(pr?.title ?? message.split('\n')[0], 200), body: String(pr?.body ?? '').slice(0, 65536), createdBy: by?.id ?? null, authorMember, needsCode: !!needsCode, checks, capability });
      if (!(await refs.setRef(`cr/${number}`, commit, null))) throw new CoreError(409, `change ${number} already has a ref`, { type: 'exists' });
      const branch = `cr/${number}`;
      let result = { state: 'opened', number, url: `/studio/changes/${number}`, branch, base: 'main' };
      if (autoAccept) {
        // Publish straight away (spec 4.5): still a change request, still fast-forward only. A lost race closes it.
        try {
          const done = await api.accept(number, { by });
          result = { ...result, state: 'merged', merged: done.sha };
        } catch (e) { await refs.updateChange(number, { state: 'closed', closedAt: now().toISOString() }, 'open'); throw e; }
      }
      return { branch, commit, tree, files: changes.map((c) => c.path), pr: result };
    },
    /**
     * The files a change touches between two versions (base null: the first version), read-set text files only:
     * [{ path, status: 'added' | 'removed' | 'changed', before, after }], sorted by path.
     */
    async diff(base, head) {
      const index = async (sha) => new Map((await files(sha)).filter((e) => inReadSet(e.path)).map((e) => [e.path, e]));
      const [a, b] = await Promise.all([index(base), index(head)]);
      const out = [];
      for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
        const x = a.get(path);
        const y = b.get(path);
        if (x && y && x.sha === y.sha && x.mode === y.mode) continue;
        out.push({ path, status: !x ? 'added' : !y ? 'removed' : 'changed', before: x ? await text(x.sha) : null, after: y ? await text(y.sha) : null });
      }
      return out;
    },
    /** Whether `sha` is main or one of its ancestors (a version this team published), walking at most `limit` commits. */
    async published(sha, limit = 10_000) {
      let cur = (await refs.getRef('main'))?.sha ?? null;
      for (let n = 0; cur && n < limit; n++) {
        if (cur === sha) return true;
        cur = (await commitOf(cur)).parents[0] ?? null;
      }
      return false;
    },
    /**
     * Rollback (spec 4.5, S2-19): a new commit on main whose tree is version `to`'s, opened as a change request like any
     * other; never a move of main backwards. `to` must be a version this team published.
     */
    // `changes` turn main into `to` (core.plan of to's .agent-team/ against main with the current kit): never to's whole
    // tree, whose generated files may be an older kit's, which the checks would then refuse forever (code review L9c).
    // Never auto-accepted: a rollback can put access back, so it waits for a person.
    async rollback({ to, changes, message, pr, by = null, checks = null, capability = [], authorMember = null, needsCode = false }) {
      if (!SHA.test(to ?? '')) throw new CoreError(400, 'to is a commit id');
      if (!Array.isArray(changes) || !changes.length) throw new CoreError(409, 'the team is already at that version', { type: 'no-change' });
      const main = await refs.getRef('main');
      if (!main) throw new CoreError(409, 'the team has no published version yet');
      if (!(await api.published(to))) throw new CoreError(404, 'that is not a version this team published');
      for (const c of changes) if (!inReadSet(c.path)) throw new CoreError(400, `${c.path} is outside the team's files`);
      let tree;
      try { tree = await applyChanges(store, (await commitOf(main.sha)).tree, changes.map((c) => ({ path: c.path, mode: c.mode ?? '100644', content: c.content }))); } catch (e) { throw new CoreError(400, `the rollback could not be written: ${clean(e.message, 160)}`); }
      const a = author(by);
      const who = { name: clean(a?.name, 100) || 'OrgCraft Studio', email: clean(a?.email, 100) || 'studio@orgcraft.invalid', time: Math.floor(now().getTime() / 1000), tz: '+0000' };
      const commit = await writeObject(store, 'commit', writeCommit({ tree, parents: [main.sha], author: who, message: message || `Roll back to ${to.slice(0, 12)}` }));
      const number = await refs.openChange({ base: main.sha, head: commit, title: clean(pr?.title ?? `Roll back to ${to.slice(0, 12)}`, 200), body: String(pr?.body ?? '').slice(0, 65536), createdBy: by?.id ?? null, authorMember, needsCode: !!needsCode, checks, capability, rollbackTo: to });
      if (!(await refs.setRef(`cr/${number}`, commit, null))) throw new CoreError(409, `change ${number} already has a ref`, { type: 'exists' });
      return { branch: `cr/${number}`, commit, number, url: `/studio/changes/${number}` };
    },
    /** Accepts change request n: main moves to its head, fast-forward only. 409 stale when main moved since it opened. */
    async accept(number, { by = null } = {}) {
      const c = await refs.getChange(number);
      if (!c) throw new CoreError(404, `no change ${number}`);
      if (c.state !== 'open') throw new CoreError(409, `change ${number} is ${c.state}`, { type: c.state });
      // The move and the state change in one transaction: a close or a crash between them can't split them.
      const r = await refs.acceptChange(number, { from: c.base ?? null, to: c.head, by: by?.id ?? null, at: now().toISOString() });
      if (!r.ok && r.reason === 'stale') throw new CoreError(409, STALE, { type: 'stale' });
      if (!r.ok) throw new CoreError(409, `change ${number} is not open`, { type: 'closed' });
      return { number, sha: c.head, change: r.row };
    },
    async close(number) {
      const row = await refs.updateChange(number, { state: 'closed', closedAt: now().toISOString() }, 'open');
      if (!row) throw new CoreError(409, `change ${number} is not open`);
      return row;
    },
    async prStatus(branch) {
      const m = CR.exec(String(branch ?? ''));
      const c = m ? await refs.getChange(Number(m[1])) : null;
      if (!c) return { state: 'none', number: null, url: null, checks: null };
      return { state: c.state === 'accepted' ? 'merged' : c.state, number: c.number, url: `/studio/changes/${c.number}`, checks: c.checks ?? null };
    },
  };
  return api;
}
