// The runner's resilience before the real M3 exit test, offline: the real control plane, the Studio and the runner
// with the scripted fake model (apps/runner/adapters/dryrun.mjs), against a stand-in remote on disk. No model, no
// key, no GitHub. Each test breaks something on purpose and checks the run comes through without a duplicate push,
// a double spend or a merge nobody approved:
//   - the runner is killed mid-session and started again
//   - the control plane goes away for a while
//   - the run pauses at 100% of the daily budget and resumes when the cap is raised
//   - an approval card expires while the runner is down
//
//   npm ci --prefix apps/server && npm ci --prefix apps/runner && node --test tests/e2e/m3-resilience.e2e.mjs
//   M3_DRY_RUN_RUNNER=docker uses the runner image; M3_DRY_RUN_DEBUG=1 prints the step log and the events.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { KIT } from '../../bin/agent-team.mjs';
import { up, hooks, waitFor } from '../../tools/dry-run/m3.mjs';

const deps = existsSync(join(KIT, 'apps/server/node_modules/@electric-sql/pglite')) && existsSync(join(KIT, 'apps/runner/node_modules/ws'));
if (process.env.CI && !deps) throw new Error('CI is set but npm ci --prefix apps/server and apps/runner were not run');
const skip = !deps && 'run npm ci --prefix apps/server and npm ci --prefix apps/runner first';
const RUNNER = process.env.M3_DRY_RUN_RUNNER ?? 'process';
const IMAGE = process.env.M3_DRY_RUN_IMAGE ?? 'agent-team-runner';

let h, hk, cookie;
const logs = [];

async function studio(method, path, body) {
  const res = await fetch(`${h.studio}${path}`, { method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json', origin: h.studio }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.error ?? JSON.stringify(data)}`);
  return data;
}
const stepUp = () => studio('POST', '/v1/team/step-up', { secret: h.secret });
const cards = async () => {
  const page = await studio('GET', '/v1/team/chat');
  const latest = new Map();
  for (const e of page.items ?? []) if (e.data?.card?.id) { const c = e.data.card; if (!latest.has(c.id) || (latest.get(c.id).version ?? 0) <= (c.version ?? 0)) latest.set(c.id, c); }
  return [...latest.values()];
};
const openApproval = (seen = new Set()) => waitFor(async () => (await cards()).find((c) => c.kind === 'approval' && c.state === 'open' && !seen.has(c.id)), 60_000);
const answer = async (c, option = 'approve') => {
  await stepUp();
  return studio('POST', `/v1/team/cards/${encodeURIComponent(c.id)}`, { kind: c.kind, subject: c.subject, option, version: c.version, key: `e2e-${c.id}-${option}` });
};
const proposal = (pred, ms = 60_000) => waitFor(() => Object.values(hk.proposals()).find(pred), ms);
/** Events the control plane stored, of one type (or a prefix ending in a dot). */
const stored = async (type) => (await h.db.system('select type, actor_id, envelope from events where team = $1 and (type = $2 or ($3 and type like $2 || \'%\')) order by seq', [h.team, type, type.endsWith('.')])).map((r) => r.envelope);
const commits = (branch) => execFileSync('git', ['-C', h.bare, 'rev-list', `main..refs/heads/${branch}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (skip) return;
  h = await up({ port: 0, studioPort: 0, runner: RUNNER, image: IMAGE, log: (l) => logs.push(l) });
  hk = hooks(h.dir);
  const res = await fetch(h.link, { redirect: 'manual' });
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  await stepUp();
  await studio('POST', '/v1/team/budget', { perDay: 500, perRun: 400, key: 'r-cap' });
  await studio('POST', '/v1/team/run/start', { key: 'r-start' });
});
after(async () => {
  if (process.env.M3_DRY_RUN_DEBUG && h) console.log(JSON.stringify({ log: hk.log(), proposals: hk.proposals(), events: await h.events().catch((e) => e.message), logs }, null, 1));
  await h?.down();
});

test('the runner is killed mid-session and started again: the work resumes, with no second push, pull request or spend', { skip, timeout: 240_000 }, async () => {
  await studio('POST', '/v1/team/chat', { text: 'Add a page that says hello to new visitors', clientId: 'r-ask-1' });
  const opened = await proposal((p) => p.state === 'open' && p.branch.startsWith('team/web-dev/'));
  await waitFor(() => hk.log().some((l) => l.step === 'qa:waiting-for-signoff'), 60_000);
  const pushed = commits(opened.branch);
  const usageBefore = (await stored('usage.recorded')).length;

  // A crash: nothing is flushed, the sessions are not stopped.
  await h.stopRunner('SIGKILL');
  await h.startRunner();
  hk.signoff({ evidence: ['qa/dry-run.log'] });
  const decision = await waitFor(async () => (await cards()).find((x) => x.kind === 'decision' && x.state === 'open'), 90_000);
  await studio('POST', `/v1/team/cards/${encodeURIComponent(decision.id)}`, { kind: decision.kind, subject: decision.subject, option: 'new-page', version: decision.version, key: `r-${decision.id}` });
  const c = await openApproval();
  assert.equal(c.data.pr, opened.ref);
  await answer(c);
  const merged = await proposal((p) => p.ref === opened.ref && p.state === 'merged', 90_000);
  assert.equal(merged.mergedHead, pushed[0], 'no second push: what merged is the head pushed before the crash');
  assert.equal(c.data.headSha, pushed[0]);
  assert.equal(Object.values(hk.proposals()).filter((p) => p.branch.startsWith('team/web-dev/')).length, 1, 'one pull request');
  assert.equal(hk.log().filter((l) => l.step === 'builder:changed').length, 1, 'the builder, done before the crash, did not redo its work');
  console.log(JSON.stringify({ usageBefore, usageAfter: (await stored('usage.recorded')).length, merged: merged.ref, log: hk.log().map((l) => l.step) }));
});

test('the control plane goes away, then the runner\'s link is cut: it reconnects, and merges only once it is back', { skip, timeout: 240_000 }, async () => {
  const seen = new Set((await cards()).map((c) => c.id));
  const before = new Set(Object.keys(hk.proposals()));
  await studio('POST', '/v1/team/chat', { text: 'Now say goodbye too', clientId: 'r-ask-2' });
  const opened = await proposal((p) => p.state === 'open' && !before.has(String(p.ref)));
  await waitFor(() => hk.log().filter((l) => l.step === 'qa:waiting-for-signoff').length >= 3, 60_000);

  // The whole control plane is gone for a while (nothing listening), then back: the runner reconnects by itself.
  await h.planeDown();
  await sleep(3000);
  await h.planeUp();
  await waitFor(() => h.connected(), 60_000);
  hk.signoff({ evidence: ['qa/dry-run-2.log'] });
  const c = await openApproval(seen);
  assert.equal(c.data.pr, opened.ref);

  // A partition: the owner approves while the runner cannot reach the control plane. Nothing merges until it can.
  h.cutRunner(true);
  await waitFor(() => !h.connected(), 10_000);
  await answer(c);
  await sleep(4000);
  assert.equal(hk.proposals()[opened.ref].state, 'open', 'not merged while the runner is cut off');
  h.cutRunner(false);
  const merged = await proposal((p) => p.ref === opened.ref && p.state === 'merged', 90_000);
  assert.equal(merged.mergedHead, c.data.headSha, 'merged once it was back, on the approved head');
  // The runner merges on the remote first and reports proposal.accepted after (apps/runner/session.mjs), so the
  // stored event can land after the remote shows merged: wait for it, then check there is exactly one.
  const acceptedFor = async () => (await stored('proposal.accepted')).filter((e) => e.data.ref === opened.ref);
  await waitFor(async () => (await acceptedFor()).length > 0, 60_000);
  assert.equal((await acceptedFor()).length, 1, 'one merge');
});

test('approved, then the run is stopped while the runner is cut off: once back it stops the session and merges nothing', { skip, timeout: 240_000 }, async () => {
  const seen = new Set((await cards()).map((c) => c.id));
  const before = new Set(Object.keys(hk.proposals()));
  const signoffs = hk.log().filter((l) => l.step === 'qa:waiting-for-signoff').length;
  await studio('POST', '/v1/team/chat', { text: 'And a thank-you note', clientId: 'r-ask-3' });
  const opened = await proposal((p) => p.state === 'open' && !before.has(String(p.ref)));
  await waitFor(() => hk.log().filter((l) => l.step === 'qa:waiting-for-signoff').length > signoffs, 60_000);
  hk.signoff({ evidence: ['qa/dry-run-3.log'] });
  const c = await openApproval(seen);
  h.cutRunner(true);
  await waitFor(() => !h.connected(), 10_000);
  await answer(c);
  await stepUp();
  await studio('POST', '/v1/team/run/stop', { key: 'r-stop-1' });
  h.cutRunner(false);
  await waitFor(() => h.connected(), 60_000);
  await sleep(6000);
  assert.equal(hk.proposals()[opened.ref].state, 'open', 'a stopped run merges nothing, even on an approval given before the stop');
  assert.equal((await stored('proposal.accepted')).filter((e) => e.data.ref === opened.ref).length, 0);
  // A fresh run for the tests after this one.
  await studio('POST', '/v1/team/run/start', { key: 'r-start-2' });
});

test('an approval card expires while the runner is down: after the restart nothing merges on it', { skip, timeout: 240_000 }, async () => {
  const seen = new Set((await cards()).map((c) => c.id));
  const before = new Set(Object.keys(hk.proposals()));
  const signoffs = hk.log().filter((l) => l.step === 'qa:waiting-for-signoff').length;
  await studio('POST', '/v1/team/chat', { text: 'A footer with the opening hours', clientId: 'r-ask-4' });
  const opened = await proposal((p) => p.state === 'open' && !before.has(String(p.ref)));
  await waitFor(() => hk.log().filter((l) => l.step === 'qa:waiting-for-signoff').length > signoffs, 60_000);
  hk.signoff({ evidence: ['qa/dry-run-4.log'] });
  const c = await openApproval(seen);
  await h.stopRunner('SIGKILL');
  // Nobody answers in time: the card's approval passes its expiry, and the tick expires it.
  await h.db.system("update approvals set expires_at = now() where card = $1", [c.id]);
  await waitFor(async () => (await cards()).find((x) => x.id === c.id && x.state === 'expired'), 30_000);
  await h.startRunner();
  await sleep(8000);
  assert.equal(hk.proposals()[opened.ref].state, 'open', 'nothing merged on the expired approval');
  assert.equal((await stored('proposal.accepted')).filter((e) => e.data.ref === opened.ref).length, 0);
  const again = (await cards()).filter((x) => x.kind === 'approval' && x.state === 'open' && x.data?.pr === opened.ref);
  console.log(JSON.stringify({ reasked: again.length }));
});

test('the run pauses at 100% of the daily budget and carries on when the cap is raised; every cent is counted once', { skip, timeout: 240_000 }, async () => {
  /** Today's spend as the budget has it, and as the usage events add up: they must agree (no double count). */
  const books = async () => {
    const day = new Date().toISOString().slice(0, 10);
    const [b] = await h.db.system('select spent from budget_days where team = $1 and day = $2::date', [h.team, day]);
    const usage = (await stored('usage.recorded')).filter((e) => String(e.time).slice(0, 10) === day);
    return { budget: Number(b?.spent ?? 0), usage: usage.reduce((n, e) => n + Number(e.data.cost ?? 0), 0), events: usage.length };
  };
  // Only the day's cap is in play here (a run past its own cap as well stays paused: the server tests prove that).
  await stepUp();
  await studio('POST', '/v1/team/budget', { perDay: 500, perRun: 5000, key: 'r-cap-2' });
  hk.spend(6);
  await studio('POST', '/v1/team/chat', { text: 'One more thing', clientId: 'r-ask-5' });
  await waitFor(async () => (await studio('GET', '/v1/team/run')).run?.state === 'paused', 60_000);
  const card = await waitFor(async () => (await cards()).find((c) => c.kind === 'budget' && c.state === 'open'), 30_000);
  await sleep(3000); // the pause's checkpoints settle
  const paused = await books();
  assert.equal(paused.budget, paused.usage, 'the budget counted each usage event once');
  assert.ok(paused.budget >= 500, 'at or past the 100% mark');

  // The owner raises the cap (half again, with step-up): the run carries on, the held work goes out.
  await answer(card, 'raise');
  await waitFor(async () => (await studio('GET', '/v1/team/run')).run?.state === 'running', 30_000);
  await studio('POST', '/v1/team/chat', { text: 'Thanks, carry on', clientId: 'r-ask-6' });
  await waitFor(async () => (await books()).events > paused.events, 60_000);
  await sleep(3000);
  const after = await books();
  assert.equal(after.budget, after.usage, 'still counted once after the resume');
  assert.equal((await studio('GET', '/v1/team/run')).run?.state, 'running', 'below the raised cap, it keeps running');
});
