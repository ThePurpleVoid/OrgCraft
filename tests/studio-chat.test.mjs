// The Studio's chief-of-staff chat, server side: it proxies the control plane so the token never reaches the page,
// keeps the owner's words verbatim, sends card versions, and passes a stale card's 409 back with the current card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
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

async function serve(env, fn) {
  const server = createStudio({ root: repo(), env });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body) => {
    const cookie = `studio_session=${server.launchToken}`;
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
      assert.equal((await call('/v1/team/run/resume', { key: 'r1' })).status, 200);
      assert.equal((await call('/v1/team/run/stop', { key: 's1' })).status, 200);
      assert.equal((await call('/v1/team/run')).body.run, null);
      assert.equal((await call('/v1/team/run/pause', { key: 'p2' })).status, 409);
    });
  } finally { cp.close(); }
});
