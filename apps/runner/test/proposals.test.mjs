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
  let existing = [];
  const fetch = async (url, init = {}) => {
    const path = url.replace('https://api.github.com', '');
    calls.push({ method: init.method ?? 'GET', path, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : undefined });
    const json = (status, body) => ({ status, json: async () => body });
    if (path === '/repos/acme/shop/installation') return json(200, { id: 77 });
    if (path === '/app/installations/77/access_tokens') return json(201, { token: 'ghs_installation', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    if (path.startsWith('/repos/acme/shop/pulls?')) return json(200, existing);
    if (path === '/repos/acme/shop/pulls') return json(201, { number: 9, html_url: 'https://github.com/acme/shop/pull/9', head: { sha: H } });
    if (path === '/repos/acme/shop/pulls/9/merge') return json(merge.status, merge.body);
    return json(404, { message: 'not found' });
  };
  const g = githubProposals({ appId: 123, privateKey, fetch });
  const o = await g.open({ repo: 'https://github.com/acme/shop.git', branch: 'web/9-x', base: 'main', title: 't' });
  assert.deepEqual([o.ref, o.url, o.existed], [9, 'https://github.com/acme/shop/pull/9', false]);
  assert.match(calls[0].auth, /^Bearer ey/, 'the installation is looked up with the app JWT');
  assert.deepEqual(calls[1].body, { repositories: ['shop'], permissions: { contents: 'write', pull_requests: 'write' } }, 'the token is scoped to the one repository and two permissions');
  assert.equal(calls.at(-1).auth, 'Bearer ghs_installation');
  assert.equal(calls.at(-1).body.maintainer_can_modify, false);
  existing = [{ number: 9, html_url: 'https://github.com/acme/shop/pull/9', head: { sha: H } }];
  assert.equal((await g.open({ repo: 'git@github.com:acme/shop.git', branch: 'web/9-x', base: 'main', title: 't' })).existed, true);
  assert.equal(calls.filter((c) => c.path.endsWith('/access_tokens')).length, 1, 'the token is reused until it nears expiry');
  const secrets = g.secrets();
  assert.ok(secrets.includes('ghs_installation'), 'the installation token is a secret value for the scans');
  assert.ok(secrets.some((l) => privateKey.includes(l) && l.length >= 40), 'so are the key\'s lines');

  assert.deepEqual(await g.accept({ repo: 'https://github.com/acme/shop', ref: 9, headSha: H }), { result: 'b'.repeat(40) });
  assert.deepEqual(calls.at(-1).body, { sha: H, merge_method: 'squash' }, 'GitHub refuses the merge if the head is not this sha');
  for (const [status, message, reason] of [[409, 'Head branch was modified. Review and try the merge again.', 'head-moved'], [405, 'Merge conflict', 'conflict'], [405, 'Required status check "test" is expected.', 'checks']]) {
    merge = { status, body: { message } };
    await assert.rejects(g.accept({ repo: 'https://github.com/acme/shop', ref: 9, headSha: H }), (e) => e.reason === reason, message);
  }
  await assert.rejects(g.accept({ repo: 'https://github.com/acme/shop', ref: 9, headSha: 'abc1234' }), (e) => e.reason === 'head-moved');
  await assert.rejects(g.open({ repo: '/srv/git/shop.git', branch: 'x', base: 'main', title: 't' }), /not a GitHub repository/);
  assert.throws(() => githubProposals({ appId: '', privateKey }), /app id/);
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
  const runner = startRunner({ server: cp.url, key: cp.key, root, adapter, proposals: localProposals(), log: (m) => process.env.DBG && console.error('LOG', m) });
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
