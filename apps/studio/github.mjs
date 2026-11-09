// The Studio's `github` backend (docs/specs/studio-embed.md section 3): the team's read set and a publish through the
// GitHub REST API with an installation token, so a host's server needs no checkout and no git. Repository I/O only;
// the shared core (core.mjs) decides what a publish changes. Refs are create-only: nothing is ever moved or forced.
import { createHash } from 'node:crypto';
import { READ_SET, inReadSet, CoreError } from './core.mjs';
import { hashObject } from '../../packages/git-store/index.mjs';

const MAX_FILES = 2000;
const MAX_BYTES = 20 * 1024 * 1024;
const PARALLEL = 16;

/** A GitHub error as a plain sentence: never its headers, never the token, never a whole body (E3). */
class GitHubError extends CoreError {}
const sentence = (status, what, body) => {
  const msg = typeof body?.message === 'string' ? body.message.replace(/[^\x20-\x7e]/g, ' ').slice(0, 160) : '';
  if (status === 401) return `GitHub refused the app's token while ${what}; check the app's installation`;
  if (status === 403) return `GitHub did not allow ${what}${msg ? ` (${msg})` : ''}; check the app's permissions and the branch ruleset`;
  if (status === 404) return `GitHub found nothing while ${what}; check the repository name and that the app is installed on it`;
  return `GitHub answered ${status} while ${what}${msg ? ` (${msg})` : ''}`;
};

/** The git object id of a blob's content (sha1, from packages/git-store; or sha256 for a 64-character id). */
export const blobId = (content, algo = 'sha1') => {
  if (algo === 'sha1') return hashObject('blob', Buffer.from(content, 'utf8'));
  const buf = Buffer.from(content, 'utf8');
  return createHash(algo).update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');
};

/**
 * A blob cache shared across warm invocations: keyed on (repository id, installation id, sha), and every read is
 * hashed again against its sha, so one customer's warm cache never answers another's read (S3).
 */
export function blobCache({ max = 20_000 } = {}) {
  const map = new Map();
  return {
    get(repoId, installation, sha) {
      const key = `${repoId}\u0000${installation}\u0000${sha}`;
      const v = map.get(key);
      if (v === undefined) return undefined;
      if (blobId(v, sha.length === 64 ? 'sha256' : 'sha1') !== sha) { map.delete(key); return undefined; }
      return v;
    },
    set(repoId, installation, sha, content) {
      if (map.size >= max) map.delete(map.keys().next().value);
      map.set(`${repoId}\u0000${installation}\u0000${sha}`, content);
    },
    get size() { return map.size; },
  };
}

/**
 * `repo` is "owner/name"; `token()` gives an installation token (in memory only); `installation` names the
 * installation for the cache key. `api` is GitHub's API (or a fake one in tests).
 */
export function githubBackend({ repo, token, installation = 'default', api = 'https://api.github.com', fetch: fetchImpl = globalThis.fetch, cache = blobCache() }) {
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo ?? '')) throw new TypeError('repo is "owner/name"');
  const [owner] = repo.split('/');
  const base = `${api.replace(/\/+$/, '')}/repos/${repo}`;
  let repoInfo = null;

  async function call(method, path, what, body) {
    const t = await token();
    let res;
    try {
      res = await fetchImpl(path.startsWith('http') ? path : `${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${t}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'agent-team-studio', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch { throw new GitHubError(502, `GitHub could not be reached while ${what}`); }
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) throw new GitHubError(res.status === 404 || res.status === 422 ? res.status : 502, sentence(res.status, what, json), { github: res.status });
    return json;
  }

  async function repository() {
    if (!repoInfo) {
      const r = await call('GET', '', 'reading the repository');
      repoInfo = { id: String(r.id), defaultBranch: r.default_branch, url: r.html_url ?? `https://github.com/${repo}` };
    }
    return repoInfo;
  }

  const refSha = async (branch, what) => (await call('GET', `/git/ref/heads/${encodeURIComponent(branch).replace(/%2F/g, '/')}`, what)).object.sha;
  const treeOf = async (commit) => (await call('GET', `/git/commits/${commit}`, 'reading a commit')).tree.sha;
  const tree = (sha, recursive = false) => call('GET', `/git/trees/${sha}${recursive ? '?recursive=1' : ''}`, 'reading the tree');

  /** The entries under a path from the root tree, walking one level at a time (no recursive root tree: S, section 3). */
  async function subtree(rootTree, dir) {
    const parts = dir.split('/');
    let entries = rootTree.tree;
    for (const [i, part] of parts.entries()) {
      const e = entries.find((x) => x.path === part && x.type === 'tree');
      if (!e) return [];
      if (i < parts.length - 1) { entries = (await tree(e.sha)).tree; continue; }
      const deep = await tree(e.sha, true);
      if (deep.truncated) throw new CoreError(413, `${dir}/ has more files than GitHub lists at once`);
      return deep.tree.map((x) => ({ ...x, path: `${dir}/${x.path}` }));
    }
    return [];
  }

  async function blobs(entries) {
    const { id } = await repository();
    const out = new Array(entries.length);
    let next = 0;
    const worker = async () => {
      while (next < entries.length) {
        const i = next++;
        const e = entries[i];
        let content = cache.get(id, installation, e.sha);
        if (content === undefined) {
          const b = await call('GET', `/git/blobs/${e.sha}`, `reading ${e.path}`);
          content = b.encoding === 'base64' ? Buffer.from(b.content ?? '', 'base64').toString('utf8') : String(b.content ?? '');
          cache.set(id, installation, e.sha, content);
        }
        out[i] = { path: e.path, content, mode: e.mode };
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, entries.length) }, worker));
    return out;
  }

  return {
    kind: 'github',
    async info() {
      const r = await repository();
      const sha = await refSha(r.defaultBranch, 'reading the default branch');
      const c = await call('GET', `/git/commits/${sha}`, 'reading the head commit');
      return { repo: r.url, defaultBranch: r.defaultBranch, head: { sha, at: c.committer?.date ?? null }, pr: true };
    },
    async readTeam(baseSha) {
      const rootTree = await tree(await treeOf(baseSha));
      // The read-set folders side by side: each is one or two calls.
      const entries = (await Promise.all(READ_SET.map(async (r) => {
        if (r.endsWith('/')) return subtree(rootTree, r.slice(0, -1));
        const e = rootTree.tree.find((x) => x.path === r);
        return e ? [{ ...e, path: r }] : [];
      }))).flat();
      // Regular files only: no symlinks (120000) and no submodules (E5).
      const files = entries.filter((e) => e.type === 'blob' && (e.mode === '100644' || e.mode === '100755') && inReadSet(e.path));
      const size = files.reduce((n, e) => n + (e.size ?? 0), 0);
      if (files.length > MAX_FILES || size > MAX_BYTES) throw new CoreError(413, `the team's files are too large to read (${files.length} files, ${Math.round(size / 1024 / 1024)} MB; at most ${MAX_FILES} files and 20 MB)`);
      return { files: await blobs(files), base: baseSha };
    },
    async listPaths(baseSha) {
      const t = await tree(await treeOf(baseSha), true);
      return t.tree.filter((e) => e.type === 'blob').map((e) => e.path);
    },
    /** A root file's text at `base`, for suggestions (package.json). */
    async readRootFile(baseSha, path) {
      const rootTree = await tree(await treeOf(baseSha));
      const e = rootTree.tree.find((x) => x.path === path && x.type === 'blob');
      return e ? (await blobs([{ ...e, path }]))[0].content : null;
    },
    async publish({ base: baseSha, into, branch, message, changes, pr }) {
      const baseTree = await treeOf(baseSha);
      const newTree = await call('POST', '/git/trees', 'writing the tree', {
        base_tree: baseTree,
        tree: changes.map((c) => (c.content === null ? { path: c.path, mode: c.mode ?? '100644', type: 'blob', sha: null } : { path: c.path, mode: c.mode, type: 'blob', content: c.content })),
      });
      const commit = await call('POST', '/git/commits', 'writing the commit', { message, tree: newTree.sha, parents: [baseSha] });
      try {
        await call('POST', '/git/refs', 'creating the branch', { ref: `refs/heads/${branch}`, sha: commit.sha });
      } catch (e) {
        if (e.github === 422) throw new CoreError(409, `branch ${branch} already exists`, { type: 'exists' });
        throw e;
      }
      // The default branch moved since the page read it: take back our own new branch and say so.
      const now = await refSha(into, 'reading the default branch');
      if (now !== baseSha) {
        await call('DELETE', `/git/refs/heads/${branch}`, 'removing the new branch').catch(() => {});
        throw new CoreError(409, 'the team changed on GitHub since you opened it; reload', { type: 'stale' });
      }
      let result = null;
      if (pr) {
        try {
          const p = await call('POST', '/pulls', 'opening the pull request', { title: pr.title, body: pr.body, head: branch, base: into });
          result = { state: 'opened', number: p.number, url: p.html_url, branch, base: into };
        } catch (e) {
          if (e.github !== 422) throw e;
          const list = await call('GET', `/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open`, 'finding the pull request');
          result = { state: 'exists', number: list?.[0]?.number ?? null, url: list?.[0]?.html_url ?? null, branch, base: into };
        }
      }
      return { branch, commit: commit.sha, tree: newTree.sha, files: changes.map((c) => c.path), pr: result };
    },
    async prStatus(branch) {
      const list = await call('GET', `/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all`, 'finding the pull request');
      const p = list?.[0];
      if (!p) return { state: 'none', number: null, url: null, checks: null };
      return { state: p.merged_at ? 'merged' : p.state === 'open' ? 'open' : 'closed', number: p.number, url: p.html_url, checks: null };
    },
  };
}
