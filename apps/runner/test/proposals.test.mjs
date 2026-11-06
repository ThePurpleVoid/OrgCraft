// Proposals: the runner opens the pull request after the first checkpoint push and merges it, pinned to the
// approved head, only on approval.result (runner-protocol.md, Proposals; m3-design D1, D2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkEvent } from '../../../packages/events/index.mjs';
import { appJwt, githubProposals, localProposals, ProposalError } from '../proposals.mjs';
import { startRunner } from '../runner.mjs';
import { stubAdapter } from '../adapters/stub.mjs';
import { fakeControlPlane } from './fake-control-plane.mjs';
import { noFailedTurns, origin, sh } from './helpers.mjs';

/** A branch on the bare origin with one commit on top of its main (or of the seed's older main, for a conflict). */
function branch(bare, root, name, file, text, { stale = false } = {}) {
  const seed = join(root, '..', 'seed');
  sh(seed, 'fetch', '--quiet', bare, 'main');
  sh(seed, 'checkout', '--quiet', '-B', name, stale ? 'main' : 'FETCH_HEAD');
  writeFileSync(join(seed, file), text);
  sh(seed, 'add', '-A'); sh(seed, 'commit', '--quiet', '-m', `${name}: ${file}`); sh(seed, 'push', '--quiet', '--force', bare, name);
  sh(seed, 'checkout', '--quiet', 'main');
  return sh(bare, 'rev-parse', name);
}

test('local proposals: open once, merge only the approved head, and say why not', async () => {
  const { bare, root } = origin();
  const p = localProposals();
  const head = branch(bare, root, 'web/1-a', 'a.txt', 'a\n');
  const o = await p.open({ repo: bare, branch: 'web/1-a', base: 'main', title: 'web-dev: web/1-a' });
  assert.deepEqual([o.connector, o.ref, o.headSha, o.existed], ['local', 1, head, false]);
  assert.equal((await p.open({ repo: bare, branch: 'web/1-a', base: 'main', title: 'again' })).existed, true, 'a second open finds the same proposal');
  await assert.rejects(p.accept({ repo: bare, ref: 1, headSha: head.slice(0, 7) }), (e) => e instanceof ProposalError && e.reason === 'head-moved', 'an abbreviation is not a pin');
  await assert.rejects(p.accept({ repo: bare, ref: 1, headSha: 'f'.repeat(40) }), (e) => e.reason === 'head-moved');
  const m = await p.accept({ repo: bare, ref: 1, headSha: head, approval: 'apr_1' });
  assert.equal(sh(bare, 'rev-parse', 'main'), m.result);
  assert.equal(sh(bare, 'show', 'main:a.txt'), 'a');
  const rec = JSON.parse(readFileSync(join(bare, 'agent-team-proposals.json'), 'utf8')).proposals['1'];
  assert.deepEqual([rec.state, rec.mergedHead, rec.result, rec.approval], ['merged', head, m.result, 'apr_1'], 'the harness can read the head and the merge result');

  // A conflict with what landed on main meanwhile, and a red check.
  const h2 = branch(bare, root, 'web/2-b', 'a.txt', 'other\n', { stale: true });
  const o2 = await p.open({ repo: bare, branch: 'web/2-b', base: 'main', title: 'b' });
  await assert.rejects(p.accept({ repo: bare, ref: o2.ref, headSha: h2 }), (e) => e.reason === 'conflict');
  const red = localProposals({ checks: async () => false });
  const h3 = branch(bare, root, 'web/3-c', 'c.txt', 'c\n');
  const o3 = await red.open({ repo: bare, branch: 'web/3-c', base: 'main', title: 'c' });
  await assert.rejects(red.accept({ repo: bare, ref: o3.ref, headSha: h3 }), (e) => e.reason === 'checks');
});

test('GitHub proposals: an app JWT, an installation token, the pull request found or opened, and the merge pinned to the head', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const jwt = appJwt(123, privateKey, Date.parse('2026-11-06T00:00:00Z'));
  const [h, b, sig] = jwt.split('.');
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(sig, 'base64url')), 'signed with the app key');
  const claims = JSON.parse(Buffer.from(b, 'base64url'));
  assert.equal(claims.iss, '123');
  assert.ok(claims.exp - claims.iat <= 600, 'GitHub takes at most 10 minutes');

  const H = 'a'.repeat(40);
  const calls = [];
  let merge = { status: 200, body: { merged: true, sha: 'b'.repeat(40) } };
  let existing = [], del = 204;
  const fetch = async (url, init = {}) => {
    const path = url.replace('https://api.github.com', '');
    calls.push({ method: init.method ?? 'GET', path, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : undefined });
    const json = (status, body) => ({ status, json: async () => body });
    if (path === '/repos/acme/shop/installation') return json(200, { id: 77 });
    if (path === '/app/installations/77/access_tokens') return json(201, { token: 'ghs_installation', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    if (path.startsWith('/repos/acme/shop/pulls?')) return json(200, existing);
    if (path === '/repos/acme/shop/pulls') return json(201, { number: 9, html_url: 'https://github.com/acme/shop/pull/9', head: { sha: H } });
    if (path === '/repos/acme/shop/pulls/9/merge') return json(merge.status, merge.body);
    if (path === '/repos/acme/shop/git/refs/heads/web/9-x' && init.method === 'DELETE') return json(del, {});
    return json(404, { message: 'not found' });
  };
  const g = githubProposals({ appId: 123, privateKey, fetch });
  const o = await g.open({ installations: [77], repo: 'https://github.com/acme/shop.git', branch: 'web/9-x', base: 'main', title: 't' });
  assert.deepEqual([o.ref, o.url, o.existed], [9, 'https://github.com/acme/shop/pull/9', false]);
  assert.match(calls[0].auth, /^Bearer ey/, 'the installation is looked up with the app JWT');
  assert.deepEqual(calls[1].body, { repositories: ['shop'], permissions: { contents: 'write', pull_requests: 'write' } }, 'the token is scoped to the one repository and two permissions');
  assert.equal(calls.at(-1).auth, 'Bearer ghs_installation');
  assert.equal(calls.at(-1).body.maintainer_can_modify, false);
  existing = [{ number: 9, html_url: 'https://github.com/acme/shop/pull/9', head: { sha: H } }];
  assert.equal((await g.open({ installations: [77], repo: 'git@github.com:acme/shop.git', branch: 'web/9-x', base: 'main', title: 't' })).existed, true);
  assert.equal(calls.filter((c) => c.path.endsWith('/access_tokens')).length, 1, 'the token is reused until it nears expiry');
  const secrets = g.secrets();
  assert.ok(secrets.includes('ghs_installation'), 'the installation token is a secret value for the scans');
  assert.ok(secrets.some((l) => privateKey.includes(l) && l.length >= 40), 'so are the key\'s lines');

  assert.deepEqual(await g.accept({ installations: [77], repo: 'https://github.com/acme/shop', ref: 9, headSha: H }), { result: 'b'.repeat(40), deleted: false }, 'no branch named: nothing deleted');
  assert.deepEqual(calls.at(-1).body, { sha: H, merge_method: 'squash' }, 'GitHub refuses the merge if the head is not this sha');
  assert.deepEqual(await g.accept({ installations: [77], repo: 'https://github.com/acme/shop', ref: 9, branch: 'web/9-x', headSha: H }), { result: 'b'.repeat(40), deleted: true });
  assert.equal(calls.at(-1).method, 'DELETE', 'the merged branch is deleted after the merge');
  del = 422; // already deleted by the repository's own setting
  assert.equal((await g.accept({ installations: [77], repo: 'https://github.com/acme/shop', ref: 9, branch: 'web/9-x', headSha: H })).deleted, true);
  del = 403; // a ruleset protects it: the session must stay on the branch
  assert.equal((await g.accept({ installations: [77], repo: 'https://github.com/acme/shop', ref: 9, branch: 'web/9-x', headSha: H })).deleted, false);
  for (const [status, message, reason] of [[409, 'Head branch was modified. Review and try the merge again.', 'head-moved'], [405, 'Merge conflict', 'conflict'], [405, 'Required status check "test" is expected.', 'checks']]) {
    merge = { status, body: { message } };
    await assert.rejects(g.accept({ installations: [77], repo: 'https://github.com/acme/shop', ref: 9, headSha: H }), (e) => e.reason === reason, message);
  }
  await assert.rejects(g.accept({ installations: [77], repo: 'https://github.com/acme/shop', ref: 9, headSha: 'abc1234' }), (e) => e.reason === 'head-moved');
  await assert.rejects(g.open({ installations: [77], repo: '/srv/git/shop.git', branch: 'x', base: 'main', title: 't' }), /not a GitHub repository/);
  assert.throws(() => githubProposals({ appId: '', privateKey }), /app id/);
});

test('GitHub previews: the newest successful https deployment of the commit, read with a deployments-only token', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const S = 'c'.repeat(40);
  const calls = [];
  let grant = 201;
  const vercel = { login: 'vercel[bot]', type: 'Bot' };
  const statuses = {
    9: [{ state: 'success', environment_url: 'https://login-acme.example.com', creator: { login: 'github-actions[bot]', type: 'Bot' } }],
    8: [{ state: 'success', environment_url: 'https://phish.example.com', creator: { login: 'vercel[bot]', type: 'User' } }],
    7: [{ state: 'failure', environment_url: 'https://broken.example.app', creator: vercel }],
    6: [{ state: 'success', environment_url: 'https://user:pw@shop.example.app', creator: vercel }],
    5: [{ state: 'success', environment_url: 'https://shop-abc.vercel.app', creator: vercel }],
  };
  const fetch = async (url, init = {}) => {
    const path = url.replace('https://api.github.com', '');
    calls.push({ path, body: init.body ? JSON.parse(init.body) : undefined });
    const json = (status, body) => ({ status, json: async () => body });
    if (path === '/repos/acme/shop/installation') return json(200, { id: 77 });
    if (path === '/app/installations/77/access_tokens') return grant === 201 ? json(201, { token: 'ghs_read', expires_at: new Date(Date.now() + 3600_000).toISOString() }) : json(grant, { message: 'The permissions requested are not granted to this installation.' });
    if (path === `/repos/acme/shop/deployments?sha=${S}&per_page=10`) return json(200, [9, 8, 7, 6, 5].map((id) => ({ id, environment: 'Preview' })));
    const m = /^\/repos\/acme\/shop\/deployments\/(\d+)\/statuses\?per_page=1$/.exec(path);
    if (m) return json(200, statuses[m[1]] ?? []);
    return json(404, {});
  };
  const g = githubProposals({ appId: 1, privateKey, fetch });
  assert.deepEqual(await g.preview({ installations: [77], repo: 'https://github.com/acme/shop', sha: S }), { deployment: 5, environment: 'Preview', url: 'https://shop-abc.vercel.app/' }, 'a status from Actions, from a user named like a bot, a failed one and a link with a password are passed over');
  // Configured: github-actions[bot] is never trusted, even when listed; a host allowlist narrows it further.
  const actions = githubProposals({ appId: 1, privateKey, fetch, previewCreators: ['github-actions[bot]'] });
  assert.equal(await actions.preview({ installations: [77], repo: 'https://github.com/acme/shop', sha: S }), null);
  const other = githubProposals({ appId: 1, privateKey, fetch, previewHosts: ['netlify.app'] });
  assert.equal(await other.preview({ installations: [77], repo: 'https://github.com/acme/shop', sha: S }), null, 'a vercel.app link is not on a netlify.app allowlist');
  const ok = githubProposals({ appId: 1, privateKey, fetch, previewHosts: ['vercel.app'] });
  assert.equal((await ok.preview({ installations: [77], repo: 'https://github.com/acme/shop', sha: S }))?.deployment, 5);
  assert.deepEqual(calls.find((c) => c.body)?.body, { repositories: ['shop'], permissions: { deployments: 'read' } }, 'the preview token reads deployments and nothing else');
  assert.equal(await g.preview({ installations: [77], repo: 'https://github.com/acme/shop', sha: 'abc' }), null, 'only a full commit');
  const g2 = githubProposals({ appId: 1, privateKey, fetch });
  grant = 422;
  assert.equal(await g2.preview({ installations: [77], repo: 'https://github.com/acme/shop', sha: S }), null, 'an app without Deployments read: no link, no error');
});

test('#28 installation binding: only an installation bound to the tenant, looked up fresh for every write, never another', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const H = 'a'.repeat(40), S = 'c'.repeat(40);
  let installation = 77, now = Date.parse('2026-11-06T09:00:00Z');
  const calls = [];
  const fetch = async (url, init = {}) => {
    const path = url.replace('https://api.github.com', '');
    calls.push(path);
    const json = (status, body) => ({ status, json: async () => body });
    if (path === '/repos/acme/shop/installation') return installation ? json(200, { id: installation }) : json(404, { message: 'Not Found' });
    const t = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (t) return json(201, { token: `ghs_${t[1]}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    if (path.startsWith('/repos/acme/shop/pulls?')) return json(200, []);
    if (path === '/repos/acme/shop/pulls') return json(201, { number: 9, html_url: 'https://github.com/acme/shop/pull/9', head: { sha: H } });
    if (path === '/repos/acme/shop/pulls/9') return json(200, { head: { sha: H } });
    if (path === '/repos/acme/shop/pulls/9/merge') return json(200, { merged: true, sha: 'b'.repeat(40) });
    if (path.startsWith(`/repos/acme/shop/deployments?sha=${S}`)) return json(200, []);
    return json(404, {});
  };
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const g = githubProposals({ appId: 1, privateKey, fetch });
    const repo = 'https://github.com/acme/shop';
    const lookups = () => calls.filter((c) => c === '/repos/acme/shop/installation').length;
    const installation_ = (e) => e.reason === 'installation';
    // No binding at all (the server sent none): every call is refused before any token is taken.
    for (const installations of [undefined, [], ['77'], [0]]) {
      await assert.rejects(g.open({ repo, installations, branch: 'web/9', base: 'main', title: 't' }), installation_);
      await assert.rejects(g.bound({ repo, installations }), installation_);
      await assert.rejects(g.preview({ repo, installations, sha: S }), installation_);
    }
    assert.equal(calls.filter((c) => c.endsWith('/access_tokens')).length, 0, 'no token is minted without a binding');
    // Bound: it works, and the token is for that installation only.
    assert.equal(await g.bound({ repo, installations: [77] }), 77);
    assert.equal((await g.open({ repo, installations: [5, 77], branch: 'web/9', base: 'main', title: 't' })).ref, 9);
    assert.ok(calls.includes('/app/installations/77/access_tokens'));
    // Writes look the installation up every time; reads may use one up to five minutes old.
    let n = lookups();
    await g.accept({ repo, installations: [77], ref: 9, headSha: H });
    await g.bound({ repo, installations: [77] });
    assert.equal(lookups(), n + 2, 'every write and every push check is a fresh lookup');
    n = lookups();
    await g.head({ repo, installations: [77], ref: 9 });
    await g.preview({ repo, installations: [77], sha: S });
    assert.equal(lookups(), n, 'reads within five minutes reuse the lookup');
    // The repository moves to another installation (reinstalled under another account, or transferred).
    installation = 99;
    await assert.rejects(g.accept({ repo, installations: [77], ref: 9, headSha: H }), (e) => installation_(e) && /99/.test(e.message) && /no other installation/.test(e.message), 'a merge is refused at once');
    await assert.rejects(g.bound({ repo, installations: [77] }), installation_, 'so is a push');
    assert.ok(!calls.includes('/app/installations/99/access_tokens'), 'and no token is ever taken for the other installation');
    now += 5 * 60_000 + 1;
    await assert.rejects(g.preview({ repo, installations: [77], sha: S }), installation_, 'a read sees it after at most five minutes');
    // Uninstalled: refused too, with the same reason.
    installation = 0;
    await assert.rejects(g.bound({ repo, installations: [77] }), (e) => installation_(e) && /not installed/.test(e.message));
    // A repository that is not on GitHub has no installation to check.
    assert.equal(await g.bound({ repo: '/srv/git/shop.git', installations: [] }), null);
  } finally { Date.now = realNow; }
});

test('the runner opens the pull request after the first checkpoint, and merges it pinned to the approved head only on approval', async () => {
  const { bare, root } = origin();
  let moveHead = false, movedTo = null;
  const cp = await fakeControlPlane({
    decide: (req) => {
      // The branch moves after the person saw it: the merge must not land.
      if (moveHead) { moveHead = false; movedTo = branch(bare, root, 'web/5-form', 'form.txt', 'changed after approval\n'); }
      return { decision: 'approved', by: 'owner', headSha: req.headSha };
    },
  });
  const results = [];
  let rounds = 0;
  const adapter = stubAdapter({
    'web-dev': async (t) => {
      writeFileSync(join(t.cwd, 'form.txt'), `form ${++rounds}\n`); // each round changes something
      const own = await t.use('Bash', { command: `gh pr merge 1 --squash --match-head-commit ${'a'.repeat(40)}` });
      assert.match(own.refused ?? '', /runner merges this branch's pull request/, 'the session never merges itself');
      const r = await t.call('request_approval', { action: 'accept', call: 'merge the login form', why: 'qa-web signed off' });
      results.push(r); if (process.env.DBG) console.error('RESULT', r.text);
      return {};
    },
  });
  const runner = startRunner({ server: cp.url, key: cp.key, root, adapter, proposals: localProposals(), previewDelays: Array(40).fill(50), log: (m) => process.env.DBG && console.error('LOG', m) });
  try {
    await runner.ready;
    const f = cp.start({ role: 'web-dev', run: 'run_5', repo: { url: bare }, worktree: 'web/5-form', areas: ['form.txt'] });
    // Events travel on their own; wait for them, not only for the tool result.
    await cp.until(() => results.length === 1 && cp.events.some((e) => e.type === 'proposal.accepted'));
    const opened = cp.events.find((e) => e.type === 'proposal.opened');
    assert.ok(opened, 'proposal.opened after the first push');
    assert.deepEqual([opened.data.connector, opened.data.ref, opened.data.branch], ['local', 1, 'web/5-form']);
    const head = opened.data.headSha;
    assert.match(head, /^[0-9a-f]{40}$/);
    assert.throws(() => sh(bare, 'rev-parse', '--verify', '--quiet', 'refs/heads/web/5-form'), 'the merged branch is deleted, as delete-branch-on-merge');
    // The approval names the pull request and the pushed head; the session never named either.
    const asked = cp.approvals.at(-1).input;
    assert.deepEqual([asked.pr, asked.headSha], [1, head]);
    const accepted = cp.events.find((e) => e.type === 'proposal.accepted');
    assert.deepEqual([accepted.data.ref, accepted.data.headSha, accepted.data.approval], [1, head, cp.approvals.at(-1).approval]);
    assert.equal(accepted.data.result, sh(bare, 'rev-parse', 'main'));
    assert.equal(sh(bare, 'show', 'main:form.txt'), 'form 1');
    assert.ok(!results[0].isError, results[0].text);
    // G-12: the host deploys the merge commit; the runner reads the link from the deployment, and sends it once.
    writeFileSync(join(bare, 'agent-team-deployments.json'), JSON.stringify([
      { id: 40, sha: accepted.data.result, environment: 'Preview', state: 'pending', url: 'https://shop-pending.example.app' },
      { id: 41, sha: accepted.data.result, environment: 'Preview', state: 'success', url: 'http://shop-plain.example.app' },
      { id: 42, sha: accepted.data.result, environment: 'Preview', state: 'success', url: 'https://shop-git-web-5-form.example.app/' },
    ]));
    await cp.until(() => cp.events.some((e) => e.type === 'proposal.previewed'));
    const pv = cp.events.filter((e) => e.type === 'proposal.previewed');
    assert.equal(pv.length, 1);
    assert.deepEqual(pv[0].data, { connector: 'local', ref: 1, sha: accepted.data.result, url: 'https://shop-git-web-5-form.example.app/', environment: 'Preview', state: 'success', deployment: 42 }, 'only a successful https deployment of the merge commit');
    assert.equal(pv[0].actor?.session, f.body.session);

    // A second round on a new branch, whose head moves between the approval and the merge.
    moveHead = true;
    cp.send('session.stop', { session: f.body.session, mode: 'finish-step', reason: 'owner' });
    await cp.until(() => cp.events.some((e) => e.type === 'session.ended'));
    const g = cp.start({ role: 'web-dev', run: 'run_5', repo: { url: bare }, worktree: 'web/5-form', areas: ['form.txt'] });
    await cp.until(() => results.length === 2 && cp.events.filter((e) => e.type === 'proposal.accepted').length === 2);
    const failed = cp.events.find((e) => e.type === 'proposal.failed');
    assert.equal(failed.data.reason, 'head-moved');
    const round2 = cp.approvals.slice(1);
    assert.equal(round2.length, 2, 'one new card for the new head, asked by the runner (the server only supersedes)');
    assert.equal(failed.data.approval, round2[0].approval);
    assert.equal(failed.data.headSha, round2[0].input.headSha, 'what failed is the head that was approved');
    assert.equal(round2[1].input.headSha, movedTo, 'the new card names the head that is there now');
    assert.match(round2[1].input.why, /asked again: the pull request's head moved/);
    const merged = cp.events.filter((e) => e.type === 'proposal.accepted').at(-1);
    assert.deepEqual([merged.data.headSha, merged.data.approval], [movedTo, round2[1].approval], 'only the head the person saw last is merged');
    assert.equal(sh(bare, 'show', 'main:form.txt'), 'changed after approval');
    assert.ok(!results[1].isError, results[1].text);
    for (const e of cp.events) assert.deepEqual(checkEvent(e), [], JSON.stringify(e));
    noFailedTurns(cp);
    cp.send('session.stop', { session: g.body.session, mode: 'finish-step', reason: 'owner' });
  } finally {
    await runner.close();
    await cp.close();
  }
});

test('#28 installation binding in a session: no push, proposal or merge for a repository whose installation is not the tenant\'s, and it is audited', async () => {
  const { bare, root } = origin();
  const cp = await fakeControlPlane({ decide: (req) => ({ decision: 'approved', by: 'owner', headSha: req.headSha }) });
  const results = [];
  const adapter = stubAdapter({
    'web-dev': async (t) => {
      writeFileSync(join(t.cwd, 'form.txt'), 'form\n');
      results.push(await t.call('request_approval', { action: 'accept', call: 'merge the form', why: 'done' }));
      return {};
    },
  });
  // The local connector with GitHub's binding check in front: installation 7 is the repository's.
  const checked = [];
  let outage = true;
  const proposals = { ...localProposals(), async bound({ installations }) {
    checked.push(installations);
    if (outage) throw new Error('the installation of acme/shop could not be read (502)');
    if (!installations?.includes(7)) throw new ProposalError('installation', 'acme/shop is under GitHub App installation 7, which is not bound to this team\'s tenant');
    return 7;
  } };
  const runner = startRunner({ server: cp.url, key: cp.key, root, adapter, proposals, previewDelays: [], log: () => {} });
  try {
    await runner.ready;
    // GitHub's API is down: nothing is pushed (fail closed), but the work is still committed in the copy.
    const o = cp.start({ role: 'web-dev', run: 'run_7', repo: { url: bare, installations: [7] }, worktree: 'web/7-out', areas: ['form.txt'] });
    await cp.until(() => results.length === 1);
    assert.ok(results[0].isError);
    assert.match(results[0].text, /could not be pushed.*502/);
    cp.send('session.stop', { session: o.body.session, mode: 'finish-step', reason: 'owner' });
    await cp.until(() => cp.events.some((e) => e.type === 'session.ended'));
    const out = cp.events.find((e) => e.type === 'session.ended').data;
    const copy = cp.events.find((e) => e.type === 'session.started').data.worktree;
    assert.equal(out.pushed, false);
    assert.match(out.commit ?? '', /^[0-9a-f]{40}$/, 'the work is committed even though the push was refused');
    assert.equal(sh(copy, 'show', `${out.commit}:form.txt`), 'form');
    assert.throws(() => sh(bare, 'rev-parse', '--verify', '--quiet', 'refs/heads/web/7-out'), 'and nothing was pushed');
    assert.ok(!cp.events.some((e) => e.type === 'proposal.failed'), 'an outage is not an installation refusal');
    outage = false;
    results.length = 0; cp.events.length = 0;
    const a = cp.start({ role: 'web-dev', run: 'run_7', repo: { url: bare, installations: [8] }, worktree: 'web/7-form', areas: ['form.txt'] });
    await cp.until(() => results.length === 1 && cp.events.some((e) => e.type === 'proposal.failed'));
    assert.ok(results[0].isError);
    assert.match(results[0].text, /could not be pushed/);
    const failed = cp.events.find((e) => e.type === 'proposal.failed');
    assert.deepEqual([failed.data.reason, failed.data.phase, failed.data.branch], ['installation', 'push', 'web/7-form']);
    assert.match(failed.data.detail, /not bound/);
    assert.throws(() => sh(bare, 'rev-parse', '--verify', '--quiet', 'refs/heads/web/7-form'), 'nothing was pushed');
    assert.equal(cp.approvals.length, 0, 'and no card was asked');
    cp.send('session.stop', { session: a.body.session, mode: 'finish-step', reason: 'owner' });
    await cp.until(() => cp.events.some((e) => e.type === 'session.ended'));
    // Bound: the same work goes through.
    cp.start({ role: 'web-dev', run: 'run_7', repo: { url: bare, installations: [7] }, worktree: 'web/7-form', areas: ['form.txt'] });
    await cp.until(() => results.length === 2 && cp.events.some((e) => e.type === 'proposal.accepted'));
    assert.ok(!results[1].isError, results[1].text);
    assert.deepEqual(checked.at(-1), [7], 'the check is given the server\'s list for the run');
    for (const e of cp.events) assert.deepEqual(checkEvent(e), [], JSON.stringify(e));
  } finally {
    await runner.close();
    await cp.close();
  }
});

// A head the runner did not push must pass the same checks as a checkpoint before any card names it.
for (const [name, file, text, rule] of [
  ['a path outside the role\'s areas', 'other.txt', 'not yours\n', 'ownership'],
  ['a secret in a commit', 'form.txt', `key = AKIA${'Q'.repeat(16)}\n`, 'secret-scan'],
]) {
  test(`a head moved after approval with ${name} gets no new card, and the run hears why (${rule})`, async () => {
    const { bare, root } = origin();
    let moveHead = true;
    const cp = await fakeControlPlane({
      decide: (req) => {
        if (moveHead) { moveHead = false; branch(bare, root, 'web/6-form', file, text); }
        return { decision: 'approved', by: 'owner', headSha: req.headSha };
      },
    });
    const results = [];
    const adapter = stubAdapter({
      'web-dev': async (t) => {
        writeFileSync(join(t.cwd, 'form.txt'), 'form\n');
        results.push(await t.call('request_approval', { action: 'accept', call: 'merge the form', why: 'qa-web signed off' }));
        return {};
      },
    });
    const runner = startRunner({ server: cp.url, key: cp.key, root, adapter, proposals: localProposals() });
    try {
      await runner.ready;
      const mainBefore = sh(bare, 'rev-parse', 'main');
      cp.start({ role: 'web-dev', run: 'run_6', repo: { url: bare }, worktree: 'web/6-form', areas: ['form.txt'] });
      await cp.until(() => results.length === 1 && cp.events.filter((e) => e.type === 'proposal.failed').length === 2);
      assert.equal(cp.approvals.length, 1, 'no second card for a head that failed the checks');
      const [moved, refused] = cp.events.filter((e) => e.type === 'proposal.failed');
      assert.equal(moved.data.reason, 'head-moved');
      assert.equal(refused.data.reason, 'checks');
      assert.match(refused.data.detail, new RegExp(rule === 'ownership' ? 'outside this role' : 'hold a secret'));
      assert.equal(refused.data.headSha, sh(bare, 'rev-parse', 'web/6-form'), 'the failure names the head that was checked');
      assert.ok(results[0].isError);
      assert.match(results[0].text, new RegExp(`"rule":"${rule}"`));
      assert.equal(sh(bare, 'rev-parse', 'main'), mainBefore, 'nothing merged');
      for (const e of cp.events) assert.deepEqual(checkEvent(e), [], JSON.stringify(e));
      noFailedTurns(cp);
    } finally {
      await runner.close();
      await cp.close();
    }
  });
}
