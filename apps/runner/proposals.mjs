// Proposals: the pull request for a session's branch, opened and accepted by the runner, never by the session
// (runner-protocol.md, "Proposals are opened and accepted by the runner"; m3-design D1, D2). Two connectors:
//
//   githubProposals  a GitHub App (the "merger" app) with Contents and Pull requests write. The runner signs a JWT
//                    with the app's key, takes an installation token for the session's repository, opens the pull
//                    request after the first checkpoint push and merges it pinned to the approved head.
//   localProposals   for a stand-in remote (a bare repository on disk): the dry-run harness and the tests. The
//                    "pull request" is a record kept beside the bare repository; accepting it merges the branch
//                    into the base there, also pinned to the approved head.
//
// Both answer the same calls:
//   open({ repo, branch, base, title, body })  -> { connector, ref, url, headSha, existed }
//   accept({ repo, ref, branch, base, headSha, approval }) -> { result, deleted } (the merge commit; whether the
//                    branch is gone, so the session may start again from the base)
//   head({ repo, ref }) -> the proposal's head on the remote now
//   preview({ repo, sha }) -> { deployment, environment, url } for a successful deployment of that commit, or null
//                    (G-12, "Ready to try": the link comes from the host's deployment status, never from the model)
//   bound({ repo, installations }) -> the installation id, checked fresh (before a checkpoint push)
// and an accept that cannot land throws a ProposalError with `reason` head-moved, checks or conflict.
//
// Installation binding (#28, studio-embed S9): every call also takes `installations`, the GitHub App installation
// ids the server has bound to the run's tenant (session.start repo.installations; the server proved each one). The
// repository's installation must be one of them, or the call is refused with a ProposalError of reason
// `installation`, and no other installation is ever tried. Writes (open, accept, bound) look the installation up
// fresh every time; reads (head, preview) may use a lookup up to five minutes old.
import { createSign } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from './worktree.mjs';
import { repoSlug } from './policy.mjs';

export class ProposalError extends Error {
  constructor(reason, message) { super(message); this.reason = reason; }
}

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const need = (sha) => { if (!FULL_SHA.test(String(sha ?? ''))) throw new ProposalError('head-moved', 'an accept needs the full head commit it was approved for'); };

// The long lines of a PEM key: any one of them in a commit is a leak (a whole key rarely survives copy and paste).
const pemLines = (pem) => String(pem).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 40 && !l.startsWith('-----'));

/** The hosts' GitHub Apps whose deployment statuses a preview link may come from (configurable per runner). */
export const PREVIEW_CREATORS = ['vercel[bot]', 'netlify[bot]'];
const NEVER_PREVIEW_CREATORS = ['github-actions[bot]'];

/** A deployment's link, if it is one a person may be sent to: https, no user or password, at most 2000 characters. */
export function previewUrl(u) {
  if (typeof u !== 'string' || u.length > 2000) return null;
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && !x.username && !x.password ? x.href : null;
  } catch { return null; }
}

/** A GitHub App's JWT (RS256, 9 minutes, backdated a minute for clock drift). */
export function appJwt(appId, privateKey, now = Date.now()) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(now / 1000) - 60;
  const head = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat, exp: iat + 540, iss: String(appId) })}`;
  return `${head}.${createSign('RSA-SHA256').update(head).sign(privateKey).toString('base64url')}`;
}

/**
 * GitHub, through the merger app. `fetch` is injectable for the tests; nothing here runs without an app id and key.
 * Tokens are per repository installation and kept until five minutes before they expire.
 */
export function githubProposals({ appId, privateKey, api = 'https://api.github.com', fetch = globalThis.fetch, method = 'squash', previewCreators = PREVIEW_CREATORS, previewHosts = null }) {
  if (!appId || !privateKey) throw new Error('the merger app needs an app id and a private key');
  // Who may write the status a preview link is read from: the host's own app, never Actions (agent code can run
  // there with deployments write, and could put any link on a trusted card).
  const creators = new Set(previewCreators.map((c) => String(c).trim().toLowerCase()).filter((c) => c && !NEVER_PREVIEW_CREATORS.includes(c)));
  const hosts = previewHosts?.length ? previewHosts.map((h) => String(h).trim().toLowerCase().replace(/^\.+/, '')).filter(Boolean) : null;
  const trusted = (status, url) => {
    const c = status?.creator;
    if (!c || c.type !== 'Bot' || !creators.has(String(c.login ?? '').toLowerCase())) return false;
    if (!hosts) return true;
    const host = new URL(url).hostname.toLowerCase();
    return hosts.some((h) => host === h || host.endsWith(`.${h}`));
  };
  const tokens = new Map(); // slug#installation#permissions -> { token, until }
  const lookups = new Map(); // slug -> { id, at }: the repository's installation, for reads only
  const READ_FOR = 5 * 60_000;
  async function call(path, { token, ...init } = {}) {
    const res = await fetch(`${api}${path}`, { ...init, headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'agent-team-runner', authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }
  // Each token carries only what its calls need: the merge path writes, the preview path only reads deployments.
  const WRITE = { contents: 'write', pull_requests: 'write' };
  // The repository's installation, checked against the tenant's bound installations. `fresh` (every write) never
  // uses an earlier lookup; a read may use one up to five minutes old.
  async function installationFor(slug, installations, { fresh }) {
    const bound = Array.isArray(installations) ? installations.filter((i) => Number.isSafeInteger(i) && i > 0) : [];
    if (!bound.length) throw new ProposalError('installation', `no GitHub App installation is bound to this team's tenant, so nothing is written to or read from ${slug}; connect the GitHub App for this repository first`);
    const seen = lookups.get(slug);
    let id = !fresh && seen && Date.now() - seen.at < READ_FOR ? seen.id : null;
    if (id === null) {
      const inst = await call(`/repos/${slug}/installation`, { token: appJwt(appId, privateKey) });
      if (inst.status === 404) { lookups.delete(slug); throw new ProposalError('installation', `the merger app is not installed on ${slug}`); }
      if (inst.status !== 200 || !Number.isSafeInteger(inst.body?.id)) { lookups.delete(slug); throw new Error(`the installation of ${slug} could not be read (${inst.status})`); }
      id = inst.body.id;
      lookups.set(slug, { id, at: Date.now() });
    }
    if (!bound.includes(id)) throw new ProposalError('installation', `${slug} is under GitHub App installation ${id}, which is not bound to this team's tenant; refused, and no other installation is tried`);
    return id;
  }
  async function tokenFor(slug, installations, { permissions = WRITE, fresh = true } = {}) {
    const id = await installationFor(slug, installations, { fresh });
    const key = `${slug}#${id}#${Object.entries(permissions).map(([k, v]) => `${k}:${v}`).join(',')}`;
    const t = tokens.get(key);
    if (t && t.until > Date.now()) return t.token;
    const jwt = appJwt(appId, privateKey);
    const tok = await call(`/app/installations/${id}/access_tokens`, { token: jwt, method: 'POST', body: JSON.stringify({ repositories: [slug.split('/')[1]], permissions }) });
    if (tok.status !== 201 || !tok.body.token) throw new Error(`no installation token for ${slug} (${tok.status})`);
    tokens.set(key, { token: tok.body.token, until: Date.parse(tok.body.expires_at) - 5 * 60_000 });
    return tok.body.token;
  }
  const slugOf = (repo) => { const s = repoSlug(repo); if (!s) throw new Error(`${repo} is not a GitHub repository`); return s; };
  return {
    connector: 'github',
    /** Values the checkpoint scan and the memory redaction look for (the key's base64 body and the live tokens). */
    secrets: () => [...pemLines(privateKey), ...[...tokens.values()].map((t) => t.token)],
    /** Before a checkpoint push: the repository's installation, looked up fresh, must be bound to the tenant. */
    async bound({ repo, installations }) {
      const slug = repoSlug(repo);
      return slug ? installationFor(slug, installations, { fresh: true }) : null;
    },
    async open({ repo, branch, base, title, body = '', installations }) {
      const slug = slugOf(repo);
      const token = await tokenFor(slug, installations);
      const owner = slug.split('/')[0];
      const found = await call(`/repos/${slug}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(base)}`, { token });
      const pr = found.status === 200 && Array.isArray(found.body) ? found.body[0] : null;
      if (pr) return { connector: 'github', ref: pr.number, url: pr.html_url, headSha: pr.head?.sha ?? null, existed: true };
      const made = await call(`/repos/${slug}/pulls`, { token, method: 'POST', body: JSON.stringify({ title, head: branch, base, body, maintainer_can_modify: false }) });
      if (made.status !== 201) throw new Error(`the pull request for ${branch} was not opened (${made.status}: ${made.body.message ?? 'no message'})`);
      return { connector: 'github', ref: made.body.number, url: made.body.html_url, headSha: made.body.head?.sha ?? null, existed: false };
    },
    /** The proposal's head on the remote now (after a head-moved, the commit a new approval must name). */
    async head({ repo, ref, installations }) {
      const slug = slugOf(repo);
      const r = await call(`/repos/${slug}/pulls/${Number(ref)}`, { token: await tokenFor(slug, installations, { fresh: false }) });
      if (r.status !== 200 || !FULL_SHA.test(r.body.head?.sha ?? '')) throw new Error(`could not read the head of pull request ${ref} (${r.status})`);
      return r.body.head.sha;
    },
    /**
     * The newest successful deployment of `sha` with an https link (GitHub deployment statuses, which hosts such as
     * Vercel and Netlify write), written by a host app on `previewCreators` (and, if set, on a `previewHosts` domain).
     * Needs the app's Deployments read permission; without it, null (no link, no error).
     */
    async preview({ repo, sha, installations }) {
      if (!FULL_SHA.test(String(sha ?? ''))) return null;
      const slug = slugOf(repo);
      let token;
      try { token = await tokenFor(slug, installations, { permissions: { deployments: 'read' }, fresh: false }); } catch (e) { if (e instanceof ProposalError) throw e; return null; }
      const list = await call(`/repos/${slug}/deployments?sha=${sha}&per_page=10`, { token });
      if (list.status !== 200 || !Array.isArray(list.body)) return null;
      for (const d of list.body) {
        const st = await call(`/repos/${slug}/deployments/${Number(d.id)}/statuses?per_page=1`, { token });
        const last = st.status === 200 && Array.isArray(st.body) ? st.body[0] : null;
        const url = previewUrl(last?.environment_url);
        if (last?.state === 'success' && url && trusted(last, url)) return { deployment: Number(d.id), environment: String(d.environment ?? 'Preview').slice(0, 100), url };
      }
      return null;
    },
    async accept({ repo, ref, branch, headSha, installations }) {
      need(headSha);
      const slug = slugOf(repo);
      const token = await tokenFor(slug, installations);
      // GitHub refuses with 409 when the head is no longer `sha`, and 405 when the pull request cannot be merged.
      const r = await call(`/repos/${slug}/pulls/${Number(ref)}/merge`, { token, method: 'PUT', body: JSON.stringify({ sha: headSha, merge_method: method }) });
      if (r.status === 200 && r.body.merged) {
        // The branch goes, so the session's next push starts a new pull request from the new base. A repository
        // that deletes merged branches itself answers 422 (already gone). Anything else: the branch is still there,
        // and the session must not restart onto it (its next push would not be a fast-forward).
        let deleted = false;
        if (branch) {
          const d = await call(`/repos/${slug}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, { token, method: 'DELETE' }).catch(() => ({ status: 0 }));
          deleted = d.status === 204 || d.status === 422;
        }
        return { result: r.body.sha, deleted };
      }
      const why = r.body.message ?? `status ${r.status}`;
      if (r.status === 409) throw new ProposalError('head-moved', why);
      if (r.status === 405 && /conflict/i.test(why)) throw new ProposalError('conflict', why);
      throw new ProposalError('checks', why);
    },
  };
}

/**
 * A stand-in remote on disk (a bare repository path as repo.url). Records live in `<bare>/agent-team-proposals.json`
 * so a harness or a test can read the head and the merge result. `checks` can refuse an accept, the way a required
 * status check would (the harness's hook for a red check).
 */
export function localProposals({ checks = async () => true, before = async () => {} } = {}) {
  // repo.url as the Studio sends it for a repository on disk (file:///…), or a plain path.
  const dir = (repo) => (String(repo).startsWith('file://') ? fileURLToPath(repo) : String(repo));
  const file = (repo) => join(dir(repo), 'agent-team-proposals.json');
  const load = (repo) => (existsSync(file(repo)) ? JSON.parse(readFileSync(file(repo), 'utf8')) : { next: 1, proposals: {} });
  // Readable by the harness, which may be another user than the runner (the runner's umask is 077): it holds no secret.
  const store = (repo, s) => { writeFileSync(`${file(repo)}.tmp`, JSON.stringify(s, null, 2)); chmodSync(`${file(repo)}.tmp`, 0o644); renameSync(`${file(repo)}.tmp`, file(repo)); };
  return {
    connector: 'local',
    async open({ repo, branch, base, title }) {
      const s = load(repo);
      const headSha = await git(dir(repo), 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`);
      const open = Object.values(s.proposals).find((p) => p.branch === branch && p.state === 'open');
      if (open) { open.headSha = headSha; store(repo, s); return { connector: 'local', ref: open.ref, url: `file://${dir(repo)}#${open.ref}`, headSha, existed: true }; }
      const ref = s.next++;
      s.proposals[ref] = { ref, branch, base, title, headSha, state: 'open' };
      store(repo, s);
      return { connector: 'local', ref, url: `file://${dir(repo)}#${ref}`, headSha, existed: false };
    },
    /** The harness's stand-in host: `<bare>/agent-team-deployments.json`, [{ id, sha, environment, state, url }]. */
    async preview({ repo, sha }) {
      const f = join(dir(repo), 'agent-team-deployments.json');
      if (!existsSync(f)) return null;
      const list = JSON.parse(readFileSync(f, 'utf8'));
      const d = [...list].reverse().find((x) => x.sha === sha && x.state === 'success' && previewUrl(x.url));
      return d ? { deployment: Number(d.id), environment: String(d.environment ?? 'Preview'), url: previewUrl(d.url) } : null;
    },
    async head({ repo, ref }) {
      const p = load(repo).proposals[ref];
      if (!p) throw new Error(`no proposal ${ref}`);
      return git(dir(repo), 'rev-parse', '--verify', `refs/heads/${p.branch}^{commit}`);
    },
    async accept({ repo, ref, headSha, approval }) {
      need(headSha);
      // The dry run's hook: hold the merge here, after the approval, so a test can move the head first (step 9b).
      await before(load(repo).proposals[ref]);
      const s = load(repo);
      const p = s.proposals[ref];
      if (!p || p.state !== 'open') throw new ProposalError('checks', `proposal ${ref} is not open`);
      const head = await git(dir(repo), 'rev-parse', '--verify', `refs/heads/${p.branch}^{commit}`);
      if (head !== headSha) throw new ProposalError('head-moved', `the head of ${p.branch} is ${head}, not the approved ${headSha}`);
      if (!(await checks(p))) throw new ProposalError('checks', 'a required check has not passed');
      const tmp = mkdtempSync(join(tmpdir(), 'merge-'));
      try {
        await git(tmp, 'clone', '--quiet', '--no-hardlinks', '--', dir(repo), 'w');
        const w = join(tmp, 'w');
        await git(w, 'checkout', '--quiet', p.base);
        try {
          await git(w, '-c', 'user.name=merger', '-c', 'user.email=merger@agent-team.invalid', 'merge', '--quiet', '--squash', headSha);
          await git(w, '-c', 'user.name=merger', '-c', 'user.email=merger@agent-team.invalid', 'commit', '--quiet', '--no-verify', '-m', `${p.title ?? p.branch} (#${ref})`);
        } catch (e) {
          throw new ProposalError('conflict', String(e.stderr || e.message).trim().split('\n').pop());
        }
        const result = await git(w, 'rev-parse', 'HEAD');
        // A plain push: if the base moved under the merge, it is not a fast-forward and is refused.
        await git(w, 'push', '--quiet', 'origin', `HEAD:refs/heads/${p.base}`);
        // As GitHub's delete-branch-on-merge: the next push from the session starts a new pull request.
        await git(dir(repo), 'update-ref', '-d', `refs/heads/${p.branch}`, headSha);
        Object.assign(p, { state: 'merged', result, mergedHead: headSha, approval: approval ?? null });
        store(repo, s);
        return { result, deleted: true };
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  };
}
