// An in-process fake of the GitHub REST API endpoints the Studio's github backend uses, backed by a real bare git
// repository, so tree SHAs are real and comparable with a local publish (docs/specs/studio-embed.md section 8).
// Also the app-token endpoints githubAppToken and the handler's scope check call.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV = { GIT_AUTHOR_NAME: 'Studio App', GIT_AUTHOR_EMAIL: 'app@example.com', GIT_COMMITTER_NAME: 'Studio App', GIT_COMMITTER_EMAIL: 'app@example.com', GIT_AUTHOR_DATE: '2026-11-06T10:00:00Z', GIT_COMMITTER_DATE: '2026-11-06T10:00:00Z' };

/**
 * Starts the fake. `bare` is a bare repository (the "GitHub" copy). Options: `token` the installation token it accepts,
 * `latency` ms per call, `repos` what GET /installation/repositories lists, `permissions` what a minted token gets,
 * `installation` the id GET /repos/{repo}/installation answers.
 * Returns { url, calls, close, git, pulls, setLatency }.
 */
export async function fakeGitHub({ bare, repo = 'acme/shop', id = 4242, installation = 77, token = 'ghs_fake', latency = 0, repos = null, permissions = null, appKey = null } = {}) {
  const git = (args, opts = {}) => execFileSync('git', ['--git-dir', bare, ...args], { encoding: 'utf8', env: { ...process.env, ...ENV, ...(opts.env ?? {}) }, input: opts.input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const calls = [];
  const pulls = [];
  const minted = [];
  let delay = latency;
  let inflight = 0;
  let peak = 0;
  const prefix = `/repos/${repo}`;
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };

  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const url = new URL(req.url, 'http://x');
    calls.push({ method: req.method, path: url.pathname + url.search, auth: req.headers.authorization ?? '' });
    // How many calls are waiting on the fake at once: the client's parallelism, independent of how busy the machine is.
    inflight++; peak = Math.max(peak, inflight);
    if (delay) await new Promise((r) => setTimeout(r, delay));
    inflight--;
    const body = raw ? JSON.parse(raw) : null;
    try {
      // App endpoints: a JWT mints an installation token.
      const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
      if (mint && req.method === 'POST') {
        if (!/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(req.headers.authorization ?? '')) return json(res, 401, { message: 'A JSON web token could not be decoded' });
        minted.push({ installation: mint[1], jwt: req.headers.authorization.slice(7), body });
        return json(res, 201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: permissions ?? body?.permissions ?? {}, repositories: (repos ?? [repo]).map((full) => ({ id, full_name: full, name: full.split('/')[1] })) });
      }
      // Which installation holds the repository: asked with the app's JWT (the hosted Studio, before every write).
      if (url.pathname === `${prefix}/installation` && req.method === 'GET') {
        if (!/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(req.headers.authorization ?? '')) return json(res, 401, { message: 'A JSON web token could not be decoded' });
        return json(res, 200, { id: installation, account: { login: repo.split('/')[0] } });
      }
      if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { message: 'Bad credentials' });
      if (url.pathname === '/installation/repositories') return json(res, 200, { total_count: (repos ?? [repo]).length, repositories: (repos ?? [repo]).map((full) => ({ id, full_name: full })) });
      if (!url.pathname.startsWith(prefix)) return json(res, 404, { message: 'Not Found' });
      const p = url.pathname.slice(prefix.length);
      const head = () => git(['symbolic-ref', '--short', 'HEAD']);
      if (p === '' && req.method === 'GET') return json(res, 200, { id, full_name: repo, default_branch: head(), html_url: `https://github.com/${repo}` });
      let m;
      if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(p)) && req.method === 'GET') {
        const sha = (() => { try { return git(['rev-parse', '--verify', '--quiet', `refs/heads/${m[1]}`]); } catch { return ''; } })();
        return sha ? json(res, 200, { ref: `refs/heads/${m[1]}`, object: { sha, type: 'commit' } }) : json(res, 404, { message: 'Not Found' });
      }
      if ((m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(p)) && req.method === 'GET') {
        const [tree, date] = git(['show', '-s', '--format=%T%n%cI', m[1]]).split('\n');
        return json(res, 200, { sha: m[1], tree: { sha: tree }, committer: { date } });
      }
      if ((m = /^\/git\/trees\/([0-9a-f]{40})$/.exec(p)) && req.method === 'GET') {
        const args = ['ls-tree', '-l', ...(url.searchParams.get('recursive') ? ['-r', '-t'] : []), m[1]];
        const tree = git(args).split('\n').filter(Boolean).map((l) => {
          const [meta, path] = l.split('\t');
          const [mode, type, sha, size] = meta.split(/\s+/);
          return { path, mode, type, sha, ...(size !== '-' ? { size: Number(size) } : {}) };
        });
        return json(res, 200, { sha: m[1], tree, truncated: false });
      }
      if ((m = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(p)) && req.method === 'GET') {
        // Async, so the fake answers calls side by side the way GitHub does (the timing test measures the client).
        const { stdout: content } = await promisify(execFile)('git', ['--git-dir', bare, 'cat-file', 'blob', m[1]], { encoding: 'buffer' });
        return json(res, 200, { sha: m[1], encoding: 'base64', content: content.toString('base64') });
      }
      if (p === '/git/trees' && req.method === 'POST') {
        const index = join(mkdtempSync(join(tmpdir(), 'fake-gh-index-')), 'index');
        const env = { GIT_INDEX_FILE: index };
        try {
          if (body.base_tree) git(['read-tree', body.base_tree], { env });
          for (const e of body.tree) {
            if (e.sha === null) { git(['update-index', '--index-info'], { env, input: `0 ${'0'.repeat(40)}\t${e.path}\n` }); continue; }
            if (!['100644', '100755'].includes(e.mode)) return json(res, 422, { message: `mode ${e.mode} not allowed here` });
            const blob = git(['hash-object', '-w', '--stdin'], { input: e.content });
            git(['update-index', '--add', '--cacheinfo', `${e.mode},${blob},${e.path}`], { env });
          }
          return json(res, 201, { sha: git(['write-tree'], { env }) });
        } finally { rmSync(join(index, '..'), { recursive: true, force: true }); }
      }
      if (p === '/git/commits' && req.method === 'POST') {
        return json(res, 201, { sha: git(['commit-tree', body.tree, ...body.parents.flatMap((x) => ['-p', x]), '-m', body.message]) });
      }
      if (p === '/git/refs' && req.method === 'POST') {
        const exists = (() => { try { return git(['rev-parse', '--verify', '--quiet', body.ref]); } catch { return ''; } })();
        if (exists) return json(res, 422, { message: 'Reference already exists' });
        git(['update-ref', body.ref, body.sha, '']);
        return json(res, 201, { ref: body.ref, object: { sha: body.sha } });
      }
      if ((m = /^\/git\/refs\/heads\/(.+)$/.exec(p)) && req.method === 'DELETE') { git(['update-ref', '-d', `refs/heads/${m[1]}`]); return json(res, 204); }
      if (p === '/pulls' && req.method === 'POST') {
        if (pulls.some((x) => x.head === body.head && x.state === 'open')) return json(res, 422, { message: 'A pull request already exists' });
        const pr = { number: pulls.length + 1, html_url: `https://github.com/${repo}/pull/${pulls.length + 1}`, state: 'open', merged_at: null, ...body };
        pulls.push(pr);
        return json(res, 201, pr);
      }
      if (p === '/pulls' && req.method === 'GET') {
        const headQ = url.searchParams.get('head')?.split(':')[1];
        return json(res, 200, pulls.filter((x) => x.head === headQ));
      }
      return json(res, 404, { message: 'Not Found' });
    } catch (e) {
      return json(res, 500, { message: e.message.split('\n')[0] });
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls, pulls, minted, git,
    setInstallation: (v) => { installation = v; },
    setLatency: (ms) => { delay = ms; },
    get peak() { return peak; },
    close: () => new Promise((r) => server.close(r)),
  };
}
