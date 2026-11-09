// The Studio's chief-of-staff chat, server side: it proxies the control plane so the token never reaches the page,
// keeps the owner's words verbatim, sends card versions, and passes a stale card's 409 back with the current card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT } from '../bin/agent-team.mjs';
import { createStudio } from '../apps/studio/server.mjs';
import { fakeControlPlane } from './fixtures/fake-control-plane.mjs';

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'studio-chat-'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--project', 'Chat', '--dir', root], { stdio: 'ignore' });
  return root;
}

const signIn = async (base, server) => (await fetch(`${base}/?t=${server.launchToken}`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];

async function serve(env, fn) {
  const server = createStudio({ root: repo(), env });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = await signIn(base, server);
  const call = async (path, body) => {
    const res = await fetch(base + path, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try { await fn(call, base); } finally { server.closeAllConnections?.(); server.close(); }
}

const until = async (fn) => { for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timed out'); };

test('without a control plane the chat says so and sends nothing', async () => {
  await serve({}, async (call) => {
    assert.deepEqual((await call('/v1/team/chat')).body, { connected: false, items: [] });
    assert.equal((await call('/v1/team/run')).body.connected, false);
    const r = await call('/v1/team/chat', { text: 'hello' });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /AGENT_TEAM_SERVER/);
  });
});

test('a chat round trip: verbatim text, a client id sent once, the reply and cards', async () => {
  const cp = await fakeControlPlane();
  try {
    await serve(cp.env, async (call) => {
      const text = '  Add a dark mode toggle.\n\n  Keep my *exact* words <b>please</b>  ';
      const sent = await call('/v1/team/chat', { text, clientId: 'c-1' });
      assert.equal(sent.status, 200);
      assert.equal(sent.body.data.text, text, 'stored verbatim, untrimmed');
      const again = await call('/v1/team/chat', { text, clientId: 'c-1' });
      assert.equal(again.body.id, sent.body.id, 'a retried message lands once');
      const page = await until(async () => { const r = (await call('/v1/team/chat')).body; return Object.keys(r.cards ?? {}).length === 2 && r; });
      assert.equal(page.connected, true);
      assert.equal(page.team, 'demo');
      assert.deepEqual(page.items.map((e) => e.type), ['chat.message', 'chat.message', 'card.updated', 'decision.requested', 'card.updated', 'approval.requested']);
      assert.equal(page.items.filter((e) => e.data.clientId === 'c-1').length, 1);
      assert.equal(page.run.state, 'running');
      assert.equal(page.cost.today, 655, 'usage counts into today');
      assert.ok(page.asOf);
      assert.equal(JSON.stringify(page).includes(cp.token), false, 'the token never reaches the page');
      assert.equal((await call('/v1/team/chat', { text: '   ' })).status, 400);
    });
  } finally { cp.close(); }
});

test('answers carry the card version; a stale one comes back as 409 with the current card', async () => {
  const cp = await fakeControlPlane();
  try {
    await serve(cp.env, async (call) => {
      await call('/v1/team/chat', { text: 'go', clientId: 'c-2' });
      await until(() => cp.cards.size === 2);
      const [decision, approval] = [...cp.cards.values()];
      cp.bump(decision.id, { title: 'What should the default be now?' });
      const stale = await call(`/v1/team/cards/${decision.id}`, { kind: 'decision', subject: decision.subject, option: 'light', version: 1, key: 'k1' });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.card.version, 2);
      assert.equal(stale.body.card.title, 'What should the default be now?');
      const ok = await call(`/v1/team/cards/${decision.id}`, { kind: 'decision', subject: decision.subject, option: 'light', version: 2, key: 'k2' });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.type, 'decision.answered');
      const ask = await call(`/v1/team/cards/${approval.id}`, { kind: 'approval', subject: approval.subject, option: 'approve', version: 1, key: 'k3' });
      assert.equal(ask.status, 401);
      assert.equal(ask.body.type, 'step-up-required');
      assert.equal((await call('/v1/team/step-up', { secret: 'wrong' })).status, 401);
      const su = await call('/v1/team/step-up', { secret: cp.stepUpSecret });
      assert.equal(su.status, 200);
      assert.equal(JSON.stringify(su.body).includes('su_'), false, 'the step-up token stays on the Studio server');
      const appr = await call(`/v1/team/cards/${approval.id}`, { kind: 'approval', subject: approval.subject, option: 'approve', version: 1, key: 'k4' });
      assert.equal(appr.body.type, 'approval.decided');
      // One step-up, one answer: the next approval asks again.
      cp.card({ id: 'card_second', kind: 'approval', subject: 'approval/apr_second', title: 'Raise today\'s cap', options: [{ id: 'approve', label: 'Approve', stepUp: true }, { id: 'deny', label: 'Deny' }] });
      const second = await call('/v1/team/cards/card_second', { kind: 'approval', subject: 'approval/apr_second', option: 'approve', version: 1, key: 'k5' });
      assert.equal(second.status, 401);
      assert.equal(second.body.type, 'step-up-required');
      assert.equal(appr.body.data.decision, 'approved');
      assert.equal(appr.body.subject, approval.subject);
    });
  } finally { cp.close(); }
});

test('run state, today\'s cost against the cap, pause, resume and stop', async () => {
  const cp = await fakeControlPlane();
  try {
    await serve(cp.env, async (call) => {
      const r = (await call('/v1/team/run')).body;
      assert.deepEqual(r.run, { id: 'run_1', state: 'running' });
      assert.equal(r.summary.cost.today, 620);
      assert.equal(r.summary.cost.capPerDay, 5000);
      assert.equal((await call('/v1/team/run/pause', { key: 'p1' })).status, 200);
      assert.equal((await call('/v1/team/run')).body.run.state, 'paused');
      // Resuming needs a step-up bound to this run, whoever paused it (ADR 0013); the answer names the scope.
      const ask = await call('/v1/team/run/resume', { key: 'r1' });
      assert.deepEqual([ask.status, ask.body.type, ask.body.scope], [401, 'step-up-required', 'resume:run_1']);
      assert.equal((await call('/v1/team/step-up', { secret: cp.stepUpSecret })).status, 200);
      assert.equal((await call('/v1/team/run/resume', { key: 'r1b' })).status, 401, 'a step-up not bound to this run does not resume it');
      assert.equal((await call('/v1/team/step-up', { secret: cp.stepUpSecret, scope: ask.body.scope })).status, 200);
      assert.equal((await call('/v1/team/run/resume', { key: 'r1c' })).status, 200);
      assert.equal((await call('/v1/team/run/stop', { key: 's1' })).status, 200);
      assert.equal((await call('/v1/team/run')).body.run, null);
      assert.equal((await call('/v1/team/run/pause', { key: 'p2' })).status, 409);
    });
  } finally { cp.close(); }
});

// Start a run: the team as published (the last commit), a daily cap first, one run per team.
const commit = (root, m = 'team') => { execFileSync('git', ['-C', root, 'add', '-A']); execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', m]); };
/** A team published and pushed: origin is a bare repository, then its URL is set to one with credentials in it. */
function published() {
  const root = repo();
  const bare = mkdtempSync(join(tmpdir(), 'studio-origin-'));
  execFileSync('git', ['init', '-q', '--bare', bare]);
  commit(root);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', bare]);
  execFileSync('git', ['-C', root, 'push', '-q', '-u', 'origin', 'HEAD:refs/heads/main']);
  execFileSync('git', ['-C', root, 'branch', '-q', '--set-upstream-to=origin/main']);
  execFileSync('git', ['-C', root, 'remote', 'set-url', 'origin', 'https://someone:ghp_secret@example.com/acme/shop.git']);
  return root;
}

async function serveAt(root, env, fn) {
  const server = createStudio({ root, env });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = await signIn(base, server);
  const call = async (path, body) => {
    const res = await fetch(base + path, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try { await fn(call); } finally { server.closeAllConnections?.(); server.close(); }
}

test('start a run: the published roster, a daily cap first, step-up to raise it, one run at a time', async () => {
  const cp = await fakeControlPlane({ running: false, perDay: null });
  const root = published();
  try {
    await serveAt(root, cp.env, async (call) => {
      const plan = (await call('/v1/team/run/plan')).body;
      assert.equal(plan.ok, true);
      assert.equal(plan.frontDoor, 'chief-of-staff');
      assert.deepEqual(plan.repo, { url: 'https://example.com/acme/shop.git', ref: 'main' }, 'no credentials in the repo URL; the upstream branch');
      assert.equal((await call('/v1/team/budget')).body.perDay, null);
      // No daily cap: the control plane refuses, and the Studio passes its words on.
      const refused = await call('/v1/team/run/start', { key: 's0' });
      assert.equal(refused.status, 409);
      assert.match(refused.body.error, /daily cap/);
      // Setting the first cap raises it from "no run may start", so it needs step-up.
      const ask = await call('/v1/team/budget', { perDay: 2000, key: 'b1' });
      assert.equal(ask.status, 401);
      assert.equal(ask.body.type, 'step-up-required');
      assert.equal((await call('/v1/team/step-up', { secret: cp.stepUpSecret })).status, 200);
      const set = await call('/v1/team/budget', { perDay: 2000, key: 'b2' });
      assert.equal(set.status, 200);
      assert.equal(set.body.perDay, 2000);
      // Lowering never needs it.
      assert.equal((await call('/v1/team/budget', { perDay: 1500, key: 'b3' })).status, 200);
      assert.equal((await call('/v1/team/budget', { perDay: 12.5 })).status, 400, 'whole cents only');
      const ok = await call('/v1/team/run/start', { key: 's1' });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.state, 'running');
      const sent = cp.started[0];
      const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      assert.equal(sent.mode, 'runner');
      assert.equal(sent.team.version, head, 'the run is frozen on the published commit');
      assert.deepEqual(sent.team.repo, { url: 'https://example.com/acme/shop.git', ref: 'main' });
      assert.equal(typeof sent.team.summary, 'string');
      assert.ok(sent.team.summary.length <= 2000);
      assert.equal(sent.team.roles.filter((r) => r.reportsTo === 'owner').length, 1);
      for (const r of sent.team.roles) {
        assert.match(r.slug, /^[a-z0-9-]+$/);
        assert.ok(Array.isArray(r.areas));
        assert.match(r.brief, /^# /, `${r.slug} carries its brief`);
        assert.ok(Buffer.byteLength(r.brief) <= 20_000);
      }
      assert.equal(JSON.stringify(sent).includes('ghp_secret'), false);
      // One run per team: a second start is the control plane's 409, shown as it said it.
      const twice = await call('/v1/team/run/start', { key: 's2' });
      assert.equal(twice.status, 409);
      assert.match(twice.body.error, /still going/);
    });
  } finally { cp.close(); }
});

test('start a run refuses a team with changes nobody published', async () => {
  const cp = await fakeControlPlane({ running: false });
  const root = published();
  execFileSync('git', ['-C', root, 'rm', '-q', '--cached', '-r', '.agent-team/team.json']);
  try {
    await serveAt(root, cp.env, async (call) => {
      const plan = (await call('/v1/team/run/plan')).body;
      assert.equal(plan.ok, false);
      assert.match(plan.error, /publish first/);
      const r = await call('/v1/team/run/start', { key: 'x' });
      assert.equal(r.status, 409);
      assert.equal(r.body.type, 'not-published');
      assert.equal(cp.started.length, 0, 'nothing reached the control plane');
    });
  } finally { cp.close(); }
});

test('resuming a run today\'s cap paused needs step-up, and is refused while the cap is spent', async () => {
  const cp = await fakeControlPlane();
  try {
    await serve(cp.env, async (call) => {
      cp.exhaust();
      const spent = await call('/v1/team/run/resume', { key: 'r1' });
      assert.equal(spent.status, 409);
      assert.match(spent.body.error, /spent/);
      cp.cost.state = 'ok';
      const ask = await call('/v1/team/run/resume', { key: 'r2' });
      assert.equal(ask.status, 401);
      assert.equal(ask.body.type, 'step-up-required');
      await call('/v1/team/step-up', { secret: cp.stepUpSecret, scope: ask.body.scope });
      assert.equal((await call('/v1/team/run/resume', { key: 'r3' })).status, 200);
      assert.equal((await call('/v1/team/run')).body.run.state, 'running');
    });
  } finally { cp.close(); }
});

test('start a run refuses a published commit that is not pushed, or a branch with no upstream', async () => {
  const cp = await fakeControlPlane({ running: false });
  const root = published();
  writeFileSync(join(root, 'docs/team/roles/README.md'), 'changed\n');
  commit(root, 'publish again, not pushed');
  try {
    await serveAt(root, cp.env, async (call) => {
      const plan = (await call('/v1/team/run/plan')).body;
      assert.equal(plan.ok, false);
      assert.match(plan.error, /^push first: 1 published commit is not on origin\/main/);
      const r = await call('/v1/team/run/start', { key: 'np' });
      assert.equal(r.status, 409);
      assert.match(r.body.error, /push first/);
      execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'studio/new-roles']);
      assert.match((await call('/v1/team/run/plan')).body.error, /^push first: branch studio\/new-roles has no upstream/);
      assert.equal(cp.started.length, 0, 'nothing reached the control plane');
    });
  } finally { cp.close(); }
});

test('money uses each currency\'s own minor unit (cents, yen, fils)', async () => {
  const { minorDigits } = await import('../apps/studio/public/chat.js');
  assert.deepEqual(['USD', 'EUR', 'JPY', 'KWD'].map(minorDigits), [2, 2, 0, 3]);
});
